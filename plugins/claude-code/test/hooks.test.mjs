// Tests for the plugin's hooks: node --test plugins/claude-code/test/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  TITLE_NOTE,
  updateContext,
  UPDATES_REPEAT_MS,
  howToUpdate,
  PROMPT_LIMIT,
  RESULT_LIMIT,
  agentResult,
  branchFromCommand,
  g1tTool,
  hook,
  repoPath,
  MIN_CLI,
  oldNode,
  older,
  typedSkill,
  transcriptUsage,
  USAGE_CLI,
  LONG_PROMPT_TOKENS,
  isG1tRemote,
  isGitCommit,
  isGitPush,
  itemFromBranch,
  itemFromCommand,
  mayAddRemote,
  pairSubagent,
  plan,
  rememberTask,
  takeTask,
  redact,
  sessionFiles,
  subagentHarnessId,
  summarizeTool,
  work,
  checkForUpdate,
  pluginVersion,
  takeNotice,
  UPDATE_CHECK_MS,
  setProblem,
  harnessOf,
  commandOf,
  patchFiles,
  codexCounts,
  dataDir,
  updateNotice,
  idContext,
  trailerFor,
} from "../hooks/g1t.mjs";

import { CONTRACT, refusal } from "./fake-g1t.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "..", "hooks", "g1t.mjs");
const FAKE = join(HERE, "fake-g1t.mjs");

const base = { session_id: "abc-123", cwd: "/work/repo", transcript_path: "/t.jsonl", permission_mode: "default" };

