// g1t's pull request reviewer behind the ReviewBench agent contract
// (https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md).
//
// Runs inside the image built from bench/reviewbench/Dockerfile, which is
// the g1t sandbox's base image (same Claude Code CLI, same toolchains).
// It does what crates/runner/src/review.rs does after its clone: write the
// change to /work/change.diff, run Claude Code headless with the same
// flags as crates/runner/src/harness.rs, read /work/review.json, and apply
// the same filters services/work/src/reviews.rs applies when it records a
// review. Then it writes the review's line comments as findings.
//
// Configuration (all optional):
//   ANTHROPIC_MODEL or RB_CONFIG_MODEL   model id (production review route: claude-sonnet-5-5)
//   ANTHROPIC_BASE_URL                   g1t's model proxy (MODELS_URL/anthropic) or a gateway
//   ANTHROPIC_API_KEY                    provider key, or a model-proxy session token
//   RB_CONFIG_BUDGET_USD                 per-PR cost cap (--max-budget-usd), default 5
//   RB_CONFIG_VARIANT                    prompt variant: "production" (default) or a file in variants/

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { buildPrompt } from "./prompt-lib.mjs";

const REPO = "/work/repo";
const DIFF_FILE = "/work/change.diff";
const REVIEW_FILE = "/work/review.json";
const MAX_TURNS = "80"; // harness.rs
const MAX_REVIEW_COMMENTS = 30; // reviews.rs
const MAX_REVIEW_CHARS = 20_000; // reviews.rs

const env = (name, fallback) => process.env[name] ?? fallback;
const out = env("RB_OUT", "/work/out/findings.json");
const agent = env("RB_AGENT", "g1t-agent");
const pr = JSON.parse(readFileSync(env("RB_PR_JSON", "/work/pr/pr.json"), "utf8"));
const model = env("RB_CONFIG_MODEL", env("ANTHROPIC_MODEL", "claude-sonnet-5-5"));
const budget = Number(env("RB_CONFIG_BUDGET_USD", "5"));
const variant = env("RB_CONFIG_VARIANT", "production");

// The run's settings, printed so ReviewBench can see each label took effect.
console.log(`model=${model} budget_usd=${budget} variant=${variant}`);

function write(findings, usage) {
  const body = {
    pr: { repo: pr.repo ?? `https://github.com/${env("RB_NWO")}`, pr_number: Number(env("RB_PR_NUMBER", pr.pr_number)), base: env("RB_BASE", pr.base), head: env("RB_HEAD", pr.head) },
    agent,
    findings,
    usage,
  };
  writeFileSync(out, JSON.stringify(body, null, 2));
}

/** Paths the change touches, as the work service knows them (pull.files). */
function changedPaths(diff) {
  const paths = new Set();
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/) ?? line.match(/^--- a\/(.+)$/);
    if (m && m[1] !== "/dev/null") paths.add(m[1]);
  }
  return paths;
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ["--print", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", MAX_TURNS, "--dangerously-skip-permissions", "--model", model];
    if (budget > 0) args.push("--max-budget-usd", budget.toFixed(2));
    const child = spawn("claude", args, { cwd: REPO, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ANTHROPIC_MODEL: model } });
    let result = null;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "result") result = event;
        } catch {}
      }
    });
    child.on("error", reject);
    child.on("close", (code) => (result ? resolve(result) : reject(new Error(`claude exited ${code} without a result`))));
  });
}

const started = Date.now();
copyFileSync(env("RB_DIFF", "/work/pr/diff.patch"), DIFF_FILE);
const diff = readFileSync(DIFF_FILE, "utf8");
if (!diff.trim()) {
  // review.rs bails on an empty change; the benchmark still wants a file.
  write([], { time_in_ms: Date.now() - started });
  process.exit(0);
}

const instructionsFile = variant === "production" ? new URL("./instructions.txt", import.meta.url) : new URL(`./variants/${variant}.txt`, import.meta.url);
const prompt = buildPrompt(pr, readFileSync(instructionsFile, "utf8"));
const result = await runClaude(prompt);

let review = null;
if (existsSync(REVIEW_FILE)) {
  try {
    review = JSON.parse(readFileSync(REVIEW_FILE, "utf8"));
  } catch {}
}
// review.rs: no file means the agent's answer is the review, with no line comments.
const comments = Array.isArray(review?.comments) ? review.comments : [];
const known = changedPaths(diff);
const findings = comments
  .filter((c) => typeof c?.body === "string" && c.body.trim() && typeof c.path === "string")
  // reviews.rs: a line in a file the pull request does not change is dropped.
  .filter((c) => known.size === 0 || known.has(c.path.replace(/^\.\//, "")))
  .slice(0, MAX_REVIEW_COMMENTS)
  .map((c) => {
    const line = Number.isInteger(c.line) && c.line > 0 ? c.line : 1;
    const end = Number.isInteger(c.end_line) && c.end_line >= line ? c.end_line : line;
    return { file: c.path.replace(/^\.\//, ""), start_line: line, end_line: end, message: c.body.trim().slice(0, MAX_REVIEW_CHARS), producer: agent };
  });

// Kept beside the findings for analysis: what production would also have
// posted (verdict, summary) and what the run cost.
writeFileSync(out.replace(/\.json$/, ".g1t.json"), JSON.stringify({ verdict: review?.verdict ?? null, body: review?.body ?? result.result ?? "", dropped: comments.length - findings.length, cost_usd: result.total_cost_usd, turns: result.num_turns, model }, null, 2));
write(findings, { time_in_ms: Date.now() - started, ...(typeof result.total_cost_usd === "number" ? { cost_usd: result.total_cost_usd } : {}) });
