#!/usr/bin/env node
// What does Cloudflare count as an Artifacts "operation"? Compares what
// Cloudflare's analytics say happened (GraphQL `artifactsEventsAdaptiveGroups`:
// create, fork, push, pull, delete, and errors) with what g1t metered itself
// (repos D1: `artifacts_meters`, every interaction by kind, and
// `git_operations`, what workspaces are counted for), day by day, and says
// which of g1t's meters line up with each of Cloudflare's events.
// docs/ARTIFACTS.md (R1) explains how to read it.
//
// Read-only: one GraphQL query, and SELECTs against the g1t-repos database.
//
//   CLOUDFLARE_API_TOKEN=<token with Account Analytics: Read> \
//     node scripts/ops/artifacts-usage.mjs [--days 31] [--json]
//     node scripts/ops/artifacts-usage.mjs --hours 2026-10-07
//
// --hours DAY shows one UTC day hour by hour (Cloudflare's operations and
// errors against `git_operations`), and the errors by message and repository:
// a fix that lands mid-day is judged on the hours after it.
//
// The D1 queries run through Wrangler with the same environment (so the
// token needs D1: Read too), or with CLOUDFLARE_D1_TOKEN when that is set,
// or as you are logged in (`npx wrangler login`) when neither has it.

import { ACCOUNT_ID, cloudflareAuth, exec, jsonFrom, wranglerEnv } from "../deploy/cloudflare.mjs";
import { ROOT } from "../deploy/stack.mjs";
import { join } from "node:path";

const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const DATABASE = "g1t-repos";
const NAMESPACE = process.env.ARTIFACTS_NAMESPACE || null;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const days = Math.min(31, Math.max(1, Number(option("--days", "31")) || 31));
const asJson = flag("--json");
const hoursOf = option("--hours", null);
if (hoursOf && !/^\d{4}-\d{2}-\d{2}$/.test(hoursOf)) {
  console.error("--hours takes a UTC day, YYYY-MM-DD");
  process.exit(2);
}

const auth = cloudflareAuth();
if (!auth) {
  console.error(
    "Set CLOUDFLARE_API_TOKEN to a token with Account Analytics: Read on account " + ACCOUNT_ID +
      ", or CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL.",
  );
  process.exit(2);
}

const end = new Date();
const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
const day = (date) => date.toISOString().slice(0, 10);

async function graphql(query, variables) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", "user-agent": "g1t-ops" },
    body: JSON.stringify({ query, variables: { accountTag: ACCOUNT_ID, ...variables } }),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) {
    throw new Error(`GraphQL: ${response.status} ${JSON.stringify(body.errors ?? body).slice(0, 600)}`);
  }
  return body.data?.viewer?.accounts?.[0] ?? {};
}

