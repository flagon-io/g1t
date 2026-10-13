#!/usr/bin/env node
// g1t's Claude Code hooks. Claude Code runs this file for SessionStart,
// UserPromptSubmit, PreToolUse, PostToolUse, SubagentStart, SubagentStop,
// Stop and SessionEnd, with the event as JSON on stdin. In a working copy of
// a g1t repository it records the session on g1t through the `g1t` CLI:
//
//   SessionStart      g1t session start --harness claude_code --harness-session-id ID
//                     and, when the branch, G1T_ISSUE or the session names an
//                     issue, g1t work context N, given to Claude as context
//   UserPromptSubmit  g1t session log --kind prompt TEXT     (first 2,000 characters)
//   PreToolUse        Agent: the task it is given, kept until its subagent starts.
//                     Inside a subagent, its own g1t session for the g1t
//                     commands and g1t MCP claims it makes.
//   PostToolUse       g1t session log --kind tool_call "Tool: what it was called with"
//                     (a Skill: g1t session log --kind skill NAME), and
//                     g1t session touch for the files it wrote, the commits
//                     it made, the branches it pushed and the issues it claimed;
//                     after a git push that reached the remote,
//                     g1t api update_session -f id=SESSION -f head_commit=SHA;
//                     after an Agent call, its subagent's task and, once it
//                     finished, its final message
//   SubagentStart     g1t session start --parent SESSION --agent-type TYPE …:
//                     each subagent is a session of its own, under this one
//   SubagentStop      g1t session end --result "its final message" for it
//   Stop              g1t session heartbeat
//   SessionEnd        g1t session end --reason REASON
//
// What a tool returned (tool_response) is never sent, with one exception
// that is not a tool's output: an Agent call's answer, which is its
// subagent's final message (as SubagentStop gives it) and its id. Prompts
// are not sent when G1T_RECORD_PROMPTS=0, and nothing is when G1T_RECORD=0.
//
// Every hook returns at once: the CLI calls run in a detached process of
// their own, so a slow network never holds Claude up. If `g1t` is not
// installed or not signed in, nothing is recorded and Claude Code says so
// once. Nothing is ever installed. No dependencies; Node 18 or later.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The most of a prompt that is sent. */
export const PROMPT_LIMIT = 2000;
/** The most of a tool call's summary that is sent. */
export const SUMMARY_LIMIT = 200;
/** The most of an issue's work context given to Claude. */
export const CONTEXT_LIMIT = 8000;
/** The most of a subagent's task (its description) that is sent. */
export const TASK_LIMIT = 200;
/** The most of a subagent's prompt that is sent. */
export const AGENT_PROMPT_LIMIT = 4000;
/** The most of a subagent's final message that is sent. */
export const RESULT_LIMIT = 8000;
/** How long SessionStart waits for an issue's work context. */
const CONTEXT_WAIT_MS = 900;
/** Exit code the g1t CLI gives when signing in is needed. */
const EXIT_AUTH = 4;
/** The tool that starts subagents (Task before Claude Code renamed it). */
const AGENT_TOOLS = new Set(["Agent", "Task"]);
/** Tools that write a file, and where they say which. */
const WRITERS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const SELF = fileURLToPath(import.meta.url);

// --- what to send ------------------------------------------------------

