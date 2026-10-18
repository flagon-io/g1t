/**
 * Home's week (lib/signals.ts): the week in a sentence and four figures,
 * the last two weeks day by day (what agents and people landed), and what
 * is worth a look, each pinned to the day it happened where it happened
 * on one. The page leads with what needs you; this is the work's own
 * account, so it never says whether anything needs anyone.
 */
import { ChevronRight, MessageSquare, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { askG1t } from "../lib/ask";
import { cn } from "../lib/cn";
import type { DailySignal, DayBar, PulseTile, Signal } from "../lib/signals";
import { TrendLine } from "./signals";
import { Hint } from "./ui/hint";
import { Skeleton } from "./ui/skeleton";

const DELTA_TONE: Record<"good" | "bad" | "flat", string> = { good: "text-success", bad: "text-danger", flat: "text-faint" };

/** One figure: what it counts, this week's value, and the change on last week. */
function Figure({ tile }: { tile: PulseTile }) {
  return (
    <Hint label={tile.hint}>
      <Link to={tile.to} className="group min-w-0 rounded-lg px-3 py-2 transition-colors hover:bg-raised">
        <p className="truncate text-xs text-muted group-hover:text-fg">{tile.label}</p>
        <p className="mt-0.5 flex items-baseline gap-2">
          <span className="text-xl font-semibold tracking-tight text-fg tabular-nums">{tile.value}</span>
          {tile.delta && (
            <span className={cn("text-xs tabular-nums", DELTA_TONE[tile.delta.tone])}>
              {tile.delta.text}
              <span className="text-faint"> on last week</span>
            </span>
          )}
        </p>
      </Link>
    </Hint>
  );
}

function dayName(day: string, style: "short" | "long"): string {
  const date = new Date(`${day}T00:00:00Z`);
  return style === "short"
    ? date.toLocaleDateString("en-US", { weekday: "narrow", timeZone: "UTC" })
    : date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

function dayWords(bar: DayBar): string {
  const landed = bar.agent + bar.people;
  if (landed === 0 && bar.sessions === 0) return `${dayName(bar.day, "long")}: nothing landed`;
  const parts = [`${landed} landed`, `${bar.agent} by agents`, `${bar.people} by people`];
  if (bar.sessions > 0) parts.push(`${bar.sessions} ${bar.sessions === 1 ? "session" : "sessions"} started`);
  return `${dayName(bar.day, "long")}: ${parts.join(", ")}`;
}

/**
 * Two weeks of days as columns: agents' changes in the accent, people's
 * above them, last week's faded. A finding that happened on a day is
 * pinned over it with its number in the list below.
 */
function Days({ days, pins }: { days: DayBar[]; pins: Map<string, number[]> }) {
  const [active, setActive] = useState<number | null>(null);
  const top = Math.max(1, ...days.map((bar) => bar.agent + bar.people));
  const thisWeek = days.length - 7;
  const shown = active ?? days.length - 1;
  return (
    <figure className="px-5">
      <div
        className="grid h-36 items-end gap-1.5 sm:gap-2"
        style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
        onPointerLeave={() => setActive(null)}
      >
        {days.map((bar, i) => {
          const landed = bar.agent + bar.people;
          const pinned = pins.get(bar.day);
          return (
            <button
              key={bar.day}
              type="button"
              aria-label={dayWords(bar)}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className={cn(
                "group relative flex h-full flex-col items-stretch justify-end rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                i < thisWeek && "opacity-45",
                active === i && "opacity-100",
              )}
            >
              {pinned && (
                <span className="absolute inset-x-0 -top-1 flex justify-center gap-0.5">
                  {pinned.map((n) => (
                    <span key={n} className="flex size-4 items-center justify-center rounded-full bg-warn text-[0.625rem] font-semibold text-bg">
                      {n}
                    </span>
                  ))}
                </span>
              )}
              <span
                className="mx-auto flex w-full max-w-11 flex-col justify-end overflow-hidden rounded-[5px]"
                style={{ height: `${Math.max(landed > 0 ? 6 : 2, (landed / top) * 80)}%` }}
              >
                {landed === 0 ? (
                  <span className="h-full bg-line" />
                ) : (
                  <>
                    <span className="bg-line-strong transition-colors group-hover:bg-fg-soft/50" style={{ flexGrow: bar.people }} />
                    <span className="bg-accent transition-colors group-hover:bg-accent-hover" style={{ flexGrow: bar.agent }} />
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 grid gap-1.5 sm:gap-2" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }} aria-hidden>
        {days.map((bar, i) => (
          <span key={bar.day} className={cn("text-center font-mono text-[0.625rem] text-faint", i === days.length - 1 && "text-fg-soft")}>
            {dayName(bar.day, "short")}
          </span>
        ))}
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="text-fg-soft" aria-live="polite">
          {days[shown] ? dayWords(days[shown]) : ""}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-accent" />
            Agents
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-line-strong" />
            People
          </span>
          <span className="text-faint">last week faded</span>
        </span>
      </figcaption>
    </figure>
  );
}

/** A finding: what the work says, the evidence after it, where to see it, and Ask. */
function Finding({ signal, n }: { signal: Signal; n: number | null }) {
  return (
    <li className={cn("grid gap-3 border-t border-line px-5 py-4", signal.trend && "md:grid-cols-[minmax(0,1fr)_9rem] md:gap-6")}>
      <div className="flex min-w-0 gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold",
            n != null ? "bg-warn text-bg" : "border border-line-strong text-faint",
          )}
          aria-hidden
        >
          {n ?? "·"}
        </span>
        <div className="min-w-0 space-y-1">
          <p className="text-sm leading-snug font-medium text-fg">{signal.headline}</p>
          <p className="text-xs leading-relaxed text-muted">{signal.facts.join(" · ")}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5">
            {signal.link && (
              <Link to={signal.link.to} className="inline-flex items-center gap-0.5 text-xs font-medium text-accent hover:underline">
                {signal.link.label}
                <ChevronRight size={12} />
              </Link>
            )}
            <button type="button" onClick={() => askG1t(signal.ask)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
              <MessageSquare size={11} />
              Ask g1t
            </button>
          </div>
        </div>
      </div>
      {signal.trend && (
        <div className="hidden md:block">
          <TrendLine
            values={signal.trend.values}
            points={signal.trend.points}
            label={`${signal.trend.caption}, ${signal.trend.range}`}
            width={144}
            height={32}
          />
          <p className="mt-1 font-mono text-[0.625rem] text-faint">{signal.trend.range}</p>
        </div>
      )}
    </li>
  );
}

/** Findings shown before "N more". */
const SHOWN = 4;

/** Home's week: its figures, its days with findings pinned, and what is worth a look. */
export function HomeWeek({ view }: { view: DailySignal | null }) {
  const [more, setMore] = useState(false);
  if (view == null) {
    return (
      <section aria-labelledby="week" className="rounded-2xl border border-line bg-surface px-5 py-4">
        <h2 id="week" className="text-base font-semibold tracking-tight text-fg">
          This week
        </h2>
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
          <TriangleAlert size={13} className="shrink-0 text-warn" />
          The week&apos;s work couldn&apos;t be read just now.
        </p>
      </section>
    );
  }
  // A number for each finding pinned to a day in the chart, in the list's order.
  const days = new Set(view.days.map((bar) => bar.day));
  const numbers = new Map<string, number>();
  const pins = new Map<string, number[]>();
  for (const signal of view.findings) {
    if (!signal.day || !days.has(signal.day)) continue;
    const n = numbers.size + 1;
    numbers.set(signal.key, n);
    pins.set(signal.day, [...(pins.get(signal.day) ?? []), n]);
  }
  const shown = more ? view.findings : view.findings.slice(0, SHOWN);
  return (
    <section aria-labelledby="week" className="rounded-2xl border border-line bg-surface">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 pt-4">
        <h2 id="week" className="text-base font-semibold tracking-tight text-fg">
          This week
        </h2>
        <p className="text-sm text-muted">{view.summary}</p>
      </header>
      {view.tiles.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-1 px-2 lg:grid-cols-4">
          {view.tiles.map((tile) => (
            <Figure key={tile.key} tile={tile} />
          ))}
        </div>
      )}
      <div className="mt-4">
        <Days days={view.days} pins={pins} />
      </div>
      <div className="mt-5">
        <h3 className="px-5 pb-2 text-xs font-medium text-muted">Worth a look</h3>
        {view.findings.length === 0 ? (
          <p className="border-t border-line px-5 py-4 text-sm text-muted">Nothing in the work stands out against its last weeks.</p>
        ) : (
          <ul>
            {shown.map((signal) => (
              <Finding key={signal.key} signal={signal} n={numbers.get(signal.key) ?? null} />
            ))}
          </ul>
        )}
        {view.findings.length > SHOWN && (
          <button type="button" onClick={() => setMore(!more)} className="border-t border-line px-5 py-3 text-left text-xs text-muted hover:text-fg w-full">
            {more ? "Show fewer" : `${view.findings.length - SHOWN} more worth a look`}
          </button>
        )}
      </div>
      {!view.complete && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-2.5 text-xs text-faint">
          <TriangleAlert size={12} className="shrink-0" />
          Some projects didn&apos;t answer, so the week leaves them out.
        </p>
      )}
      <div className="h-2" />
    </section>
  );
}

export function HomeWeekSkeleton() {
  return (
    <section className="space-y-4 rounded-2xl border border-line bg-surface px-5 py-4" aria-busy="true">
      <Skeleton className="h-5 w-72" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
      <Skeleton className="h-36 w-full" />
    </section>
  );
}
