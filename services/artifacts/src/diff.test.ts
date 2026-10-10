import assert from "node:assert/strict";
import { test } from "node:test";

import { diffLines, diffStats } from "./diff.ts";

test("a line diff keeps what stayed and marks what changed", () => {
  const lines = diffLines("# Title\n\nold line\nkept\n", "# Title\n\nnew line\nkept\nadded\n");
  assert.deepEqual(lines, [
    { op: "same", text: "# Title" },
    { op: "same", text: "" },
    { op: "del", text: "old line" },
    { op: "add", text: "new line" },
    { op: "same", text: "kept" },
    { op: "add", text: "added" },
  ]);
  assert.deepEqual(diffStats(lines), { added: 2, removed: 1 });
});

test("from nothing, everything is added", () => {
  assert.deepEqual(diffLines("", "a\nb"), [
    { op: "add", text: "a" },
    { op: "add", text: "b" },
  ]);
});
