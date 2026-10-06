/**
 * The geometry and timing behind g1t's artwork (components/art.tsx). Pure,
 * so it is tested on its own.
 */

/** Isometric projection: x runs down-right, y down-left, z up. */
const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;

export type Point = [number, number];

/** A point on the floor (or at height `z`), as it is drawn on the page. */
export function iso(x: number, y: number, z = 0): Point {
  return [(x - y) * COS, (x + y) * SIN - z];
}

/** Points for a `<polygon>` or `<polyline>`, to one decimal place. */
export function pts(points: Point[]): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

/** A path's `d` through floor points at height `z`. */
export function isoPath(points: Point[], z = 0): string {
  return points
    .map(([x, y], index) => {
      const [px, py] = iso(x, y, z);
      return `${index === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(" ");
}

/**
 * When each of `count` things starts within one loop of `period` seconds,
 * spread evenly from `from` and never past the loop, as CSS delays.
 */
export function stagger(count: number, period: number, from = 0): string[] {
  if (count <= 0) return [];
  const step = (period - from) / count;
  return Array.from({ length: count }, (_, index) => `${round(from + index * step)}s`);
}

/** The CSS custom properties an animated piece reads: its loop and its start. */
export function timing(dur: number, delay: number | string = 0): Record<string, string> {
  return { "--dur": `${round(dur)}s`, "--delay": typeof delay === "number" ? `${round(delay)}s` : delay };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
