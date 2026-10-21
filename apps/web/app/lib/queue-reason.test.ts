import assert from "node:assert/strict";
import { test } from "node:test";

import { queueReason } from "./queue-reason.ts";

const LOCKED = "This repository is being copied into a fork. Try again in a few minutes; if it lasts more than an hour, g1t staff release it.";

test("an entry waiting on a refusal says it is waiting, not that it failed", () => {
  assert.deepEqual(queueReason("waiting", LOCKED), { label: "Waiting:", text: LOCKED, waiting: true });
  assert.deepEqual(queueReason("passed", LOCKED), { label: "Waiting:", text: LOCKED, waiting: true });
  // One that left says why, as before.
  assert.deepEqual(queueReason("failed", "It conflicts."), { label: null, text: "It conflicts.", waiting: false });
  assert.deepEqual(queueReason("removed", "It was closed."), { label: null, text: "It was closed.", waiting: false });
  // No reason, nothing shown.
  assert.equal(queueReason("waiting", null), null);
  assert.equal(queueReason("testing", undefined), null);
});
