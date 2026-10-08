import assert from "node:assert/strict";
import { test } from "node:test";

import { mentionSuggestions, partialMention } from "./mention.ts";

test("an @ that could become @g1t is offered", () => {
  assert.equal(partialMention("@", 1), 0);
  assert.equal(partialMention("thanks @g1", 10), 7);
  assert.equal(partialMention("(@G1", 4), 1);
  assert.equal(partialMention("line\n@g", 7), 5);
});

test("anything else is not", () => {
  // Already complete.
  assert.equal(partialMention("@g1t", 4), null);
  assert.equal(partialMention("@G1T", 4), null);
  // Longer names that start with it are other names.
  assert.equal(partialMention("@g1t-agent", 10), null);
  assert.equal(partialMention("@g1t-a", 6), null);
  assert.equal(partialMention("@g1t/g1t", 8), null);
  assert.equal(partialMention("@g1tx", 5), null);
  // Another name.
  assert.equal(partialMention("@ana", 4), null);
  // An email address.
  assert.equal(partialMention("me@g1", 5), null);
  // The caret is not at the end of it.
  assert.equal(partialMention("@g1 later", 9), null);
});

const TEAMS = ["@acme/backend", "@acme/backend-oncall", "@acme/web", "@acme/design", "@acme/docs", "@acme/data"];

test("@g1t is offered with no teams, as before", () => {
  assert.deepEqual(mentionSuggestions("thanks @g1", 10), { start: 7, options: ["@g1t"] });
  assert.deepEqual(mentionSuggestions("@", 1), { start: 0, options: ["@g1t"] });
  assert.equal(mentionSuggestions("@g1t", 4), null);
  assert.equal(mentionSuggestions("me@g1", 5), null);
  assert.equal(mentionSuggestions("@ana", 4), null);
  assert.equal(mentionSuggestions("@g1 later", 9), null);
});

test("teams complete from the workspace or from their own name", () => {
  assert.deepEqual(mentionSuggestions("cc @acme/b", 10, TEAMS), { start: 3, options: ["@acme/backend", "@acme/backend-oncall"] });
  assert.deepEqual(mentionSuggestions("@back", 5, TEAMS), { start: 0, options: ["@acme/backend", "@acme/backend-oncall"] });
  assert.deepEqual(mentionSuggestions("(@ACME/W", 8, TEAMS), { start: 1, options: ["@acme/web"] });
  // Handles given without their @ work the same.
  assert.deepEqual(mentionSuggestions("@we", 3, ["acme/web"]), { start: 0, options: ["@acme/web"] });
});

test("at most five, @g1t first, and nothing once one is typed in full", () => {
  const all = mentionSuggestions("@", 1, TEAMS);
  assert.equal(all?.options.length, 5);
  assert.equal(all?.options[0], "@g1t");
  assert.equal(mentionSuggestions("@acme/web", 9, TEAMS), null);
  assert.equal(mentionSuggestions("@acme/x", 7, TEAMS), null);
  assert.equal(mentionSuggestions("@acme/web later", 15, TEAMS), null);
});