export function clip(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** Hides what looks like a secret in a command line before it is sent. */
export function redact(text) {
  return String(text)
    .replace(/\b(g1t|ghp|gho|ghs|github_pat|glpat|xox[abpr]|sk-ant|sk|rk)[-_][A-Za-z0-9_-]{8,}/g, "$1_…")
    .replace(/(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi, "$1…")
    .replace(/(\b[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Za-z_]*=)("[^"]*"|'[^']*'|\S+)/gi, "$1…")
    .replace(/(--(?:token|password|secret)[= ])\S+/gi, "$1…")
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1…@");
}

/** A path as the repository names it: relative to its root, with forward slashes; null outside it. */
export function repoPath(path, cwd) {
  if (typeof path !== "string" || !path) return null;
  if (!isAbsolute(path)) return path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!cwd) return null;
  const rel = relative(cwd, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.replaceAll("\\", "/");
}

/** One line on what a tool was called with: never what it returned. */
export function summarizeTool(name, input, cwd) {
  const i = input && typeof input === "object" ? input : {};
  const path = (p) => {
    if (typeof p !== "string") return "";
    return repoPath(p, cwd) ?? p;
  };
  let what = "";
  if (typeof i.command === "string") what = i.command.split("\n")[0] + (i.command.includes("\n") ? " …" : "");
  else if (i.file_path || i.notebook_path) what = path(i.file_path ?? i.notebook_path);
  else if (typeof i.pattern === "string") what = `${i.pattern}${i.path ? ` in ${path(i.path)}` : ""}`;
  else if (typeof i.url === "string") what = i.url;
  else if (typeof i.query === "string") what = i.query;
  else if (typeof i.description === "string") what = i.description;
  else if (typeof i.action === "string") what = i.action;
  const line = what ? `${name}: ${redact(what)}` : String(name);
  return clip(line, SUMMARY_LIMIT);
}

/** The issue a branch is for, when its name holds the number: 42-fix, issue-42, fix/42, g1t/42-x. */
export function issueFromBranch(branch) {
  if (!branch || branch === "HEAD") return null;
  if (/^(release|releases|hotfix|v\d)/i.test(branch)) return null;
  const match = /(?:^|[/_-])(?:issues?-?|#)?(\d{1,7})(?=$|[/_-])/i.exec(branch);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 ? n : null;
}

/** The issue a shell command claims or attaches the session to, if any. */
export function issueFromCommand(command) {
  if (typeof command !== "string") return null;
  const patterns = [
    /\bg1t\s+work\s+claim\s+#?(\d+)/,
    /\bg1t\s+session\s+(?:start|attach)\b[^|;&\n]*--issue[= ]#?(\d+)/,
    /\bg1t\s+pr\s+create\b[^|;&\n]*--issue[= ]#?(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(command);
    if (match) return Number(match[1]);
  }
  return null;
}

export const isGitPush = (command) =>
  typeof command === "string" && /(^|[\s;&|(])git(\s+-\S+(\s+[^-\s]\S*)?)*\s+push\b/.test(command);

export const isGitCommit = (command) =>
  typeof command === "string" && /(^|[\s;&|(])git(\s+-\S+(\s+[^-\s]\S*)?)*\s+commit\b/.test(command);

/** The branch a command makes: git checkout -b X, git switch -c X, git branch X. */
export function branchFromCommand(command) {
  if (typeof command !== "string") return null;
  const match =
    /\bgit\s+(?:checkout\s+-[bB]|switch\s+-[cC]|switch\s+--create)\s+([^\s;&|]+)/.exec(command) ??
    /\bgit\s+branch\s+(?!-)([^\s;&|]+)/.exec(command);
  return match ? match[1] : null;
}

/** A subagent's harness id: the parent's, `/agent/`, and its id without Claude Code's `agent-` prefix. */
export function subagentHarnessId(parent, agentId) {
  return `${String(parent).trim()}/agent/${String(agentId).trim().replace(/^agent-/, "")}`;
}

/** The text of an Agent call's answer: its subagent's final message. */
export function agentResult(response) {
  const content = response?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** The g1t MCP tool a call is to, by name: `issue` for mcp__plugin_g1t_g1t__issue or mcp__g1t__issue. */
export function g1tTool(name) {
  const match = /^mcp__(?:plugin_g1t_)?g1t__([a-z_]+)$/.exec(String(name ?? ""));
  return match ? match[1] : null;
}

/**
 * What a hook event asks for: the CLI calls to run in the background
 * (`steps`), whether to start the session first, and for a subagent's
 * events, which subagent (`agent`). Pure, so the tests can check it
 * without a CLI.
 */
export function plan(event, env = process.env) {
  const name = event?.hook_event_name;
  const sid = event?.session_id;
  if (!name || !sid || env.G1T_RECORD === "0") return null;
  const cwd = event.cwd || process.cwd();
  const job = { cwd, sid, steps: [] };
  // Inside a subagent, what it does is its own session's.
  if (event.agent_id) job.agent = { id: String(event.agent_id), type: event.agent_type || null };
  switch (name) {
    case "SessionStart": {
      job.start = true;
      const issue = Number(env.G1T_ISSUE);
      if (issue > 0) job.issue = issue;
      return job;
    }
    case "UserPromptSubmit":
      if (env.G1T_RECORD_PROMPTS === "0" || typeof event.prompt !== "string" || !event.prompt.trim()) return null;
      job.steps.push({ args: ["session", "log", "--kind", "prompt", "--", clip(event.prompt, PROMPT_LIMIT)] });
      return job;
    case "SubagentStart":
      if (!job.agent) return null;
      job.agent.start = true;
      return job;
    case "SubagentStop": {
      if (!job.agent) return null;
      const args = ["session", "end", "--reason", "done"];
      const result = typeof event.last_assistant_message === "string" ? event.last_assistant_message.trim() : "";
      if (result) args.push("--result", clip(result, RESULT_LIMIT));
      job.steps.push({ args });
      return job;
    }
    case "PostToolUse": {
      if (!event.tool_name) return null;
      const tool = event.tool_name;
      const input = event.tool_input ?? {};
      if (tool === "Skill") {
        const skill = typeof input.skill === "string" ? input.skill.trim() : "";
        if (!skill) return null;
        // Its name, nothing more.
        job.steps.push({ args: ["session", "log", "--kind", "skill", "--", clip(skill, 100)] });
        return job;
      }
      job.steps.push({ args: ["session", "log", "--kind", "tool_call", "--", summarizeTool(tool, input, cwd)] });
      const touch = [];
      if (WRITERS.has(tool)) {
        const file = repoPath(input.file_path ?? input.notebook_path, cwd);
        if (file) touch.push("--file", file);
      }
      if (AGENT_TOOLS.has(tool) && !job.agent) {
        const response = event.tool_response ?? {};
        const agentId = response.agentId ?? response.agent_id;
        if (agentId) {
          job.subagent = {
            id: String(agentId),
            type: input.subagent_type || null,
            task: input.description ? clip(input.description, TASK_LIMIT) : null,
            prompt: env.G1T_RECORD_PROMPTS === "0" || !input.prompt ? null : clip(input.prompt, AGENT_PROMPT_LIMIT),
            model: response.resolvedModel || null,
            result: response.status === "completed" ? clip(agentResult(response), RESULT_LIMIT) || null : null,
          };
        }
      }
      if (tool === "Bash") {
        const issue = issueFromCommand(input.command);
        if (issue) {
          job.issue = issue;
          touch.push("--issue", String(issue));
        }
        const branch = branchFromCommand(input.command);
        if (branch) touch.push("--branch", branch);
        if (isGitCommit(input.command)) job.steps.push({ touchHead: true });
        if (isGitPush(input.command)) job.steps.push({ headCommit: true });
      }
      const claimed = g1tTool(tool) === "issue" && input.action === "claim" && Number(input.number) > 0 ? Number(input.number) : null;
      if (claimed) {
        job.issue = claimed;
        touch.push("--issue", String(claimed));
      }
      if (touch.length) job.steps.push({ args: ["session", "touch", ...touch] });
      return job;
    }
    case "Stop":
      job.steps.push({ args: ["session", "heartbeat"] });
      return job;
    case "SessionEnd":
      job.steps.push({ args: ["session", "end", "--reason", String(event.reason || "other")] });
      job.end = true;
      return job;
    default:
      return null;
  }
}

// --- the machine -------------------------------------------------------

function git(cwd, args) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 3000 });
  return out.status === 0 ? out.stdout.trim() : null;
}

/** The g1t CLI on PATH, without running it. G1T_BIN names another. */
export function findCli(env = process.env) {
  if (env.G1T_BIN) return existsSync(env.G1T_BIN) ? env.G1T_BIN : null;
  const names = process.platform === "win32" ? ["g1t.exe", "g1t"] : ["g1t"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir.replace(/^"|"$/g, ""), name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

/** Runs the CLI. A .js or .mjs G1T_BIN (the tests' stand-in) runs under Node. */
function cli(bin, args, options) {
  const script = /\.m?js$/.test(bin);
  return spawnSync(script ? process.execPath : bin, script ? [bin, ...args] : args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

/** Where the plugin keeps its state: Claude Code's data folder for it. */
export function dataDir(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA || join(homedir(), ".g1t", "claude-code");
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function write(path, text) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  } catch {}
}

const readText = (path) => {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
};

const safeName = (text) => String(text).replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * This session's files: its marker (it is in a g1t working copy), its g1t
 * session id, its issue, the Agent calls waiting for their subagents, and
 * each subagent's g1t session id.
 */
export function sessionFiles(sid, env = process.env) {
  const dir = join(dataDir(env), "sessions");
  const safe = safeName(sid);
  return {
    dir,
    prefix: `${safe}.`,
    marker: join(dir, `${safe}.json`),
    id: join(dir, `${safe}.id`),
    issue: join(dir, `${safe}.issue`),
    pending: join(dir, `${safe}.pending.json`),
    agent: (agentId) => join(dir, `${safe}.agent.${safeName(String(agentId).replace(/^agent-/, ""))}.id`),
  };
}

/** Forgets sessions untouched for a week (ones that never saw SessionEnd). */
function prune(dir) {
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    }
  } catch {}
}

// --- Agent calls and their subagents -----------------------------------

/** Keeps an Agent call's task until its subagent starts (PreToolUse). */
export function rememberTask(files, input) {
  const pending = readJson(files.pending, []);
  pending.push({
    type: input?.subagent_type || null,
    task: input?.description ? clip(input.description, TASK_LIMIT) : null,
    prompt: input?.prompt ? clip(input.prompt, AGENT_PROMPT_LIMIT) : null,
    at: Date.now(),
  });
  // An Agent call refused or never started is forgotten after an hour.
  write(files.pending, JSON.stringify(pending.filter((p) => Date.now() - p.at < 3600 * 1000).slice(-50)));
}

/** The task of the oldest Agent call of `type` still waiting for its subagent, taken. */
export function takeTask(files, type) {
  const pending = readJson(files.pending, []);
  const at = pending.findIndex((p) => !type || !p.type || p.type === type);
  if (at < 0) return null;
  const [task] = pending.splice(at, 1);
  write(files.pending, JSON.stringify(pending));
  return task;
}

// --- saying so once ----------------------------------------------------

const MESSAGES = {
  missing:
    "g1t: this session is not being recorded on g1t, because the g1t CLI is not installed. Install it (https://docs.g1t.sh/guides/cli/) and run `g1t auth login`. This is said once.",
  signed_out:
    "g1t: this session is not being recorded on g1t, because the g1t CLI is not signed in. Run `g1t auth login`. This is said once.",
};

/** Remembers a problem (missing, signed_out), or that there is none (null). */
export function setProblem(env, problem) {
  const path = join(dataDir(env), "notice.json");
  const notice = readJson(path, {});
  if ((notice.problem ?? null) === problem) return;
  write(path, JSON.stringify({ problem, shown: false }));
}

/** The message for a problem not shown yet, marking it shown. */
export function takeNotice(env) {
  const path = join(dataDir(env), "notice.json");
  const notice = readJson(path, {});
  if (!notice.problem || notice.shown || !MESSAGES[notice.problem]) return null;
  write(path, JSON.stringify({ ...notice, shown: true }));
  return MESSAGES[notice.problem];
}

/** Whether a working copy's remotes are on g1t (g1t.sh, or G1T_HOST's host). */
export function isG1tRemote(urls, env = process.env) {
  if (env.G1T_REPO) return true;
  const hosts = ["g1t.sh", env.G1T_HOST].filter(Boolean).map((h) => h.toLowerCase());
  return urls.some((url) => hosts.some((host) => url.toLowerCase().includes(host)));
}

// --- the background half -----------------------------------------------

/** Hands a job to a detached copy of this script and returns at once. */
function background(job, env = process.env) {
  const payload = Buffer.from(JSON.stringify(job)).toString("base64url");
  try {
    const child = spawn(process.execPath, [SELF, "--worker", payload], {
      cwd: job.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/** The session id in a `g1t session start --json` answer. */
function startedId(out) {
  try {
    return JSON.parse(out.stdout).id ?? null;
  } catch {
    return /\bses_[A-Za-z0-9]+/.exec(out.stdout ?? "")?.[0] ?? null;
  }
}

/**
 * Starts a subagent's session under `parentId` (again, when it was: the
 * same session comes back, taking what is newly said), and keeps its id.
 */
function startSubagent(bin, job, files, agent, parentId, opts) {
  const args = [
    "session",
    "start",
    "--harness",
    "claude_code",
    "--harness-session-id",
    subagentHarnessId(job.sid, agent.id),
    "--parent",
    parentId,
    "--no-remember",
  ];
  if (agent.type) args.push("--agent-type", String(agent.type));
  if (agent.task) args.push("--task", agent.task);
  if (agent.prompt) args.push("--prompt", agent.prompt);
  if (agent.model) args.push("--model", String(agent.model));
  args.push("--json");
  const out = cli(bin, args, { ...opts, env: { ...opts.env, G1T_SESSION: parentId } });
  if (out.status === EXIT_AUTH) return { auth: true };
  const id = out.status === 0 ? startedId(out) : null;
  if (id) write(files.agent(agent.id), id);
  return { id };
}

/** Starts the session if it needs to, then runs the job's steps in order. */
export function work(job, env = process.env) {
  const bin = findCli(env);
  if (!bin) return setProblem(env, "missing");
  const files = sessionFiles(job.sid, env);
  if (job.issue && !job.agent) write(files.issue, String(job.issue));
  const opts = { cwd: job.cwd, timeout: 20000, env: { ...env } };
  let id = readText(files.id);
  if (job.start || !id) {
    const issue = job.issue ?? readText(files.issue);
    const args = ["session", "start", "--harness", "claude_code", "--harness-session-id", job.sid];
    if (issue) args.push("--issue", String(issue));
    args.push("--json");
    const out = cli(bin, args, opts);
    if (out.status === EXIT_AUTH) return setProblem(env, "signed_out");
    if (out.status !== 0) return;
    setProblem(env, null);
    id = startedId(out);
    if (!id) return;
    write(files.id, id);
  }
  // A subagent's events go to its own session, started first if need be.
  let session = id;
  if (job.agent) {
    let child = readText(files.agent(job.agent.id));
    if (job.agent.start || !child) {
      const started = startSubagent(bin, job, files, job.agent, id, opts);
      if (started.auth) return setProblem(env, "signed_out");
      child = started.id ?? child;
    }
    if (!child) return;
    session = child;
  }
  opts.env.G1T_SESSION = session;
  for (const step of job.steps) {
    if (step.args) {
      const out = cli(bin, step.args, opts);
      if (out.status === EXIT_AUTH) return setProblem(env, "signed_out");
    } else if (step.headCommit) {
      // Only once the push reached the remote: HEAD is on a remote branch.
      const head = git(job.cwd, ["rev-parse", "HEAD"]);
      const remote = git(job.cwd, ["branch", "-r", "--contains", "HEAD"]);
      if (head && remote) {
        cli(bin, ["api", "update_session", "-f", `id=${session}`, "-f", `head_commit=${head}`, "--silent"], opts);
        const branch = git(job.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
        const touch = ["session", "touch", "--commit", head];
        if (branch && branch !== "HEAD") touch.push("--branch", branch);
        cli(bin, touch, opts);
      }
    } else if (step.touchHead) {
      const head = git(job.cwd, ["rev-parse", "HEAD"]);
      if (head) cli(bin, ["session", "touch", "--commit", head], opts);
    }
  }
  // An Agent call answered: its subagent has its task, and once it
  // finished, what it reported.
  if (job.subagent) {
    const started = startSubagent(bin, job, files, job.subagent, id, opts);
    if (started.id && job.subagent.result) {
      cli(bin, ["session", "end", "--reason", "done", "--result", job.subagent.result], { ...opts, env: { ...opts.env, G1T_SESSION: started.id } });
    }
  }
  if (job.end) {
    try {
      for (const name of readdirSync(files.dir)) if (name.startsWith(files.prefix)) rmSync(join(files.dir, name), { force: true });
    } catch {}
  }
}

// --- the hooks ---------------------------------------------------------

/** What every session is told about trailers, so commits find their way back. */
const TRAILER = "Add the trailer `G1t-Session: $G1T_SESSION` to the commits you make (git commit --trailer), so g1t ties them to this session.";

/**
 * SessionStart: marks the session as one in a g1t working copy, and
 * returns what to print: context for Claude, and a notice for you, once.
 * Null outside a g1t working copy, where nothing is recorded.
 */
export function sessionStart(event, env = process.env, bin = findCli(env)) {
  const cwd = event.cwd || process.cwd();
  const gitDir = git(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return null;
  // The branch, from HEAD itself: also on a branch with no commits yet.
  const branch = /^ref: refs\/heads\/(.+)$/m.exec(readText(join(gitDir, "HEAD")) ?? "")?.[1] ?? null;
  const urls = (git(cwd, ["config", "--get-regexp", "^remote\\..*\\.url$"]) ?? "").split(/\r?\n/);
  if (!isG1tRemote(urls, env)) return null;

  const files = sessionFiles(event.session_id, env);
  prune(files.dir);
  write(files.marker, JSON.stringify({ cwd, git_dir: gitDir }));

  const output = {};
  if (!bin) setProblem(env, "missing");
  const notice = takeNotice(env);
  if (notice) output.systemMessage = notice;
  if (!bin) return output;

  if (env.CLAUDE_ENV_FILE) {
    // Claude's own `g1t` commands then act in this session, not in another
    // one in the same working copy. Read as each command runs, since the
    // session's id arrives after this hook has returned.
    const p = files.id.replaceAll("\\", "/");
    try {
      writeFileSync(env.CLAUDE_ENV_FILE, `[ -f "${p}" ] && export G1T_SESSION="$(cat "${p}")"\n`, { flag: "a" });
    } catch {}
  }

  const remembered = Number(readText(files.issue)) || null;
  const handedOff = Number(env.G1T_ISSUE) || null;
  const issue = remembered ?? handedOff ?? issueFromBranch(branch);
  let context;
  if (issue) {
    const where = remembered ? "this session's claim" : handedOff ? "the work handed to it" : `the branch ${branch}`;
    const out = cli(bin, ["work", "context", String(issue)], { cwd, timeout: CONTEXT_WAIT_MS, env });
    if (out.status === 0 && out.stdout.trim()) {
      context = `g1t: this session is working on issue #${issue} (from ${where}). Its work context on g1t:\n\n${clip(out.stdout.trim(), CONTEXT_LIMIT)}\n\nIf it is not claimed by this session yet, claim it with \`g1t work claim ${issue}\` before you start. ${TRAILER}`;
    } else if (out.status === EXIT_AUTH) {
      setProblem(env, "signed_out");
      const now = takeNotice(env);
      if (now) output.systemMessage = now;
    } else {
      context = `g1t: ${where} points at issue #${issue}. Load what is known about it with \`g1t work context ${issue}\`, and claim it with \`g1t work claim ${issue}\` before you start. ${TRAILER}`;
    }
  } else {
    context = `g1t: this is a g1t repository. Before starting on an issue, load it with \`g1t work context N\` and claim it with \`g1t work claim N\`, so the people and agents also working here know. ${TRAILER}`;
  }
  if (context) output.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: context };
  return output;
}

/** What a subagent is told as it starts: it is a session of its own, beside its siblings. */
export function subagentContext(issue) {
  const on = issue ? ` on issue #${issue}` : "";
  const see = issue
    ? `Before you change anything, run \`g1t work context ${issue}\` and \`g1t session list --issue ${issue} --subagents\`: other subagents of the same session may be on it, and you see what each touches.`
    : "Before you change anything, run `g1t session list --subagents` to see the other subagents at work here.";
  return `g1t: you are a subagent of a session recorded on g1t${on}, and g1t records you as a session of your own under it: the g1t commands and g1t tools you use act as that session. ${see} Claim only the issue you take on (\`g1t work claim N --note "what you are doing"\`), and if g1t reports an overlap with another session, settle it before going on. ${TRAILER}`;
}

/**
 * PreToolUse: an Agent call's task is kept for its subagent; inside a
 * subagent, its g1t commands and g1t claims act as its own session.
 * Returns what to print, or null.
 */
export function preToolUse(event, env = process.env) {
  const files = sessionFiles(event.session_id, env);
  const tool = event.tool_name;
  const input = event.tool_input ?? {};
  if (AGENT_TOOLS.has(tool) && !event.agent_id) {
    rememberTask(files, input);
    return null;
  }
  const session = event.agent_id ? readText(files.agent(event.agent_id)) : readText(files.id);
  if (!session) return null;
  let updated = null;
  const command = typeof input.command === "string" ? input.command : "";
  const namesG1t = /\bg1t\s/.test(command) || /\$\{?G1T_SESSION\b/.test(command);
  if (tool === "Bash" && event.agent_id && namesG1t && !command.includes("G1T_SESSION=")) {
    updated = { ...input, command: `export G1T_SESSION=${session}; ${input.command}` };
  }
  const g1t = g1tTool(tool);
  if (g1t === "issue" && ["claim", "release", "handoff"].includes(input.action) && !input.session_id) {
    updated = { ...input, session_id: session };
  }
  return updated ? { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: updated } } : null;
}

/** Runs one hook: what it prints, and the job it hands to the background. */
export function hook(event, env = process.env) {
  if (env.G1T_RECORD === "0") return { output: null, job: null };
  const name = event?.hook_event_name;
  if (name === "PreToolUse") {
    if (!event.session_id || !existsSync(sessionFiles(event.session_id, env).marker)) return { output: null, job: null };
    return { output: preToolUse(event, env), job: null };
  }
  const job = plan(event, env);
  if (!job) return { output: null, job: null };
  if (name === "SessionStart") {
    const bin = findCli(env);
    const output = sessionStart(event, env, bin);
    if (!output) return { output: null, job: null };
    return { output: Object.keys(output).length ? output : null, job: bin ? job : null };
  }
  // Only sessions SessionStart found in a g1t working copy are recorded.
  const files = sessionFiles(event.session_id, env);
  if (!existsSync(files.marker) || !findCli(env)) return { output: null, job: null };
  if (name === "SubagentStart") {
    const task = takeTask(files, job.agent.type);
    if (task) Object.assign(job.agent, { task: task.task, prompt: env.G1T_RECORD_PROMPTS === "0" ? null : task.prompt });
    const issue = Number(readText(files.issue)) || null;
    return { output: { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: subagentContext(issue) } }, job };
  }
  const notice = name === "UserPromptSubmit" ? takeNotice(env) : null;
  return { output: notice ? { systemMessage: notice } : null, job };
}

async function main() {
  if (process.argv[2] === "--worker") {
    work(JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8")));
    return;
  }
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const { output, job } = hook(JSON.parse(raw || "{}"));
  if (output) process.stdout.write(JSON.stringify(output));
  if (job) background(job);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
