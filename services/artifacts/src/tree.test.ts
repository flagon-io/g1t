import assert from "node:assert/strict";
import { test } from "node:test";

import { STEP, ancestors, childrenOf, descendants, exportPaths, fileName, lastPosition, placeBefore, wouldCycle } from "./tree.ts";

const rows = [
  { id: "a", parent_id: null, position: 1024, title: "Alpha" },
  { id: "b", parent_id: null, position: 2048, title: "Beta" },
  { id: "c", parent_id: "a", position: 1024, title: "Child" },
  { id: "d", parent_id: "c", position: 1024, title: "Deep" },
];

test("children come in position order", () => {
  assert.deepEqual(
    childrenOf(rows, null).map((r) => r.id),
    ["a", "b"],
  );
  assert.equal(lastPosition(rows, null), 2048 + STEP);
  assert.equal(lastPosition(rows, "b"), STEP);
});

test("placing before a sibling takes the midpoint", () => {
  const placed = placeBefore(rows, "x", null, "b");
  assert.equal(placed.position, 1536);
  assert.equal(placed.renumber.size, 0);
  assert.ok(placeBefore(rows, "x", null, "a").position < 1024);
  assert.equal(placeBefore(rows, "x", null, null).position, 2048 + STEP);
});

test("moving a page among its own siblings ignores where it was", () => {
  // b before a: b is not its own neighbour.
  const placed = placeBefore(rows, "b", null, "a");
  assert.ok(placed.position < 1024);
});

test("siblings too close together are renumbered", () => {
  const tight = [
    { id: "p", parent_id: null, position: 1 },
    { id: "q", parent_id: null, position: 1 + 1e-7 },
  ];
  const placed = placeBefore(tight, "x", null, "q");
  assert.equal(placed.renumber.size, 2);
  assert.ok(placed.position > placed.renumber.get("p")! && placed.position < placed.renumber.get("q")!);
});

test("a page can't move under itself or its own descendants", () => {
  assert.equal(wouldCycle(rows, "a", "d"), true);
  assert.equal(wouldCycle(rows, "a", "a"), true);
  assert.equal(wouldCycle(rows, "d", "b"), false);
  assert.equal(wouldCycle(rows, "c", null), false);
});

test("descendants and ancestors", () => {
  assert.deepEqual(descendants(rows, "a").sort(), ["a", "c", "d"]);
  assert.deepEqual(
    ancestors(rows, "d").map((r) => r.id),
    ["a", "c"],
  );
  assert.deepEqual(ancestors(rows, "a"), []);
});

test("export paths follow the tree and stay unique", () => {
  const paths = exportPaths([...rows, { id: "e", parent_id: null, position: 4000, title: "alpha" }, { id: "f", parent_id: null, position: 5000, title: "a/b: c?" }]);
  assert.equal(paths.get("a"), "Alpha.md");
  assert.equal(paths.get("c"), "Alpha/Child.md");
  assert.equal(paths.get("d"), "Alpha/Child/Deep.md");
  assert.equal(paths.get("e"), "alpha (2).md");
  assert.equal(paths.get("f"), "a b c.md");
  assert.equal(fileName("..."), "Untitled");
});
