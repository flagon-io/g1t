import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_PINS, placePin, recentAfterPins, reorderPins } from "./pins.ts";

test("a pin goes at the end, or where it is asked for", () => {
  assert.deepEqual(placePin([], "a"), ["a"]);
  assert.deepEqual(placePin(["a", "b"], "c"), ["a", "b", "c"]);
  assert.deepEqual(placePin(["a", "b"], "c", 0), ["c", "a", "b"]);
  assert.deepEqual(placePin(["a", "b"], "c", 1), ["a", "c", "b"]);
  // Past either end lands at that end.
  assert.deepEqual(placePin(["a", "b"], "c", 99), ["a", "b", "c"]);
  assert.deepEqual(placePin(["a", "b"], "c", -3), ["c", "a", "b"]);
});

test("pinning one already pinned moves it, never twice", () => {
  assert.deepEqual(placePin(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
  assert.deepEqual(placePin(["a", "b", "c"], "a"), ["b", "c", "a"]);
});

test("a workspace holds a limited number of pins", () => {
  const full = Array.from({ length: MAX_PINS }, (_, i) => `p${i}`);
  assert.equal(placePin(full, "new"), null);
  // Moving one that is already there is still fine.
  assert.deepEqual(placePin(full, "p3", 0)?.[0], "p3");
  assert.equal(placePin(full.slice(1), "new")?.length, MAX_PINS);
});

test("reordering names every pin once and nothing else", () => {
  assert.deepEqual(reorderPins(["a", "b", "c"], ["c", "a", "b"]), { ok: true, order: ["c", "a", "b"] });
  assert.equal(reorderPins(["a", "b"], ["a", "a"]).ok, false);
  assert.equal(reorderPins(["a", "b"], ["a"]).ok, false);
  assert.equal(reorderPins(["a", "b"], ["a", "b", "z"]).ok, false);
  assert.deepEqual(reorderPins([], []), { ok: true, order: [] });
});

test("recent leaves out what is pinned and keeps the latest few", () => {
  const visited = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id }));
  assert.deepEqual(
    recentAfterPins(visited, ["b", "d"]).map((p) => p.id),
    ["a", "c", "e", "f", "g"],
  );
  assert.deepEqual(recentAfterPins(visited, [], 2).map((p) => p.id), ["a", "b"]);
});
