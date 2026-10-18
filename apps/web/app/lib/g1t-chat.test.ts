import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatLiveEvent, ChatMessage } from "@g1t/contracts";

import { askedFrom, answerLabel, anyAnswering, applyLive, cutOff, fromG1t, isClearCommand, refTarget, suggestions } from "./g1t-chat.ts";

const g1t = { kind: "system" as const, id: "g1t", name: "g1t", display_name: "g1t", avatar: null, role: null };
const ana = { kind: "user" as const, id: "u1", name: "ana", display_name: "Ana", avatar: null, role: null };

function message(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    channel_id: "chn_1",
    author: ana,
    kind: "text",
    body: "",
    card: null,
    thread_root: null,
    reply_count: 0,
    last_reply_at: null,
    created_at: "2026-10-12T00:00:00Z",
    edited_at: null,
    deleted_at: null,
    ...extra,
  };
}

test("an answer streams into its message, then the stored one takes over", () => {
  let list = [message("msg_1", { body: "What shipped?" })];
  const placeholder = message("msg_2", { author: g1t, answer: { state: "thinking" } });
  list = applyLive(list, { type: "message.created", message: placeholder }, "chn_1");
  assert.ok(anyAnswering(list));
  list = applyLive(list, { type: "message.streaming", channel_id: "chn_1", id: "msg_2", body: "Two", answer: { state: "streaming" } }, "chn_1");
  assert.equal(list[1]!.body, "Two");
  const done: ChatMessage = { ...placeholder, body: "Two pull requests.", answer: { state: "done", provider_label: "Anthropic", model: "m" } };
  list = applyLive(list, { type: "message.updated", message: done }, "chn_1");
  assert.equal(list[1]!.body, "Two pull requests.");
  assert.ok(!anyAnswering(list));
  // A frame that arrives after the end changes nothing.
  list = applyLive(list, { type: "message.streaming", channel_id: "chn_1", id: "msg_2", body: "Tw", answer: { state: "streaming" } }, "chn_1");
  assert.equal(list[1]!.body, "Two pull requests.");
  assert.equal(answerLabel(list[1]!.answer), "Anthropic · m");
  // Auto names the model it chose.
  assert.equal(answerLabel({ state: "done", provider_label: "Anthropic", model: "claude-sonnet-5-5", auto: true }), "Anthropic · Auto · claude-sonnet-5-5");
  assert.equal(answerLabel({ state: "thinking" }), null);
});

test("other conversations, thread replies and deletions", () => {
  const list = [message("msg_1"), message("msg_2")];
  const elsewhere: ChatLiveEvent = { type: "message.created", message: message("msg_3", { channel_id: "chn_2" }) };
  assert.equal(applyLive(list, elsewhere, "chn_1").length, 2);
  assert.equal(applyLive(list, { type: "message.created", message: message("msg_3", { thread_root: "msg_1" }) }, "chn_1").length, 2);
  assert.deepEqual(applyLive(list, { type: "message.deleted", channel_id: "chn_1", id: "msg_1" }, "chn_1").map((m) => m.id), ["msg_2"]);
  // Out of order arrivals land in order.
  assert.deepEqual(applyLive([message("msg_3")], { type: "message.created", message: message("msg_2") }, "chn_1").map((m) => m.id), ["msg_2", "msg_3"]);
});

test("a cleared conversation empties, and only that one", () => {
  const list = [message("msg_1"), message("msg_2", { author: g1t, answer: { state: "streaming" } })];
  assert.deepEqual(applyLive(list, { type: "channel.cleared", channel_id: "chn_1" }, "chn_1"), []);
  assert.equal(applyLive(list, { type: "channel.cleared", channel_id: "chn_2" }, "chn_1").length, 2);
  // An answer's late frame after the clear brings nothing back.
  assert.deepEqual(applyLive([], { type: "message.streaming", channel_id: "chn_1", id: "msg_2", body: "Two", answer: { state: "streaming" } }, "chn_1"), []);
});

test("/clear, typed to g1t, is the command and nothing else is", () => {
  assert.ok(isClearCommand("/clear"));
  assert.ok(isClearCommand("  /CLEAR \n"));
  assert.ok(!isClearCommand("/clear the cache for me"));
  assert.ok(!isClearCommand("clear"));
});

test("who g1t is, and answers cut off at their limit", () => {
  assert.ok(fromG1t({ author: g1t }));
  assert.ok(!fromG1t({ author: ana }));
  assert.ok(cutOff({ state: "done", stop_reason: "max_tokens" }));
  assert.equal(answerLabel({ state: "thinking" }), null);
});

test("suggestions fit the page", () => {
  assert.match(suggestions({ pull: 4, repo: { namespace: "acme", name: "web" } })[0]!, /#4/);
  assert.match(suggestions({ item: 12 }).join(" "), /blocking #12/);
  assert.match(suggestions({ path: "/acme/-/work/12" }).join(" "), /work item #12/);
  assert.match(suggestions({ repo: { namespace: "acme", name: "web" } })[0]!, /web/);
  assert.equal(suggestions({}).length, 4);
});

test("links into the site show as what they lead to", () => {
  // An old issue's address reads as `#12` in its repository, as `ref` does.
  assert.deepEqual(refTarget("/acme/web/issues/12"), { kind: "ref", repo: "acme/web", number: 12, href: "/acme/web/issues/12" });
  assert.deepEqual(refTarget("/acme/web/ref/12"), { kind: "ref", repo: "acme/web", number: 12, href: "/acme/web/ref/12" });
  assert.deepEqual(refTarget("/Acme/-/work/12"), { kind: "item", workspace: "acme", number: 12, href: "/Acme/-/work/12" });
  assert.deepEqual(refTarget("https://g1t.sh/Acme/web/pull/7#discussion"), { kind: "pull", repo: "acme/web", number: 7, href: "/Acme/web/pull/7#discussion" });
  assert.deepEqual(refTarget("/acme/web/commit/0123abcd"), { kind: "commit", repo: "acme/web", sha: "0123abcd", href: "/acme/web/commit/0123abcd" });
  assert.deepEqual(refTarget("https://g1t.example/acme/-/chat", "https://g1t.example"), { kind: "page", href: "/acme/-/chat" });
  assert.equal(refTarget("https://example.com/acme/web/issues/1"), null);
  assert.equal(refTarget("//evil.example/x"), null);
  assert.equal(refTarget("javascript:alert(1)"), null);
});

test("a question asked on a page says which, and one written in Chat says nothing", () => {
  const repo = { namespace: "flagon-io", name: "g1t" };
  assert.deepEqual(askedFrom({ path: "/flagon-io/g1t/pull/8", repo, pull: 8 }), { label: "pull request #8 in flagon-io/g1t", href: "/flagon-io/g1t/pull/8" });
  assert.deepEqual(askedFrom({ workspace: "flagon-io", item: 21 }), { label: "work item #21 in flagon-io", href: "/flagon-io/-/work/21" });
  assert.deepEqual(askedFrom({ path: "/flagon-io/-/work/21" }), { label: "work item #21 in flagon-io", href: "/flagon-io/-/work/21" });
  assert.equal(askedFrom({ path: "/flagon-io/g1t", repo })?.label, "flagon-io/g1t");
  assert.equal(askedFrom({ path: "/flagon-io/-/chat/dm/chn_1" }), null);
  assert.equal(askedFrom({ time_zone: "America/Denver" }), null);
  assert.equal(askedFrom(null), null);
});
