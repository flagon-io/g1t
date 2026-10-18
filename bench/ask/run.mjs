#!/usr/bin/env node
// Ask g1t's quality bar: asks every question in questions.json on the live
// Ask endpoint as the user, records the whole answer, and grades it against
// ground truth fetched at the same time, with deterministic checks and an
// LLM judge.
//
//   node bench/ask/run.mjs                      ask, grade, judge, report (one pass)
//   node bench/ask/run.mjs --only id,id         some questions
//   node bench/ask/run.mjs --dry-run            fetch ground truth and print the plan; asks nothing
//   node bench/ask/run.mjs --no-judge           deterministic checks only
//   node bench/ask/run.mjs grade --run <dir>    grade a saved run again (and judge, unless --no-judge, which keeps the saved verdicts;
//                                               --refresh-truth fetches ground truth again)
//   node bench/ask/run.mjs report --run <dir>   write the report again
//   node bench/ask/run.mjs fixtures             make the fixtures the suite needs (writes to the test repository)
//
// Options: --workspace flagon-io, --pace 3500 (ms between questions; Ask
// allows 20 a minute per person), --label text (kept in the run's folder name).
//
// Credentials, read in-process and never printed or written:
//   G1T_TOKEN (or its export in ~/.bashrc)       g1t's API and MCP, for ground truth
//   .credentials/g1t_token.txt                   g1t.sh as the user, for Ask and link checks
//   .secrets/anthropic-key.txt                   the judge
// The latter two are read from the main checkout, so this runs from a worktree too.
//
// Runs land in bench/ask/runs/<timestamp>/ (git-ignored): one JSON per
// question (truth, every event, checks, verdict), summary.json and report.md.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { BAR, DIMENSIONS, JUDGE_MODEL, deterministic, judge, summarize } from "./grade.mjs";
import { HERE, ask, loadCredentials, parseArgs, redact, sleep } from "./lib.mjs";
import { ensureFixtures, resolveTruth } from "./truth.mjs";

const { command, flags } = parseArgs(process.argv.slice(2));
const suite = JSON.parse(readFileSync(join(HERE, "questions.json"), "utf8"));
const WORKSPACE = flags.workspace ?? suite.workspace;
process.env.ASK_WORKSPACE ??= WORKSPACE;

const write = (path, value) => writeFileSync(path, redact(typeof value === "string" ? value : JSON.stringify(value, null, 2)));
const say = (line) => console.log(redact(line));

function selected() {
  const only = typeof flags.only === "string" ? new Set(flags.only.split(",")) : null;
  return suite.questions.filter((q) => !only || only.has(q.id));
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
}

async function gradeOne(question, truth, answer, { useJudge }) {
  const checks = await deterministic(question, truth, answer);
  const verdict = useJudge ? await judge(question, truth, answer) : null;
  return { checks, judge: verdict };
}

async function runSuite() {
  const creds = loadCredentials();
  if (!creds.api) throw new Error("No G1T_TOKEN: export it, or source ~/.bashrc.");
  if (!creds.web) throw new Error("No site token: .credentials/g1t_token.txt is missing.");
  const dry = Boolean(flags["dry-run"]);
  const useJudge = !flags["no-judge"] && !dry;
  if (useJudge && !creds.anthropic) throw new Error("No judge key: .secrets/anthropic-key.txt is missing (or pass --no-judge).");
  const pace = Number(flags.pace ?? 3500);
  const questions = selected();
  const dir = dry ? null : join(HERE, "runs", `${stamp()}${flags.label ? `-${String(flags.label).replace(/[^\w-]+/g, "-")}` : ""}`);
  if (dir) mkdirSync(join(dir, "questions"), { recursive: true });
  say(`${dry ? "Dry run" : "Run"}: ${questions.length} questions in ${WORKSPACE}${useJudge ? `, judged by ${JUDGE_MODEL}` : ""}${dir ? `, into ${dir}` : ""}`);

  const results = [];
  for (const [index, question] of questions.entries()) {
    const truth = await resolveTruth(question.truth);
    const page = question.page === "$truth" ? truth.page : question.page;
    const messages = question.messages ?? [{ role: "user", content: question.question }];
    const label = `[${index + 1}/${questions.length}] ${question.id}`;
    if (truth.skip) {
      say(`${label}: skipped (${truth.skip})`);
      results.push({ id: question.id, category: question.category, skipped: truth.skip, truth });
      continue;
    }
    if (dry) {
      say(
        `${label}: ${messages.at(-1).content}\n  page: ${JSON.stringify(page ?? {})}\n  truth: ${truth.digest.split("\n").slice(0, 6).join("\n         ")}\n  require: ${JSON.stringify([...(truth.require_any ?? []), ...(question.require_any ?? [])]).slice(0, 300)}`,
      );
      continue;
    }
    if (index > 0) await sleep(pace);
    const answer = await ask(WORKSPACE, { messages, page });
    const graded = await gradeOne(question, truth, answer, { useJudge });
    const result = { id: question.id, category: question.category, question: messages.at(-1).content, page: page ?? null, truth, answer, ...graded };
    results.push(result);
    write(join(dir, "questions", `${question.id}.json`), result);
    const passed = graded.checks.filter((c) => c.pass).length;
    say(
      `${label}: ${answer.status} ${answer.total_ms} ms, checks ${passed}/${graded.checks.length}${graded.judge?.mean != null ? `, judge ${graded.judge.mean.toFixed(2)}` : graded.judge?.error ? `, ${graded.judge.error}` : ""}${answer.unknown_types.length ? `, new events: ${answer.unknown_types.join(",")}` : ""}`,
    );
  }
  if (dry) return;
  finish(dir, results);
}

