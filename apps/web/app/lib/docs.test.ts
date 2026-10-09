import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTree, canDo, coverStyle, cursorColour, flatten, pageIdOf, pagePath, pathTo, readingTime, snippetParts } from "./docs.ts";

const id = "pag_01jb2k7x9hfq0b3zj0f5s2m8ra";

const nodes = [
  { id: "b", parent_id: null, position: 2, title: "B", icon: null, slug: "b" },
  { id: "a", parent_id: null, position: 1, title: "A", icon: null, slug: "a" },
  { id: "c", parent_id: "a", position: 1, title: "C", icon: null, slug: "c" },
  { id: "orphan", parent_id: "gone", position: 3, title: "O", icon: null, slug: "o" },
];

test("the tree orders each level and lifts pages whose parent is gone", () => {
  const tree = buildTree(nodes);
  assert.deepEqual(
    tree.map((n) => n.id),
    ["a", "b", "orphan"],
  );
  assert.equal(tree[0]!.children[0]!.id, "c");
  assert.equal(tree[0]!.children[0]!.depth, 1);
  assert.deepEqual(
    flatten(tree).map((n) => n.id),
    ["a", "c", "b", "orphan"],
  );
  assert.deepEqual(pathTo(nodes, "c"), ["a"]);
});

test("page addresses carry the id, read back from the end", () => {
  assert.equal(pagePath("acme", "eng", "Release plan!", id), `/acme/-/docs/eng/release-plan-${id}`);
  assert.equal(pagePath("acme", "eng", "", id), `/acme/-/docs/eng/${id}`);
  assert.equal(pageIdOf(`old-title-${id}`), id);
  assert.equal(pageIdOf("settings"), null);
});

test("snippets mark their matches", () => {
  assert.deepEqual(snippetParts("a [[b]] c"), [
    { text: "a ", match: false },
    { text: "b", match: true },
    { text: " c", match: false },
  ]);
});

test("covers, colours, roles, reading time", () => {
  assert.match(coverStyle("gradient:1")!, /^linear-gradient/);
  assert.match(coverStyle("https://g1tusercontent.com/docs-files/x")!, /url\("https:/);
  assert.equal(coverStyle("javascript:alert(1)"), null);
  assert.equal(cursorColour("ana"), cursorColour("ana"));
  assert.equal(canDo("edit", "comment"), true);
  assert.equal(canDo("comment", "edit"), false);
  assert.deepEqual(readingTime("one two three"), { words: 3, minutes: 1 });
});
