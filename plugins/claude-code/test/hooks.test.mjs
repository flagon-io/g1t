// Tests for the plugin's hooks: node --test plugins/claude-code/test/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  updateContext,
  UPDATES_REPEAT_MS,
  howToUpdate,
  PROMPT_LIMIT,
  RESULT_LIMIT,
  agentResult,
  branchFromCommand,
  g1tTool,
  hasTitle,
  hook,
  intentTitle,
  MIN_CLI,
  TITLE_LIMIT,
  oldNode,
  older,
  typedSkill,
  isG1tRemote,
  isGitCommit,
  isGitPush,
  issueFromBranch,
  issueFromCommand,
  plan,
  redact,
  sessionFiles,
  subagentHarnessId,
  summarizeTool,
  work,
} from "../hooks/g1t.mjs";

import { CONTRACT, refusal } from "./fake-g1t.mjs";

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

  test("a turn Claude Code starts itself for a background task is not a prompt", () => {
    const notification = "<task-notification>\n<task-id>a1</task-id>\n<result>SECRET OUTPUT</result>\n</task-notification>";
    assert.equal(plan({ ...base, hook_event_name: "UserPromptSubmit", prompt: notification }, {}), null);
    assert.equal(plan({ ...base, hook_event_name: "UserPromptSubmit", prompt: "﻿hi" }, {}).steps[0].args.at(-1), "hi");
  });

  test("a prompt's intent is its first line or sentence, plain, clipped on a word", () => {
    assert.equal(intentTitle("fix the login redirect"), "Fix the login redirect");
    assert.equal(intentTitle("Make preview builds faster. They time out on big repositories."), "Make preview builds faster");
    assert.equal(intentTitle("Why does `src/app.ts` fail? It worked yesterday."), "Why does src/app.ts fail?");
    assert.equal(intentTitle("```js\nconst a = 1;\n```\n## Clean **this** up\nmore"), "Clean this up");
    assert.equal(intentTitle("\n\n- look at [the docs](https://docs.g1t.sh) for g1t.mjs"), "Look at the docs for g1t.mjs");
    assert.equal(intentTitle("  spread   over\tspaces  "), "Spread over spaces");
    const long = intentTitle("[TEST] Tidy up the README and then look at the CI pipeline, which keeps failing on the Windows runners");
    assert.ok(long.length <= TITLE_LIMIT, long);
    assert.ok(long.endsWith("…") && !long.endsWith(" …"), long);
    assert.ok(long.startsWith("[TEST] Tidy up the README"), long);
    assert.ok("[TEST] Tidy up the README and then look at the CI pipeline, which keeps failing on the Windows runners".startsWith(long.slice(0, -1)));
    // Not intents: slash commands, turns Claude Code starts, nothing to say.
    for (const prompt of ["/clear", "/compact keep the plan", "/g1t:status 4", "<command-name>/clear</command-name>", "```\ncode only\n```", "?", "", null]) {
      assert.equal(intentTitle(prompt), null, String(prompt));
    }
  });

  test("UserPromptSubmit titles the session with its intent, unless prompts are kept back", () => {
    const job = plan({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix the login redirect" }, {});
    assert.deepEqual(job.steps.at(-1), { title: "Fix the login redirect" });
    assert.ok(!plan({ ...base, hook_event_name: "UserPromptSubmit", prompt: "/clear" }, {}).steps.some((s) => s.title));
    assert.equal(plan({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix it" }, { G1T_RECORD_PROMPTS: "0" }), null);
    assert.equal(hasTitle(JSON.stringify({ id: "ses_1", title: null })), false);
    assert.equal(hasTitle(JSON.stringify({ id: "ses_1", title: "  " })), false);
    assert.equal(hasTitle(JSON.stringify({ id: "ses_1", title: "Fix it" })), true);
    assert.equal(hasTitle("not json"), true, "unreadable: nothing is replaced");
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
    tool_response: { status: "async_launched", agentId: "b5", description: "Review the diff", prompt: "Review it", outputFile: "/tmp/b5.out", resolvedModel: "claude-sonnet-4-5" },
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
  skill: { ...base, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "work-on-issue", args: "42" }, tool_response: { success: true, commandName: "work-on-issue" } },
};

describe("subagents", () => {
  test("SubagentStart starts a session of its own for the subagent", () => {
    const job = plan(fixtures.subagentStart, {});
    assert.deepEqual(job.agent, { id: "agent-def456", type: "Explore", start: true });
    assert.deepEqual(job.steps, []);
    assert.equal(subagentHarnessId("abc-123", "agent-def456"), "abc-123/agent/def456");
    assert.equal(subagentHarnessId("abc-123", "def456"), "abc-123/agent/def456", "the Agent tool's id names the same subagent");
  });

  test("SubagentStop ends it with its final message, cut to the limit", () => {
    const job = plan(fixtures.subagentStop, {});
    assert.deepEqual(job.agent, { id: "def456", type: "Explore" });
    assert.deepEqual(job.steps, [{ args: ["session", "end", "--reason", "done", "--result=Analysis complete. Found 3 potential issues..."] }]);
    const long = plan({ ...fixtures.subagentStop, last_assistant_message: "z".repeat(RESULT_LIMIT * 2) }, {});
    assert.equal(long.steps[0].args.at(-1).length, "--result=".length + RESULT_LIMIT);
    const dash = plan({ ...fixtures.subagentStop, last_assistant_message: "- Found 3 issues" }, {});
    assert.equal(dash.steps[0].args.at(-1), "--result=- Found 3 issues", "a message that starts with a dash is still a value");
    assert.equal(refusal(dash.steps[0].args), null);
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
    assert.deepEqual(plan(fixtures.skill, {}).steps, [{ args: ["session", "log", "--kind", "skill", "--", "work-on-issue"], skill: "work-on-issue" }]);
  });

  test("branches made, commits, claims and g1t's MCP tools are touched", () => {
    const bash = (command) => plan({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } }, {});
    assert.deepEqual(bash("git checkout -b 42-fix").steps.at(-1), { args: ["session", "touch", "--branch", "42-fix"] });
    assert.deepEqual(bash('git commit -m "x" --trailer "G1t-Session: $G1T_SESSION"').steps.at(-1), { touchHead: true });
    assert.deepEqual(bash("g1t work claim 42").steps.at(-1), { args: ["session", "touch", "--issue", "42"] });
    const mcp = plan({ ...base, hook_event_name: "PostToolUse", tool_name: "mcp__plugin_g1t_g1t__issue", tool_input: { action: "claim", repo: "a/b", number: 7 } }, {});
    assert.equal(mcp.issue, 7);
    assert.equal(branchFromCommand("git switch -c feat/x && echo"), "feat/x");
    assert.equal(branchFromCommand("git branch -d old"), null);
    assert.equal(isGitCommit("git -C repo commit -am x"), true);
    assert.equal(g1tTool("mcp__g1t__session"), "session");
    assert.equal(g1tTool("mcp__github__issue"), null);
  });

  test("a hand-off's issue comes with the session", () => {
    assert.equal(plan({ ...base, hook_event_name: "SessionStart" }, { G1T_ISSUE: "12" }).issue, 12);
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
    env = { PATH: process.env.PATH, G1T_BIN: FAKE, FAKE_G1T_LOG: log, CLAUDE_PLUGIN_DATA: join(dir, ".data") };
  });
  afterEach(() => {
    // Every call the hooks made is one the real CLI takes (the stand-in refuses the rest).
    const refused = allCalls().filter((c) => refusal(c.args));
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    assert.deepEqual(refused, [], "the CLI refuses these calls");
  });

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
    const [start, logged] = calls().filter((call) => call.args[1] !== "get_session");
    assert.deepEqual(start.args, ["session", "start", "--harness", "claude_code", "--harness-session-id", "abc-123", "--json"]);
    assert.deepEqual(logged, { args: ["session", "log", "--kind", "prompt", "--", "fix the login"], session: "ses_fake01" });
    assert.equal(readFileSync(sessionFiles(base.session_id, env).id, "utf8"), "ses_fake01");
  });

  test("background retrieval reaches the next tool without auto-acknowledging", () => {
    // A CLI that acknowledges: an older one is told to update instead (below).
    env.FAKE_G1T_VERSION = "0.3.3";
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
    assert.match(started.output.hookSpecificOutput.additionalContext, /g1t session list --issue 42 --subagents|g1t session list --subagents/);
    assert.equal(started.job.agent.task, "Find API endpoints");
    work(started.job, env);
    // What it does goes to its own session.
    const edited = { ...fixtures.inSubagent.tool_input, file_path: join(dir, "src", "api", "routes.ts") };
    work(hook(at({ ...fixtures.inSubagent, tool_input: edited }), env).job, env);
    // Its g1t commands act as it.
    const bash = hook(at({ ...base, hook_event_name: "PreToolUse", agent_id: "agent-def456", agent_type: "Explore", tool_name: "Bash", tool_input: { command: "g1t work claim 42" } }), env);
    assert.equal(bash.output.hookSpecificOutput.updatedInput.command, "export G1T_SESSION=ses_sub_def456; g1t work claim 42");
    const mcp = hook(at({ ...base, hook_event_name: "PreToolUse", agent_id: "agent-def456", tool_name: "mcp__plugin_g1t_g1t__issue", tool_input: { action: "claim", repo: "acme/app", number: 42 } }), env);
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
    assert.deepEqual(first.slice(0, 8), ["session", "start", "--harness", "claude_code", "--harness-session-id", "abc-123/agent/def456", "--parent", "ses_fake01"]);
    assert.ok(first.includes("--no-remember"));
    assert.ok(first.includes("--agent-type=Explore"));
    assert.ok(first.includes("--task=Find API endpoints"));
    const edit = log.find((c) => c.args[2] === "--kind" && c.args.at(-1) === "Edit: src/api/routes.ts");
    assert.equal(edit.session, "ses_sub_def456");
    const touched = log.find((c) => c.args[1] === "touch");
    assert.deepEqual(touched, { args: ["session", "touch", "--file=src/api/routes.ts"], session: "ses_sub_def456" });
    const ended = log.find((c) => c.args[1] === "end");
    assert.deepEqual(ended, { args: ["session", "end", "--reason", "done", "--result=Analysis complete. Found 3 potential issues..."], session: "ses_sub_def456" });
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

  test("a hand-off names its issue at the start", () => {
    git("checkout", "-q", "-b", "main");
    const { output, job } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, { ...env, G1T_ISSUE: "12" });
    assert.match(output.hookSpecificOutput.additionalContext, /issue #12 \(from the work handed to it\)/);
    assert.match(output.hookSpecificOutput.additionalContext, /G1t-Session/);
    work(job, env);
    const start = calls().find((c) => c.args[1] === "start");
    assert.ok(start.args.includes("--issue") && start.args.includes("12"));
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

  test("a CLI older than the plugin needs records nothing and says so once, with how to update it", () => {
    const old = { ...env, FAKE_G1T_VERSION: "0.3.1" };
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, old);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, old);
    work(plan({ ...base, cwd: dir, hook_event_name: "Stop" }, old), old);
    // SessionStart still asks it for the issue's context, which every CLI gives.
    assert.deepEqual(calls().map((c) => c.args.join(" ")), ["work context 42"], "nothing is recorded with it");
    assert.equal(allCalls().filter((c) => c.args[0] === "--version").length, 1, "the version is asked once for each build of the CLI");
    const first = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }, old);
    assert.match(first.output.systemMessage, /g1t CLI is 0\.3\.1, and the plugin needs 0\.3\.2 or later/);
    assert.match(first.output.systemMessage, /curl -fsSL https:\/\/g1t\.sh\/install \| sh/);
    assert.match(first.output.systemMessage, /irm https:\/\/g1t\.sh\/install\.ps1 \| iex/);
    assert.equal(hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }, old).output, null);
    assert.equal(older("0.3.1", MIN_CLI), true);
    assert.equal(older("0.3.2", MIN_CLI), false);
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
    assert.match(refusal(["work", "context", "abc"]), /not abc/);
    assert.match(refusal(["session", "pause"]), /takes 0 argument/);
    assert.equal(refusal(["api", "update_session", "-f", "id=ses_1", "-f", "head_commit=abc", "--silent"]), null);
  });

  test("PowerShell commands are read as Bash ones are, and a subagent's act as its session", () => {
    const ps = (command, extra = {}) => ({ ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "PowerShell", tool_input: { command }, ...extra });
    assert.equal(plan(ps("g1t work claim 42"), env).issue, 42);
    assert.deepEqual(plan(ps("git checkout -b 42-fix; git status"), env).steps.at(-1), { args: ["session", "touch", "--branch", "42-fix"] });
    assert.deepEqual(plan(ps("git commit -m x"), env).steps.at(-1), { touchHead: true });
    assert.deepEqual(plan(ps("git push origin 42-fix"), env).steps.at(-1), { headCommit: true });
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    work(hook({ ...fixtures.subagentStart, cwd: dir }, env).job, env);
    const pre = (tool_name, command) =>
      hook({ ...base, cwd: dir, hook_event_name: "PreToolUse", agent_id: "agent-def456", agent_type: "Explore", tool_name, tool_input: { command } }, env).output;
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
    assert.equal(typedSkill("/g1t:work-on-issue 42"), "g1t:work-on-issue");
    assert.equal(typedSkill("﻿/g1t:status"), "g1t:status");
    assert.equal(typedSkill("/clear"), null, "Claude Code's own commands are not skills");
    assert.equal(typedSkill("look at /g1t:status"), null);
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    const typed = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "/g1t:work-on-issue 42" }, env).job;
    assert.deepEqual(typed.steps.map((s) => s.args.slice(0, 4)), [["session", "log", "--kind", "prompt"], ["session", "log", "--kind", "skill"]]);
    work(typed, env);
    const tool = hook({ ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "g1t:work-on-issue", args: "42" } }, env).job;
    work(tool, env);
    const skills = calls().filter((c) => c.args.includes("skill"));
    assert.equal(skills.length, 2);
    assert.deepEqual(skills[0].args, ["session", "log", "--kind", "skill", "--key=skill:work-on-issue:1", "--", "g1t:work-on-issue"]);
    assert.equal(skills[1].args[4], "--key=skill:work-on-issue:1", "the same key: g1t keeps the first");
    // Another skill in the turn has a key of its own; the next prompt is another turn.
    const next = hook({ ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "g1t:coordinate" } }, env).job;
    assert.equal(next.steps[0].key, "skill:coordinate:1");
    hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "go on" }, { ...env, G1T_RECORD_PROMPTS: "0" });
    const later = hook({ ...base, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "g1t:work-on-issue" } }, env).job;
    assert.equal(later.steps[0].key, "skill:work-on-issue:2", "a turn whose prompt is not sent is still a turn");
    // Prompts kept back: the typed skill's name is still recorded, the prompt is not.
    const quiet = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "/g1t:status" }, { ...env, G1T_RECORD_PROMPTS: "0" }).job;
    assert.deepEqual(quiet.steps.map((s) => s.args.at(-1)), ["g1t:status"]);
  });

  test("with no issue in sight, Claude is told the session is recorded and when to open or claim one", () => {
    git("symbolic-ref", "HEAD", "refs/heads/fix-previews");
    const { output } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart", source: "startup" }, env);
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /this session is recorded on g1t and shows to the team/);
    assert.match(context, /Just work/);
    assert.match(context, /`g1t work claim --title "…"`/);
    assert.match(context, /Never open issues for questions, exploration or trivial fixes/);
    assert.ok(context.length < 900, `injected every session, so short: ${context.length}`);
    assert.ok(!calls().some((c) => c.args[0] === "work"), "no issue's context is asked for");
  });

  test("the session's first prompt with an intent titles it, once, and never over a title it has", () => {
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    const prompt = (text, more = {}) => hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: text }, { ...env, ...more }).job;
    // A slash command says nothing of what the session is for.
    work(prompt("/clear"), env);
    assert.ok(!calls().some((c) => c.args[1] === "attach" || c.args[1] === "heartbeat"));
    work(prompt("[TEST] fix the preview builds. They time out."), env);
    const titled = calls().filter((c) => c.args[1] === "heartbeat" || c.args[1] === "attach");
    assert.deepEqual(titled, [
      { args: ["session", "heartbeat", "--json"], session: "ses_fake01" },
      { args: ["session", "attach", "--title=[TEST] fix the preview builds"], session: "ses_fake01" },
    ]);
    // Later prompts do not try again.
    const next = prompt("now the tests");
    assert.ok(!next.steps.some((s) => s.title));
  });

  test("a session titled already keeps its title", () => {
    hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, env);
    work({ cwd: dir, sid: base.session_id, start: true, steps: [] }, env);
    const job = hook({ ...base, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "fix the login" }, env).job;
    work(job, { ...env, FAKE_G1T_TITLE: "Rewrite the auth flow" });
    assert.ok(calls().some((c) => c.args[1] === "heartbeat"));
    assert.ok(!calls().some((c) => c.args[1] === "attach"), "a title set before is never replaced");
  });

  test("Claude's own commands get the session's id once it has started", () => {
    const envFile = join(dir, "env.sh");
    const { job } = hook({ ...base, cwd: dir, hook_event_name: "SessionStart" }, { ...env, CLAUDE_ENV_FILE: envFile });
    assert.ok(!existsSync(envFile), "nothing is written before the session's id is known");
    work(job, env);
    // A plain assignment: Claude Code gives it to PowerShell commands too.
    assert.equal(readFileSync(envFile, "utf8"), "export G1T_SESSION=ses_fake01\n");
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
    writeFileSync(files.updates("ses_parent"), JSON.stringify([{ id: "parent-update", kind: "overlap.detected", data: {} }, { id: "newer", kind: "work.claimed", data: {} }]));
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
    writeFileSync(files.updates("ses_old"), JSON.stringify([{ id: "upd_1", data: {} }, { id: "upd_2", data: {} }]));
    assert.match(updateContext(event, env), /upd_2/);
    // A CLI that acknowledges is asked to.
    writeFileSync(join(dir, "cli.json"), JSON.stringify({ stamp: "x", version: "0.3.3" }));
    assert.match(updateContext(event, env), /g1t session acknowledge UPDATE_ID --session ses_old/);
    assert.equal(howToUpdate("0.3.4"), "`g1t upgrade`");
    assert.match(howToUpdate("0.3.3"), /curl -fsSL https:\/\/g1t\.sh\/install \| sh/);
    assert.match(howToUpdate(null), /installer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
