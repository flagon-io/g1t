#!/usr/bin/env node
// Sessions from the user's own harness, end to end: Claude Code, headless,
// with g1t's plugin, works a real issue in the test repository and spawns a
// subagent; then g1t must show it: a session linked to the issue, the
// subagent as a child session with its task and result, the pull request
// linking back, and the Work pages showing all of it.
//
//   node bench/ask/sessions.mjs                     dry run: preflight and the plan; changes nothing
//   node bench/ask/sessions.mjs --live              open (or reuse) the test issue, run Claude Code, verify
//   node bench/ask/sessions.mjs --verify --session ses_… [--issue N] [--pull N]
//                                                   only the checks, on a session that already ran
//
// Options: --repo flagon-io/automation-lab (the test repository; it must be
// one meant for tests), --budget 3 (USD cap for Claude Code), --max-turns 40,
// --installed (use the installed g1t plugin instead of --plugin-dir
// plugins/claude-code), --keep (keep the scratch clone).
//
// Needs: the `claude` CLI; the `g1t` CLI on PATH (or G1T_BIN), which the
// plugin records through; G1T_TOKEN (or its export in ~/.bashrc); the
// judge's key file .secrets/anthropic-key.txt, given to Claude Code as
// ANTHROPIC_API_KEY in its own environment only. Nothing is printed or
// written with a credential in it: the MCP config names ${G1T_TOKEN} and
// git gets its header through GIT_CONFIG_* variables of the child.
//
// Results land in bench/ask/runs/sessions-<timestamp>/ (git-ignored).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { HERE, ROOT, SITE, anthropicKeyValue, api, apiAll, apiTokenValue, loadCredentials, mcp, parseArgs, redact, site, webTokenValue } from "./lib.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const REPO = String(flags.repo ?? "flagon-io/automation-lab");
const LIVE = Boolean(flags.live);
const VERIFY = Boolean(flags.verify);
const say = (line = "") => console.log(redact(line));

/** Issue the scenario works on: small, real, and only in the test repository. */
const TASK = {
  title: "[bench] sessions scenario: add abs() to math.js",
  body: "Add `abs(x)` to math.js: the absolute value of a number, exported like the other functions, with a test next to the others.\n\nThis issue is opened by g1t's sessions bench (bench/ask/sessions.mjs) to check that sessions, subagents and pull requests show on the Work page. Its pull request can be merged or closed.",
};

const prompt = (issue) =>
  [
    `You are working on issue #${issue} in ${REPO} (this checkout).`,
    "First use the Agent tool with the Explore agent to find where the math functions and their tests live and how they are exported; wait for its answer.",
    `Then claim the issue, make the change on a branch named ${issue}-abs, run the tests if there are any, commit, push the branch,`,
    `and open a pull request on g1t (the g1t MCP server's pull_request tool) that closes #${issue}. Keep the change small. Do not merge it.`,
  ].join(" ");

// --- preflight ------------------------------------------------------------------

function which(name) {
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  }
  return null;
}