/** One UTC day by the hour: Cloudflare's operations and errors against `git_operations`. */
async function hourly(dayText) {
  const from = `${dayText}T00:00:00Z`;
  const to = new Date(Date.parse(from) + 24 * 3600 * 1000).toISOString();
  const nsFilter = NAMESPACE ? `, repositoryNamespace: "${NAMESPACE.replace(/"/g, "")}"` : "";
  const query = `query ArtifactsHours($accountTag: String!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        hours: artifactsEventsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $start, datetime_lt: $end${nsFilter} }
          orderBy: [datetimeHour_ASC]
        ) { count dimensions { datetimeHour eventKind eventType } }
        errors: artifactsEventsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $start, datetime_lt: $end, eventKind: "error"${nsFilter} }
          orderBy: [count_DESC]
        ) { count dimensions { eventType errorMessage repositoryName } }
      }
    }
  }`;
  const [account, operations] = await Promise.all([
    graphql(query, { start: from, end: to }),
    d1(
      `SELECT substr(hour, 12, 2) AS h, SUM(operations) AS operations FROM git_operations WHERE hour >= '${dayText}T00' AND hour <= '${dayText}T23' GROUP BY h`,
    ),
  ]);
  const ours = Object.fromEntries(operations.map((row) => [row.h, Number(row.operations)]));
  const types = ["pull", "push", "create", "fork", "delete"];
  const byHour = {};
  for (const group of account.hours ?? []) {
    const { datetimeHour, eventKind, eventType } = group.dimensions;
    const key = eventKind === "error" ? "errors" : eventType;
    if (key !== "errors" && !types.includes(key)) continue;
    const h = datetimeHour.slice(11, 13);
    (byHour[h] ??= {})[key] = (byHour[h][key] ?? 0) + group.count;
  }
  console.log(`Artifacts by the hour, ${dayText} UTC${NAMESPACE ? ` (namespace ${NAMESPACE})` : ""}\n`);
  console.log(["hour", ...types.map((t) => pad(`cf.${t}`, 9)), pad("cf.ops", 8), pad("g1t.ops", 8), pad("ratio", 6), pad("cf.errors", 10)].join(" "));
  let cfTotal = 0;
  let ourTotal = 0;
  for (let i = 0; i < 24; i++) {
    const h = String(i).padStart(2, "0");
    const cf = byHour[h] ?? {};
    const cfOps = types.reduce((total, t) => total + (cf[t] ?? 0), 0);
    const mine = ours[h] ?? 0;
    if (!cfOps && !mine && !cf.errors) continue;
    cfTotal += cfOps;
    ourTotal += mine;
    console.log(
      [h + "  ", ...types.map((t) => pad(cf[t] ?? 0, 9)), pad(cfOps, 8), pad(mine, 8), pad(mine ? (cfOps / mine).toFixed(2) : "n/a", 6), pad(cf.errors ?? 0, 10)].join(" "),
    );
  }
  console.log(`\nday   cf.ops ${cfTotal}, g1t.ops ${ourTotal}${ourTotal ? `, ratio ${(cfTotal / ourTotal).toFixed(2)}` : ""}`);
  const messages = {};
  const repositories = {};
  for (const group of account.errors ?? []) {
    const { eventType, errorMessage, repositoryName } = group.dimensions;
    const key = `${eventType}: ${errorMessage || "(no message)"}`;
    messages[key] = (messages[key] ?? 0) + group.count;
    repositories[repositoryName] = (repositories[repositoryName] ?? 0) + group.count;
  }
  console.log("\nErrors by message:");
  for (const [message, count] of Object.entries(messages).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(count, 6)}  ${message}`);
  console.log("Errors by repository (top 8):");
  for (const [name, count] of Object.entries(repositories).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${pad(count, 6)}  ${name}`);
  console.log(
    "\ng1t.ops is what workspaces are counted for (billable meters only; nightly backups are g1t's own and not in it). An hour can straddle the two sides of a write by a few seconds.",
  );
}

/** Cloudflare's own count, by day, event kind and type (and namespace). */
async function cloudflare() {
  const query = `query ArtifactsUsage($accountTag: String!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        artifactsEventsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $start, datetime_leq: $end }
          orderBy: [date_ASC]
        ) {
          count
          sum { durationMs }
          dimensions { date eventKind eventType repositoryNamespace }
        }
      }
    }
  }`;
  const account = await graphql(query, { start: start.toISOString(), end: end.toISOString() });
  const groups = account.artifactsEventsAdaptiveGroups ?? [];
  return groups
    .filter((group) => !NAMESPACE || group.dimensions.repositoryNamespace === NAMESPACE)
    .map((group) => ({
      day: group.dimensions.date,
      kind: group.dimensions.eventKind,
      type: group.dimensions.eventType,
      namespace: group.dimensions.repositoryNamespace,
      count: group.count,
      ms: group.sum?.durationMs ?? 0,
    }));
}

/** A read-only query against the repos database. */
async function d1(sql) {
  const env = { ...wranglerEnv({ ...process.env, CI: "true" }) };
  if (process.env.CLOUDFLARE_D1_TOKEN) env.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_D1_TOKEN;
  const { code, out } = await exec(process.execPath, [WRANGLER, "d1", "execute", DATABASE, "--remote", "--json", "--command", sql], {
    cwd: join(ROOT, "services/repos"),
    env,
  });
  if (code !== 0) throw new Error(out.slice(-600));
  return jsonFrom(out)[0]?.results ?? [];
}

async function ours() {
  const since = day(start);
  const operations = await d1(
    `SELECT substr(hour, 1, 10) AS day, SUM(operations) AS operations FROM git_operations WHERE hour >= '${since}' GROUP BY day ORDER BY day`,
  );
  let meters = [];
  let mapping = [];
  try {
    meters = await d1(
      `SELECT day, meter, SUM(count) AS count, SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out FROM artifacts_meters WHERE day >= '${since}'` +
        (NAMESPACE ? ` AND store = '${NAMESPACE.replace(/'/g, "")}'` : "") +
        " GROUP BY day, meter ORDER BY day, meter",
    );
    mapping = await d1("SELECT meter, cost_operations, billable_operations FROM operation_mapping ORDER BY meter");
  } catch (error) {
    console.error(`(artifacts_meters not readable yet: migration 0011 not applied? ${String(error.message).split("\n")[0]})`);
  }
  return { operations, meters, mapping };
}

