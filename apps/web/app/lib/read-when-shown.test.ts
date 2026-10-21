import assert from "node:assert/strict";
import { test } from "node:test";

import { readNow, showConversation, shownConversations } from "./read-when-shown.ts";

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