async function preflight() {
  const creds = loadCredentials();
  const rows = [];
  const add = (name, ok, detail, blocking = true) => rows.push({ name, ok: Boolean(ok), detail, blocking });

  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  add("claude CLI", claude.status === 0, claude.status === 0 ? claude.stdout.trim() : "not on PATH");

  const g1tBin = process.env.G1T_BIN ?? which("g1t");
  add("g1t CLI (the plugin records through it)", g1tBin, g1tBin ?? "not on PATH and no G1T_BIN: install it from g1t.sh/download or `cargo build -p g1t` and set G1T_BIN");

  const pluginDir = join(ROOT, "plugins", "claude-code");
  if (flags.installed) {
    const list = spawnSync("claude", ["plugin", "list"], { encoding: "utf8" });
    add("g1t plugin installed", /\bg1t\b/.test(list.stdout ?? ""), "claude plugin marketplace add https://g1t.sh/flagon-io/g1t-plugins.git && claude plugin install g1t@g1t");
  } else add("g1t plugin (--plugin-dir)", existsSync(join(pluginDir, ".claude-plugin", "plugin.json")), pluginDir);

  const hooks = existsSync(join(pluginDir, "hooks", "hooks.json")) ? JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")) : {};
  const subagentHooks = ["SubagentStart", "SubagentStop"].filter((h) => hooks.hooks?.[h]);
  add("plugin records subagents (SubagentStart/SubagentStop hooks)", subagentHooks.length === 2, subagentHooks.length ? subagentHooks.join(", ") : "the plugin has no subagent hooks yet", false);

  add("G1T_TOKEN", creds.api, creds.api ? "found" : "export G1T_TOKEN or put it in ~/.bashrc");
  add("site token (.credentials/g1t_token.txt)", creds.web, creds.web ? "found" : "missing");
  add("Anthropic key (.secrets/anthropic-key.txt)", creds.anthropic, creds.anthropic ? "found" : "missing");

  const repo = await api(`/repos/${REPO}`);
  const description = repo.data?.description ?? repo.data?.repository?.description ?? "";
  add(`test repository ${REPO}`, repo.status === 200 && /test|scratch|lab/i.test(`${REPO} ${description}`), repo.status === 200 ? `"${description}"` : `API ${repo.status}`);

  // Does the server know child sessions yet? The session tool's schema says.
  const schema = await mcpSchema("session");
  const parentField = schema ? ["parent_id", "parent_session_id", "parent", "agent_id"].find((f) => schema.includes(`"${f}"`)) : null;
  add("server: sessions take a parent (child sessions)", parentField, parentField ? `session tool has ${parentField}` : "the session tool has no parent field yet", false);

  return { rows, ready: rows.filter((r) => r.blocking).every((r) => r.ok), pluginDir, g1tBin };
}

