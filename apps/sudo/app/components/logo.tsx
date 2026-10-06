/**
 * Copied from apps/web/app/components/logo.tsx; keep the two in step.
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

/** The wordmark, with sudo's badge beside it. */
export function Logo({ className = "text-[1.5rem]" }: { className?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-flex items-baseline leading-none text-fg ${className}`}>
        <svg viewBox="1 1 148 68" role="img" aria-label="g1t" className="h-[0.85em] w-auto shrink-0 self-baseline">
          <Pixels of={WORD} />
        </svg>
      </span>
      <span className="rounded-full bg-merged/12 px-2 py-0.5 font-mono text-[0.7rem] font-semibold tracking-wide text-merged ring-1 ring-merged/35 ring-inset">
        sudo
      </span>
    </span>
  );
}
