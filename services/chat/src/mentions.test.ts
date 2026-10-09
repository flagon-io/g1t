import { test } from "node:test";
import assert from "node:assert/strict";

import { mentionedHandles, mentions, mentionsColumn, plainOutside } from "./mentions.ts";

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

test("an agent's mention of someone outside the conversation becomes a plain name", () => {
  const members = new Set(["syntaqx", "g1t"]);
  assert.equal(
    plainOutside("Ask @mike to help @syntaqx. @Triage, @bruno and @david know too; I'm @g1t.", members),
    "Ask mike to help @syntaqx. Triage, bruno and david know too; I'm @g1t.",
  );
  // Matching is by whole handle, whatever its case.
  assert.equal(plainOutside("@SYNTAQX and @syntaqxx", members), "@SYNTAQX and syntaqxx");
});

test("code, addresses and team mentions are left as written", () => {
  const none = new Set<string>();
  assert.equal(
    plainOutside("Use `@mike` or\n```py\n@property\ndef x(): ...\n```\nthen @mike", none),
    "Use `@mike` or\n```py\n@property\ndef x(): ...\n```\nthen mike",
  );
  assert.equal(plainOutside("mail me@example.com, ping @acme/web", none), "mail me@example.com, ping @acme/web");
  assert.equal(plainOutside("```\n@open fence", none), "```\n@open fence");
});
