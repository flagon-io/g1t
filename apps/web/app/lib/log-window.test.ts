import assert from "node:assert/strict";
import { test } from "node:test";

import { ROW_HEIGHT, rowAt, rowStarts, windowOf } from "./log-window.ts";

test("rows start where the rows above them end, measured or not", () => {
  const starts = rowStarts(4, (index) => (index === 1 ? 60 : undefined));
  assert.deepEqual([...starts], [0, ROW_HEIGHT, ROW_HEIGHT + 60, 2 * ROW_HEIGHT + 60, 3 * ROW_HEIGHT + 60]);
  assert.equal(rowAt(starts, 0), 0);
  assert.equal(rowAt(starts, ROW_HEIGHT), 1);
  assert.equal(rowAt(starts, ROW_HEIGHT + 59), 1);
  assert.equal(rowAt(starts, ROW_HEIGHT + 60), 2);
  assert.equal(rowAt(starts, 10_000), 3, "past the end is the last row");
});

test("only the rows on screen and a little around them are drawn", () => {
  const starts = rowStarts(50_000, () => undefined);
  // The screen shows rows 1000 to 1040.
  const [from, to] = windowOf(starts, 1000 * ROW_HEIGHT, 1040 * ROW_HEIGHT, 200);
  assert.deepEqual([from, to], [990, 1051]);
  // At the very end, following the newest line.
  const end = starts[50_000]!;
  assert.deepEqual(windowOf(starts, end - 800, end, 200), [49_950, 50_000]);
  // The log above or below the screen draws a few rows at the near end.
  assert.deepEqual(windowOf(starts, -5000, -4000, 200), [0, 20]);
  assert.deepEqual(windowOf(starts, end + 4000, end + 5000, 200), [49_980, 50_000]);
  assert.deepEqual(
    windowOf(
      rowStarts(0, () => undefined),
      0,
      100,
    ),
    [0, 0],
  );
});
