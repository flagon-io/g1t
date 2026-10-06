#!/usr/bin/env node
// Runs g1t's pull request reviewer over ReviewBench and scores it with the
// benchmark's own judge. docs/research/reviewbench.md explains the design.
//
//   node bench/reviewbench/run.mjs setup                 clone ReviewBench (pinned) and install its judge
//   node bench/reviewbench/run.mjs build                 build the agent image from the runner base image
//   node bench/reviewbench/run.mjs estimate --set sample:50
//   node bench/reviewbench/run.mjs review --set sample:50 [--seed 1] [--variant production] [--model claude-sonnet-5-5] --yes
//   node bench/reviewbench/run.mjs judge  --run <id> [--judge-model claude-sonnet-5] --yes
//   node bench/reviewbench/run.mjs report --run <id> [--json]
//
// --set is test (the benchmark's 25), full (all 219) or sample:N (N of the
// 219, stratified by change size, reproducible with --seed).
//
// Model access, from the environment, passed into each container:
//   ANTHROPIC_API_KEY                         a provider key, or
//   ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY    g1t's model proxy (MODELS_URL/anthropic and a session token)
// The judge reads ANTHROPIC_API_KEY itself (through ReviewBench's pi registry).
//
// Nothing that spends money runs without --yes. Each review is capped by
// --budget-usd (default 5), and a run stops once --max-total-usd is spent.
//
// Needs docker, git, jq and bash (Git Bash on Windows) and Node 20+.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CACHE = join(HERE, ".cache");
const RB = join(CACHE, "ReviewBench");
const RUNS = join(CACHE, "runs");
// The ReviewBench commit these numbers are comparable against.
const RB_COMMIT = "ceb0794a3768da6ef4a56e5311dfb4afd29e5dee";
const IMAGE = "g1t-reviewbench:dev";
// The model the official leaderboard is judged with.
const DEFAULT_JUDGE = "claude-sonnet-5";
// services/runner/wrangler.jsonc AGENT_ROUTES.review
const DEFAULT_MODEL = "claude-sonnet-5-5";

// $ per million tokens: input, output, cache read, cache write (5 minute).
const PRICES = {
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
};

function args() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].replace(/^--/, "");
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else flags[name] = rest[++i];
  }
  return { command, flags };
}

const run = (cmd, argv, opts = {}) => {
  const result = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} exited ${result.status}`);
};

function manifest() {
  return JSON.parse(readFileSync(join(RB, "corpus", "manifest.json"), "utf8"));
}

/** A seeded shuffle, so a sample is the same sample next week. */
function shuffle(items, seed) {
  let state = seed >>> 0 || 1;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Indices into the full manifest for --set. */
function select(set, seed) {
  const all = manifest();
  if (set === "full") return all.map((_, i) => i);
  if (set === "test") {
    const test = JSON.parse(readFileSync(join(RB, "corpus", "test", "test.json"), "utf8"));
    const keys = new Set(test.map((p) => `${p.nwo}#${p.pr_number}`));
    return all.flatMap((p, i) => (keys.has(`${p.nwo}#${p.pr_number}`) ? [i] : []));
  }
  const m = /^sample:(\d+)$/.exec(set);
  if (!m) throw new Error(`--set is test, full or sample:N, not ${set}`);
  const n = Number(m[1]);
  // Stratified by change size, in the corpus's proportions, so a sample is
  // not all small or all huge.
  const bucket = (p) => {
    const lines = p.lines_added + p.lines_removed;
    return lines <= 200 ? 0 : lines <= 1000 ? 1 : 2;
  };
  const strata = [[], [], []];
  all.forEach((p, i) => strata[bucket(p)].push(i));
  const picked = [];
  for (const stratum of strata) {
    const share = Math.round((stratum.length / all.length) * n);
    picked.push(...shuffle(stratum, seed).slice(0, share));
  }
  return picked.slice(0, n).sort((a, b) => a - b);
}

/**
 * What one review is expected to cost. An agentic review re-reads its
 * growing context every turn, mostly from cache: turns and context grow
 * with the size of the change. Calibrate against real review runs (the
 * billing ledger records each run's cost) before trusting the absolute
 * numbers; see docs/research/reviewbench.md.
 */
