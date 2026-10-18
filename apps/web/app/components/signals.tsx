/**
 * The daily signal on Home (lib/signals.ts): the past week in four
 * figures, each against the week before and drawn over ten, and the
 * findings worth a look today, each a sentence with its evidence, where
 * to see it, and a way to ask g1t about it.
 */
import { ChevronRight, MessageSquare, TriangleAlert } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link } from "react-router";

import { askG1t } from "../lib/ask";
import { cn } from "../lib/cn";
import type { DailySignal as DailySignalView, PulseTile, Signal } from "../lib/signals";
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

// --- The findings -------------------------------------------------------------------

function Facts({ facts }: { facts: string[] }) {
  return (
    <p className="font-mono text-[0.75rem] leading-relaxed text-muted">
      {facts.map((fact, i) => (
        <span key={i}>
          {i > 0 && <span className="px-1.5 text-faint">·</span>}
          {fact}
        </span>
      ))}
    </p>
  );
}

function Actions({ signal }: { signal: Signal }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {signal.link && (
        <Link to={signal.link.to} className="inline-flex items-center gap-0.5 text-sm font-medium text-accent hover:underline">
          {signal.link.label}
          <ChevronRight size={14} />
        </Link>
      )}
      <button type="button" onClick={() => askG1t(signal.ask)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <MessageSquare size={12} />
        Ask g1t
      </button>
    </div>
  );
}

function Trend({ trend }: { trend: NonNullable<Signal["trend"]> }) {
  const [point, setPoint] = useState<number | null>(null);
  return (
    <figure className="space-y-1.5">
      <TrendLine values={trend.values} points={trend.points} label={`${trend.caption}, ${trend.range}`} width={196} height={40} onPoint={setPoint} />
      <figcaption>
        <p className="text-xs text-fg-soft">{trend.caption}</p>
        <p className="font-mono text-[0.6875rem] text-faint">{point != null ? trend.points[point] : trend.range}</p>
      </figcaption>
    </figure>
  );
}

function Finding({ signal }: { signal: Signal }) {
  return (
    <li className={cn("grid gap-4 py-5 first:pt-0 last:pb-0", signal.trend && "md:grid-cols-[minmax(0,1fr)_12.5rem] md:gap-8")}>
      <div className="min-w-0 space-y-2">
        <h3 className="font-display text-lg leading-snug text-fg md:text-xl">{signal.headline}</h3>
        <Facts facts={signal.facts} />
        <Actions signal={signal} />
      </div>
      {signal.trend && (
        <div className="md:pt-1">
          <Trend trend={signal.trend} />
        </div>
      )}
    </li>
  );
}

/** Findings under the lead, before "and N more". */
const SHOWN = 4;

/**
 * The daily signal: the day, the finding that matters most as the page's
 * headline, and the others under it. A quiet week still gets a sentence.
 * Null `view`: the work service did not answer.
 */
export function DailySignal({ date, view, line, footer }: { date: string; view: DailySignalView | null; line?: ReactNode; footer?: ReactNode }) {
  const [more, setMore] = useState(false);
  const lead = view?.findings[0] ?? null;
  const rest = view?.findings.slice(1) ?? [];
  const shown = more ? rest : rest.slice(0, SHOWN);
  return (
    <section aria-labelledby="daily-signal" className="rounded-2xl border border-line bg-surface px-5 py-6 md:px-8 md:py-8">
      <p className="font-mono text-[0.6875rem] tracking-[0.16em] text-accent uppercase">Daily signal</p>
      <p className="mt-2 font-display text-xl text-fg-soft md:text-2xl">{date}</p>
      {view == null ? (
        <>
          <h1 id="daily-signal" className="mt-4 font-display text-3xl leading-tight tracking-tight text-fg md:text-[2.5rem]">
            Here&apos;s your day.
          </h1>
          <p className="mt-3 flex items-center gap-1.5 text-sm text-muted">
            <TriangleAlert size={13} className="shrink-0 text-warn" />
            What the work says couldn&apos;t be read just now, so today&apos;s findings aren&apos;t here.
          </p>
        </>
      ) : (
        <>
          <h1
            id="daily-signal"
            className="mt-4 max-w-3xl font-display text-3xl leading-[1.12] tracking-tight text-balance text-fg md:text-[2.25rem] xl:text-[2.5rem]"
          >
            {lead?.headline ?? view.quiet}
          </h1>
          {lead && (
            <div className={cn("mt-4 grid gap-4", lead.trend && "md:grid-cols-[minmax(0,1fr)_12.5rem] md:gap-8")}>
              <div className="space-y-2">
                <Facts facts={lead.facts} />
                <Actions signal={lead} />
              </div>
              {lead.trend && <Trend trend={lead.trend} />}
            </div>
          )}
          {!view.complete && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-faint">
              <TriangleAlert size={12} className="shrink-0" />
              Some projects didn&apos;t answer, so these findings leave them out.
            </p>
          )}
        </>
      )}
      {line && <p className="mt-4 text-sm text-muted">{line}</p>}
      {shown.length > 0 && (
        <>
          <hr className="my-7 border-line" />
          <ul className="divide-y divide-line">
            {shown.map((signal) => (
              <Finding key={signal.key} signal={signal} />
            ))}
          </ul>
          {rest.length > SHOWN && (
            <button type="button" onClick={() => setMore(!more)} className="mt-5 text-xs text-muted hover:text-fg">
              {more ? "Show fewer" : `${rest.length - SHOWN} more ${rest.length - SHOWN === 1 ? "finding" : "findings"}`}
            </button>
          )}
        </>
      )}
      {footer && <div className="mt-8 border-t border-line pt-6">{footer}</div>}
    </section>
  );
}

export function DailySignalSkeleton({ date }: { date: string }) {
  return (
    <section className="rounded-2xl border border-line bg-surface px-5 py-6 md:px-8 md:py-8">
      <p className="font-mono text-[0.6875rem] tracking-[0.16em] text-accent uppercase">Daily signal</p>
      <p className="mt-2 font-display text-xl text-fg-soft md:text-2xl">{date}</p>
      <Skeleton className="mt-5 h-9 w-full max-w-2xl" />
      <Skeleton className="mt-2 h-9 w-2/3 max-w-xl" />
      <Skeleton className="mt-5 h-3 w-64" />
    </section>
  );
}