async function mcpSchema(tool) {
  try {
    const response = await fetch("https://mcp.g1t.sh", {
      method: "POST",
      headers: { authorization: `Bearer ${apiTokenValue()}`, "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "g1t-ask-bench/1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const json = await response.json();
    const found = json.result?.tools?.find((t) => t.name === tool);
    return found ? JSON.stringify(found.inputSchema) : null;
  } catch {
    return null;
  }
}

// --- the run ---------------------------------------------------------------------

async function testIssue() {
  const all = await apiAll(`/repos/${REPO}/issues?state=open`, 300);
  const open = all.find((i) => i.title === TASK.title);
  if (open) return open.number;
  if (!LIVE) return null;
  const created = await api(`/repos/${REPO}/issues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(TASK) });
  const number = created.data?.number ?? created.data?.issue?.number;
  if (!number) throw new Error(`could not open the test issue (API ${created.status})`);
  return number;
}

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // The judge's key, for this child only; never the parent's own.
  env.ANTHROPIC_API_KEY = anthropicKeyValue();
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.G1T_TOKEN = apiTokenValue();
  // git's header for g1t.sh, without a credential helper or a file.
  const user = process.env.G1T_USER ?? "syntaqx";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = `http.${SITE}/.extraheader`;
  env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${user}:${webTokenValue()}`).toString("base64")}`;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  return env;
}

function runClaude({ cwd, issue, pluginDir, out }) {
  const mcpConfig = join(out, "mcp.json");
  // The token stays in the environment: Claude Code expands ${G1T_TOKEN}.
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { g1t: { type: "http", url: "https://mcp.g1t.sh", headers: { Authorization: "Bearer ${G1T_TOKEN}" } } } }, null, 2));
  const args = [
    "-p",
    prompt(issue),
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfig,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(git:*) Bash(npm:*) Bash(node:*) Bash(g1t:*) Read Edit Write Glob Grep Agent Task mcp__g1t",
    "--max-budget-usd",
    String(flags.budget ?? 3),
    "--max-turns",
    String(flags["max-turns"] ?? 40),
  ];
  if (!flags.installed) args.push("--plugin-dir", pluginDir);
  return new Promise((done) => {
    const child = spawn("claude", args, { cwd, env: childEnv(), windowsHide: true });
    const events = [];
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => done({ code, events, stderr: redact(stderr).slice(-4000) }));
  });
}

/** What the stream says happened: Claude Code's session id, subagents it ran, the PR it opened. */
function readStream(events) {
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const subagents = [];
  for (const e of events) {
    for (const block of e.message?.content ?? []) {
      if (block.type === "tool_use" && (block.name === "Agent" || block.name === "Task")) {
        subagents.push({ id: block.id, type: block.input?.subagent_type, description: block.input?.description, prompt: String(block.input?.prompt ?? "").slice(0, 400) });
      }
    }
  }
  const result = events.findLast((e) => e.type === "result");
  return { sessionId: init?.session_id ?? result?.session_id ?? null, subagents, result: result ? { subtype: result.subtype, cost_usd: result.total_cost_usd, turns: result.num_turns, text: String(result.result ?? "").slice(0, 2000) } : null };
}

// --- the checks ----------------------------------------------------------------------

async function verify({ sessionId, harnessSessionId, issue, pull, subagents = [] }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  const sessions = await mcp("session", { action: "list", repo: REPO }).catch((e) => ({ error: e.message }));
  const list = Array.isArray(sessions) ? sessions : [];
  const session = list.find((s) => s.id === sessionId) ?? list.find((s) => harnessSessionId && s.harness_session_id === harnessSessionId) ?? null;
  add("a session exists for the run", session, session ? `${session.id} (${session.harness}, ${session.state})` : `none of ${list.length} sessions on ${REPO} is ${sessionId ?? harnessSessionId}`);
  if (!session) return checks;
  issue ??= session.issue;
  add("the session is linked to the issue", issue && session.issue === issue, `session issue ${session.issue ?? "none"}, expected ${issue ?? "?"}`);

  // Children: whatever the server calls the parent link.
  const parentOf = (s) => s.parent_id ?? s.parent_session_id ?? s.parent?.id ?? s.parent ?? null;
  const children = list.filter((s) => parentOf(s) === session.id);
  add("subagents appear as child sessions", children.length > 0, children.length ? `${children.length}: ${children.map((c) => c.id).join(", ")}` : `no session names ${session.id} as its parent${list.some((s) => parentOf(s)) ? "" : " (no session has a parent field at all)"}`);
  if (subagents.length) add("one child per subagent the run spawned", children.length >= subagents.length, `${children.length} children for ${subagents.length} subagents`);
  const detail = await mcp("session", { action: "get", repo: REPO, id: session.id }).catch(() => null);
  for (const child of children) {
    const task = child.title ?? child.task ?? child.description;
    const result = child.result ?? child.summary ?? child.end_reason;
    add(`child ${child.id} has its task and result`, task && result, `task ${task ? `"${String(task).slice(0, 80)}"` : "missing"}; result ${result ? `"${String(result).slice(0, 80)}"` : "missing"}`);
  }
  const entries = detail?.entries ?? [];
  add("the session recorded tool calls", entries.some((e) => e.kind === "tool_call"), `${entries.length} entries`);

  // The pull request, and its link back to the issue and session.
  let pr = pull ?? session.pull ?? null;
  if (!pr && issue) {
    const pulls = await apiAll(`/repos/${REPO}/pulls?state=all`, 100);
    pr = pulls.find((p) => p.issue === issue || new RegExp(`#${issue}\\b`).test(p.body ?? ""))?.number ?? null;
  }
  add("a pull request was opened", pr, pr ? `#${pr}` : "none found for the issue");
  if (pr) {
    const { data } = await api(`/repos/${REPO}/pulls/${pr}`);
    const p = data?.pull ?? data;
    add("the pull request links back to the issue", p?.issue === issue || new RegExp(`#${issue}\\b`).test(p?.body ?? ""), `issue ${p?.issue ?? "none"}`);
    add("the session is attached to the pull request", session.pull === pr, `session pull ${session.pull ?? "none"}`);
  }

  // The Work pages, as the user sees them.
  const page = async (path) => {
    const response = await site(path);
    return { status: response.status, html: response.ok ? await response.text() : "" };
  };
  const work = await page(`/${REPO}/work`);
  add("the Work page shows the session", work.status === 200 && work.html.includes(session.id), `status ${work.status}${work.html.includes(session.id) ? "" : `, no ${session.id} on the page`}`);
  const sessionPage = await page(`/${REPO}/work/sessions/${session.id}`);
  add("the session's page loads", sessionPage.status === 200, `status ${sessionPage.status}`);
  for (const child of children) add(`the session's page shows child ${child.id}`, sessionPage.html.includes(child.id) || (child.title && sessionPage.html.includes(child.title)), "");
  if (issue) {
    const issuePage = await page(`/${REPO}/issues/${issue}`);
    add("the issue's Work panel shows the session", issuePage.status === 200 && issuePage.html.includes(session.id), `status ${issuePage.status}`);
  }
  return checks;
}

// --- main ------------------------------------------------------------------------------

async function main() {
  const out = join(HERE, "runs", `sessions-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const pre = await preflight();
  say(`Sessions scenario on ${REPO} (${VERIFY ? "verify only" : LIVE ? "live" : "dry run"})\n\nPreflight:`);
  for (const r of pre.rows) say(`  ${r.ok ? "ok  " : r.blocking ? "FAIL" : "gap "} ${r.name}: ${r.detail}`);

  if (VERIFY) {
    if (!flags.session) throw new Error("--verify needs --session ses_…");
    const checks = await verify({ sessionId: String(flags.session), issue: flags.issue ? Number(flags.issue) : undefined, pull: flags.pull ? Number(flags.pull) : undefined });
    return report(out, { mode: "verify", preflight: pre.rows, checks });
  }

  const issue = await testIssue();
  say(`\nTest issue: ${issue ? `#${issue}` : `none open yet ("${TASK.title}"); --live opens it`}`);
  say(`Prompt: ${prompt(issue ?? "N")}`);
  if (!LIVE) {
    say("\nDry run: nothing was changed. Run with --live once the preflight passes.");
    return;
  }
  if (!pre.ready) throw new Error("Preflight failed; see above. Nothing was run.");

  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "g1t-sessions-"));
  try {
    const clone = spawnSync("git", ["clone", "-q", `${SITE}/${REPO}.git`, join(scratch, "repo")], { env: childEnv(), encoding: "utf8" });
    if (clone.status !== 0) throw new Error(`clone failed: ${redact(clone.stderr).slice(0, 400)}`);
    say(`Cloned into ${join(scratch, "repo")}; running Claude Code…`);
    const run = await runClaude({ cwd: join(scratch, "repo"), issue, pluginDir: pre.pluginDir, out });
    writeFileSync(join(out, "stream.jsonl"), redact(run.events.map((e) => JSON.stringify(e)).join("\n")));
    const stream = readStream(run.events);
    say(`Claude Code exited ${run.code}: session ${stream.sessionId}, ${stream.subagents.length} subagents, ${stream.result?.turns ?? "?"} turns, $${stream.result?.cost_usd?.toFixed?.(2) ?? "?"}`);
    // The plugin's hooks record in the background: give them a moment.
    await new Promise((done) => setTimeout(done, 8000));
    const sessions = await mcp("session", { action: "list", repo: REPO }).catch(() => []);
    const mine = (Array.isArray(sessions) ? sessions : []).find((s) => s.harness_session_id === stream.sessionId);
    const checks = await verify({ sessionId: mine?.id, harnessSessionId: stream.sessionId, issue, subagents: stream.subagents });
    report(out, { mode: "live", preflight: pre.rows, issue, stream, exit: run.code, stderr: run.stderr, checks });
  } finally {
    if (!flags.keep) rmSync(scratch, { recursive: true, force: true });
  }
}

function report(out, result) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "result.json"), redact(JSON.stringify(result, null, 2)));
  const passed = result.checks.filter((c) => c.pass).length;
  say(`\nChecks ${passed}/${result.checks.length}:`);
  for (const c of result.checks) say(`  ${c.pass ? "ok  " : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  say(`\nSaved ${join(out, "result.json")}`);
  process.exitCode = passed === result.checks.length ? 0 : 1;
}

main().catch((error) => {
  console.error(redact(error?.stack ?? String(error)));
  process.exit(1);
});
