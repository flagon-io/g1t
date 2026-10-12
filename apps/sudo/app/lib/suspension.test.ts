import assert from "node:assert/strict";
import { test } from "node:test";

import { isSuspensionHold, parseReason, suspensionHold } from "./suspension.ts";

test("a suspension's hold is known as one, so lifting it lifts the hold", () => {
  const hold = suspensionHold("  card testing  ");
  assert.equal(hold, "Suspended: card testing");
  assert.ok(isSuspensionHold(hold));
  assert.ok(!isSuspensionHold("Unpaid invoice"));
  assert.ok(!isSuspensionHold(null));
});

test("a reason is required, and kept short", () => {
  assert.deepEqual(parseReason("  spam   sign-ups "), { ok: true, value: "spam sign-ups" });
  assert.equal(parseReason("x").ok, false);
  assert.equal(parseReason("x".repeat(501)).ok, false);
});
