#!/usr/bin/env node
// What Auto (the agent model router, services/runner/src/model-env.ts)
// saves against routing as it was before, and against running everything
// on the most capable model: an estimate, offline, that never calls a
// model.
//
//   node scripts/ops/routing-savings.mjs              # the sample in routing-savings.sample.json
//   node scripts/ops/routing-savings.mjs --json       # the same, as JSON
//   node scripts/ops/routing-savings.mjs --live 30    # g1t's own runs of the last 30 days, from billing
//   node scripts/ops/routing-savings.mjs --small-turns 1.5   # assume the fast model takes 50% more tokens
//
// How it estimates. Each task's tokens (input, output, cache reads and
// writes) are priced at each tier's list price from the routing's
// catalogue (AGENT_ROUTING in services/runner/wrangler.jsonc). Prices are
// per token, so the same work on a cheaper tier costs its price ratio,
// except that a smaller model may take more turns: its tokens are scaled
// by --small-turns (1.25 by default). A task the sample says a tier
// cannot do is charged that failed attempt and then the retry Auto makes
// one tier up (two failures in a row go to the most capable), so savings
// are net of escalation. Cost per merged change is the policy's cost over
// the tasks that end merged.
//
// --live reads, read-only, the runs billing settled and the tokens the
// model proxy counted for them (g1t-billing: runs, token_usage), through
// Wrangler as you are logged in, or CLOUDFLARE_D1_TOKEN. Live runs carry no
// change size, labels or outcome, so a review keeps the tier it ran on and
// nothing is escalated: a first look, not a verdict.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exec, jsonFrom, wranglerEnv } from "../deploy/cloudflare.mjs";
import { ROOT, parseJsonc } from "../deploy/stack.mjs";
import { DEFAULT_ROUTING, TIERS, parseRouting, route } from "../../services/runner/src/model-env.ts";

const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const DATABASE = "g1t-billing";
const SAMPLE = join(ROOT, "scripts/ops/routing-savings.sample.json");

/** The routing the next deploy runs: AGENT_ROUTING in the runner's wrangler.jsonc. */
export function configuredRouting(wranglerText) {
  try {
    return parseRouting(parseJsonc(wranglerText).vars?.AGENT_ROUTING);
  } catch {
    return DEFAULT_ROUTING;
  }
}

/** What `tokens` cost on `tier`, in dollars, with the fast tier's extra turns. */
export function costOn(tier, tokens, routing, smallTurns = 1) {
  const price = routing.tiers[tier].price;
  if (!price) return null;
  const scale = tier === "small" ? smallTurns : 1;
  const dollars =
    (tokens.input ?? 0) * price.input +
    (tokens.output ?? 0) * price.output +
    (tokens.cacheRead ?? 0) * price.cacheRead +
    (tokens.cacheWrite ?? 0) * price.cacheWrite;
  return (dollars * scale) / 1_000_000;
}

/**
 * The tier routing chose before Auto: changes, revisions and answers on
 * the large tier, plans and catching up on the small, a review small for
 * a small change that touches nothing sensitive, and a retry large.
 */
export function previousTier(task) {
  const kind = task.kind;
  if (kind === "plan" || kind === "update") return "small";
  if (kind !== "review") return "large";
  const change = task.change;
  if (!change || !change.files) return "large";
  const security = (task.labels ?? []).some((label) => label.toLowerCase() === "security");
  const small = !security && (change.sensitive ?? []).length === 0 && change.files <= 10 && change.lines <= 200;
  return small ? "small" : "large";
}

/** Auto's retry: one tier up, the most capable after `frontierAfter` failures in a row. */
export function autoNext(routing) {
  return (tier, failures) =>
    tier === "frontier" ? null : failures >= routing.frontierAfter ? "frontier" : TIERS[TIERS.indexOf(tier) + 1];
}

/**
 * Routing before Auto: a retry ran on the large tier, and after two
 * failures there a person was asked.
 */
export function previousNext(tier, failures) {
  return failures >= 2 && tier === "large" ? null : "large";
}

/**
 * What one task costs under a policy that starts it on `first` and, after
 * each failure, retries on what `next(tier, failures)` says (null: it
 * stops, for a person). `failsOn` lists the tiers the task fails on.
 * Returns the attempts, the cost and whether it ended done.
 */
export function play(task, first, next, routing, smallTurns) {
  const fails = new Set(task.failsOn ?? []);
  const attempts = [];
  let tier = first;
  let failures = 0;
  for (;;) {
    attempts.push(tier);
    if (!fails.has(tier)) return { attempts, cost: sum(attempts, task, routing, smallTurns), done: true };
    failures += 1;
    const then = attempts.length < 5 ? next(tier, failures) : null;
    if (!then) return { attempts, cost: sum(attempts, task, routing, smallTurns), done: false };
    tier = then;
  }
}

function sum(attempts, task, routing, smallTurns) {
  return attempts.reduce((total, tier) => total + (costOn(tier, task.tokens, routing, smallTurns) ?? 0), 0);
}

