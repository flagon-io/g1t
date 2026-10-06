/**
 * Line links on a file: `#L12` names one line, `#L10-L20` a run of them.
 * The view reads the address on arrival, and writes it when a line number
 * is picked.
 */

/** The lines picked, first to last, both included and 1-based. */
export type LineRange = { start: number; end: number };

/**
 * The lines an address fragment names (`#L12`, `#L10-L20`, with or without
 * the `#`), in order, or null when it names none. With `lines`, a run that
 * starts past the end of the file names none, and one that runs past it
 * stops at the last line.
 */
export function parseLineHash(hash: string, lines?: number): LineRange | null {
  const match = /^#?L(\d+)(?:-L?(\d+))?$/.exec(hash);
  if (!match) return null;
  const a = Number(match[1]);
  const b = match[2] == null ? a : Number(match[2]);
  let start = Math.min(a, b);
  let end = Math.max(a, b);
  if (start < 1) start = 1;
  if (end < 1) return null;
  if (lines != null) {
    if (start > lines) return null;
    end = Math.min(end, lines);
  }
  return { start, end };
}

/** The fragment for a run of lines: `#L12`, or `#L10-L20`. */
export function formatLineHash(range: LineRange): string {
  return range.start === range.end ? `#L${range.start}` : `#L${range.start}-L${range.end}`;
}

/**
 * What picking `line` selects. A plain pick is that line alone; a pick
 * with shift held runs from the line already picked (the first of a run)
 * to this one, whichever way round they are.
 */
export function pickLine(current: LineRange | null, line: number, extend: boolean): LineRange {
  if (!extend || !current) return { start: line, end: line };
  const anchor = current.start;
  return { start: Math.min(anchor, line), end: Math.max(anchor, line) };
}

/** Whether `line` is in the run picked. */
export function inRange(range: LineRange | null, line: number): boolean {
  return range != null && range.start <= line && line <= range.end;
}
