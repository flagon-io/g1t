import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTree, canDo, citationHref, coverStyle, cursorColour, dayGroups, dayKey, flatten, linkedArtifacts, pathTo, readingTime, repoFilePath, repoFolders, snippetParts, spacePath } from "./folios.ts";

const node = (id: string, parent_id: string | null, position: number) => ({ id, kind: "doc" as const, parent_id, position, title: id.toUpperCase(), icon: null, slug: id, restricted: false });

const nodes = [node("b", null, 2), node("a", null, 1), node("c", "a", 1), node("orphan", "gone", 3)];

test("the tree orders each level and lifts folios whose parent isn't there", () => {
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

test("the home list groups by the viewer's day: Today, Yesterday, then dates", () => {
  const now = new Date("2026-10-09T15:00:00Z");
  const items = ["2026-10-09T14:00:00Z", "2026-10-09T01:00:00Z", "2026-10-08T20:00:00Z", "2026-10-07T12:00:00Z", "2025-12-31T12:00:00Z"];
  const utc = dayGroups(items, (i) => i, "UTC", now);
  assert.deepEqual(
    utc.map((g) => [g.label, g.items.length]),
    [
      ["Today", 2],
      ["Yesterday", 1],
      ["Oct 7", 1],
      ["Dec 31, 2025", 1],
    ],
  );
  // At 01:00 UTC it is still the 8th in Chicago: that one is yesterday's there.
  const chicago = dayGroups(items, (i) => i, "America/Chicago", now);
  assert.deepEqual(
    chicago.map((g) => [g.label, g.items.length]),
    [
      ["Today", 1],
      ["Yesterday", 2],
      ["Oct 7", 1],
      ["Dec 31, 2025", 1],
    ],
  );
  assert.equal(dayKey("2026-10-09T01:00:00Z", "America/Chicago"), "2026-10-08");
});

test("chat messages name the artifacts they link to, in this workspace only", () => {
  const id = "fol_01jb2k7x9hfq0b3zj0f5s2m8ra";
  const other = "fol_01jb2k7x9hfq0b3zj0f5s2m8rb";
  assert.deepEqual(linkedArtifacts(`See https://g1t.sh/acme/-/artifacts/q4-plan-${id} and /acme/-/artifacts/${other}, and again /Acme/-/artifacts/${id}`, "acme"), [id, other]);
  assert.deepEqual(linkedArtifacts(`/other/-/artifacts/x-${id}`, "acme"), []);
  assert.deepEqual(linkedArtifacts(`/acme/-/artifacts/spaces/general`, "acme"), []);
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

test("a citation links to its code, a glob to the folder it starts from", () => {
  assert.equal(citationHref({ repo: "acme/web", path: "src/export.ts", ref: "abc1234" }), "/acme/web/blob/abc1234/src/export.ts");
  assert.equal(citationHref({ repo: "acme/web", path: "src/jobs", ref: null }), "/acme/web/tree/HEAD/src/jobs");
  assert.equal(citationHref({ repo: "acme/web", path: "src/**/*.sql", ref: "abc" }), "/acme/web/tree/abc/src");
});

test("a project's docs become folders, and spaces and files have addresses under Artifacts", () => {
  const root = repoFolders([
    { path: "README.md", title: "Acme" },
    { path: "docs/setup.md", title: "Setup" },
    { path: "docs/guides/deploy.md", title: "Deploy" },
  ]);
  assert.deepEqual(
    root.files.map((f) => f.path),
    ["README.md", "docs/setup.md"],
  );
  assert.equal(root.folders[0]!.name, "guides");
  assert.deepEqual(root.folders[0]!.files.map((f) => f.title), ["Deploy"]);
  assert.equal(repoFilePath("acme", "acme/web", "docs/a b.md"), "/acme/-/artifacts/repo/acme/web/docs/a%20b.md");
  assert.equal(spacePath("acme", "general"), "/acme/-/artifacts/spaces/general");
});
