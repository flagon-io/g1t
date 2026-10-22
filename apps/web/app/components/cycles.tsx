/**
 * The pieces of a cycle's page (routes/workspace/work/cycle.tsx): its
 * figures, the burn-up, the stage strip, each person's and agent's share,
 * and a row for each of its work items. Charts follow one rule: one hue
 * (the accent) for what is done, the neutral line for what was taken on,
 * thin marks, and every chart readable as a table.
 */
import { ArrowDownRight, ArrowUpRight, Bot, Plus } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link } from "react-router";

import type { CycleMember, WorkItem } from "@g1t/contracts";

import { STAGES, STAGE_INFO, type Stage } from "../lib/board";
import { cn } from "../lib/cn";
import { type BurnPoint, type Tally, UNASSIGNED, dayNumber, dayOf, dayText } from "../lib/cycles";
import { itemPath } from "../lib/work-items";
import { type WorkTrail, trailState } from "../lib/work-trail";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { ItemIcon } from "./work-icons";

// --- Figures --------------------------------------------------------------------

/** One figure: a label, a number, and a line under it. */
export function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface px-4 py-3">
      <span className="truncate text-xs text-muted">{label}</span>
      <span className="text-2xl leading-none font-semibold tracking-tight tabular-nums">{value}</span>
      <span className="min-h-4 truncate text-[0.6875rem] text-faint">{note}</span>
    </div>
  );
}

/** A row of figures, joined by hairlines. */
export function Figures({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
      {children}
    </section>
  );
}

// --- The burn-up ------------------------------------------------------------------

const BURN_HEIGHT = 132;
// The axes' words are HTML around the drawing, so they stay readable however wide it is drawn.
const PAD = { top: 8, right: 6, bottom: 4, left: 6 };

/**
 * The burn-up: what the cycle had taken on (the neutral line) and what of
 * it was done (the accent, filled under), day by day, across all of the
 * cycle's days, so the days still to come stand empty. Pointing at a day,
 * or moving along with the arrow keys, says its figures; the same figures
 * are a table under it.
 */