/** An assistant line of a transcript, as Claude Code writes one for each part of an API response. */
function assistant(id, model, usage, requestId = `req_${id}`) {
  return JSON.stringify({
    type: "assistant",
    requestId,
    message: { id, model, role: "assistant", content: [{ type: "text", text: "the secret plan" }], usage },
  });
}

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

  test("a turn Claude Code starts itself for a background task is not a prompt", () => {
    const notification = "<task-notification>\n<task-id>a1</task-id>\n<result>SECRET OUTPUT</result>\n</task-notification>";
    assert.equal(plan({ ...base, hook_event_name: "UserPromptSubmit", prompt: notification }, {}), null);
    assert.equal(plan({ ...base, hook_event_name: "UserPromptSubmit", prompt: "﻿hi" }, {}).steps[0].args.at(-1), "hi");
  });

  test("UserPromptSubmit sends no title: g1t names the session from what it records", () => {
    for (const prompt of ["fix the login redirect", "/clear", "Build me a todo app. Use React."]) {
      const job = plan({ ...base, hook_event_name: "UserPromptSubmit", prompt }, {});
      assert.ok(
        job.steps.every((s) => s.args && !s.title && !s.args.includes("attach")),
        prompt,
      );
    }
    assert.equal(plan({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix it" }, { G1T_RECORD_PROMPTS: "0" }), null);
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

  test("PostToolUse remembers the work item a command claims", () => {
    const job = plan({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "g1t work claim 42 --note x" } }, {});
    assert.equal(job.item, 42);
  });

  test("Stop sends a heartbeat with the transcript's usage, and SessionEnd reports it and ends the session with its reason", () => {
    assert.deepEqual(plan({ ...base, hook_event_name: "Stop", stop_hook_active: false }, {}).steps, [{ args: ["session", "heartbeat"], usage: "/t.jsonl" }]);
    const { transcript_path, ...untracked } = base;
    assert.deepEqual(plan({ ...untracked, hook_event_name: "Stop" }, {}).steps, [{ args: ["session", "heartbeat"] }]);
    const end = plan({ ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" }, {});
    assert.deepEqual(end.steps, [
      { args: ["session", "heartbeat"], usage: "/t.jsonl", only: true },
      { args: ["session", "end", "--reason", "prompt_input_exit"] },
    ]);
    assert.equal(end.end, true);
  });

  test("events without a session, and other events, do nothing", () => {
    assert.equal(plan({ hook_event_name: "Stop" }, {}), null);
    assert.equal(plan({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash" }, {}), null);
  });
});

// Payloads as Claude Code sends them (code.claude.com/docs/en/hooks).
const fixtures = {
  subagentStart: {
    session_id: "abc-123",
    transcript_path: "/t.jsonl",
    cwd: "/work/repo",
    hook_event_name: "SubagentStart",
    agent_id: "agent-def456",
    agent_type: "Explore",
  },
  subagentStop: {
    session_id: "abc-123",
    transcript_path: "/t.jsonl",
    cwd: "/work/repo",
    permission_mode: "default",
    hook_event_name: "SubagentStop",
    stop_hook_active: false,
    agent_id: "def456",
    agent_type: "Explore",
    agent_transcript_path: "/t/abc-123/subagents/agent-def456.jsonl",
    last_assistant_message: "Analysis complete. Found 3 potential issues...",
    background_tasks: [],
    session_crons: [],
  },
  agentCompleted: {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { description: "Find API endpoints", prompt: "Find all API endpoints", subagent_type: "Explore" },
    tool_response: {
      status: "completed",
      agentId: "a4d2c8f1e0b3a297",
      content: [{ type: "text", text: "Found 12 endpoints in src/api." }],
      resolvedModel: "claude-sonnet-4-5",
      totalTokens: 12450,
      totalDurationMs: 48211,
      totalToolUseCount: 7,
      usage: { input_tokens: 8320, output_tokens: 410 },
    },
    tool_use_id: "toolu_9",
  },
  agentLaunched: {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { description: "Review the diff", prompt: "Review it", subagent_type: "code-reviewer", run_in_background: true },
    tool_response: {
      status: "async_launched",
      agentId: "b5",
      description: "Review the diff",
      prompt: "Review it",
      outputFile: "/tmp/b5.out",
      resolvedModel: "claude-sonnet-4-5",
    },
  },
  inSubagent: {
    ...base,
    hook_event_name: "PostToolUse",
    agent_id: "agent-def456",
    agent_type: "Explore",
    tool_name: "Edit",
    tool_input: { file_path: "/work/repo/src/api/routes.ts", old_string: "a", new_string: "b" },
    tool_response: { filePath: "/work/repo/src/api/routes.ts", structuredPatch: "SECRET PATCH" },
  },
  skill: {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Skill",
    tool_input: { skill: "work-on-item", args: "42" },
    tool_response: { success: true, commandName: "work-on-item" },
  },
};

describe("subagents", () => {
  test("SubagentStart starts a session of its own for the subagent", () => {
    const job = plan(fixtures.subagentStart, {});
    assert.deepEqual(job.agent, { id: "agent-def456", type: "Explore", start: true });
    assert.deepEqual(job.steps, []);
    assert.equal(subagentHarnessId("abc-123", "agent-def456"), "abc-123/agent/def456");
    assert.equal(subagentHarnessId("abc-123", "def456"), "abc-123/agent/def456", "the Agent tool's id names the same subagent");
  });

  test("SubagentStop reports its own transcript's usage and ends it with its final message, cut to the limit", () => {
    const job = plan(fixtures.subagentStop, {});
    assert.deepEqual(job.agent, { id: "def456", type: "Explore" });
    assert.deepEqual(job.steps, [
      { args: ["session", "heartbeat"], usage: "/t/abc-123/subagents/agent-def456.jsonl", only: true },
      { args: ["session", "end", "--reason", "done", "--result=Analysis complete. Found 3 potential issues..."] },
    ]);
    // Without agent_transcript_path, its own beside its parent's.
    const { agent_transcript_path, ...noPath } = fixtures.subagentStop;
    assert.equal(plan(noPath, {}).steps[0].usage, join("/t", "subagents", "agent-def456.jsonl"));
    const long = plan({ ...fixtures.subagentStop, last_assistant_message: "z".repeat(RESULT_LIMIT * 2) }, {});
    assert.equal(long.steps.at(-1).args.at(-1).length, "--result=".length + RESULT_LIMIT);
    const dash = plan({ ...fixtures.subagentStop, last_assistant_message: "- Found 3 issues" }, {});
    assert.equal(dash.steps.at(-1).args.at(-1), "--result=- Found 3 issues", "a message that starts with a dash is still a value");
    assert.equal(refusal(dash.steps.at(-1).args), null);
  });

  test("an Agent call gives its subagent the task, and once finished its final message, and nothing else of its answer", () => {
    const job = plan(fixtures.agentCompleted, {});
    assert.deepEqual(job.subagent, {
      id: "a4d2c8f1e0b3a297",
      type: "Explore",
      task: "Find API endpoints",
      prompt: "Find all API endpoints",
      model: "claude-sonnet-4-5",
      result: "Found 12 endpoints in src/api.",
    });
    assert.deepEqual(job.steps, [{ args: ["session", "log", "--kind", "tool_call", "--", "Agent: Find API endpoints"] }]);
    assert.ok(!JSON.stringify(job).includes("12450") && !JSON.stringify(job).includes("8320"));
    const launched = plan(fixtures.agentLaunched, {});
    assert.equal(launched.subagent.id, "b5");
    assert.equal(launched.subagent.result, null, "a background subagent reports at SubagentStop");
    assert.equal(plan(fixtures.agentCompleted, { G1T_RECORD_PROMPTS: "0" }).subagent.prompt, null);
    assert.equal(agentResult({ content: "plain" }), "plain");
  });

  test("what a subagent does is its own session's, and the files it writes are touched", () => {
    const job = plan(fixtures.inSubagent, {});
    assert.deepEqual(job.agent, { id: "agent-def456", type: "Explore" });
    assert.deepEqual(job.steps, [
      { args: ["session", "log", "--kind", "tool_call", "--", "Edit: src/api/routes.ts"] },
      { args: ["session", "touch", "--file=src/api/routes.ts"] },
    ]);
    assert.ok(!JSON.stringify(job).includes("SECRET PATCH"));
  });

  test("a skill is its name only", () => {
    assert.deepEqual(plan(fixtures.skill, {}).steps, [{ args: ["session", "log", "--kind", "skill", "--", "work-on-item"], skill: "work-on-item" }]);
  });

  test("branches made, commits, claims and g1t's MCP tools are touched", () => {
    const bash = (command) => plan({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } }, {});
    assert.deepEqual(bash("git checkout -b 42-fix").steps.at(-1), { args: ["session", "touch", "--branch", "42-fix"] });
    assert.deepEqual(bash('git commit -m "x" --trailer "G1t-Session: $G1T_SESSION"').steps.at(-1), { touchHead: true });
    assert.deepEqual(bash("g1t work claim 42").steps.at(-1), { args: ["session", "touch", "--item", "42"] });
    const mcp = plan(
      { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__plugin_g1t_g1t__work_item", tool_input: { action: "claim", workspace: "a", number: 7 } },
      {},
    );
    assert.equal(mcp.item, 7);
    assert.equal(branchFromCommand("git switch -c feat/x && echo"), "feat/x");
    assert.equal(branchFromCommand("git branch -d old"), null);
    assert.equal(isGitCommit("git -C repo commit -am x"), true);
    assert.equal(g1tTool("mcp__g1t__session"), "session");
    assert.equal(g1tTool("mcp__plugin_g1t_g1t__work_item"), "work_item");
    assert.equal(g1tTool("mcp__github__issue"), null);
  });

  test("a hand-off's work item comes with the session", () => {
    assert.equal(plan({ ...base, hook_event_name: "SessionStart" }, { G1T_ITEM: "12" }).item, 12);
  });
});

describe("summaries", () => {
  test("say what a tool was called with, in one short line", () => {
    assert.equal(summarizeTool("Edit", { file_path: "/work/repo/src/a.ts", old_string: "x", new_string: "y" }, "/work/repo"), "Edit: src/a.ts");
    assert.equal(summarizeTool("Grep", { pattern: "TODO", path: "src" }, "/w"), "Grep: TODO in src");
    // From the top of the working copy, wherever the shell has moved to.
    assert.equal(repoPath("/work/repo/apps/web/app/a.ts", "/work/repo/apps/web", "/work/repo"), "apps/web/app/a.ts");
    assert.equal(repoPath("app/a.ts", "/work/repo/apps/web", "/work/repo"), "apps/web/app/a.ts");
    assert.equal(repoPath("/elsewhere/a.ts", "/work/repo/apps/web", "/work/repo"), null);
    assert.equal(repoPath("/work/repo/src/a.ts", "/work/repo", null), "src/a.ts");
    assert.equal(summarizeTool("WebFetch", { url: "https://example.com", prompt: "p" }), "WebFetch: https://example.com");
    assert.equal(summarizeTool("Bash", { command: "echo one\necho two" }), "Bash: echo one …");
    assert.equal(summarizeTool("mcp__g1t__work_item", { action: "get", number: 4 }), "mcp__g1t__work_item: get");
    assert.ok(summarizeTool("Bash", { command: "y".repeat(1000) }).length <= 200);
  });

  test("hide what looks like a secret", () => {
    const line = redact('curl -H "Authorization: Bearer g1t_abcdefghijklmnop" https://u:pw@x.com GITHUB_TOKEN=ghp_123456789012 --token abc');
    assert.ok(!line.includes("abcdefghijklmnop"));
    assert.ok(!line.includes("ghp_123456789012"));
    assert.ok(!line.includes("u:pw@"));
    assert.ok(!line.includes("--token abc"));
  });

  test("hide credentials wherever text is sent, and leave references alone", () => {
    for (const [text, secret] of [
      ["$env:G1T_TOKEN='abc123def456'; g1t whoami", "abc123def456"],
      ["G1T_TOKEN=abc123def456 g1t whoami", "abc123def456"],
      ['{"password": "hunter2!"}', "hunter2"],
      ["curl -u admin:pa55word https://x", "pa55word"],
      ["open https://x.com/cb?state=1&token=t0k3n", "t0k3n"],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "dozjgNryP4J3"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5v\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1"], // g1t:allow-secret
      ["here is my key: sk-ant-api03-abcDEF123456ghiJKL, use it", "abcDEF123456ghiJKL"],
    ]) {
      const out = redact(text);
      assert.ok(!out.includes(secret), `${secret} in ${out}`);
      assert.ok(out.includes("[redacted]"), out);
    }
    for (const kept of [
      "A path is not a secret: the rule read it as one",
      "password: the one you set",
      "TOKEN=$G1T_TOKEN",
      "token: ${{ secrets.DEPLOY }}",
      "fn f(token: String)",
      "npm_config_user_agent",
      "git show 58def4040e93a1dcda5f388f55360f3cd46cd97e",
    ]) {
      assert.equal(redact(kept), kept);
    }
  });

  test("find the work item in a branch name", () => {
    assert.equal(itemFromBranch("42-fix-login"), 42);
    assert.equal(itemFromBranch("issue-7"), 7);
    assert.equal(itemFromBranch("item-8"), 8);
    assert.equal(itemFromBranch("fix/123-thing"), 123);
    assert.equal(itemFromBranch("main"), null);
    assert.equal(itemFromBranch("release/1.2"), null);
    assert.equal(itemFromBranch("HEAD"), null);
    assert.equal(itemFromCommand("g1t session attach --item 9"), 9);
    assert.equal(itemFromCommand("g1t pr create --item=12 --draft"), 12);
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
    for (const file of [
      ".claude-plugin/marketplace.json",
      "plugins/claude-code/.claude-plugin/plugin.json",
      "plugins/claude-code/.mcp.json",
      "plugins/claude-code/hooks/hooks.json",
    ]) {
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
  const allCalls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  // The calls that do something: not the version check before them.
  const calls = () => allCalls().filter((c) => c.args[0] !== "--version");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "g1t-hook-"));
    log = join(dir, "calls.jsonl");
    git("init", "-q", "-b", "42-fix-login");
    git("remote", "add", "origin", "https://g1t.sh/acme/app.git");
    // Never the network: no look for a newer plugin.
    env = { PATH: process.env.PATH, G1T_BIN: FAKE, FAKE_G1T_LOG: log, CLAUDE_PLUGIN_DATA: join(dir, ".data"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  });
  afterEach(() => {
    // Every call the hooks made is one the real CLI takes (the stand-in refuses the rest).
    const refused = allCalls().filter((c) => refusal(c.args));
    // And none let the CLI claim every uncommitted file as this session's (the stand-in logs `touch` then).
    const guessing = allCalls().filter((c) => c.touch !== undefined);
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    assert.deepEqual(refused, [], "the CLI refuses these calls");
    assert.deepEqual(guessing, [], "these calls let the CLI guess what was touched");
  });

  test("SessionStart gives Claude the branch's work item's work context", () => {
    const { output, job } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart", source: "startup" }, env);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(context, /work item #42/);
    assert.match(context, /Definition of done: it works/);
    assert.deepEqual(calls()[0].args, ["work", "view", "42"]);
    assert.equal(job.start, true);
  });

  test("the background half starts the session once, then logs into it", () => {
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    const { job } = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "fix the login" }, env);
    // No SessionStart marked this session as one in a g1t working copy.
    assert.equal(job, null);
    work(plan({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "fix the login" }, env), env);
    const [start, logged] = calls().filter((call) => call.args[1] !== "get_session");
    assert.deepEqual(start.args, ["session", "start", "--harness", "claude_code", "--harness-session-id", "abc-123", "--json"]);
    assert.deepEqual(logged, { args: ["session", "log", "--kind", "prompt", "--", "fix the login"], session: "ses_fake01" });
    assert.equal(readFileSync(sessionFiles(base.session_id, env).id, "utf8"), "ses_fake01");
  });

  test("a shell command's writes are this session's; what was uncommitted before it is not", () => {
    const { job } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work(job, env);
    // Another session's edit, uncommitted in the same working copy.
    writeFileSync(join(dir, "theirs.md"), "theirs");
    const command = { ...base, cwd: dir, tool_name: "Bash", tool_use_id: "tu_1", tool_input: { command: "sed -i s/a/b/ mine.md" } };
    hook({ ...command, hook_event_name: "PreToolUse" }, env);
    writeFileSync(join(dir, "mine.md"), "mine");
    const after = hook({ ...command, hook_event_name: "PostToolUse" }, env).job;
    const touched = after.steps.filter((step) => step.args?.[1] === "touch").flatMap((step) => step.args.filter((arg) => arg.startsWith("--file=")));
    assert.ok(touched.includes("--file=mine.md"), String(touched));
    assert.ok(!touched.includes("--file=theirs.md"), String(touched));
    // Read once: a command run again under the same id finds nothing kept.
    assert.equal(existsSync(sessionFiles(base.session_id, env).shell("tu_1")), false);
  });

  test("the CLI never guesses touched files from the whole working copy", () => {
    const { job } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work(job, env);
    work(plan({ ...base, cwd: dir, hook_event_name: "Stop" }, env), env);
    const heartbeat = calls().find((call) => call.args[0] === "session" && call.args[1] === "heartbeat");
    assert.ok(heartbeat, "a heartbeat was sent");
    assert.equal(heartbeat.touch, undefined);
  });

  test("background retrieval reaches the next tool without auto-acknowledging", () => {
    // A CLI that acknowledges: an older one is told to update instead (below).
    env.FAKE_G1T_VERSION = "0.4.0";
    env.FAKE_G1T_UPDATES = JSON.stringify([{ id: "upd_real", kind: "overlap.detected", data: { paths: ["src/api.ts"] } }]);
    const event = { ...base, cwd: dir, hook_event_name: "SessionStart" };
    const { job } = hook(event, env);
    work(job, env);
    const next = { ...event, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "src/api.ts" } };
    const first = hook(next, env).output;
    assert.match(first.hookSpecificOutput.additionalContext, /upd_real/);
    assert.equal(first.hookSpecificOutput.hookEventName, "PreToolUse");
    // The next tool is not told again at once; the next prompt is.
    assert.equal(hook(next, env).output, null);
    const prompt = hook({ ...event, hook_event_name: "UserPromptSubmit", prompt: "go on" }, env).output;
    assert.match(prompt.hookSpecificOutput.additionalContext, /upd_real/);
    assert.ok(calls().some((call) => call.args[1] === "get_session" && call.args.includes("after=4294967295")));
    assert.ok(!calls().some((call) => call.args[1] === "record_session_entries"));
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
    git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "one");
    git("update-ref", "refs/remotes/origin/42-fix-login", "HEAD");
    const head = git("rev-parse", "HEAD").stdout.trim();
    work(plan({ ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push" } }, env), env);
    const update = calls().find((c) => c.args[0] === "api");
    assert.deepEqual(update.args, ["api", "update_session", "-f", "id=ses_fake01", "-f", `head_commit=${head}`, "--silent"]);
  });

  test("each subagent is a session of its own under this one, whatever order its hooks arrive in", () => {
    const at = (event) => ({ ...event, cwd: dir });
    hook(at({ ...base, hook_event_name: "SessionStart", source: "startup" }), env);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    // Claude calls Agent; its task waits for the subagent.
    const pre = hook(at({ ...base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: fixtures.agentCompleted.tool_input }), env);
    assert.equal(pre.output, null);
    const started = hook(at(fixtures.subagentStart), env);
    assert.match(started.output.hookSpecificOutput.additionalContext, /session of your own/);
    assert.match(started.output.hookSpecificOutput.additionalContext, /g1t session list --item 42 --subagents|g1t session list --subagents/);
    assert.equal(started.job.pair, true, "paired with its Agent call in the background half");
    work(started.job, env);
    assert.equal(started.job.agent.task, "Find API endpoints", "no files of the subagent's: the oldest call of its type");
    // What it does goes to its own session.
    const edited = { ...fixtures.inSubagent.tool_input, file_path: join(dir, "src", "api", "routes.ts") };
    work(hook(at({ ...fixtures.inSubagent, tool_input: edited }), env).job, env);
    // Its g1t commands act as it.
    const bash = hook(
      at({
        ...base,
        hook_event_name: "PreToolUse",
        agent_id: "agent-def456",
        agent_type: "Explore",
        tool_name: "Bash",
        tool_input: { command: "g1t work claim 42" },
      }),
      env,
    );
    assert.equal(bash.output.hookSpecificOutput.updatedInput.command, "export G1T_SESSION=ses_sub_def456; g1t work claim 42");
    const mcp = hook(
      at({
        ...base,
        hook_event_name: "PreToolUse",
        agent_id: "agent-def456",
        tool_name: "mcp__plugin_g1t_g1t__work_item",
        tool_input: { action: "claim", workspace: "acme", number: 42 },
      }),
      env,
    );
    assert.equal(mcp.output.hookSpecificOutput.updatedInput.session_id, "ses_sub_def456");
    // Outside a subagent, a command is left alone.
    assert.equal(hook(at({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "g1t work claim 42" } }), env).output, null);
    work(hook(at(fixtures.subagentStop), env).job, env);
    // A late SubagentStart starts it again, which g1t answers with the same, ended, session.
    work(hook(at(fixtures.subagentStart), env).job, env);
    const log = calls();
    const childStarts = log.filter((c) => c.args[1] === "start" && c.args.includes("--parent"));
    assert.ok(childStarts.length >= 2);
    const first = childStarts[0].args;
    assert.deepEqual(first.slice(0, 8), [
      "session",
      "start",
      "--harness",
      "claude_code",
      "--harness-session-id",
      "abc-123/agent/def456",
      "--parent",
      "ses_fake01",
    ]);
    assert.ok(first.includes("--no-remember"));
    assert.ok(first.includes("--agent-type=Explore"));
    assert.ok(first.includes("--task=Find API endpoints"));
    const edit = log.find((c) => c.args[2] === "--kind" && c.args.at(-1) === "Edit: src/api/routes.ts");
    assert.equal(edit.session, "ses_sub_def456");
    const touched = log.find((c) => c.args[1] === "touch");
    assert.deepEqual(touched, { args: ["session", "touch", "--file=src/api/routes.ts"], session: "ses_sub_def456" });
    const ended = log.find((c) => c.args[1] === "end");
    assert.deepEqual(ended, {
      args: ["session", "end", "--reason", "done", "--result=Analysis complete. Found 3 potential issues..."],
      session: "ses_sub_def456",
    });
  });

  test("five subagents of one type started at once each get their own Agent call's task, whatever order they start in", () => {
    // Claude Code's transcript and, beside it, each subagent's files.
    const transcript = join(dir, "projects", "abc-123.jsonl");
    const subagents = join(dir, "projects", "abc-123", "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(transcript, "");
    const at = (event) => ({ ...event, cwd: dir, transcript_path: transcript });
    hook(at({ ...base, hook_event_name: "SessionStart" }), env);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    const n = [1, 2, 3, 4, 5];
    // One message, five Agent calls of the same type.
    for (const i of n) {
      const tool_input = { description: `Task ${i}`, prompt: `Do thing ${i}, and only thing ${i}.`, subagent_type: "general-purpose" };
      hook(at({ ...base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input, tool_use_id: `toolu_${i}` }), env);
    }
    const files = (i, { meta = true, first = true } = {}) => {
      if (meta)
        writeFileSync(
          join(subagents, `agent-a${i}.meta.json`),
          JSON.stringify({ agentType: "general-purpose", description: `Task ${i}`, toolUseId: `toolu_${i}` }),
        );
      if (first)
        writeFileSync(
          join(subagents, `agent-a${i}.jsonl`),
          `${JSON.stringify({ type: "user", agentId: `a${i}`, message: { role: "user", content: `Do thing ${i}, and only thing ${i}.` } })}\n{"type":"attachment"}\n`,
        );
    };
    // They start in another order: one with its meta file, one with only its transcript (by prompt), the rest with both.
    files(4);
    files(2, { meta: false });
    files(5);
    files(1);
    files(3, { first: false });
    for (const i of [4, 2, 5, 1, 3])
      work(hook(at({ ...base, hook_event_name: "SubagentStart", agent_id: `a${i}`, agent_type: "general-purpose" }), env).job, env);
    const starts = calls().filter((c) => c.args[1] === "start" && c.args.includes("--parent"));
    assert.equal(starts.length, 5);
    for (const i of n) {
      const start = starts.find((c) => c.args.includes(`abc-123/agent/a${i}`)).args;
      assert.ok(start.includes(`--task=Task ${i}`), `subagent ${i}: ${start.join(" ")}`);
      assert.ok(start.includes(`--prompt=Do thing ${i}, and only thing ${i}.`), `subagent ${i}'s own prompt`);
    }
    assert.equal(readdirSync(join(env.CLAUDE_PLUGIN_DATA, "sessions")).filter((f) => f.includes(".task.")).length, 0, "every task taken once");
  });

  test("a pending task is never handed to two subagents, and an exact subagent never takes another's", () => {
    const files = sessionFiles(base.session_id, env);
    const input = (i) => ({ description: `Task ${i}`, prompt: `Prompt ${i}`, subagent_type: "general-purpose" });
    for (const i of [1, 2, 3]) rememberTask(files, input(i), `toolu_${i}`);
    assert.equal(takeTask(files, { type: "general-purpose", toolUseId: "toolu_2" }).task, "Task 2");
    assert.equal(takeTask(files, { type: "general-purpose", toolUseId: "toolu_2" }), null, "taken once");
    assert.equal(takeTask(files, { type: "general-purpose", prompt: "Prompt 2" }), null, "nor by its prompt");
    assert.equal(takeTask(files, { type: "general-purpose", toolUseId: "toolu_9" }), null, "an unknown call takes nothing rather than a guess");
    assert.equal(takeTask(files, { type: "general-purpose", prompt: "  Prompt 3\n" }).task, "Task 3", "the prompt as the transcript has it");
    // With no files of the subagent's (an older Claude Code): the oldest of its type, as before.
    assert.equal(takeTask(files, "general-purpose").task, "Task 1");
    assert.equal(takeTask(files, "general-purpose"), null);
    // An Agent call answered takes its own task back, so no later subagent guesses it.
    rememberTask(files, input(4), "toolu_4");
    work({ ...plan({ ...fixtures.agentLaunched, cwd: dir, tool_use_id: "toolu_4" }, env) }, env);
    assert.equal(takeTask(files, "general-purpose"), null);
  });

  test("a subagent's files give its task even when its Agent call was not kept", () => {
    const subagents = join(dir, "t", "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, "agent-a7.meta.json"), JSON.stringify({ description: "Look around", toolUseId: "toolu_7" }));
    writeFileSync(
      join(subagents, "agent-a7.jsonl"),
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Look around the repo" }] } })}\n`,
    );
    const files = sessionFiles(base.session_id, env);
    rememberTask(files, { description: "Someone else's", prompt: "not yours", subagent_type: "Explore" }, "toolu_8");
    const agent = pairSubagent({ id: "agent-a7", type: "Explore" }, files, join(dir, "t.jsonl"), env);
    assert.deepEqual(agent, { id: "agent-a7", type: "Explore", task: "Look around", prompt: "Look around the repo" });
    assert.equal(takeTask(files, "Explore").task, "Someone else's", "left for its own subagent");
    assert.equal(pairSubagent({ id: "a7", type: "Explore" }, files, join(dir, "t.jsonl"), { G1T_RECORD_PROMPTS: "0" }).prompt, undefined);
  });

  test("a session started with no g1t remote is recorded once a command adds one", () => {
    git("remote", "remove", "origin");
    const at = (event) => ({ ...base, cwd: dir, ...event });
    assert.deepEqual(hook(at({ hook_event_name: "SessionStart", source: "startup" }), env), { output: null, job: null });
    assert.equal(hook(at({ hook_event_name: "UserPromptSubmit", prompt: "Build me a todo app. Use React." }), env).job, null);
    assert.equal(hook(at({ hook_event_name: "UserPromptSubmit", prompt: "and make it blue" }), env).job, null);
    const bash = (command) => at({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } });
    assert.equal(hook(at({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(dir, "a.ts") } }), env).job, null);
    assert.equal(hook(bash("npm init -y"), env).job, null);
    assert.equal(hook(bash("git remote -v"), env).job, null, "looked, and there is none yet");
    assert.deepEqual(calls(), [], "nothing recorded without a g1t remote");
    // The agent makes the repository and adds it as the remote.
    git("remote", "add", "origin", "https://g1t.sh/acme/app.git");
    const { output, job } = hook(bash("g1t repo create acme/app --private && git remote add origin https://g1t.sh/acme/app.git"), env);
    assert.equal(job.start, true);
    assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(output.hookSpecificOutput.additionalContext, /work item #42/, "told what SessionStart would have told it");
    work(job, env);
    const recorded = calls().filter((c) => c.args[0] === "session");
    assert.deepEqual(recorded[0].args, ["session", "start", "--harness", "claude_code", "--harness-session-id", "abc-123", "--json"]);
    assert.ok(recorded.some((c) => c.args[1] === "log" && c.args.at(-1).startsWith("Bash: g1t repo create acme/app")));
    // g1t names it, from what it records from here on: no title is sent.
    assert.ok(!recorded.some((c) => c.args[1] === "attach"));
    const next = hook(at({ hook_event_name: "UserPromptSubmit", prompt: "Now add tests" }), env).job;
    assert.ok(next && !next.start);
    assert.deepEqual(
      next.steps.map((s) => s.args.slice(0, 4)),
      [["session", "log", "--kind", "prompt"]],
    );
  });

  test("a session given a g1t remote between prompts is recorded at the next one", () => {
    git("remote", "set-url", "origin", "https://example.com/acme/app.git");
    const at = (event) => ({ ...base, cwd: dir, ...event });
    hook(at({ hook_event_name: "SessionStart" }), env);
    assert.equal(hook(at({ hook_event_name: "UserPromptSubmit", prompt: "/clear" }), env).job, null);
    git("remote", "set-url", "origin", "https://g1t.sh/acme/app.git");
    const { job } = hook(at({ hook_event_name: "UserPromptSubmit", prompt: "fix the login" }), env);
    assert.equal(job.start, true);
    assert.equal(job.steps.at(-1).args.at(-1), "fix the login", "its prompt is recorded, and g1t names the session from it");
    assert.ok(existsSync(sessionFiles(base.session_id, env).marker));
    assert.ok(!existsSync(sessionFiles(base.session_id, env).unrecorded));
  });

  test("only commands that may add a remote look for one", () => {
    for (const command of [
      "git remote add origin https://g1t.sh/a/b.git",
      "git -C app push -u origin main",
      "git init",
      "g1t repo create a/b",
      "cd x && git clone https://g1t.sh/a/b",
    ]) {
      assert.equal(mayAddRemote(command), true, command);
    }
    for (const command of ["git status", "npm install", "g1t work list", "echo push", undefined]) assert.equal(mayAddRemote(command), false, String(command));
  });

  test("a subagent whose stop arrives first is started, then ended", () => {
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work(hook({ ...fixtures.subagentStop, cwd: dir }, env).job, env);
    const [, start, end] = calls().filter((c) => c.args[0] === "session");
    assert.ok(start.args.includes("--parent"));
    assert.equal(end.args[1], "end");
    assert.equal(end.session, "ses_sub_def456");
  });

  test("an Agent call that finished ends its subagent with what it reported", () => {
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work(hook({ ...fixtures.agentCompleted, cwd: dir }, env).job, env);
    const log = calls().filter((c) => c.args[0] === "session");
    assert.equal(log.find((c) => c.args[1] === "log").session, "ses_fake01", "the Agent call is the parent's");
    const end = log.find((c) => c.args[1] === "end");
    assert.deepEqual(end, { args: ["session", "end", "--reason", "done", "--result=Found 12 endpoints in src/api."], session: "ses_sub_a4d2c8f1e0b3a297" });
  });

  test("a hand-off names its work item at the start", () => {
    git("checkout", "-q", "-b", "main");
    const { output, job } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, { ...env, G1T_ITEM: "12" });
    assert.match(output.hookSpecificOutput.additionalContext, /work item #12 \(from the work handed to it\)/);
    assert.match(output.hookSpecificOutput.additionalContext, /G1t-Session/);
    work(job, env);
    const start = calls().find((c) => c.args[1] === "start");
    assert.ok(start.args.includes("--item") && start.args.includes("12"));
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
    assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /work item #42/);
    assert.ok(took < 3000, `took ${took} ms`);
    // The detached half starts the session after the hook has returned.
    const id = sessionFiles(base.session_id, env).id;
    for (let i = 0; i < 100 && !existsSync(id); i++) await new Promise((done) => setTimeout(done, 50));
    assert.equal(readFileSync(id, "utf8"), "ses_fake01");
    await new Promise((done) => setTimeout(done, 200));
  });

  test("run as Codex's hook (`g1t.mjs codex`), the session starts as Codex's", async () => {
    const out = spawnSync(process.execPath, [SCRIPT, "codex"], {
      input: JSON.stringify({ ...base, cwd: dir, hook_event_name: "SessionStart", source: "startup", model: "gpt-6.1-sol" }),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    assert.equal(out.status, 0);
    assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /work item #42/);
    const id = sessionFiles(base.session_id, env).id;
    for (let i = 0; i < 100 && !existsSync(id); i++) await new Promise((done) => setTimeout(done, 50));
    const start = calls().find((c) => c.args[0] === "session" && c.args[1] === "start");
    assert.deepEqual(start.args.slice(2, 4), ["--harness", "codex"]);
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

  test("a CLI older than the plugin needs records nothing and says so once, with how to update it", () => {
    const old = { ...env, FAKE_G1T_VERSION: "0.3.1" };
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, old);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, old);
    work(plan({ ...base, cwd: dir, hook_event_name: "Stop" }, old), old);
    // SessionStart still asks it for the work item's context.
    assert.deepEqual(
      calls().map((c) => c.args.join(" ")),
      ["work view 42"],
      "nothing is recorded with it",
    );
    assert.equal(allCalls().filter((c) => c.args[0] === "--version").length, 1, "the version is asked once for each build of the CLI");
    const first = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }, old);
    assert.match(first.output.systemMessage, /g1t CLI is 0\.3\.1, and the plugin needs 0\.4\.0 or later/);
    assert.match(first.output.systemMessage, /curl -fsSL https:\/\/g1t\.sh\/install \| sh/);
    assert.match(first.output.systemMessage, /irm https:\/\/g1t\.sh\/install\.ps1 \| iex/);
    assert.equal(hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }, old).output, null);
    assert.equal(older("0.3.1", MIN_CLI), true);
    assert.equal(older("0.3.7", MIN_CLI), true);
    assert.equal(older("0.4.0", MIN_CLI), false);
    assert.equal(older("0.10.0", MIN_CLI), false);
    assert.equal(older("1.0.0", MIN_CLI), false);
  });

  test("a CLI that refuses a command (exit 2) is said once, as one to update", () => {
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, { ...env, FAKE_G1T_EXIT: "2" });
    const first = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }, env);
    assert.match(first.output.systemMessage, /refused `g1t session start`/);
    assert.match(first.output.systemMessage, /installer again/);
    assert.equal(hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }, env).output, null);
  });

  test("the stand-in CLI refuses what the real one refuses", () => {
    assert.equal(CONTRACT.minimum_version, MIN_CLI, "the hooks ask for the CLI the contract needs");
    assert.match(refusal(["session", "log", "--kind", "tool-calls", "--", "x"]), /takes prompt, tool_call, skill/);
    assert.match(refusal(["session", "log", "--kind", "note", "--", "x"]), /not note/, "the hooks never send a note");
    assert.match(refusal(["session", "end", "--result", "- a list"]), /unexpected argument/);
    assert.equal(refusal(["session", "end", "--result=- a list"]), null);
    assert.match(refusal(["session", "touch"]), /needs one of/);
    assert.match(refusal(["session", "heartbeat", "--now"]), /takes no --now/);
    assert.match(refusal(["session", "start", "--harness", "claude-managed-agents", "--harness-session-id", "x"]), /takes claude_code/);
    assert.match(refusal(["work", "view", "abc"]), /not abc/);
    assert.match(refusal(["session", "pause"]), /takes 0 argument/);
    assert.equal(refusal(["api", "update_session", "-f", "id=ses_1", "-f", "head_commit=abc", "--silent"]), null);
    // --usage-json is newer than the oldest CLI the hooks take: only a CLI that has it is given it.
    const usage = ["session", "heartbeat", '--usage-json=[{"model":"claude-opus-5-5","input_tokens":1}]'];
    assert.equal(refusal(usage, CONTRACT, USAGE_CLI), null);
    assert.match(refusal(usage, CONTRACT, MIN_CLI), /takes no --usage-json/);
    assert.equal(CONTRACT.commands.find((c) => c.command.join(" ") === "session heartbeat").since["--usage-json"], USAGE_CLI);
  });

  test("a session's usage is reported from its own transcript, to a CLI that takes it, and only the counts", () => {
    const transcript = join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "the secret plan" } })}\n${assistant("msg_1", "claude-opus-5-5", { input_tokens: 10, output_tokens: 20 })}\n`,
    );
    const subagent = join(dir, "agent-def456.jsonl");
    writeFileSync(subagent, `${assistant("msg_2", "claude-haiku-4-5", { input_tokens: 7 })}\n`);
    const newer = { ...env, FAKE_G1T_VERSION: USAGE_CLI };
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, newer);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, newer);
    work(hook({ ...base, transcript_path: transcript, cwd: dir, hook_event_name: "Stop" }, newer).job, newer);
    work(hook({ ...fixtures.subagentStop, transcript_path: transcript, agent_transcript_path: subagent, cwd: dir }, newer).job, newer);
    const heartbeats = calls().filter((c) => c.args[1] === "heartbeat");
    const usage = (call) => JSON.parse(call.args.find((a) => a.startsWith("--usage-json=")).slice("--usage-json=".length));
    assert.equal(heartbeats[0].session, "ses_fake01");
    assert.deepEqual(usage(heartbeats[0]), [
      { model: "claude-opus-5-5", input_tokens: 10, output_tokens: 20, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 0 },
    ]);
    // The subagent's own, to its own session, before it ends; never its parent's.
    assert.equal(heartbeats[1].session, "ses_sub_def456");
    assert.deepEqual(
      usage(heartbeats[1]).map((row) => [row.model, row.input_tokens]),
      [["claude-haiku-4-5", 7]],
    );
    const order = calls()
      .filter((c) => c.session === "ses_sub_def456")
      .map((c) => c.args[1]);
    assert.ok(order.indexOf("heartbeat") < order.indexOf("end"), String(order));
    assert.ok(!allCalls().some((c) => c.args.join(" ").includes("secret plan")), "nothing of what the transcript says is sent");
    // A CLI without --usage-json gets a plain heartbeat, and no extra one before a subagent ends.
    rmSync(log, { force: true });
    rmSync(join(env.CLAUDE_PLUGIN_DATA, "cli.json"), { force: true });
    work(hook({ ...base, transcript_path: transcript, cwd: dir, hook_event_name: "Stop" }, env).job, env);
    work(hook({ ...fixtures.subagentStop, transcript_path: transcript, agent_transcript_path: subagent, cwd: dir }, env).job, env);
    assert.deepEqual(
      calls()
        .filter((c) => c.args[1] === "heartbeat")
        .map((c) => c.args),
      [["session", "heartbeat"]],
    );
  });

  test("PowerShell commands are read as Bash ones are, and a subagent's act as its session", () => {
    const ps = (command, extra = {}) => ({ ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "PowerShell", tool_input: { command }, ...extra });
    assert.equal(plan(ps("g1t work claim 42"), env).item, 42);
    assert.deepEqual(plan(ps("git checkout -b 42-fix; git status"), env).steps.at(-1), { args: ["session", "touch", "--branch", "42-fix"] });
    assert.deepEqual(plan(ps("git commit -m x"), env).steps.at(-1), { touchHead: true });
    assert.deepEqual(plan(ps("git push origin 42-fix"), env).steps.at(-1), { headCommit: true });
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    work(hook({ ...fixtures.subagentStart, cwd: dir }, env).job, env);
    const pre = (tool_name, command) =>
      hook({ ...base, cwd: dir, hook_event_name: "PreToolUse", agent_id: "agent-def456", agent_type: "Explore", tool_name, tool_input: { command } }, env)
        .output;
    assert.equal(pre("PowerShell", "g1t work claim 42").hookSpecificOutput.updatedInput.command, "$env:G1T_SESSION='ses_sub_def456'; g1t work claim 42");
    assert.equal(pre("PowerShell", "g1t.exe session view").hookSpecificOutput.updatedInput.command, "$env:G1T_SESSION='ses_sub_def456'; g1t.exe session view");
    assert.equal(pre("Bash", "echo $G1T_SESSION").hookSpecificOutput.updatedInput.command, "export G1T_SESSION=ses_sub_def456; echo $G1T_SESSION");
    assert.equal(pre("PowerShell", "$env:G1T_SESSION='ses_other'; g1t work claim 42"), null, "a session the command sets itself is kept");
    assert.equal(pre("PowerShell", "Get-ChildItem"), null, "other commands are left alone");
    // The tool call is recorded as Claude wrote it.
    const after = plan(ps("$env:G1T_SESSION='ses_sub_def456'; g1t work claim 42", { agent_id: "agent-def456" }), env);
    assert.deepEqual(after.steps[0].args.at(-1), "PowerShell: g1t work claim 42");
    assert.equal(summarizeTool("Bash", { command: "export G1T_SESSION=ses_1; g1t pr view" }), "Bash: g1t pr view");
  });

  test("a skill typed as /plugin:name is recorded once in its turn, however Claude Code then runs it", () => {
    assert.equal(typedSkill("/g1t:work-on-item 42"), "g1t:work-on-item");
    assert.equal(typedSkill("﻿/g1t:status"), "g1t:status");
    assert.equal(typedSkill("/clear"), null, "Claude Code's own commands are not skills");
    assert.equal(typedSkill("look at /g1t:status"), null);
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    const typed = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "/g1t:work-on-item 42" }, env).job;
    assert.deepEqual(
      typed.steps.map((s) => s.args.slice(0, 4)),
      [
        ["session", "log", "--kind", "prompt"],
        ["session", "log", "--kind", "skill"],
      ],
    );
    work(typed, env);
    const tool = hook(
      { ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "g1t:work-on-item", args: "42" } },
      env,
    ).job;
    work(tool, env);
    const skills = calls().filter((c) => c.args.includes("skill"));
    assert.equal(skills.length, 2);
    assert.deepEqual(skills[0].args, ["session", "log", "--kind", "skill", "--key=skill:work-on-item:1", "--", "g1t:work-on-item"]);
    assert.equal(skills[1].args[4], "--key=skill:work-on-item:1", "the same key: g1t keeps the first");
    // Another skill in the turn has a key of its own; the next prompt is another turn.
    const next = hook({ ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "g1t:coordinate" } }, env).job;
    assert.equal(next.steps[0].key, "skill:coordinate:1");
    hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "go on" }, { ...env, G1T_RECORD_PROMPTS: "0" });
    const later = hook({ ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "g1t:work-on-item" } }, env).job;
    assert.equal(later.steps[0].key, "skill:work-on-item:2", "a turn whose prompt is not sent is still a turn");
    // Prompts kept back: the typed skill's name is still recorded, the prompt is not.
    const quiet = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "/g1t:status" }, { ...env, G1T_RECORD_PROMPTS: "0" }).job;
    assert.deepEqual(
      quiet.steps.map((s) => s.args.at(-1)),
      ["g1t:status"],
    );
  });

  test("with no work item in sight, Claude is told the session is recorded and when to open or claim one", () => {
    git("symbolic-ref", "HEAD", "refs/heads/fix-previews");
    const { output } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart", source: "startup" }, env);
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /this session is recorded on g1t and shows to the team/);
    assert.match(context, /Just work/);
    assert.match(context, /`g1t work claim --title "…"`/);
    assert.match(context, /Never open work items for questions, exploration or trivial fixes/);
    // Told once that g1t names the session, and when to name it itself.
    assert.ok(context.includes(TITLE_NOTE));
    assert.match(context, /only if you can name the whole job/);
    assert.doesNotMatch(context, /retitle/i);
    assert.ok(context.length < 1100, `injected every session, so short: ${context.length}`);
    assert.ok(!calls().some((c) => c.args[0] === "work"), "no work item's context is asked for");
  });

  test("Claude is never nudged to retitle, and no prompt sets a title", () => {
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    for (const text of ["/clear", "[TEST] fix the preview builds. They time out.", "now the tests", "and the docs", "commit it", "push"]) {
      const { output, job } = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: text }, env);
      assert.doesNotMatch(JSON.stringify(output ?? {}), /retitle|attach --title/, text);
      if (job) work(job, env);
    }
    assert.ok(!calls().some((c) => c.args[1] === "attach" || (c.args[1] === "heartbeat" && c.args.includes("--json"))), "no title is set or looked for");
  });

  test("Claude's own commands get the session's id once it has started", () => {
    const envFile = join(dir, "env.sh");
    const { job } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, { ...env, CLAUDE_ENV_FILE: envFile });
    assert.ok(!existsSync(envFile), "nothing is written before the session's id is known");
    work(job, env);
    // A plain assignment: Claude Code gives it to PowerShell commands too.
    assert.equal(readFileSync(envFile, "utf8"), "export G1T_SESSION=ses_fake01\nexport G1T_TOUCH=0\n");
  });

  test("on a Node older than 18 nothing is recorded, and that is said once", () => {
    const at = (hook_event_name) => ({ ...base, cwd: dir, hook_event_name });
    assert.equal(oldNode(at("SessionStart"), env, "18.0.0"), undefined);
    const first = oldNode(at("SessionStart"), env, "16.20.2");
    assert.match(first.systemMessage, /need Node 18 or later, and `node` is v16\.20\.2/);
    assert.equal(oldNode(at("UserPromptSubmit"), env, "16.20.2"), null);
    assert.equal(oldNode(at("PostToolUse"), env, "16.20.2"), null);
    assert.deepEqual(calls(), []);
  });
});

test("pending updates survive delivery and stay isolated between parent and child", () => {
  const dir = mkdtempSync(join(tmpdir(), "g1t-inbox-"));
  try {
    const env = { CLAUDE_PLUGIN_DATA: dir };
    const files = sessionFiles("harness", env);
    mkdirSync(files.dir, { recursive: true });
    writeFileSync(files.id, "ses_parent");
    writeFileSync(files.agent("child"), "ses_child");
    writeFileSync(files.updates("ses_parent"), JSON.stringify([{ id: "parent-update", kind: "overlap.detected", data: {} }]));
    writeFileSync(files.updates("ses_child"), JSON.stringify([{ id: "child-update", kind: "dependency.changed", data: {} }]));
    const event = { session_id: "harness" };
    const first = updateContext(event, env);
    assert.match(first, /parent-update/);
    assert.doesNotMatch(first, /child-update/);
    assert.equal(updateContext(event, env), first);
    // Before tools: shown once, again when it changes or after a while.
    const files2 = sessionFiles("harness", env);
    rmSync(files2.shown("ses_parent"), { force: true });
    assert.equal(updateContext(event, env, { throttle: true, now: 1000 }), first);
    assert.equal(updateContext(event, env, { throttle: true, now: 2000 }), null);
    assert.equal(updateContext(event, env, { throttle: true, now: 1000 + UPDATES_REPEAT_MS }), first);
    writeFileSync(
      files.updates("ses_parent"),
      JSON.stringify([
        { id: "parent-update", kind: "overlap.detected", data: {} },
        { id: "newer", kind: "work.claimed", data: {} },
      ]),
    );
    assert.match(updateContext(event, env, { throttle: true, now: 1001 + UPDATES_REPEAT_MS }), /newer/);
    writeFileSync(files.updates("ses_parent"), JSON.stringify([{ id: "parent-update", kind: "overlap.detected", data: {} }]));
    const child = updateContext({ ...event, agent_id: "child" }, env);
    assert.match(child, /child-update/);
    assert.doesNotMatch(child, /parent-update/);
    assert.equal(updateContext({ ...event, agent_id: "unknown" }, env), null);
    writeFileSync(files.updates("ses_parent"), JSON.stringify([{ id: "oversized", data: "x".repeat(20000) }]));
    const bounded = updateContext(event, env);
    assert.ok(bounded.length < 10000);
    assert.match(bounded, /read get_session first/);
    // A payload that was omitted is not cleared from the cache.
    assert.match(readFileSync(files.updates("ses_parent"), "utf8"), /oversized/);
    writeFileSync(files.updates("ses_parent"), "[]");
    assert.equal(updateContext(event, env), null);
    assert.equal(updateContext({ ...event, agent_id: "child" }, env), child);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a CLI too old to acknowledge is told to update, once per set of updates", () => {
  const dir = mkdtempSync(join(tmpdir(), "g1t-stuck-"));
  try {
    const env = { CLAUDE_PLUGIN_DATA: dir };
    const files = sessionFiles("harness", env);
    mkdirSync(files.dir, { recursive: true });
    writeFileSync(files.id, "ses_old");
    writeFileSync(join(dir, "cli.json"), JSON.stringify({ stamp: "x", version: "0.3.2" }));
    writeFileSync(files.updates("ses_old"), JSON.stringify([{ id: "upd_1", kind: "session.ended", data: {} }]));
    const event = { session_id: "harness" };
    const first = updateContext(event, env);
    assert.match(first, /upd_1/);
    assert.match(first, /cannot acknowledge them \(0\.3\.3 can\)/);
    assert.match(first, /install\.ps1/, "0.3.2 has no g1t upgrade: the installer");
    assert.doesNotMatch(first, /g1t session acknowledge/);
    // Nothing can clear them, so not again on every prompt or tool.
    assert.equal(updateContext(event, env), null);
    assert.equal(updateContext(event, env, { throttle: true, now: Date.now() + 10 * UPDATES_REPEAT_MS }), null);
    writeFileSync(
      files.updates("ses_old"),
      JSON.stringify([
        { id: "upd_1", data: {} },
        { id: "upd_2", data: {} },
      ]),
    );
    assert.match(updateContext(event, env), /upd_2/);
    // A CLI that acknowledges is asked to.
    writeFileSync(join(dir, "cli.json"), JSON.stringify({ stamp: "x", version: "0.3.3" }));
    assert.match(updateContext(event, env), /g1t session acknowledge UPDATE_ID --session ses_old/);
    assert.equal(howToUpdate("0.3.4"), "`g1t upgrade`");
    assert.match(howToUpdate("0.3.3"), /curl -fsSL https:\/\/g1t\.sh\/install \| sh/);
    assert.match(howToUpdate(null), /installer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an acknowledgement refreshes the inbox at once, from the shell or MCP", () => {
  const dir = mkdtempSync(join(tmpdir(), "g1t-ack-"));
  try {
    const env = { CLAUDE_PLUGIN_DATA: dir };
    const base = { session_id: "harness", cwd: dir, hook_event_name: "PostToolUse" };
    const shell = plan({ ...base, tool_name: "Bash", tool_input: { command: "g1t session acknowledge upd_1 --note 'Separate scopes'" } }, env);
    assert.equal(shell.refreshUpdates, true);
    const mcp = plan({ ...base, tool_name: "mcp__plugin_g1t_g1t__session", tool_input: { action: "record", id: "ses_a", acknowledge: ["upd_1"] } }, env);
    assert.equal(mcp.refreshUpdates, true);
    const other = plan({ ...base, tool_name: "Bash", tool_input: { command: "git status" } }, env);
    assert.equal(other.refreshUpdates, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("a transcript's usage", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "g1t-usage-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    // One response written as three lines, the last with its final output count.
    assistant("msg_1", "claude-opus-5-5", {
      input_tokens: 2,
      output_tokens: 6,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 },
    }),
    assistant("msg_1", "claude-opus-5-5", {
      input_tokens: 2,
      output_tokens: 6,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 },
    }),
    assistant("msg_1", "claude-opus-5-5", {
      input_tokens: 2,
      output_tokens: 40,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 },
    }),
    // Without the split, a cache write is the 5-minute kind.
    assistant("msg_2", "claude-opus-5-5", { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 9 }),
    // The same message id from another request is another response.
    assistant("msg_2", "claude-opus-5-5", { input_tokens: 1, output_tokens: 1 }, "req_other"),
    // A claude-haiku-5-5 prompt over 100,000 tokens is its long tier; one under is not.
    assistant("msg_3", "claude-haiku-5-5-20260101", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: LONG_PROMPT_TOKENS }),
    assistant("msg_4", "claude-haiku-5-5-20260101", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 99_000 }),
    JSON.stringify({ type: "assistant", message: { id: "msg_5", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } }),
    "not json",
  ];

  test("counts each response once, per model and tier", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`);
    const usage = transcriptUsage(path, null);
    assert.deepEqual(usage, [
      { model: "claude-opus-5-5", input_tokens: 4, output_tokens: 42, cache_write_5m_tokens: 39, cache_write_1h_tokens: 20, cache_read_tokens: 100 },
      {
        model: "claude-haiku-5-5-20260101",
        tier: "long",
        input_tokens: 10,
        output_tokens: 5,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: LONG_PROMPT_TOKENS,
      },
      { model: "claude-haiku-5-5-20260101", input_tokens: 10, output_tokens: 5, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 99_000 },
    ]);
  });

  test("reads on from where it stopped, a line written in half counted once it is whole", () => {
    const path = join(dir, "t.jsonl");
    const state = join(dir, "state.json");
    const whole = `${lines.join("\n")}\n`;
    const cut = whole.indexOf("msg_2") + 10;
    writeFileSync(path, whole.slice(0, cut));
    const first = transcriptUsage(path, state);
    assert.equal(first.find((row) => row.model === "claude-opus-5-5").output_tokens, 40);
    writeFileSync(path, whole);
    assert.deepEqual(transcriptUsage(path, state), transcriptUsage(path, null));
    // A transcript written again from the top is counted again.
    writeFileSync(path, `${lines[4]}\n`);
    assert.deepEqual(
      transcriptUsage(path, state).map((row) => row.input_tokens),
      [1],
    );
  });

  test("a transcript that cannot be read gives nothing, and never throws", () => {
    assert.equal(transcriptUsage(join(dir, "missing.jsonl"), join(dir, "state.json")), null);
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "");
    assert.deepEqual(transcriptUsage(path, null), []);
  });
});

