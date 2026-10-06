import assert from "node:assert/strict";
import { test } from "node:test";

import { workOwner } from "../../../../packages/contracts/src/work.ts";
import { madeByG1t, openedBy } from "./opened-by.ts";

const syntaqx = { id: "usr_1", username: "syntaqx" };
const g1t = { id: "usr_g1t_agent", username: "g1t", kind: "agent" as const };

test("a pull request g1t made shows g1t, requested by whoever asked", () => {
  const pull = { agent: "g1t", branch: null, author: g1t, requestedBy: syntaqx };
  assert.equal(madeByG1t(pull), true);
  assert.deepEqual(openedBy(pull), { name: "g1t", requestedBy: "syntaqx" });
  // It is theirs to manage, as their own would be.
  assert.equal(workOwner(pull).id, "usr_1");
});

test("anything else shows its author", () => {
  // Someone's own agent.
  assert.deepEqual(openedBy({ author: syntaqx, requestedBy: null }), { name: "syntaqx", requestedBy: null });
  // A branch pushed to the repository, even with g1t named on it.
  assert.equal(madeByG1t({ agent: "g1t", branch: "fix-login" }), false);
  assert.equal(workOwner({ author: syntaqx, requestedBy: null }).id, "usr_1");
});

test("work g1t started itself names nobody as asking", () => {
  const pull = { author: { id: "g1t", username: "g1t", kind: "system" as const }, requestedBy: null };
  assert.deepEqual(openedBy(pull), { name: "g1t", requestedBy: null });
  assert.equal(workOwner(pull).username, "g1t");
});
