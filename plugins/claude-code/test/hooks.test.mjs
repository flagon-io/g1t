// Tests for the plugin's hooks: node --test plugins/claude-code/test/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PROMPT_LIMIT,
  hook,
  isG1tRemote,
  isGitPush,
  issueFromBranch,
  issueFromCommand,
  plan,
  redact,
  sessionFiles,
  summarizeTool,
  work,
} from "../hooks/g1t.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "..", "hooks", "g1t.mjs");
const FAKE = join(HERE, "fake-g1t.mjs");

const base = { session_id: "abc-123", cwd: "/work/repo", transcript_path: "/t.jsonl", permission_mode: "default" };

describe("plan", () => {
  test("SessionStart starts the session", () => {
    const job = plan({ ...base, hook_event_name: "SessionStart", source: "startup" }, {});
    assert.equal(job.start, true);
    assert.deepEqual(job.steps, []);
  });

  test("UserPromptSubmit logs the prompt, cut to the limit", () => {
    const prompt = "x".repeat(PROMPT_LIMIT + 500);
    const job = plan({ ...base, hook_event_name: "UserPromptSubmit", prompt }, {});
    const args = job.steps[0].args;
    assert.deepEqual(args.slice(0, 5), ["session", "log", "--kind", "prompt", "--"]);
    assert.equal(args[5].length, PROMPT_LIMIT);
    assert.ok(args[5].endsWith("…"));
  });

  test("G1T_RECORD_PROMPTS=0 keeps prompts back, and G1T_RECORD=0 everything", () => {
    assert.equal(plan({ ...base, hook_event_name: "UserPromptSubmit", prompt: "hi" }, { G1T_RECORD_PROMPTS: "0" }), null);
    assert.ok(plan({ ...base, hook_event_name: "Stop" }, { G1T_RECORD_PROMPTS: "0" }));
    for (const hook_event_name of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) {
      assert.equal(plan({ ...base, hook_event_name, prompt: "hi", tool_name: "Bash" }, { G1T_RECORD: "0" }), null);
    }
  });

  test("PostToolUse sends the tool and its input's summary, never its response", () => {
    const event = {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test", description: "Run the tests" },
      tool_response: { stdout: "SECRET OUTPUT 1234", stderr: "", interrupted: false },
      tool_use_id: "toolu_1",
    };
    const job = plan(event, {});
    assert.deepEqual(job.steps, [{ args: ["session", "log", "--kind", "tool_call", "--", "Bash: npm test"] }]);
    assert.ok(!JSON.stringify(job).includes("SECRET OUTPUT"));
  });

  test("PostToolUse after a git push updates the head commit", () => {
    const job = plan({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push -u origin 42-fix" } }, {});
    assert.deepEqual(job.steps[1], { headCommit: true });
    const other = plan({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git status" } }, {});
    assert.equal(other.steps.length, 1);
  });

  test("PostToolUse remembers the issue a command claims", () => {
    const job = plan({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "g1t work claim 42 --note x" } }, {});
    assert.equal(job.issue, 42);
  });

  test("Stop sends a heartbeat and SessionEnd ends the session with its reason", () => {
    assert.deepEqual(plan({ ...base, hook_event_name: "Stop", stop_hook_active: false }, {}).steps, [{ args: ["session", "heartbeat"] }]);
    const end = plan({ ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" }, {});
    assert.deepEqual(end.steps, [{ args: ["session", "end", "--reason", "prompt_input_exit"] }]);
    assert.equal(end.end, true);
  });

  test("events without a session, and other events, do nothing", () => {
    assert.equal(plan({ hook_event_name: "Stop" }, {}), null);
    assert.equal(plan({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash" }, {}), null);
  });
});

describe("summaries", () => {
  test("say what a tool was called with, in one short line", () => {
    assert.equal(summarizeTool("Edit", { file_path: "/work/repo/src/a.ts", old_string: "x", new_string: "y" }, "/work/repo"), "Edit: src/a.ts");
    assert.equal(summarizeTool("Grep", { pattern: "TODO", path: "src" }, "/w"), "Grep: TODO in src");
    assert.equal(summarizeTool("WebFetch", { url: "https://example.com", prompt: "p" }), "WebFetch: https://example.com");
    assert.equal(summarizeTool("Bash", { command: "echo one\necho two" }), "Bash: echo one …");
    assert.equal(summarizeTool("mcp__g1t__issue", { action: "get", number: 4 }), "mcp__g1t__issue: get");
    assert.ok(summarizeTool("Bash", { command: "y".repeat(1000) }).length <= 200);
  });

  test("hide what looks like a secret", () => {
    const line = redact('curl -H "Authorization: Bearer g1t_abcdefghijklmnop" https://u:pw@x.com GITHUB_TOKEN=ghp_123456789012 --token abc');
    assert.ok(!line.includes("abcdefghijklmnop"));
    assert.ok(!line.includes("ghp_123456789012"));
    assert.ok(!line.includes("u:pw@"));
    assert.ok(!line.includes("--token abc"));
  });

  test("find the issue in a branch name", () => {
    assert.equal(issueFromBranch("42-fix-login"), 42);
    assert.equal(issueFromBranch("issue-7"), 7);
    assert.equal(issueFromBranch("fix/123-thing"), 123);
    assert.equal(issueFromBranch("main"), null);
    assert.equal(issueFromBranch("release/1.2"), null);
    assert.equal(issueFromBranch("HEAD"), null);
    assert.equal(issueFromCommand("g1t session attach --issue 9"), 9);
    assert.equal(issueFromCommand("g1t pr create --issue=12 --draft"), 12);
    assert.equal(isGitPush("cd x && git -C repo push"), true);
    assert.equal(isGitPush("git pushd"), false);
    assert.equal(isG1tRemote(["remote.origin.url https://g1t.sh/a/b.git"], {}), true);
    assert.equal(isG1tRemote(["remote.origin.url https://example.com/a/b.git"], {}), false);
    assert.equal(isG1tRemote(["remote.origin.url https://git.acme.dev/a/b.git"], { G1T_HOST: "git.acme.dev" }), true);
  });
});

describe("the plugin's files", () => {
  const root = join(HERE, "..", "..", "..");
  test("parse as JSON", () => {
    for (const file of [".claude-plugin/marketplace.json", "plugins/claude-code/.claude-plugin/plugin.json", "plugins/claude-code/.mcp.json", "plugins/claude-code/hooks/hooks.json"]) {
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, file), "utf8")), file);
    }
  });

  test("the AGENTS.md snippet is the one in the docs", () => {
    const snippet = readFileSync(join(root, "plugins/other-harnesses/AGENTS.snippet.md"), "utf8").replaceAll("\r\n", "\n");
    const guide = readFileSync(join(root, "apps/docs/src/content/docs/guides/claude-code-plugin.md"), "utf8").replaceAll("\r\n", "\n");
    const block = /```md title="AGENTS.md"\n([\s\S]*?)```/.exec(guide)?.[1];
    assert.equal(block, snippet);
  });
});

describe("with a working copy", () => {
  let dir, env, log;

  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "g1t-hook-"));
    log = join(dir, "calls.jsonl");
    git("init", "-q", "-b", "42-fix-login");
    git("remote", "add", "origin", "https://g1t.sh/acme/app.git");
    env = { PATH: process.env.PATH, G1T_BIN: FAKE, FAKE_G1T_LOG: log, CLAUDE_PLUGIN_DATA: join(dir, ".data") };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  test("SessionStart gives Claude the branch's issue's work context", () => {
    const { output, job } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart", source: "startup" }, env);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(context, /issue #42/);
    assert.match(context, /Definition of done: it works/);
    assert.deepEqual(calls()[0].args, ["work", "context", "42"]);
    assert.equal(job.start, true);
  });

  test("the background half starts the session once, then logs into it", () => {
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    const { job } = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "fix the login" }, env);
    // No SessionStart marked this session as one in a g1t working copy.
    assert.equal(job, null);
    work(plan({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "fix the login" }, env), env);
    const [start, logged] = calls();
    assert.deepEqual(start.args, ["session", "start", "--harness", "claude_code", "--harness-session-id", "abc-123", "--json"]);
    assert.deepEqual(logged, { args: ["session", "log", "--kind", "prompt", "--", "fix the login"], session: "ses_fake01" });
    assert.equal(readFileSync(sessionFiles(base.session_id, env).id, "utf8"), "ses_fake01");
  });

  test("hooks after SessionStart record; SessionEnd forgets the session", () => {
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart", source: "startup" }, env);
    const files = sessionFiles(base.session_id, env);
    assert.ok(existsSync(files.marker));
    const { job } = hook({ ...base, cwd: dir, hook_event_name: "Stop" }, env);
    work(job, env);
    work(plan({ ...base, cwd: dir, hook_event_name: "SessionEnd", reason: "clear" }, env), env);
    const args = calls().map((c) => c.args.join(" "));
    assert.ok(args.includes("session heartbeat"));
    assert.ok(args.includes("session end --reason clear"));
    assert.ok(!existsSync(files.marker) && !existsSync(files.id));
  });

  test("a push that reached the remote updates the head commit", () => {
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git("update-ref", "refs/remotes/origin/42-fix-login", "HEAD");
    const head = git("rev-parse", "HEAD").stdout.trim();
    work(plan({ ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push" } }, env), env);
    const update = calls().find((c) => c.args[0] === "api");
    assert.deepEqual(update.args, ["api", "update_session", "-f", "id=ses_fake01", "-f", `head_commit=${head}`, "--silent"]);
  });

  test("a missing CLI records nothing and says so once", () => {
    const missing = { ...env, G1T_BIN: join(dir, "no-such-g1t") };
    const first = hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, missing);
    assert.match(first.output.systemMessage, /not installed/);
    assert.equal(first.job, null);
    const second = hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, missing);
    assert.equal(second.output, null);
    assert.equal(hook({ ...base, cwd: dir, hook_event_name: "Stop" }, missing).job, null);
    assert.deepEqual(calls(), []);
  });

  test("a signed-out CLI is said once, at the next prompt", () => {
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, { ...env, CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA });
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, { ...env, FAKE_G1T_EXIT: "4" });
    const first = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }, env);
    assert.match(first.output.systemMessage, /not signed in/);
    const second = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }, env);
    assert.equal(second.output, null);
  });

  test("outside a g1t repository nothing happens", () => {
    git("remote", "set-url", "origin", "https://example.com/acme/app.git");
    const { output, job } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    assert.equal(output, null);
    assert.equal(job, null);
    assert.equal(hook({ ...base, cwd: dir, hook_event_name: "Stop" }, env).job, null);
    assert.deepEqual(calls(), []);
  });

  test("the script answers SessionStart on stdin quickly, as JSON", async () => {
    const started = Date.now();
    const out = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({ ...base, cwd: dir, hook_event_name: "SessionStart", source: "startup" }),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    const took = Date.now() - started;
    assert.equal(out.status, 0);
    assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /issue #42/);
    assert.ok(took < 3000, `took ${took} ms`);
    // The detached half starts the session after the hook has returned.
    const id = sessionFiles(base.session_id, env).id;
    for (let i = 0; i < 100 && !existsSync(id); i++) await new Promise((done) => setTimeout(done, 50));
    assert.equal(readFileSync(id, "utf8"), "ses_fake01");
    await new Promise((done) => setTimeout(done, 200));
  });

  test("the script prints nothing for a prompt, and never fails on bad input", () => {
    const prompt = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "hello" }),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    assert.equal(prompt.status, 0);
    assert.equal(prompt.stdout, "");
    const bad = spawnSync(process.execPath, [SCRIPT], { input: "not json", encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, "");
  });
});