describe("a newer plugin", () => {
  let dir, env, root;
  const catalog = (version) => async () => ({ name: "g1t", plugins: [{ name: "g1t", source: "./plugins/g1t", version }] });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "g1t-update-"));
    env = { CLAUDE_PLUGIN_DATA: join(dir, ".data") };
    // As Claude Code keeps it: cache/g1t/g1t/<version>/.
    root = join(dir, "cache", "0.3.0");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "g1t", version: "0.3.0" }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the plugin knows its own version", () => {
    assert.equal(pluginVersion(root), "0.3.0");
    assert.match(pluginVersion(), /^\d+\.\d+\.\d+$/);
    assert.equal(pluginVersion(join(dir, "nowhere")), null);
  });

  test("a newer published version is said once, with how to update and keep it current", async () => {
    await checkForUpdate(env, { fetchJson: catalog("0.3.3"), now: 1000 });
    const said = takeNotice(env, root);
    assert.match(said, /plugin here is 0\.3\.0, and 0\.3\.3 is out/);
    assert.match(said, /claude plugin marketplace update g1t/);
    assert.match(said, /claude plugin update g1t@g1t/);
    assert.match(said, /Enable auto-update/);
    assert.equal(takeNotice(env, root), null);
    // A still newer one is said again.
    await checkForUpdate(env, { fetchJson: catalog("0.3.4"), now: 1000 + UPDATE_CHECK_MS });
    assert.match(takeNotice(env, root), /0\.3\.4 is out/);
  });

  test("it looks at most once a day, and never with nonessential traffic turned off", async () => {
    let asked = 0;
    const counting = async () => (asked++, { plugins: [{ name: "g1t", version: "0.3.3" }] });
    await checkForUpdate(env, { fetchJson: counting, now: 1000 });
    await checkForUpdate(env, { fetchJson: counting, now: 1000 + UPDATE_CHECK_MS - 1 });
    assert.equal(asked, 1);
    await checkForUpdate(env, { fetchJson: counting, now: 1000 + UPDATE_CHECK_MS });
    assert.equal(asked, 2);
    await checkForUpdate({ ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, { fetchJson: counting, now: 1e12 });
    assert.equal(asked, 2);
  });

  test("nothing is said for the same or an older version, an unreadable catalog, or a network failure", async () => {
    for (const fetchJson of [catalog("0.3.0"), catalog("0.2.9"), catalog("latest"), async () => "<html>", async () => Promise.reject(new Error("offline"))]) {
      rmSync(env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
      await checkForUpdate(env, { fetchJson, now: 1000 });
      assert.equal(takeNotice(env, root), null);
    }
  });

  test("not when auto-update already downloaded it beside this one", async () => {
    mkdirSync(join(dir, "cache", "0.3.3"));
    await checkForUpdate(env, { fetchJson: catalog("0.3.3"), now: 1000 });
    assert.equal(takeNotice(env, root), null);
  });

  test("a problem that stops recording is said first", async () => {
    await checkForUpdate(env, { fetchJson: catalog("0.3.3"), now: 1000 });
    setProblem(env, "signed_out");
    assert.match(takeNotice(env, root), /not signed in/);
    assert.match(takeNotice(env, root), /0\.3\.3 is out/);
  });
});

