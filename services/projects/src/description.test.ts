import { test } from "node:test";
import assert from "node:assert/strict";

import { ownDescription } from "./description.ts";

test("a change sets the description, clears it, or leaves it", () => {
  assert.equal(ownDescription("Old", undefined), "Old");
  assert.equal(ownDescription(null, undefined), null);
  assert.equal(ownDescription("Old", "  New  "), "New");
  assert.equal(ownDescription("Old", ""), null);
  assert.equal(ownDescription("Old", "   "), null);
  assert.equal(ownDescription("Old", null), null);
  assert.equal(ownDescription(null, "x".repeat(300))?.length, 200);
});