function estimateOne(p, model) {
  const [, output, cacheRead, cacheWrite] = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  const lines = p.lines_added + p.lines_removed;
  const turns = Math.min(80, 12 + Math.round(Math.sqrt(lines) * 0.8) + Math.min(p.files_changed, 40) * 0.4);
  const startContext = 18_000 + Math.min(lines, 6_000) * 12; // prompt, tools, the diff when read
  const endContext = Math.min(startContext + turns * 2_500, 180_000); // files read along the way
  const meanContext = (startContext + endContext) / 2;
  // Each turn re-reads the context from cache and writes only what it added.
  const fresh = endContext;
  const cachedReads = Math.max(0, turns * meanContext - fresh);
  const outTokens = turns * 450 + 2_500;
  return (cachedReads * cacheRead + fresh * cacheWrite + outTokens * output) / 1e6;
}

/**
 * The judge: matching per file chunk plus classifying every unmatched
 * finding with read access to the repository (a few tool calls each).
 */
function estimateJudge(p, model, findingsPerPr = 6) {
  const [input, output, cacheRead] = PRICES[model] ?? PRICES[DEFAULT_JUDGE];
  const matchCalls = Math.max(1, Math.ceil(findingsPerPr / 3));
  const unmatched = findingsPerPr * 0.5;
  const tokensIn = matchCalls * 6_000 + unmatched * 5 * 12_000;
  const tokensOut = matchCalls * 1_500 + unmatched * 5 * 600;
  return (tokensIn * 0.5 * input + tokensIn * 0.5 * cacheRead + tokensOut * output) / 1e6;
}

function estimate(indices, model, judgeModel, rounds = 1) {
  const all = manifest();
  let review = 0;
  let judge = 0;
  for (const i of indices) {
    review += estimateOne(all[i], model);
    judge += estimateJudge(all[i], judgeModel);
  }
  return { prs: indices.length, rounds, review_usd: review * rounds, judge_usd: judge * rounds, total_usd: (review + judge) * rounds };
}

function setup() {
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(join(RB, ".git"))) run("git", ["clone", "https://github.com/review-bench/ReviewBench.git", RB]);
  run("git", ["-C", RB, "fetch", "-q", "origin", RB_COMMIT]);
  run("git", ["-C", RB, "checkout", "-q", "--detach", RB_COMMIT]);
  run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: RB, shell: process.platform === "win32" });
}

function build() {
  run(process.execPath, [join(HERE, "prompt.mjs")]);
  const base = JSON.parse(readFileSync(join(ROOT, "services", "runner", "base.json"), "utf8"));
  run("docker", ["build", "--platform", "linux/amd64", "--build-arg", `BASE=${base.image}@${base.digest}`, "-t", IMAGE, HERE]);
}

