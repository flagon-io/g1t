import assert from "node:assert/strict";
import { test } from "node:test";

import { madeByG1t, openedBy } from "./opened-by.ts";

const author = { id: "usr_1", username: "syntaqx" };

test("a pull request g1t's agent made in a fork shows g1t, requested by its author", () => {
  const pull = { agent: "g1t", branch: null, author };
  assert.equal(madeByG1t(pull), true);
  assert.deepEqual(openedBy(pull), { name: "g1t", requestedBy: "syntaqx" });
});

test("anything else shows its author", () => {
  // Someone's own agent.
  assert.deepEqual(openedBy({ agent: "claude-code", branch: null, author }), { name: "syntaqx", requestedBy: null });
  // A branch pushed to the repository, even with g1t named on it.
  assert.equal(madeByG1t({ agent: "g1t", branch: "fix-login" }), false);
  assert.deepEqual(openedBy({ agent: "g1t", branch: "fix-login", author }), { name: "syntaqx", requestedBy: null });
});

test("work g1t started itself names nobody as asking", () => {
  const pull = { agent: "g1t", branch: null, author: { id: "g1t", username: "g1t" } };
  assert.deepEqual(openedBy(pull), { name: "g1t", requestedBy: null });
});
