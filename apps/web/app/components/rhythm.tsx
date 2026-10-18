/**
 * What is moving and what is waiting (lib/signals.ts rhythm): each team's
 * last two weeks, day by day. Above the line, pull requests opened and
 * merged (bars) and agent sessions started (a wash); below it, reviews and
 * comments (a wash) and requests for changes (bars). Each row is drawn to
 * its own scale, so a small team's week is as legible as a big one's; the
 * numbers are in the readout and the table. Layers turn on and off above
 * the rows, and pointing at a day says what happened on it.
 */
import { useState } from "react";
import { Link } from "react-router";

import { cn } from "../lib/cn";
import { type RhythmDay, type RhythmRow, rhythmLine, rhythmSum } from "../lib/signals";

type Layer = "prs" | "rework" | "agent" | "reviews";

const LAYERS: { key: Layer; label: string; swatch: string }[] = [
  { key: "prs", label: "PR activity", swatch: "bg-fg-soft" },
  { key: "rework", label: "Rework", swatch: "bg-faint" },
  { key: "agent", label: "Agent activity", swatch: "bg-series-1" },
  { key: "reviews", label: "Reviews & comments", swatch: "bg-series-4" },
];

const WIDTH = 700;
const HEIGHT = 112;
const MID = HEIGHT / 2;
const BAR = 5;

