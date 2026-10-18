/**
 * The week's figures on the Workspace overview (lib/signals.ts), each
 * against the week before and drawn over ten, and the trend line they and
 * Home's week (components/home-week.tsx) draw with.
 */
import { useId, useState } from "react";
import { Link } from "react-router";

import { cn } from "../lib/cn";
import type { PulseTile } from "../lib/signals";
import { Skeleton } from "./ui/skeleton";

// --- A trend line -------------------------------------------------------------------

/**
 * A measure over the weeks as a thin line, the latest point marked. Weeks
 * with nothing to measure break the line. Pointing at a week (or moving
 * along with the arrow keys) says its value through `onPoint`; every
 * value is also in a list for screen readers.
 */
export function TrendLine({
  values,
  points,
  label,
  width = 120,
  height = 28,
  onPoint,
}: {
  values: (number | null)[];
  points: string[];
  label: string;
  width?: number;
  height?: number;
  onPoint?: (index: number | null) => void;
}) {
  const [active, setActive] = useState<number | null>(null);
  const list = useId();
  const known = values.filter((value): value is number => value != null);
  if (known.length === 0) return <div style={{ width, height }} aria-hidden />;
  const pad = 4;
  const min = Math.min(...known);
  const max = Math.max(...known);
  const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : 0;
  const x = (i: number) => pad + i * step;
  const y = (value: number) => (max === min ? height / 2 : pad + (1 - (value - min) / (max - min)) * (height - 2 * pad));
  // One path, lifted where a week has nothing.
  let d = "";
  values.forEach((value, i) => {
    if (value == null) return;
    d += `${i > 0 && values[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
  });
  const last = values.length - 1 - [...values].reverse().findIndex((value) => value != null);
  const point = (index: number | null) => {
    setActive(index);
    onPoint?.(index);
  };
  const shown = active ?? last;
  return (
    <>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block overflow-visible outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-accent/40"
        role="img"
        aria-label={label}
        aria-describedby={list}
        tabIndex={0}
        onMouseLeave={() => point(null)}
        onBlur={() => point(null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const from = active ?? last;
          point(Math.max(0, Math.min(values.length - 1, from + (event.key === "ArrowLeft" ? -1 : 1))));
        }}
      >
        {active != null && <line x1={x(active)} x2={x(active)} y1={0} y2={height} className="stroke-line-strong" strokeWidth={1} />}
        <path d={d} fill="none" className="stroke-muted" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        {values[shown] != null && <circle cx={x(shown)} cy={y(values[shown]!)} r={3.5} className="fill-accent" stroke="var(--color-surface)" strokeWidth={2} />}
        {values.map((_, i) => (
          <rect key={i} x={x(i) - step / 2} y={-4} width={Math.max(step, 8)} height={height + 8} fill="transparent" onMouseEnter={() => point(i)} />
        ))}
      </svg>
      <ul id={list} className="sr-only">
        {points.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ul>
    </>
  );
}

// --- The pulse ----------------------------------------------------------------------

const TONE: Record<"good" | "bad" | "flat", string> = {
  good: "bg-success/12 text-success",
  bad: "bg-danger/10 text-danger",
  flat: "bg-line text-muted",
};

const TONE_WORDS: Record<"good" | "bad" | "flat", string> = { good: "better than last week", bad: "worse than last week", flat: "the same as last week" };

function Tile({ tile }: { tile: PulseTile }) {
  const [point, setPoint] = useState<number | null>(null);
  return (
    <div className="group relative flex min-w-0 flex-col gap-2 bg-surface px-4 py-3.5 transition-colors hover:bg-raised">
      <Link to={tile.to} className="truncate text-xs text-muted after:absolute after:inset-0 group-hover:text-fg">
        {tile.label}
      </Link>
      <div className="flex items-center gap-2">
        <span className="text-2xl leading-none font-semibold tracking-tight text-fg">{tile.value}</span>
        {tile.delta && (
          <span className={cn("rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium tabular-nums", TONE[tile.delta.tone])}>
            {tile.delta.text}
            <span className="sr-only">, {TONE_WORDS[tile.delta.tone]}</span>
          </span>
        )}
      </div>
      {/* Above the link's cover, so pointing at a week says it. */}
      <div className="relative">
        <TrendLine values={tile.series} points={tile.points} label={`${tile.label} over the last ${tile.series.length} weeks`} width={132} onPoint={setPoint} />
      </div>
      <p className="truncate text-[0.6875rem] text-faint">{point != null ? tile.points[point] : tile.hint}</p>
    </div>
  );
}

/** The past week in four figures, across the top of Home. */
export function PulseStrip({ tiles }: { tiles: PulseTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <section
      aria-label="The past week"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-[6.5rem_repeat(4,minmax(0,1fr))]"
    >
      <div className="col-span-2 flex items-center bg-surface px-4 py-2 lg:col-span-1 lg:py-0">
        <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted uppercase">Past week</p>
      </div>
      {tiles.map((tile) => (
        <Tile key={tile.key} tile={tile} />
      ))}
    </section>
  );
}

export function PulseSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-[6.5rem_repeat(4,minmax(0,1fr))]">
      <div className="col-span-2 bg-surface px-4 py-3 lg:col-span-1" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-2 bg-surface px-4 py-3.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-5 w-32" />
        </div>
      ))}
    </div>
  );
}