function finish(dir, results) {
  const summary = summarize(results);
  write(join(dir, "summary.json"), { ...summary, workspace: WORKSPACE, judge_model: JUDGE_MODEL, finished_at: new Date().toISOString() });
  write(join(dir, "report.md"), report(dir, results, summary));
  say(`\n${headline(summary)}\nReport: ${join(dir, "report.md")}`);
}

function headline(s) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  return [
    `${s.pass ? "PASS" : "FAIL"} against the bar (checks >= ${pct(BAR.deterministic)}, judge >= ${BAR.judge_mean}, safety failures = ${BAR.safety_failures})`,
    `deterministic checks ${s.checks.passed}/${s.checks.total} (${pct(s.checks.rate)}); judge mean ${s.judge.mean?.toFixed(2) ?? "-"} over ${s.judge.judged}; safety failures ${s.safety_failures}; answers with tool use ${s.tool_use.answers_with_tools}/${s.graded}`,
  ].join("\n");
}

function report(dir, results, s) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const ms = (x) => (x ? `${(x / 1000).toFixed(1)} s` : "-");
  const model = results.find((r) => r.answer?.meta)?.answer.meta;
  const lines = [
    `# Ask g1t bench: ${basename(dir)}`,
    "",
    `**${s.pass ? "PASS" : "FAIL"}** · workspace \`${WORKSPACE}\` · answered by ${model ? `${model.provider_label} \`${model.model}\`` : "?"} · judged by \`${JUDGE_MODEL}\``,
    "",
    "| Measure | Result | Bar |",
    "| --- | --- | --- |",
    `| Deterministic checks | ${s.checks.passed}/${s.checks.total} (${pct(s.checks.rate)}) | ≥ ${pct(BAR.deterministic)} |`,
    `| Judge mean (1–5) | ${s.judge.mean?.toFixed(2) ?? "-"} over ${s.judge.judged} | ≥ ${BAR.judge_mean} |`,
    `| Safety failures | ${s.safety_failures} | ${BAR.safety_failures} |`,
    `| Answers that used tools | ${s.tool_use.answers_with_tools}/${s.graded} | |`,
    `| Time to first text, p50 / p90 | ${ms(s.latency.first_text_ms?.p50)} / ${ms(s.latency.first_text_ms?.p90)} | |`,
    `| Total time, p50 / p90 / max | ${ms(s.latency.total_ms?.p50)} / ${ms(s.latency.total_ms?.p90)} / ${ms(s.latency.total_ms?.max)} | |`,
    s.skipped ? `| Skipped | ${s.skipped} | |` : null,
    s.tool_use.unknown_event_types.length ? `| Event types the bench does not know | ${s.tool_use.unknown_event_types.join(", ")} | |` : null,
    "",
    "## Judge by dimension",
    "",
    `| ${DIMENSIONS.join(" | ")} |`,
    `| ${DIMENSIONS.map(() => "---").join(" | ")} |`,
    `| ${DIMENSIONS.map((d) => s.judge.by_dimension[d]?.toFixed(2) ?? "-").join(" | ")} |`,
    "",
    "## Questions",
    "",
    "| Question | Checks | Judge | First text | Total | Tools | Failed checks |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...results.map((r) => {
      if (r.skipped) return `| ${r.id} | skipped | | | | | ${r.skipped} |`;
      const failed = r.checks.filter((c) => !c.pass);
      return `| ${r.id} | ${r.checks.length - failed.length}/${r.checks.length} | ${r.judge?.mean?.toFixed(2) ?? (r.judge?.error ? "error" : "-")} | ${ms(r.answer.first_text_ms)} | ${ms(r.answer.total_ms)} | ${r.answer.tool_events.length} | ${failed
        .map((c) => `${c.safety ? "**SAFETY** " : ""}${c.name}`)
        .join(", ")
        .replace(/\|/g, "\\|")} |`;
    }),
    "",
    "## Answers",
    "",
  ];
  for (const r of results) {
    if (r.skipped) continue;
    lines.push(`### ${r.id}`, "", `> ${r.question.replace(/\n/g, " ")}`, "");
    if (r.page) lines.push(`Page: \`${JSON.stringify(r.page)}\``, "");
    lines.push("<details><summary>Answer</summary>", "", r.answer.text || `_(no answer: ${r.answer.error ?? "empty"})_`, "", "</details>", "");
    lines.push("Checks:", ...r.checks.map((c) => `- ${c.pass ? "✅" : "❌"} ${c.safety ? "(safety) " : ""}${c.name}: ${c.detail}`), "");
    if (r.judge && !r.judge.error) {
      lines.push(`Judge ${r.judge.mean.toFixed(2)}${r.judge.safety_ok ? "" : " · **unsafe**"}: ${r.judge.summary}`, "");
      lines.push(...DIMENSIONS.map((d) => `- ${d} ${r.judge[d].score}: ${r.judge[d].rationale}`), "");
    } else if (r.judge?.error) lines.push(`Judge: ${r.judge.error}`, "");
    lines.push("<details><summary>Ground truth</summary>", "", "```", r.truth.digest, "```", "", "</details>", "");
  }
  return lines.filter((l) => l !== null).join("\n");
}

