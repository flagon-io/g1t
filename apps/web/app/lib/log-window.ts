/**
 * Drawing a long log a screenful at a time. A step's log past a few
 * thousand rows draws only the rows on screen and a few around them, with
 * space above and below standing in for the rest, so a 50,000-line log
 * opens, grows and scrolls as fast as a short one. Rows are one line high
 * until they are drawn and measured (a long line wraps), and the space
 * kept for them is corrected then.
 */

/** Past this many rows, a step's log draws only what is on screen. */
export const WINDOW_FROM = 2000;
/** A row's height before it is measured: one line of `text-xs leading-5`. */
export const ROW_HEIGHT = 20;
/** How far past the screen rows are drawn, above and below, in pixels. */
export const OVERSCAN = 800;

/**
 * Where each row starts, from the top of the log: `starts[i]` for row `i`,
 * and `starts[rows]` for the log's whole height. `height(i)` is a row's
 * measured height, or undefined for the estimate.
 */
export function rowStarts(rows: number, height: (index: number) => number | undefined): Float64Array {
  const starts = new Float64Array(rows + 1);
  for (let i = 0; i < rows; i++) starts[i + 1] = starts[i]! + (height(i) ?? ROW_HEIGHT);
  return starts;
}

/** The first row that ends below `y`: the row at `y`, or the last. */
export function rowAt(starts: Float64Array, y: number): number {
  const rows = starts.length - 1;
  let low = 0;
  let high = rows;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (starts[middle + 1]! <= y) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, rows - 1));
}

/**
 * The rows to draw, `[from, to)`, for a view from `top` to `bottom`
 * (pixels from the top of the log; either may be past its ends), with
 * `overscan` pixels more either side.
 */
export function windowOf(starts: Float64Array, top: number, bottom: number, overscan = OVERSCAN): [number, number] {
  const rows = starts.length - 1;
  if (rows === 0) return [0, 0];
  const total = starts[rows]!;
  const from = top - overscan;
  const to = bottom + overscan;
  if (to <= 0 || from >= total) {
    // Off screen: draw a few rows at the end nearest the view, so the
    // log has something to measure and its end can be followed.
    return from >= total ? [Math.max(0, rows - 20), rows] : [0, Math.min(rows, 20)];
  }
  return [rowAt(starts, Math.max(0, from)), rowAt(starts, to) + 1];
}
