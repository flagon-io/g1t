import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_PAGE_STATE, cleanCover, cleanIcon, cleanSource, cleanTarget, cleanTitle, decodeCursor, depthOf, encodeCursor, listLimit, pageState, sharedTops, subtreeHeight, treeNodes } from "./list.ts";

test("a page carries the saved document as base64, and none when there is none or it is too large", () => {
  assert.equal(pageState(null), null);
  assert.equal(pageState(new Uint8Array(0).buffer), null);
  const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
  const carried = pageState(bytes.buffer);
  assert.ok(carried);
  assert.deepEqual(Uint8Array.from(atob(carried!), (c) => c.charCodeAt(0)), bytes);
  // D1 may hand a BLOB back as an array of numbers.
  assert.equal(pageState([104, 105]), btoa("hi"));
  assert.equal(pageState(new Uint8Array(MAX_PAGE_STATE + 1).buffer), null);
});

test("titles, icons, covers and sources are cleaned", () => {
  assert.equal(cleanTitle("  Q4   roadmap \n"), "Q4 roadmap");
  assert.equal(cleanTitle("x".repeat(300)).length, 200);
  assert.equal(cleanIcon(""), null);
  assert.equal(cleanIcon("📐 extra words"), "📐 ex");
  assert.equal(cleanCover("gradient:3"), "gradient:3");
  assert.equal(cleanCover("javascript:alert(1)"), null);
  assert.deepEqual(cleanSource({ title: "Launch thread", href: "/acme/-/chat/general?thread=1" }), { title: "Launch thread", href: "/acme/-/chat/general?thread=1" });
  assert.equal(cleanSource({ title: "x", href: "https://evil.example" }), null);
  assert.equal(cleanSource({ title: "x", href: "//evil.example" }), null);
  assert.deepEqual(cleanTarget({ kind: "section", heading: " Risks " }), { kind: "section", heading: "Risks" });
  assert.equal(cleanTarget({ kind: "nope" }), null);
});

test("the cursor goes there and back, and nonsense is no cursor", () => {
  const c = { k: "2026-10-09T03:00:00.000Z", id: "fol_01jb2k7x9hfq0b3zj0f5s2m8ra" };
  assert.deepEqual(decodeCursor(encodeCursor(c)), c);
  assert.equal(decodeCursor("not a cursor"), null);
  assert.equal(decodeCursor(null), null);
  assert.equal(listLimit(undefined), 30);
  assert.equal(listLimit(500), 100);
  assert.equal(listLimit(0), 30);
});

test("a tree puts a row under its parent only when the parent is shown", () => {
  const rows = [
    { id: "b", kind: "doc" as const, parent_id: "a", position: 2, title: "B", icon: null, inherit: 1 },
    { id: "a", kind: "doc" as const, parent_id: null, position: 1, title: "A", icon: null, inherit: 1 },
    { id: "c", kind: "doc" as const, parent_id: "hidden", position: 3, title: "C", icon: null, inherit: 0 },
  ];
  const tree = treeNodes(rows, new Set(["b"]));
  assert.deepEqual(
    tree.map((n) => [n.id, n.parent_id, n.restricted, n.stale ?? false]),
    [
      ["a", null, false, false],
      ["b", "a", false, true],
      ["c", null, true, false],
    ],
  );
  assert.equal(tree[0]!.slug, "a-a");
});

test("shared tops leave out children of what is shown and anything shown elsewhere", () => {
  const readable = [
    { id: "top", parent_id: "secret" },
    { id: "kid", parent_id: "top" },
    { id: "loose", parent_id: null },
    { id: "inspace", parent_id: null },
    { id: "underspace", parent_id: "spacedoc" },
  ];
  assert.deepEqual(
    sharedTops(readable, new Set(["inspace", "spacedoc"])).map((r) => r.id),
    ["top", "loose"],
  );
});

test("depth and height come from paths", () => {
  assert.equal(depthOf("/a/"), 1);
  assert.equal(depthOf("/a/b/c/"), 3);
  assert.equal(subtreeHeight({ path: "/a/b/" }, [{ path: "/a/b/" }, { path: "/a/b/c/" }, { path: "/a/b/c/d/" }]), 2);
});