async function regrade() {
  const dir = resolve(String(flags.run ?? ""));
  if (!flags.run || !existsSync(join(dir, "questions"))) throw new Error("--run <dir> with a questions/ folder");
  loadCredentials();
  const useJudge = !flags["no-judge"] && command === "grade";
  const byId = new Map(suite.questions.map((q) => [q.id, q]));
  const results = [];
  for (const file of readdirSync(join(dir, "questions")).filter((f) => f.endsWith(".json"))) {
    const saved = JSON.parse(readFileSync(join(dir, "questions", file), "utf8"));
    const question = byId.get(saved.id) ?? saved;
    if (command === "grade") {
      // --refresh-truth fetches ground truth again (for changed resolvers); it is no longer the moment of asking.
      if (flags["refresh-truth"] && question.truth) saved.truth = await resolveTruth(question.truth);
      const kept = saved.judge;
      Object.assign(saved, await gradeOne({ ...question, page: saved.page }, saved.truth, saved.answer, { useJudge }));
      if (!useJudge) saved.judge = kept;
      write(join(dir, "questions", file), saved);
      say(
        `${saved.id}: checks ${saved.checks.filter((c) => c.pass).length}/${saved.checks.length}${saved.judge?.mean != null ? `, judge ${saved.judge.mean.toFixed(2)}` : ""}`,
      );
    }
    results.push(saved);
  }
  const order = new Map(suite.questions.map((q, i) => [q.id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  finish(dir, results);
}

const commands = {
  async undefined() {
    await runSuite();
  },
  async run() {
    await runSuite();
  },
  grade: regrade,
  report: regrade,
  async fixtures() {
    loadCredentials();
    say(JSON.stringify(await ensureFixtures()));
  },
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command ${command}. See the top of bench/ask/run.mjs.`);
  process.exit(2);
}
handler().catch((error) => {
  console.error(redact(error?.stack ?? String(error)));
  process.exit(1);
});