describe("Codex", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "g1t-codex-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const codex = { G1T_HOOK_HARNESS: "codex" };
  const usage = (input, cached, output) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: Math.floor(output / 2),
    total_tokens: input + output,
  });
  const line = (type, payload) => JSON.stringify({ timestamp: "2026-10-22T10:00:00Z", type, payload });
  const record = (id, u) => line("token_usage_record", { response_id: id, thread_id: "t1", usage: u });
  const total = (u) => line("event_msg", { type: "token_count", info: { total_token_usage: u, last_token_usage: u }, rate_limits: { plan_type: "plus" } });

  test("the harness is Codex's only when Codex's hooks.json says so, with a state folder of its own", () => {
    assert.equal(harnessOf({}), "claude_code");
    assert.equal(harnessOf(codex), "codex");
    assert.match(dataDir(codex), /[\\/]\.g1t[\\/]codex$/);
    assert.equal(dataDir({ ...codex, CLAUDE_PLUGIN_DATA: "/data" }), "/data");
  });

  test("a shell tool's command is read whatever shape Codex gives it in, and a patch says which files it wrote", () => {
    assert.equal(commandOf("git push"), "git push");
    assert.equal(commandOf({ command: ["bash", "-lc", "git commit -m x"] }), "bash -lc git commit -m x");
    assert.equal(commandOf({ cmd: "npm test" }), "npm test");
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: docs/b.md\n+hi\n*** Delete File: old.txt\n*** End Patch";
    assert.deepEqual(patchFiles(patch), ["src/a.ts", "docs/b.md", "old.txt"]);
    assert.deepEqual(patchFiles({ input: patch }), ["src/a.ts", "docs/b.md", "old.txt"]);
    const job = plan({ ...base, hook_event_name: "PostToolUse", tool_name: "exec", tool_input: { command: ["git", "push", "-u", "origin", "42-x"] } }, codex);
    assert.deepEqual(job.steps[0].args.slice(-1), ["exec: git push -u origin 42-x"]);
    assert.ok(job.steps.some((step) => step.headCommit));
    const patched = plan({ ...base, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: patch }, codex);
    assert.deepEqual(patched.steps.at(-1).args, ["session", "touch", "--file=src/a.ts", "--file=docs/b.md", "--file=old.txt"]);
  });

  test("Codex's counts are taken apart: cached input and reasoning are never counted twice", () => {
    assert.deepEqual(
      codexCounts({ input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 50, output_tokens: 300, reasoning_output_tokens: 200 }),
      {
        input_tokens: 150,
        output_tokens: 300,
        cache_write_5m_tokens: 50,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 800,
      },
    );
  });

  test("a Codex transcript's usage is each response's, once, under the model of its turn", () => {
    const transcript = join(dir, "rollout-2026-10-22T10-00-00-abc.jsonl");
    writeFileSync(
      transcript,
      [
        line("session_meta", { id: "t1", cwd: "/work/repo" }),
        line("turn_context", { turn_id: "1", model: "gpt-6.1-sol" }),
        record("resp_1", usage(1000, 600, 100)),
        record("resp_1", usage(1000, 600, 100)),
        total(usage(1000, 600, 100)),
        line("turn_context", { turn_id: "2", model: "gpt-6-astra" }),
        record("resp_2", usage(2000, 1500, 50)),
        // A compaction's call is in the records, though the running total leaves it out.
        record("resp_3", usage(500, 0, 40)),
        total(usage(3000, 2100, 150)),
        "",
      ].join("\n"),
    );
    assert.deepEqual(transcriptUsage(transcript, null, { harness: "codex" }), [
      { model: "gpt-6.1-sol", input_tokens: 400, output_tokens: 100, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 600 },
      { model: "gpt-6-astra", input_tokens: 1000, output_tokens: 90, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 1500 },
    ]);
  });

  test("an older Codex's transcript, with no response records, is its last running total under the hook's model", () => {
    const transcript = join(dir, "rollout-old.jsonl");
    writeFileSync(transcript, [total(usage(100, 40, 10)), total(usage(300, 200, 30)), ""].join("\n"));
    assert.deepEqual(transcriptUsage(transcript, null, { harness: "codex", model: "gpt-5.6-sol" }), [
      { model: "gpt-5.6-sol", input_tokens: 100, output_tokens: 30, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 200 },
    ]);
    // With no model known at all, nothing can be priced: nothing is sent.
    assert.deepEqual(transcriptUsage(transcript, null, { harness: "codex" }), []);
  });

  test("a compressed rollout is read whole when Node can", async () => {
    const zlib = await import("node:zlib");
    if (typeof zlib.zstdDecompressSync !== "function") return;
    const transcript = join(dir, "rollout-cold.jsonl.zst");
    writeFileSync(transcript, zlib.zstdCompressSync(Buffer.from([line("turn_context", { model: "gpt-6-sol" }), record("r", usage(10, 0, 5)), ""].join("\n"))));
    assert.deepEqual(transcriptUsage(transcript, null, { harness: "codex" }), [
      { model: "gpt-6-sol", input_tokens: 10, output_tokens: 5, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, cache_read_tokens: 0 },
    ]);
  });

  test("Codex's subagents use their own transcripts, and are not paired from Claude Code's files", () => {
    const stop = plan(
      { ...base, hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "worker", agent_transcript_path: "/c/sub.jsonl", model: "gpt-6-luna" },
      codex,
    );
    assert.deepEqual(stop.steps[0], { args: ["session", "heartbeat"], usage: "/c/sub.jsonl", only: true, model: "gpt-6-luna" });
    // Claude Code's plugin update notice is not Codex's.
    assert.equal(updateNotice(codex), null);
  });
});

test("Codex is told its session's id once, at the first prompt after it has one, for the commits' trailer", () => {
  const dir = mkdtempSync(join(tmpdir(), "g1t-codex-id-"));
  try {
    const env = { G1T_HOOK_HARNESS: "codex", CLAUDE_PLUGIN_DATA: dir };
    const files = sessionFiles("codex-run", env);
    assert.equal(idContext(files, env), null, "not before it has one");
    mkdirSync(files.dir, { recursive: true });
    writeFileSync(files.id, "ses_codex1");
    assert.match(idContext(files, env), /this session is ses_codex1 on g1t\. Add the trailer `G1t-Session: ses_codex1`/);
    assert.equal(idContext(files, env), null, "once");
    assert.equal(idContext(files, { CLAUDE_PLUGIN_DATA: dir }), null, "never for Claude Code, which has G1T_SESSION");
    assert.equal(idContext(null, env), null);
    assert.match(trailerFor(env), /which g1t says at your first prompt/);
    assert.match(trailerFor({}), /\$G1T_SESSION/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
