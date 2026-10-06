/**
 * g1t's logo: G1T in 5×7 pixel capitals, the 1 in lavender. Each pixel is
 * its own square, 0.8 of its cell. The icon is the 1 alone. The same
 * shapes as the favicon and the brand files in .g1t/brand and public/brand.
 * The product name stays "g1t" in text; only the artwork is capitals.
 */

const G = [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."];
const ONE = ["..#..", ".##..", "#.#..", "..#..", "..#..", "..#..", "#####"];
const T = ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."];

type Pixel = { x: number; y: number; one: boolean };

function pixels(rows: string[], dx: number, one: boolean): Pixel[] {
  return rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === "#" ? [{ x: dx + x, y, one }] : [])));
}

/** G at 0, the 1 at 6, the T at 10: its bar tucks in over the 1's foot. */
const WORD = [...pixels(G, 0, false), ...pixels(ONE, 6, true), ...pixels(T, 10, false)];
const ICON = pixels(ONE, 0, true);

/** Cells of 10 units, squares of 8, centred. */
function Pixels({ of }: { of: Pixel[] }) {
  return of.map((p) => (
    <rect
      key={`${p.x}.${p.y}`}
      x={p.x * 10 + 1}
      y={p.y * 10 + 1}
      width="8"
      height="8"
      fill={p.one ? "var(--g1t-merged)" : "currentColor"}
    />
  ));
}

/**
 * The icon: the pixel 1, centred in a square. `tight` crops to the ink, for
 * setting it beside type, where it must stand on the baseline.
 */
export function Mark({ className, tight = false }: { className?: string; tight?: boolean }) {
  return (
    <svg viewBox={tight ? "1 1 48 68" : "-15 -5 80 80"} className={className} aria-hidden="true">
      <Pixels of={ICON} />
    </svg>
  );
}

/**
 * The wordmark as one picture, sized by its font size: a cell is 0.125em,
 * so the letters stand 0.85em tall on the baseline, about the height of
 * the type around them.
 */
export function Logo({ className = "text-[1.5rem]" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline leading-none text-fg ${className}`}>
      <svg
        viewBox="1 1 148 68"
        role="img"
        aria-label="g1t"
        className="h-[0.85em] w-auto shrink-0 self-baseline"
      >
        <Pixels of={WORD} />
      </svg>
    </span>
  );
}

const FOUR = ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."];
const ZERO = [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."];
/** 4 at 0, the 0 at 6, 4 at 12: the logo's cells and spacing. */
const FOUR_O_FOUR = [...pixels(FOUR, 0, false), ...pixels(ZERO, 6, true), ...pixels(FOUR, 12, false)];

/**
 * 404 in the logo's pixels, the 0 in lavender where the logo has its 1.
 * Sized by its font size, like the wordmark.
 */
export function Pixel404({ className = "text-[4rem]" }: { className?: string }) {
  return (
    <span className={`inline-flex leading-none text-fg ${className}`}>
      <svg viewBox="1 1 168 68" role="img" aria-label="404" className="h-[0.85em] w-auto shrink-0" shapeRendering="crispEdges">
        <Pixels of={FOUR_O_FOUR} />
      </svg>
    </span>
  );
}
