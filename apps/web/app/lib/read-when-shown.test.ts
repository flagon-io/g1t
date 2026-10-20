import assert from "node:assert/strict";
import { test } from "node:test";

import { newestFinished, readNow, showConversation, shownConversations } from "./read-when-shown.ts";

const moment = { visible: true, onScreen: true, newestId: "msg_2", lastRead: null };

test("messages are read only while the page is visible and they are on screen", () => {
  assert.equal(readNow(moment), "msg_2");
  assert.equal(readNow({ ...moment, visible: false }), null, "a hidden tab reads nothing");
  assert.equal(readNow({ ...moment, onScreen: false }), null, "the panel closed, the card scrolled away");
  assert.equal(readNow({ ...moment, newestId: null }), null, "nothing there yet");
});

test("each newest id is read once, and only forward", () => {
  assert.equal(readNow({ ...moment, lastRead: "msg_2" }), null);
  assert.equal(readNow({ ...moment, lastRead: "msg_3" }), null);
  assert.equal(readNow({ ...moment, newestId: "msg_3", lastRead: "msg_2" }), "msg_3");
});

test("an answer is read once it is finished, not while it streams", () => {
  const question = { id: "msg_1", answer: null, deleted_at: null };
  const answer = (state: "thinking" | "streaming" | "done") => ({ id: "msg_2", answer: { state } as never, deleted_at: null });
  assert.equal(newestFinished([question, answer("thinking")]), "msg_1");
  assert.equal(newestFinished([question, answer("streaming")]), "msg_1");
  assert.equal(newestFinished([question, answer("done")]), "msg_2");
  assert.equal(newestFinished([]), null);
  assert.equal(newestFinished([{ ...question, pending: true }]), null, "a question still being sent has no id to read");
  assert.equal(newestFinished([question, { id: "msg_3", answer: null, deleted_at: "2026-10-20T00:00:00Z" }]), "msg_1");
});

test("a conversation is shown while any surface shows it", () => {
  const panel = showConversation("chn_dm");
  const card = showConversation("chn_dm");
  assert.ok(shownConversations().has("chn_dm"));
  panel();
  panel();
  assert.ok(shownConversations().has("chn_dm"), "the card still shows it; letting go twice counts once");
  card();
  assert.ok(!shownConversations().has("chn_dm"));
});