/** A smooth path through points, as a closed wash from the baseline. */
function wash(points: [number, number][]): string {
  if (points.length === 0) return "";
  let d = `M${points[0]![0]},${MID} L${points[0]![0]},${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return `${d} L${points[points.length - 1]![0]},${MID} Z`;
}

function dayWords(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function Readout({ row, day }: { row: RhythmRow; day: RhythmDay | null }) {
  const sum = day ?? rhythmSum(row.days.slice(Math.floor(row.days.length / 2)));
  return (
    <div className="min-w-48 rounded-xl border border-line bg-surface px-3.5 py-3 text-xs shadow-lg">
      <p className="font-mono text-[0.625rem] tracking-[0.14em] text-muted uppercase">
        {row.label} · {day ? dayWords(day.day) : "this week"}
      </p>
      <ul className="mt-2 space-y-1 text-fg">
        <li className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-fg-soft" />
          {sum.opened} opened · {sum.merged} merged
        </li>
        <li className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-faint" />
          {sum.reworked} {sum.reworked === 1 ? "request" : "requests"} for changes
        </li>
        <li className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-series-4" />
          {sum.reviews} reviews &amp; comments
        </li>
        <li className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-series-1" />
          {sum.sessions} agent {sum.sessions === 1 ? "session" : "sessions"}
        </li>
      </ul>
    </div>
  );
}

function Row({
  row,
  on,
  active,
  faded,
  onDay,
}: {
  row: RhythmRow;
  on: Set<Layer>;
  active: number | null;
  faded: boolean;
  onDay: (day: number | null) => void;
}) {
  const n = row.days.length;
  const slot = WIDTH / n;
  const x = (i: number) => slot * i + slot / 2;
  const up = Math.max(1, ...row.days.map((day) => Math.max(on.has("prs") ? day.opened + day.merged : 0, on.has("agent") ? day.sessions : 0)));
  const down = Math.max(1, ...row.days.map((day) => Math.max(on.has("rework") ? day.reworked : 0, on.has("reviews") ? day.reviews : 0)));
  const above = (value: number) => MID - (value / up) * (MID - 6);
  const below = (value: number) => MID + (value / down) * (MID - 6);
  const day = active != null ? row.days[active]! : null;
  return (
    <li className={cn("grid gap-3 py-5 transition-opacity md:grid-cols-[12rem_minmax(0,1fr)] md:gap-6", faded && "opacity-45")}>
      <div className="min-w-0">
        <Link to={row.to} className="text-base font-semibold text-fg hover:text-accent">
          {row.label}
        </Link>
        {row.note && <p className="text-xs text-muted">{row.note}</p>}
        <p className="mt-1.5 text-xs text-fg-soft">{rhythmLine(row)}</p>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="block h-28 w-full overflow-visible"
          role="img"
          aria-label={`${row.label}: the last ${n} days`}
          onMouseLeave={() => onDay(null)}
        >
          {active != null && <rect x={slot * active} y={0} width={slot} height={HEIGHT} className="fill-accent/8" />}
          <line x1={WIDTH / 2} x2={WIDTH / 2} y1={0} y2={HEIGHT} className="stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {on.has("agent") && (
            <path
              d={wash(row.days.map((d, i) => [x(i), above(d.sessions)]))}
              className="fill-series-1/15 stroke-series-1"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {on.has("reviews") && (
            <path
              d={wash(row.days.map((d, i) => [x(i), below(d.reviews)]))}
              className="fill-series-4/18 stroke-series-4"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
          <line x1={0} x2={WIDTH} y1={MID} y2={MID} className="stroke-line-strong" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {on.has("prs") &&
            row.days.map((d, i) =>
              d.opened + d.merged > 0 ? (
                <rect
                  key={`p${i}`}
                  x={x(i) - BAR / 2}
                  y={above(d.opened + d.merged)}
                  width={BAR}
                  height={MID - above(d.opened + d.merged)}
                  rx={1.5}
                  className="fill-fg-soft"
                />
              ) : null,
            )}
          {on.has("rework") &&
            row.days.map((d, i) =>
              d.reworked > 0 ? (
                <rect key={`r${i}`} x={x(i) - BAR / 2} y={MID} width={BAR} height={below(d.reworked) - MID} rx={1.5} className="fill-faint" />
              ) : null,
            )}
          {row.days.map((_, i) => (
            <rect key={`h${i}`} x={slot * i} y={0} width={slot} height={HEIGHT} fill="transparent" onMouseEnter={() => onDay(i)} />
          ))}
        </svg>
        {day && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-y-1/3"
            style={active! < n / 2 ? { left: `${((active! + 1) / n) * 100}%` } : { right: `${((n - active!) / n) * 100}%` }}
          >
            <Readout row={row} day={day} />
          </div>
        )}
      </div>
    </li>
  );
}

export function Rhythm({ rows, by }: { rows: RhythmRow[]; by: "team" | "project" }) {
  const [on, setOn] = useState<Set<Layer>>(new Set(["prs", "rework", "agent", "reviews"]));
  const [hover, setHover] = useState<{ row: string; day: number } | null>(null);
  const toggle = (layer: Layer) => {
    const next = new Set(on);
    if (next.has(layer)) next.delete(layer);
    else next.add(layer);
    setOn(next);
  };
  if (rows.length === 0) return <p className="text-sm text-muted">Nothing has moved in the last two weeks.</p>;
  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="What the rows show">
        {LAYERS.map((layer) => (
          <button
            key={layer.key}
            type="button"
            aria-pressed={on.has(layer.key)}
            onClick={() => toggle(layer.key)}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
              on.has(layer.key) ? "border-line-strong bg-surface text-fg" : "border-line bg-transparent text-faint",
            )}
          >
            <span className={cn("h-2.5 w-2.5 rounded-sm", on.has(layer.key) ? layer.swatch : "bg-line")} />
            {layer.label}
          </button>
        ))}
      </div>
      <div className="mt-5 hidden grid-cols-[12rem_minmax(0,1fr)] gap-6 md:grid">
        <span />
        <div className="grid grid-cols-2 font-mono text-[0.625rem] tracking-[0.14em] text-muted uppercase">
          <span>Last week</span>
          <span className="pl-2">This week</span>
        </div>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((row) => (
          <Row
            key={row.key}
            row={row}
            on={on}
            active={hover?.row === row.key ? hover.day : null}
            faded={hover != null && hover.row !== row.key}
            onDay={(day) => setHover(day == null ? null : { row: row.key, day })}
          />
        ))}
      </ul>
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer hover:text-fg">The numbers, as a table</summary>
        <table className="mt-3 w-full text-left tabular-nums">
          <thead className="text-faint">
            <tr>
              <th className="py-1 font-normal">{by === "team" ? "Team" : "Project"}</th>
              <th className="py-1 font-normal">Opened</th>
              <th className="py-1 font-normal">Merged</th>
              <th className="py-1 font-normal">Rework</th>
              <th className="py-1 font-normal">Reviews &amp; comments</th>
              <th className="py-1 font-normal">Agent sessions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const half = Math.floor(row.days.length / 2);
              const last = rhythmSum(row.days.slice(0, half));
              const now = rhythmSum(row.days.slice(half));
              const cell = (a: number, b: number) => `${b} (${a} last week)`;
              return (
                <tr key={row.key} className="border-t border-line text-fg-soft">
                  <td className="py-1.5 text-fg">{row.label}</td>
                  <td>{cell(last.opened, now.opened)}</td>
                  <td>{cell(last.merged, now.merged)}</td>
                  <td>{cell(last.reworked, now.reworked)}</td>
                  <td>{cell(last.reviews, now.reviews)}</td>
                  <td>{cell(last.sessions, now.sessions)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}