/** Cloudflare's events against combinations of g1t's meters: which line up. */
export function candidates(cfTotals, meterTotals) {
  const sum = (names) => names.reduce((total, name) => total + (meterTotals[name] ?? 0), 0);
  const options = {
    pull: [
      ["git.fetch"],
      ["git.fetch", "internal.git.fetch"],
      ["git.fetch", "internal.git.fetch", "git.ls_refs"],
      ["git.fetch", "internal.git.fetch", "git.ls_refs", "git.info_refs", "internal.git.info_refs"],
      ["git.fetch", "internal.git.fetch", "git.ls_refs", "git.info_refs", "internal.git.info_refs", "cache.info_refs", "cache.ls_refs"],
    ],
    push: [["git.receive_pack"], ["git.receive_pack", "internal.git.receive_pack"]],
    create: [["binding.create"]],
    fork: [["binding.fork"]],
    delete: [["binding.delete"]],
  };
  const rows = [];
  for (const [type, combos] of Object.entries(options)) {
    const theirs = cfTotals[type] ?? 0;
    for (const combo of combos) {
      const mine = sum(combo);
      rows.push({ type, cloudflare: theirs, meters: combo.join(" + "), g1t: mine, ratio: mine ? theirs / mine : null });
    }
  }
  return rows;
}

const pad = (value, width) => String(value).padStart(width);

async function main() {
  const [events, mine] = await Promise.all([cloudflare(), ours()]);
  const cfTotals = {};
  const cfByDay = {};
  for (const event of events) {
    const key = event.kind === "error" ? `error:${event.type}` : event.type;
    cfTotals[key] = (cfTotals[key] ?? 0) + event.count;
    (cfByDay[event.day] ??= {})[key] = (cfByDay[event.day]?.[key] ?? 0) + event.count;
  }
  const meterTotals = {};
  const meterByDay = {};
  for (const row of mine.meters) {
    meterTotals[row.meter] = (meterTotals[row.meter] ?? 0) + Number(row.count);
    (meterByDay[row.day] ??= {})[row.meter] = Number(row.count);
  }
  const opsByDay = Object.fromEntries(mine.operations.map((row) => [row.day, Number(row.operations)]));
  const lined = candidates(cfTotals, meterTotals);
  if (asJson) {
    console.log(JSON.stringify({ from: day(start), to: day(end), cloudflare: events, meters: mine.meters, git_operations: mine.operations, mapping: mine.mapping, candidates: lined }, null, 2));
    return;
  }
  console.log(`Artifacts usage ${day(start)} to ${day(end)}${NAMESPACE ? ` (namespace ${NAMESPACE})` : ""}\n`);
  const types = ["pull", "push", "create", "fork", "delete"];
  console.log(["day       ", ...types.map((t) => pad(`cf.${t}`, 10)), pad("cf.errors", 10), pad("g1t.fetch", 10), pad("g1t.push", 10), pad("g1t.ops", 10)].join(" "));
  const allDays = [...new Set([...Object.keys(cfByDay), ...Object.keys(meterByDay), ...Object.keys(opsByDay)])].sort();
  for (const d of allDays) {
    const cf = cfByDay[d] ?? {};
    const m = meterByDay[d] ?? {};
    const errors = Object.entries(cf).filter(([key]) => key.startsWith("error:")).reduce((total, [, n]) => total + n, 0);
    console.log(
      [
        d,
        ...types.map((t) => pad(cf[t] ?? 0, 10)),
        pad(errors, 10),
        pad((m["git.fetch"] ?? 0) + (m["internal.git.fetch"] ?? 0), 10),
        pad((m["git.receive_pack"] ?? 0) + (m["internal.git.receive_pack"] ?? 0), 10),
        pad(opsByDay[d] ?? 0, 10),
      ].join(" "),
    );
  }
  console.log("\nCloudflare totals:", JSON.stringify(cfTotals));
  console.log("g1t meter totals: ", JSON.stringify(meterTotals));
  console.log("\nWhich g1t meters line up with each Cloudflare event (ratio = Cloudflare / g1t; 1.00 is a match):");
  for (const row of lined) {
    console.log(`  ${row.type.padEnd(7)} ${pad(row.cloudflare, 8)}  vs ${pad(row.g1t, 8)}  ${row.ratio == null ? "  n/a" : row.ratio.toFixed(2).padStart(5)}  ${row.meters}`);
  }
  console.log("\nNow counting as operations (operation_mapping):");
  for (const row of mine.mapping) console.log(`  ${row.meter.padEnd(28)} cost ${row.cost_operations}  billable ${row.billable_operations}`);
  console.log(
    "\nThe days before 2026-10-06's meters were deployed have Cloudflare's numbers only. Errors are Cloudflare's error events (rateLimited, serverError, ...).",
  );
}

(hoursOf ? hourly(hoursOf) : main()).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
