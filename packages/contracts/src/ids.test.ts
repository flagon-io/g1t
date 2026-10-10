import assert from "node:assert/strict";
import { test } from "node:test";

import { idFloor, newId } from "./ids.ts";

test("an id has its prefix and a 26-character suffix, and sorts by time", () => {
  const earlier = newId("evt", 1_790_000_000_000);
  const later = newId("evt", 1_790_000_000_001);
  assert.match(earlier, /^evt_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.ok(earlier < later);
});

test("a floor bounds the ids of a span, as a range of any index that ends in the id", () => {
  const from = 1_790_000_000_000;
  const before = newId("msg", from - 1);
  const at = newId("msg", from);
  const later = newId("msg", from + 60_000);
  const floor = idFloor("msg", from);
  const ceiling = idFloor("msg", from + 60_000);
  assert.equal(floor.length, at.length);
  assert.ok(before < floor);
  assert.ok(floor < at && at < ceiling);
  // An id made at the very millisecond of the ceiling is past it.
  assert.ok(later >= ceiling);
});