/** Auto's first tier for a task, and why, as the runner would route it. */
export function autoFirst(task, routing) {
  if (task.kind === "review" && task.keepTier) return { tier: task.keepTier, reason: "kept: the change's size is not on record" };
  return route(task.kind, { change: task.change ?? null, labels: task.labels ?? [] }, routing);
}

/** Every policy's cost over the tasks: Auto, routing before it, and the most capable for all. */
export function compare(tasks, routing, { smallTurns = 1.25, escalate = true } = {}) {
  const stop = () => null;
  const policies = {
    auto: [(task) => autoFirst(task, routing).tier, escalate ? autoNext(routing) : stop],
    before: [(task) => previousTier(task), escalate ? previousNext : stop],
    frontier: [() => "frontier", stop],
  };
  const rows = tasks.map((task) => {
    const out = { id: task.id, kind: task.kind, merged: task.merged !== false };
    for (const [name, [first, next]] of Object.entries(policies)) {
      const played = play(task, first(task), next, routing, smallTurns);
      out[name] = { tiers: played.attempts, cost: played.cost, done: played.done };
    }
    out.reason = autoFirst(task, routing).reason;
    return out;
  });
  const totals = {};
  for (const name of Object.keys(policies)) {
    const cost = rows.reduce((total, row) => total + row[name].cost, 0);
    const merged = rows.filter((row) => row.merged && row[name].done).length;
    totals[name] = { cost, merged, perMerged: merged ? cost / merged : null };
  }
  const saving = (from) => (totals[from].cost > 0 ? 1 - totals.auto.cost / totals[from].cost : 0);
  return { rows, totals, savings: { vsBefore: saving("before"), vsFrontier: saving("frontier") } };
}

/** Billing's runs and their tokens, as tasks. Reviews keep the tier they ran on. */
export function tasksFromBilling(rows) {
  return rows
    .filter((row) => (row.input ?? 0) + (row.output ?? 0) + (row.cache_read ?? 0) + (row.cache_write ?? 0) > 0)
    .map((row) => ({
      id: row.id,
      kind: ["implement", "review", "update", "plan"].includes(row.task) ? row.task : "implement",
      keepTier: row.task === "review" && TIERS.includes(row.tier) ? row.tier : null,
      tokens: { input: row.input ?? 0, output: row.output ?? 0, cacheRead: row.cache_read ?? 0, cacheWrite: row.cache_write ?? 0 },
      merged: true,
    }));
}

async function d1(sql) {
  const env = wranglerEnv();
  if (process.env.CLOUDFLARE_D1_TOKEN) env.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_D1_TOKEN;
  const { code, out } = await exec(process.execPath, [WRANGLER, "d1", "execute", DATABASE, "--remote", "--json", "--command", sql], {
    env,
  });
  if (code !== 0) throw new Error(`wrangler d1 execute failed:\n${out.slice(-800)}`);
  return jsonFrom(out)[0]?.results ?? [];
}

function liveSql(days) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return `SELECT r.id, r.task, r.tier, r.model,
            SUM(t.input) AS input, SUM(t.output) AS output, SUM(t.cache_read) AS cache_read, SUM(t.cache_write) AS cache_write
          FROM runs r JOIN token_usage t ON t.session = r.session_id AND t.workspace = r.workspace
          WHERE r.created_at >= '${since}' AND r.session_id IS NOT NULL
          GROUP BY r.id LIMIT 5000`;
}

function dollars(n) {
  return n == null ? "—" : `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function print(result) {
  const { rows, totals, savings } = result;
  console.log("task                       kind       auto                 before         most capable");
  for (const row of rows) {
    const cell = (p) => `${dollars(row[p].cost)} ${row[p].tiers.join(">")}${row[p].done ? "" : " (failed)"}`;
    console.log(`${row.id.padEnd(26)} ${row.kind.padEnd(10)} ${cell("auto").padEnd(20)} ${cell("before").padEnd(14)} ${cell("frontier")}`);
  }
  console.log("");
  for (const [name, total] of Object.entries(totals)) {
    console.log(`${name.padEnd(9)} ${dollars(total.cost).padStart(10)}  merged ${total.merged}  per merged change ${dollars(total.perMerged)}`);
  }
  console.log("");
  console.log(`Auto against routing before it: ${(savings.vsBefore * 100).toFixed(1)}% ${savings.vsBefore >= 0 ? "less" : "more"}`);
  console.log(`Auto against the most capable model for everything: ${(savings.vsFrontier * 100).toFixed(1)}% less`);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const routing = configuredRouting(readFileSync(join(ROOT, "services/runner/wrangler.jsonc"), "utf8"));
  const smallTurns = Number(flag("--small-turns") ?? 1.25);
  let tasks;
  let escalate = true;
  if (args.includes("--live")) {
    const days = Number(flag("--live") ?? 30) || 30;
    tasks = tasksFromBilling(await d1(liveSql(days)));
    escalate = false;
  } else {
    tasks = JSON.parse(readFileSync(SAMPLE, "utf8")).tasks;
  }
  const result = compare(tasks, routing, { smallTurns, escalate });
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else print(result);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/ops/routing-savings.mjs")) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}
