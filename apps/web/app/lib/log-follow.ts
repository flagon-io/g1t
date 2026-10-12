/**
 * Following a running step's log: where the end of the log is against what
 * the viewer can see. Pure; the hook that uses it is `useFollow` in
 * routes/repo/actions-run.tsx.
 *
 * The end of the log is a marker after its last line. What covers the
 * bottom of the window (a phone's tab bar, and room to breathe under the
 * last line) is the marker's `scroll-margin-bottom`, so scrolling it into
 * view and judging whether it is in view read the same number.
 */

/** How far past what can be seen the end may be and still count as reached: rounding, not a row. */
export const FOLLOW_SLACK = 2;

export type EndBox = { top: number; bottom: number; width: number; height: number };

/**
 * Where the end of the log is: folded away (a closed step draws nothing),
 * in view above whatever covers the window's bottom (the viewer is
 * reading the latest), or below it.
 */
export function endPlace(end: EndBox | null, view: { height: number; covered: number }): "folded" | "here" | "below" {
  if (!end || (end.width === 0 && end.height === 0)) return "folded";
  return end.bottom <= view.height - view.covered + FOLLOW_SLACK ? "here" : "below";
}
