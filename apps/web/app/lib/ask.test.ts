import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_ASK, type AskState, askPage, askReducer, cutOff, history, readLines, restorable } from "./ask.ts";

test("the page says which repository, issue or pull request the person is on", () => {
  assert.deepEqual(askPage("/Acme/web/issues/12"), { path: "/Acme/web/issues/12", repo: { namespace: "acme", name: "web" }, issue: 12 });
  assert.deepEqual(askPage("/acme/web/pull/3/files"), { path: "/acme/web/pull/3/files", repo: { namespace: "acme", name: "web" }, pull: 3 });
  assert.deepEqual(askPage("/acme/web/tree/main"), { path: "/acme/web/tree/main", repo: { namespace: "acme", name: "web" } });
  assert.deepEqual(askPage("/acme/web/issues"), { path: "/acme/web/issues", repo: { namespace: "acme", name: "web" } });
  // A workspace's own pages, and g1t's, name no repository.
  assert.deepEqual(askPage("/acme/-/chat/general"), { path: "/acme/-/chat/general" });
  assert.deepEqual(askPage("/settings/profile"), { path: "/settings/profile" });
  assert.deepEqual(askPage("/acme"), { path: "/acme" });
  assert.deepEqual(askPage(""), { path: "/" });
});

function run(...actions: Parameters<typeof askReducer>[1][]): AskState {
  return actions.reduce(askReducer, EMPTY_ASK);
}

test("an answer streams into the turn after the question", () => {
  const state = run(
    { type: "ask", question: "  What broke?  ", id: "1" },
    { type: "event", event: { type: "meta", provider: "anthropic", provider_label: "Anthropic", model: "claude-x" } },
    { type: "event", event: { type: "text", text: "The " } },
    { type: "event", event: { type: "text", text: "login." } },
  );
  assert.equal(state.busy, true);
  assert.equal(state.turns[0]!.content, "What broke?");
  assert.deepEqual(
    { content: state.turns[1]!.content, provider: state.turns[1]!.provider, model: state.turns[1]!.model, status: state.turns[1]!.status },
    { content: "The login.", provider: "Anthropic", model: "claude-x", status: "streaming" },
  );
  const done = askReducer(state, { type: "event", event: { type: "done", stop_reason: "max_tokens" } });
  assert.equal(done.busy, false);
  assert.equal(done.turns[1]!.status, "done");
  assert.ok(cutOff(done.turns[1]!));
});

test("one question at a time; empty ones are not asked", () => {
  const asking = run({ type: "ask", question: "a", id: "1" });
  assert.equal(askReducer(asking, { type: "ask", question: "b", id: "2" }), asking);
  assert.equal(askReducer(EMPTY_ASK, { type: "ask", question: "   ", id: "1" }), EMPTY_ASK);
});

test("stopping keeps what came; an error says what went wrong; new conversation starts over", () => {
  const stopped = run({ type: "ask", question: "a", id: "1" }, { type: "event", event: { type: "text", text: "par" } }, { type: "stop" });
  assert.equal(stopped.busy, false);
  assert.deepEqual([stopped.turns[1]!.status, stopped.turns[1]!.content], ["stopped", "par"]);
  // Nothing after the stop lands on the answer.
  assert.equal(askReducer(stopped, { type: "event", event: { type: "text", text: "tial" } }).turns[1]!.content, "par");

  const failed = run({ type: "ask", question: "a", id: "1" }, { type: "event", event: { type: "error", message: "Anthropic did not accept the credentials." } });
  assert.equal(failed.turns[1]!.error, "Anthropic did not accept the credentials.");
  assert.equal(failed.busy, false);
  assert.equal(run({ type: "ask", question: "a", id: "1" }, { type: "failed", message: "Too many questions." }).turns[1]!.status, "error");
  assert.equal(askReducer(failed, { type: "reset" }), EMPTY_ASK);
});

test("what is sent alternates, leaving out questions whose answer failed", () => {
  const state = run(
    { type: "ask", question: "one", id: "1" },
    { type: "event", event: { type: "text", text: "first" } },
    { type: "event", event: { type: "done", stop_reason: "end_turn" } },
    { type: "ask", question: "two", id: "2" },
    { type: "event", event: { type: "error", message: "no" } },
    { type: "ask", question: "three", id: "3" },
    { type: "event", event: { type: "text", text: "cut" } },
    { type: "stop" },
  );
  assert.deepEqual(history(state.turns, " four "), [
    { role: "user", content: "one" },
    { role: "assistant", content: "first" },
    { role: "user", content: "three" },
    { role: "assistant", content: "cut" },
    { role: "user", content: "four" },
  ]);
});

test("lines are read as they arrive, across chunks", () => {
  const first = readLines("", '{"type":"meta","provider":"openai","provider_label":"OpenAI","model":"gpt-5"}\n{"type":"te');
  assert.equal(first.events.length, 1);
  assert.equal(first.rest, '{"type":"te');
  const second = readLines(first.rest, 'xt","text":"Hi"}\nnot json\n{"type":"other"}\n');
  assert.deepEqual(second.events, [{ type: "text", text: "Hi" }]);
  assert.equal(second.rest, "");
});

test("a conversation kept in the tab comes back stopped where it was", () => {
  const kept = restorable({ turns: [{ id: "1-q", role: "user", content: "a", status: "done" }, { id: "1-a", role: "assistant", content: "b", status: "streaming" }], busy: true });
  assert.equal(kept.busy, false);
  assert.equal(kept.turns[1]!.status, "stopped");
  assert.deepEqual(restorable("junk"), EMPTY_ASK);
  assert.deepEqual(restorable({ turns: [{ role: "system", content: "x" }] }).turns, []);
});
