import assert from "node:assert/strict";
import { test } from "node:test";

import { mentionSuggestions } from "./mention.ts";

const TEAMS = ["@acme/backend", "@acme/backend-oncall", "@acme/web", "@acme/design", "@acme/docs", "@acme/data"];

test("with no handles nothing is offered", () => {
  assert.equal(mentionSuggestions("thanks @g1", 10), null);
  assert.equal(mentionSuggestions("@", 1), null);
});

test("teams complete from the workspace or from their own name", () => {
  assert.deepEqual(mentionSuggestions("cc @acme/b", 10, TEAMS), { start: 3, options: ["@acme/backend", "@acme/backend-oncall"] });
  assert.deepEqual(mentionSuggestions("@back", 5, TEAMS), { start: 0, options: ["@acme/backend", "@acme/backend-oncall"] });
  assert.deepEqual(mentionSuggestions("(@ACME/W", 8, TEAMS), { start: 1, options: ["@acme/web"] });
  // Handles given without their @ work the same.
  assert.deepEqual(mentionSuggestions("@we", 3, ["acme/web"]), { start: 0, options: ["@acme/web"] });
  // An email address, and a caret not at the end of it, are not mentions.
  assert.equal(mentionSuggestions("me@acme/w", 9, TEAMS), null);
  assert.equal(mentionSuggestions("@acme/w later", 13, TEAMS), null);
});

test("at most five, and nothing once one is typed in full", () => {
  const all = mentionSuggestions("@", 1, TEAMS);
  assert.equal(all?.options.length, 5);
  assert.equal(all?.options[0], "@acme/backend");
  assert.equal(mentionSuggestions("@acme/web", 9, TEAMS), null);
  assert.equal(mentionSuggestions("@acme/x", 7, TEAMS), null);
  assert.equal(mentionSuggestions("@acme/web later", 15, TEAMS), null);
});
