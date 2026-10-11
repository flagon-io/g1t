import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmsHandle, countsLine } from "./agents-archived.ts";

test("an archived agent's row says what deleting it takes, zeros left out", () => {
  assert.equal(countsLine({ sessions: 14, replies: 231, memories: 3, routines: 0 }), "14 sessions · 231 replies · 3 memories");
  assert.equal(countsLine({ sessions: 1, replies: 1, memories: 1, routines: 1 }), "1 session · 1 reply · 1 memory · 1 routine");
  assert.equal(countsLine({ sessions: 1200, replies: 0, memories: 0, routines: 0 }), "1,200 sessions");
  assert.equal(countsLine({ sessions: 0, replies: 0, memories: 0, routines: 0 }), "Nothing recorded");
});

test("deleting is confirmed by the handle, however it is typed", () => {
  assert.ok(confirmsHandle("sam", "sam"));
  assert.ok(confirmsHandle(" @Sam ", "sam"));
  assert.ok(!confirmsHandle("sam2", "sam"));
  assert.ok(!confirmsHandle("", "sam"));
});