function review(flags) {
  if (!flags.yes) throw new Error("review spends model credit; run estimate first, then pass --yes");
  const set = flags.set ?? "sample:50";
  const seed = Number(flags.seed ?? 1);
  const model = flags.model ?? DEFAULT_MODEL;
  const variant = flags.variant ?? "production";
  const budget = Number(flags["budget-usd"] ?? 5);
  const maxTotal = Number(flags["max-total-usd"] ?? 150);
  const indices = select(set, seed);
  const id = flags.run ?? `${new Date().toISOString().slice(0, 10)}-${set.replace(":", "")}-${variant}-${model}`;
  const dir = join(RUNS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ id, set, seed, model, variant, budget_usd: budget, indices, reviewbench: RB_COMMIT, g1t: execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"]).toString().trim(), started_at: new Date().toISOString() }, null, 2));
  const env = { ...process.env, RB_CONFIG_MODEL: model, RB_CONFIG_VARIANT: variant, RB_CONFIG_BUDGET_USD: String(budget), TRY_AGENT_WORK: join(dir, ".work") };
  const pass = ["-e", "RB_CONFIG_MODEL", "-e", "RB_CONFIG_VARIANT", "-e", "RB_CONFIG_BUDGET_USD", "-e", "ANTHROPIC_API_KEY"];
  if (process.env.ANTHROPIC_BASE_URL) pass.push("-e", "ANTHROPIC_BASE_URL");
  let spent = 0;
  for (const i of indices) {
    if (spent >= maxTotal) {
      console.error(`stopped: spent $${spent.toFixed(2)} of --max-total-usd ${maxTotal}`);
      break;
    }
    spawnSync("bash", [join(RB, "scripts", "try-agent.sh"), IMAGE, "--set", "full", "--pr", String(i), ...pass], { cwd: dir, env, stdio: "inherit" });
    spent = sidecars(dir).reduce((sum, s) => sum + (s.cost_usd ?? 0), 0);
  }
  console.log(`run ${id}: ${readdirSync(join(dir, "findings")).length} of ${indices.length} reviewed, $${spent.toFixed(2)} spent`);
}

/** What production would have posted beside the findings, and the cost. */
function sidecars(dir) {
  const out = join(dir, ".work", "out");
  if (!existsSync(out)) return [];
  return readdirSync(out).flatMap((key) => {
    const file = join(out, key, "findings.g1t.json");
    return existsSync(file) ? [{ key, ...JSON.parse(readFileSync(file, "utf8")) }] : [];
  });
}

function judge(flags) {
  if (!flags.yes) throw new Error("judging spends model credit; pass --yes");
  const dir = join(RUNS, flags.run);
  const judgeModel = flags["judge-model"] ?? DEFAULT_JUDGE;
  run("npm", ["run", "judge", "--", "--candidate", join(dir, "findings"), "--golden", join(RB, "golden"), "--manifest", join(RB, "corpus", "manifest.json"), "--provider", "anthropic", "--model", judgeModel, "--output", join(dir, "scoring", "results.json"), "--repo-dir", join(CACHE, "judge-repos"), "--concurrency", String(flags.concurrency ?? 4)], { cwd: RB, shell: process.platform === "win32" });
}

function report(flags) {
  const dir = join(RUNS, flags.run);
  const meta = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  const results = JSON.parse(readFileSync(join(dir, "scoring", "results.json"), "utf8"));
  const side = sidecars(dir);
  const cost = side.reduce((sum, s) => sum + (s.cost_usd ?? 0), 0);
  const summary = {
    run: meta.id,
    date: meta.started_at.slice(0, 10),
    g1t: meta.g1t,
    model: meta.model,
    variant: meta.variant,
    set: meta.set,
    prs: side.length,
    findings: readdirSync(join(dir, "findings")).reduce((sum, f) => sum + JSON.parse(readFileSync(join(dir, "findings", f), "utf8")).findings.length, 0),
    review_cost_usd: Number(cost.toFixed(2)),
    request_changes: side.filter((s) => s.verdict === "request_changes").length,
    dropped_outside_change: side.reduce((sum, s) => sum + (s.dropped ?? 0), 0),
    // The judge's own aggregate block, as ReviewBench writes it.
    metrics: results.metrics ?? results.summary ?? results,
  };
  if (flags.json) {
    console.log(JSON.stringify(summary));
    return;
  }
  console.log(`## ReviewBench: ${summary.run}\n`);
  console.log(`g1t ${summary.g1t.slice(0, 8)}, ${summary.model}, prompt ${summary.variant}, ${summary.set} (${summary.prs} PRs), review cost $${summary.review_cost_usd}\n`);
  console.log("```json\n" + JSON.stringify(summary.metrics, null, 2) + "\n```");
}

const { command, flags } = args();
try {
  switch (command) {
    case "setup":
      setup();
      break;
    case "build":
      build();
      break;
    case "estimate": {
      const indices = select(flags.set ?? "sample:50", Number(flags.seed ?? 1));
      const model = flags.model ?? DEFAULT_MODEL;
      const judgeModel = flags["judge-model"] ?? DEFAULT_JUDGE;
      console.log(JSON.stringify({ set: flags.set ?? "sample:50", model, judge: judgeModel, ...estimate(indices, model, judgeModel, Number(flags.rounds ?? 1)) }, (k, v) => (typeof v === "number" ? Number(v.toFixed(2)) : v), 2));
      break;
    }
    case "review":
      review(flags);
      break;
    case "judge":
      judge(flags);
      break;
    case "report":
      report(flags);
      break;
    default:
      console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 22).join("\n"));
      process.exit(2);
  }
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(1);
}
