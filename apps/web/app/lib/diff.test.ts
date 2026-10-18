import assert from "node:assert/strict";
import { test } from "node:test";

import type { FileDiff } from "@g1t/contracts";

import { diffContent, firstScreens, htmlOfFile, linkedFile, withHtml } from "./diff.ts";
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
    hunks: [
      {
        lines: [
          { kind: "add", old: null, new: 1, text: "a" },
          { kind: "add", old: null, new: 2, text: "b" },
        ],
      },
    ],
  };
  assert.notEqual(diffContent(one), diffContent(two));
});

/** A file of `lines` added lines. */
function sized(path: string, lines: number): FileDiff {
  return {
    path,
    status: "added",
    additions: lines,
    deletions: 0,
    binary: false,
    hunks: [{ lines: Array.from({ length: lines }, (_, n) => ({ kind: "add" as const, old: null, new: n + 1, text: `line ${n}` })) }],
  };
}

const comparisonOf = (files: FileDiff[]) => ({ base: "a".repeat(40), head: "b".repeat(40), files, truncated: false });

test("a small change is sent whole", () => {
  const files = [sized("a", 10), sized("b", 300), FILE];
  const sent = firstScreens(comparisonOf(files));
  assert.deepEqual(sent.files, files);
  assert.ok(sent.files.every((file) => !file.deferred));
});

test("past the first screens' lines, files are sent with their counts but not their lines", () => {
  const files = Array.from({ length: 10 }, (_, n) => sized(`f${n}`, 400));
  const sent = firstScreens(comparisonOf(files), { budget: 2_000 });
  // 5 × 400 lines fit in 2,000; the rest wait, in order.
  assert.deepEqual(
    sent.files.map((file) => file.hunks.length > 0),
    [true, true, true, true, true, false, false, false, false, false],
  );
  const later = sent.files[7]!;
  assert.deepEqual(later.deferred, { lines: 400, large: false });
  assert.equal(later.additions, 400);
  assert.equal(later.path, "f7");
  // Once one does not fit, a smaller one after it waits too: what is drawn is the top of the change.
  const mixed = firstScreens(comparisonOf([sized("a", 800), sized("b", 900), sized("c", 10)]), { budget: 1_000 });
  assert.deepEqual(
    mixed.files.map((file) => file.deferred?.lines ?? null),
    [null, 900, 10],
  );
});

test("a very large file waits to be asked for, and does not hold back the files after it", () => {
  const sent = firstScreens(comparisonOf([sized("package-lock.json", 5_000), sized("src/a.ts", 20)]));
  assert.deepEqual(sent.files[0]!.deferred, { lines: 5_000, large: true });
  assert.equal(sent.files[0]!.hunks.length, 0);
  assert.equal(sent.files[1]!.deferred, undefined);
  assert.equal(sent.files[1]!.hunks.length, 1);
});

test("files with comments keep their lines wherever they are, however large", () => {
  const files = [sized("a", 900), sized("b", 400), sized("lock", 3_000), sized("c", 400)];
  const sent = firstScreens(comparisonOf(files), { budget: 1_000, eager: ["c", "lock"] });
  assert.deepEqual(
    sent.files.map((file) => file.deferred ?? null),
    [null, { lines: 400, large: false }, null, null],
  );
});

test("files the comparison left out wait with no counts; binary files are as they were", () => {
  const omitted: FileDiff = { ...sized("z", 0), hunks: [], additions: 0, omitted: true };
  const binary: FileDiff = { ...sized("logo.png", 0), hunks: [], binary: true };
  const sent = firstScreens(comparisonOf([omitted, binary]));
  assert.deepEqual(sent.files[0]!.deferred, { lines: null, large: false });
  assert.equal(sent.files[1]!.deferred, undefined);
  assert.equal(sent.files[1]!.binary, true);
});

test("a link to a file names it by path, encoded or not, and only a file of the change", () => {
  const files = [{ path: "src/a b.ts" }, { path: "README.md" }];
  assert.equal(linkedFile("#file-README.md", files), "README.md");
  assert.equal(linkedFile("#diff-src/a%20b.ts", files), "src/a b.ts");
  assert.equal(linkedFile("#file-src/a b.ts", files), "src/a b.ts");
  assert.equal(linkedFile("#file-missing.ts", files), null);
  assert.equal(linkedFile("#readme", files), null);
  assert.equal(linkedFile("", files), null);
  assert.equal(linkedFile("#file-%E0%A4%A", files), null);
});
