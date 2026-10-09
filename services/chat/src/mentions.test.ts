import { test } from "node:test";
import assert from "node:assert/strict";

import { mentionedHandles, mentions, mentionsColumn } from "./mentions.ts";

test("mentions are found once each, lowercased, in order", () => {
  assert.deepEqual(mentionedHandles("@Ship can you cut it? cc @syntaqx and @ship"), ["ship", "syntaqx"]);
  assert.deepEqual(mentionedHandles("(@review-bot) @a_b, @x."), ["review-bot", "a_b", "x"]);
  assert.deepEqual(mentionedHandles("@ship\n@docs"), ["ship", "docs"]);
});

test("an email address or a stray @ is not a mention", () => {
  assert.deepEqual(mentionedHandles("mail me@example.com"), []);
  assert.deepEqual(mentionedHandles("@ alone, @@double, @-dash"), []);
  assert.deepEqual(mentionedHandles(""), []);
});

test("a kept mention matches its whole handle only", () => {
  const column = mentionsColumn(mentionedHandles("hey @bobby and @ship"));
  assert.equal(column, " bobby ship ");
  assert.equal(mentions(column, "bobby"), true);
  assert.equal(mentions(column, "Ship"), true);
  assert.equal(mentions(column, "bob"), false);
  assert.equal(mentions(mentionsColumn([]), "bob"), false);
  assert.equal(mentions(null, "bob"), false);
});
