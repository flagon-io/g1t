import assert from "node:assert/strict";
import { test } from "node:test";

import type { FileDiff } from "@g1t/contracts";

import { diffContent, htmlOfFile, withHtml } from "./diff.ts";
import { highlightFile } from "./shiki.ts";

const FILE: FileDiff = {
  path: "src/lib.rs",
  status: "modified",
  additions: 2,
  deletions: 1,
  binary: false,
  hunks: [
    {
      lines: [
        { kind: "context", old: 1, new: 1, text: "fn main() {" },
        { kind: "delete", old: 2, new: null, text: '    println!("old");' },
        { kind: "add", old: null, new: 2, text: '    println!("new");' },
        { kind: "add", old: null, new: 3, text: "" },
        { kind: "context", old: 3, new: 4, text: "}" },
      ],
    },
    { lines: [{ kind: "add", old: null, new: 10, text: "// end" }] },
  ],
};

test("a highlighted file's HTML, kept apart and given back, is the same highlighted file", async () => {
  const highlighted = await highlightFile(FILE);
  assert.ok(highlighted);
  const html = htmlOfFile(highlighted);
  assert.equal(html.length, 2);
  assert.ok(html[0]!.every((row) => row !== null));
  // Through the data centre's cache it travels as JSON.
  const kept = JSON.parse(JSON.stringify(html));
  assert.deepEqual(withHtml(FILE, kept), highlighted);
});

test("lines without HTML stay without it", () => {
  const html = [[null, "<b>x</b>", null, "", null], [null]];
  const file = withHtml(FILE, html);
  assert.equal("html" in file.hunks[0]!.lines[0]!, false);
  assert.equal(file.hunks[0]!.lines[1]!.html, "<b>x</b>");
  // An empty line's HTML is kept: it is not the same as none.
  assert.equal(file.hunks[0]!.lines[3]!.html, "");
  assert.equal("html" in file.hunks[1]!.lines[0]!, false);
  // The diff given in is not changed.
  assert.equal("html" in FILE.hunks[0]!.lines[1]!, false);
});

test("what a file's colours depend on: each line's side and text, not its numbers or path", () => {
  const moved: FileDiff = {
    ...FILE,
    path: "other/lib.rs",
    hunks: FILE.hunks.map((hunk) => ({ lines: hunk.lines.map((line) => ({ ...line, old: 99, new: 99 })) })),
  };
  assert.equal(diffContent(moved), diffContent(FILE));
  const sideChanged: FileDiff = {
    ...FILE,
    hunks: [{ lines: FILE.hunks[0]!.lines.map((line, n) => (n === 0 ? { ...line, kind: "add" as const } : line)) }, FILE.hunks[1]!],
  };
  assert.notEqual(diffContent(sideChanged), diffContent(FILE));
  // A line split differently is different content.
  const one: FileDiff = { ...FILE, hunks: [{ lines: [{ kind: "add", old: null, new: 1, text: "a\nb" }] }] };
  const two: FileDiff = {
    ...FILE,
    hunks: [{ lines: [{ kind: "add", old: null, new: 1, text: "a" }, { kind: "add", old: null, new: 2, text: "b" }] }],
  };
  assert.notEqual(diffContent(one), diffContent(two));
});
