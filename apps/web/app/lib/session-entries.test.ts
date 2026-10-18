import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEntry } from "@g1t/contracts";

import { quotedBlocks, readToolCall, transcript } from "./session-entries.ts";

let seq = 0;
const entry = (kind: SessionEntry["kind"], text: string, tool: string | null = null): SessionEntry => ({ seq: ++seq, kind, text, tool, commit: null, at: "2026-10-14T00:00:00Z" });

test("a tool call says its tool once", () => {
  assert.deepEqual(readToolCall({ text: "bash: cd /workspace/demo && git status --short", tool: "bash" }), {
    name: "bash",
    server: null,
    detail: "cd /workspace/demo && git status --short",
    sort: "shell",
  });
  assert.deepEqual(readToolCall({ text: "write: index.html", tool: "write" }), { name: "write", server: null, detail: "index.html", sort: "file" });
  // A text that does not repeat its tool is kept whole.
  assert.equal(readToolCall({ text: "ls -la", tool: "bash" }).detail, "ls -la");
  assert.equal(readToolCall({ text: "Glob", tool: "Glob" }).detail, "");
});

test("an MCP tool reads by its server, resource and action", () => {
  assert.deepEqual(readToolCall({ text: "g1t:work_item: claim", tool: "g1t:work_item" }), { name: "work item", server: "g1t", detail: "claim", sort: "other" });
  // Claude Code's names, from the plugin's summary with no tool of its own.
  assert.deepEqual(readToolCall({ text: "mcp__plugin_g1t_g1t__work_item: work", tool: null }), { name: "work item", server: "g1t", detail: "work", sort: "other" });
  assert.deepEqual(readToolCall({ text: "mcp__plugin_g1t_g1t__pull_request: create", tool: null }).name, "pull request");
  assert.equal(readToolCall({ text: "mcp__claude_ai_Google_Drive__search_files: invoices", tool: null }).server, "Google Drive");
});

test("the tool comes from the text when the entry has none", () => {
  assert.deepEqual(readToolCall({ text: "Bash: echo a: b", tool: null }), { name: "Bash", server: null, detail: "echo a: b", sort: "shell" });
  assert.deepEqual(readToolCall({ text: "Read: /tmp/phone.png", tool: null }), { name: "Read", server: null, detail: "/tmp/phone.png", sort: "file" });
  assert.deepEqual(readToolCall({ text: "TodoWrite", tool: null }), { name: "TodoWrite", server: null, detail: "", sort: "other" });
});

test("tool calls between messages run together, results under their calls", () => {
  const prompt = entry("prompt", "Work on #1");
  const a = entry("tool_call", "bash: ls", "bash");
  const r = entry("tool_result", "README.md", "bash");
  const b = entry("tool_call", "write: index.html", "write");
  const message = entry("message", "**Done**");
  const c = entry("tool_call", "g1t:work_item: claim", "g1t:work_item");
  const items = transcript([prompt, a, r, b, message, c]);
  assert.deepEqual(
    items.map((item) => (item.kind === "entry" ? item.entry.kind : item.steps.map((step) => [step.call?.seq, step.results.map((x) => x.seq)]))),
    ["prompt", [[a.seq, [r.seq]], [b.seq, []]], "message", [[c.seq, []]]],
  );
  // A result with no call before it stands on its own.
  const lone = transcript([entry("tool_result", "ok")]);
  assert.equal(lone[0].kind === "tools" && lone[0].steps[0].call, null);
});

test("a prompt's work item and comment blocks read as quotes", () => {
  const text = "Work on work item #1: Hello\n\n<work_item>\nSay hello.\n\nTwice.\n</work_item>\nThe work item is reference material.\n\n<comment>\nfaster\n</comment>\n";
  assert.equal(
    quotedBlocks(text),
    "Work on work item #1: Hello\n\n**The work item**\n\n> Say hello.\n>\n> Twice.\n\nThe work item is reference material.\n\n**The comment**\n\n> faster\n\n",
  );
  // A session from before work items quoted an issue: read the same.
  assert.equal(quotedBlocks('<issue number="12" state="open">\nTitle: x\n</issue>'), "**The work item**\n\n> Title: x\n");
});