export function BurnUp({ points, days, label }: { points: BurnPoint[]; days: number; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const described = useId();
  const width = 560;
  if (points.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-faint">The burn-up starts on the cycle&apos;s first day.</p>
    );
  }
  const top = Math.max(1, ...points.map((point) => point.scope));
  const plotW = width - PAD.left - PAD.right;
  const plotH = BURN_HEIGHT - PAD.top - PAD.bottom;
  const span = Math.max(1, days - 1);
  const x = (index: number) => PAD.left + (index / span) * plotW;
  const y = (value: number) => PAD.top + (1 - value / top) * plotH;
  const line = (key: "scope" | "done") => points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join("");
  const area = `${line("done")}L${x(points.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const shown = active ?? points.length - 1;
  const point = points[shown]!;
  const ticks = [0, Math.round(top / 2), top].filter((value, index, all) => all.indexOf(value) === index);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-3 rounded-full bg-line-strong" />
          Taken on
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-3 rounded-full bg-accent" />
          Done
        </span>
        <span className="ml-auto tabular-nums text-fg-soft" aria-live="polite">
          {dayText(point.day)}: <span className="text-fg">{point.done}</span> done of <span className="text-fg">{point.scope}</span>
        </span>
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5">
        <div className="relative w-5 text-right text-[0.6875rem] text-faint tabular-nums" aria-hidden>
          {ticks.map((value) => (
            <span key={value} className="absolute right-0 -translate-y-1/2" style={{ top: `${(y(value) / BURN_HEIGHT) * 100}%` }}>
              {value}
            </span>
          ))}
        </div>
        <div className="min-w-0">
          <svg
            viewBox={`0 0 ${width} ${BURN_HEIGHT}`}
            className="block h-auto w-full overflow-visible rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            role="img"
            aria-label={label}
            aria-describedby={described}
            tabIndex={0}
            onMouseLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setActive(Math.max(0, Math.min(points.length - 1, shown + (event.key === "ArrowLeft" ? -1 : 1))));
            }}
          >
            {ticks.map((value) => (
              <g key={value}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)} className="stroke-line" strokeWidth={1} />
              </g>
            ))}
            {active != null && <line x1={x(shown)} x2={x(shown)} y1={PAD.top} y2={y(0)} className="stroke-line-strong" strokeWidth={1} />}
            <path d={area} className="fill-accent/12" />
            <path d={line("scope")} fill="none" className="stroke-line-strong" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            <path d={line("done")} fill="none" className="stroke-accent" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={x(shown)} cy={y(point.done)} r={4} className="fill-accent" stroke="var(--color-surface)" strokeWidth={2} />
            {points.map((_, index) => (
              <rect
                key={index}
                x={x(index) - plotW / span / 2}
                y={0}
                width={Math.max(plotW / span, 8)}
                height={BURN_HEIGHT}
                fill="transparent"
                onMouseEnter={() => setActive(index)}
              />
            ))}
          </svg>
          <div className="mt-1 flex justify-between text-[0.6875rem] text-faint" aria-hidden>
            <span>{dayText(points[0]!.day)}</span>
            <span>{dayText(dayOf(dayNumber(points[0]!.day) + days - 1))}</span>
          </div>
        </div>
      </div>
      <button type="button" onClick={() => setTable((open) => !open)} className="mt-1 text-xs text-muted underline-offset-2 hover:text-fg hover:underline">
        {table ? "Hide the table" : "Show as a table"}
      </button>
      <div id={described} className={table ? "mt-2" : "sr-only"}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Taken on</TableHead>
              <TableHead className="text-right">Done</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((one) => (
              <TableRow key={one.day}>
                <TableCell>{dayText(one.day)}</TableCell>
                <TableCell className="text-right tabular-nums">{one.scope}</TableCell>
                <TableCell className="text-right tabular-nums">{one.done}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// --- The stage strip --------------------------------------------------------------

/** Each stage's share of the strip, a step darker in the accent toward Done. */
const STAGE_FILL: Record<Stage, string> = {
  next: "bg-accent/15",
  progress: "bg-accent/35",
  review: "bg-accent/55",
  landing: "bg-accent/75",
  done: "bg-accent",
};

/**
 * Up next to Done, each with how many of the cycle's work items stand
 * there: a thin bar in one hue, darker toward Done, over the counts in
 * words, which are what is read.
 */
export function StageStrip({ counts }: { counts: Record<Stage, number> }) {
  const total = STAGES.reduce((sum, stage) => sum + counts[stage], 0);
  return (
    <div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-line" aria-hidden>
        {total > 0 &&
          STAGES.filter((stage) => counts[stage] > 0).map((stage) => (
            <span key={stage} className={cn("h-full first:rounded-l-full last:rounded-r-full", STAGE_FILL[stage])} style={{ flexGrow: counts[stage] }} />
          ))}
      </div>
      <dl className="mt-3 grid grid-cols-5 gap-2 max-sm:grid-cols-3">
        {STAGES.map((stage) => (
          <div key={stage} className="min-w-0">
            <dt className="flex items-center gap-1.5 truncate text-xs text-muted">
              <span aria-hidden className={cn("size-2 shrink-0 rounded-sm", STAGE_FILL[stage])} />
              {STAGE_INFO[stage].label}
            </dt>
            <dd className="mt-0.5 text-lg leading-none font-semibold tabular-nums">{counts[stage]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// --- Shares -----------------------------------------------------------------------

/** People or agents, each with how many of theirs are done: a thin accent bar and "3/5". */
export function Shares({ tallies, kind, empty }: { tallies: Tally[]; kind: "person" | "agent"; empty: string }) {
  if (tallies.length === 0) return <p className="text-xs text-faint">{empty}</p>;
  return (
    <ul className="space-y-2.5">
      {tallies.map((tally) => (
        <li key={tally.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            {kind === "agent" ? (
              <Bot size={16} className="shrink-0 text-faint" aria-hidden />
            ) : tally.name === UNASSIGNED ? (
              <span aria-hidden className="size-4 shrink-0 rounded-full border border-dashed border-line-strong" />
            ) : (
              <Avatar name={tally.name} size={16} />
            )}
            <span className={cn("truncate", tally.name === UNASSIGNED && "text-muted")}>{tally.name}</span>
          </span>
          <span className="font-mono text-xs tabular-nums text-muted">
            <span className="text-fg">{tally.done}</span>/{tally.total}
          </span>
          <span className="col-span-2 block h-1 overflow-hidden rounded-full bg-line" aria-hidden>
            <span className="block h-full rounded-full bg-accent" style={{ width: `${tally.total ? (tally.done / tally.total) * 100 : 0}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

// --- A work item ------------------------------------------------------------------

/** A work item of the cycle: its title, who is on it, its stage, and whether it was carried in or added. */
export function CycleItemRow({
  item,
  member,
  stage,
  workspace,
  trail,
  action,
  selected,
  rowRef,
  onFocus,
}: {
  item: WorkItem;
  member?: CycleMember;
  stage?: Stage | null;
  workspace: string;
  trail?: WorkTrail | null;
  /** At the end of the row: a button, such as pulling it into the coming cycle. */
  action?: ReactNode;
  /** Where the keyboard is, in a list J and K move through. */
  selected?: boolean;
  rowRef?: (node: HTMLLIElement | null) => void;
  onFocus?: () => void;
}) {
  return (
    <li
      ref={rowRef}
      onFocusCapture={onFocus}
      className={cn(
        "group grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-raised/60",
        selected && "bg-raised/60 shadow-[inset_2px_0_0_0_var(--color-accent)]",
      )}
    >
      <span className="mt-0.5 flex">
        <ItemIcon item={item} size={15} />
      </span>
      <div className="min-w-0">
        <Link
          to={itemPath(workspace, item.number)}
          state={trailState(trail ?? null)}
          prefetch="intent"
          className="line-clamp-2 text-sm font-medium wrap-break-word hover:text-accent sm:line-clamp-1"
        >
          <span className="mr-1.5 font-mono text-xs font-normal text-faint">#{item.number}</span>
          {item.title}
        </Link>
        {(member?.carriedIn || member?.added || member?.carriedOut || stage) && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-faint">
            {stage && <span>{STAGE_INFO[stage].label}</span>}
            {member?.carriedIn && (
              <Badge>
                <ArrowDownRight size={11} aria-hidden />
                Carried in
              </Badge>
            )}
            {member?.added && (
              <Badge>
                <Plus size={11} aria-hidden />
                Added mid-cycle
              </Badge>
            )}
            {member?.carriedOut && (
              <Badge>
                <ArrowUpRight size={11} aria-hidden />
                Carried{item.cycle ? ` to Cycle ${item.cycle}` : " out"}
              </Badge>
            )}
          </div>
        )}
      </div>
      <span className="flex min-h-5 items-center gap-2">
        {item.assignees.length > 0 && (
          <span className="flex -space-x-1">
            {item.assignees.slice(0, 3).map((name) => (
              <span key={name} className="inline-flex rounded-full ring-2 ring-surface">
                <Avatar name={name} size={18} />
              </span>
            ))}
          </span>
        )}
        {action}
      </span>
    </li>
  );
}
