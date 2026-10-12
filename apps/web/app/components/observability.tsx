/**
 * The parts of a project's Observability pages: the bar of filters every
 * page shares, numbers with how they moved, the time charts, and the
 * badges for statuses and log levels.
 */
import { Activity, ChevronDown, Radio } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Form, Link, useNavigate, useNavigation } from "react-router";

import type { LogSeverity } from "@g1t/contracts";

import { cn } from "../lib/cn";
import { RANGES, type View, axisTime, change as changeOf, niceTicks, statusTone, LEVEL_TONE, viewHref } from "../lib/observability";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { Input } from "./ui/input";
import { SelectField } from "./ui/select";

// ---- Header and filters ------------------------------------------------------

export function ObservabilityHeader({ title, about, children }: { title: string; about: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Activity size={18} className="text-accent" />
          {title}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">{about}</p>
      </div>
      {children}
    </header>
  );
}

/**
 * The period, environment and service every page narrows by, in the
 * address, so a view can be shared. Search is a page's own (`search`).
 */
export function FilterBar({
  path,
  view,
  environments,
  services,
  search,
  ranges = true,
  children,
}: {
  path: string;
  view: View;
  environments: string[];
  services: string[];
  search?: { placeholder: string; hint?: string };
  ranges?: boolean;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const go = (change: Record<string, string | null>) => navigate(viewHref(path, view, change), { preventScrollReset: true });
  const envs = [...new Set([...(view.environment ? [view.environment] : []), ...environments])];
  const svcs = [...new Set([...(view.service ? [view.service] : []), ...services])];
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      {search && (
        <Form method="get" action={path} className="min-w-0 flex-1 basis-64" role="search">
          {/* What else the view says goes with the search. */}
          {view.range && <input type="hidden" name="range" value={view.range} />}
          {view.environment && <input type="hidden" name="env" value={view.environment} />}
          {view.service && <input type="hidden" name="service" value={view.service} />}
          {view.deployment && <input type="hidden" name="deployment" value={view.deployment} />}
          <Input
            name="q"
            defaultValue={view.q}
            placeholder={search.placeholder}
            aria-label={search.hint ?? "Search"}
            className="h-8 font-mono text-[0.8125rem]"
            autoComplete="off"
            spellCheck={false}
          />
        </Form>
      )}
      {envs.length > 0 && (
        <SelectField
          aria-label="Environment"
          size="sm"
          className="w-40"
          value={view.environment ?? "*"}
          onValueChange={(value) => go({ env: value === "*" ? null : value })}
          options={[{ value: "*", label: "All environments" }, ...envs.map((e) => ({ value: e, label: e[0]!.toUpperCase() + e.slice(1) }))]}
        />
      )}
      {svcs.length > 1 || view.service ? (
        <SelectField
          aria-label="Service"
          size="sm"
          className="w-44"
          value={view.service ?? "*"}
          onValueChange={(value) => go({ service: value === "*" ? null : value })}
          options={[{ value: "*", label: "All services" }, ...svcs.map((s) => ({ value: s, label: s }))]}
        />
      ) : null}
      {view.deployment && (
        <Link
          to={viewHref(path, view, { deployment: null })}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2.5 font-mono text-xs text-accent hover:bg-accent/15"
          aria-label="Show every deployment"
        >
          {view.deployment.slice(0, 12)} <span aria-hidden="true">×</span>
        </Link>
      )}
      {children}
      {ranges && (
        <nav className="ml-auto flex rounded-md border border-line p-0.5 text-sm" aria-label="Period">
          {RANGES.map((r) => (
            <Link
              key={r.key}
              to={viewHref(path, view, { range: r.key })}
              preventScrollReset
              aria-current={r.key === view.range ? "true" : undefined}
              aria-label={`The last ${r.label}`}
              className={cn("rounded px-2 py-0.5 tabular-nums", r.key === view.range ? "bg-raised text-fg" : "text-muted hover:text-fg")}
            >
              {r.key}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

/** Whether the page is loading the next view: the content dims while it does. */
export function useLoadingView(): boolean {
  return useNavigation().state === "loading";
}

// ---- Numbers ---------------------------------------------------------------------

/** A headline number, with how it moved from the period before. */
export function StatTile({
  label,
  value,
  now,
  before,
  lowerIsBetter = false,
  detail,
}: {
  label: string;
  value: ReactNode;
  now?: number | null;
  before?: number | null;
  lowerIsBetter?: boolean;
  detail?: ReactNode;
}) {
  const moved = now !== undefined && before !== undefined ? changeOf(now, before, lowerIsBetter) : null;
  return (
    <Card className="min-w-0 p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-1 h-4 text-xs text-faint">
        {moved ? (
          <span className={cn("tabular-nums", moved.good === true && "text-success", moved.good === false && "text-danger")}>
            {moved.text} <span className="text-faint">vs the period before</span>
          </span>
        ) : (
          detail
        )}
      </p>
    </Card>
  );
}

// ---- Time charts -----------------------------------------------------------------

export type ChartSeries = { key: string; label: string; color: string; values: (number | null)[] };

const CHART_HEIGHT = 160;

/**
 * A measure over time on one axis: stacked bars (counts) or lines
 * (latency). Hovering or focusing a step shows each series' value there;
 * the legend names every series, and the table under it has the numbers.
 */
export function TimeChart({
  title,
  kind,
  times,
  stepS,
  series,
  format,
  empty = "Nothing in this period.",
  action,
}: {
  title: string;
  kind: "bars" | "lines";
  times: number[];
  stepS: number;
  series: ChartSeries[];
  format: (n: number) => string;
  empty?: string;
  action?: ReactNode;
}) {
  const id = useId();
  const [at, setAt] = useState<number | null>(null);
  const totals = times.map((_, i) => series.reduce((n, s) => n + (s.values[i] ?? 0), 0));
  const peaks = kind === "bars" ? totals : times.map((_, i) => Math.max(0, ...series.map((s) => s.values[i] ?? 0)));
  const max = Math.max(0, ...peaks);
  const scale = niceTicks(max);
  const top = scale[scale.length - 1] || 1;
  const spanMs = (times.length * stepS * 1000) || 1;
  const labelEvery = Math.max(1, Math.ceil(times.length / 6));
  const anything = series.some((s) => s.values.some((v) => v !== null && v > 0));
  const W = 1000;
  const x = (i: number) => ((i + 0.5) / Math.max(1, times.length)) * W;
  const y = (v: number) => CHART_HEIGHT - (v / top) * CHART_HEIGHT;

  return (
    <Card asChild className="min-w-0 p-4">
      <section aria-labelledby={`${id}-title`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={`${id}-title`} className="text-sm font-medium">
            {title}
          </h2>
          {action}
        </div>
        {series.length > 1 && (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className={cn(kind === "bars" ? "size-2.5 rounded-sm" : "h-0.5 w-3 rounded-full")} style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
        {!anything ? (
          <p className="mt-3 grid place-items-center rounded-md border border-dashed border-line text-sm text-faint" style={{ height: CHART_HEIGHT }}>
            {empty}
          </p>
        ) : (
          <div className="mt-3 flex gap-2">
            <div className="relative w-12 shrink-0 text-right text-[0.6875rem] text-faint tabular-nums" style={{ height: CHART_HEIGHT }} aria-hidden="true">
              {scale.map((t) => (
                <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (t / top) * 100}%` }}>
                  {format(t)}
                </span>
              ))}
            </div>
            <div className="relative min-w-0 flex-1" style={{ height: CHART_HEIGHT }} onMouseLeave={() => setAt(null)}>
              {scale.map((t) => (
                <div key={t} className="absolute inset-x-0 border-t border-line/70" style={{ top: `${100 - (t / top) * 100}%` }} aria-hidden="true" />
              ))}
              {kind === "lines" && (
                <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${W} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                  {series.map((s) => {
                    // Steps with no requests break the line rather than drop it to zero.
                    const runs: string[] = [];
                    let run: string[] = [];
                    s.values.forEach((v, i) => {
                      if (v === null) {
                        if (run.length) runs.push(run.join(" "));
                        run = [];
                      } else run.push(`${x(i)},${y(v)}`);
                    });
                    if (run.length) runs.push(run.join(" "));
                    return runs.map((points, i) =>
                      points.includes(" ") ? (
                        <polyline key={`${s.key}-${i}`} points={points} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                      ) : (
                        <circle key={`${s.key}-${i}`} cx={points.split(",")[0]} cy={points.split(",")[1]} r={3} fill={s.color} vectorEffect="non-scaling-stroke" />
                      ),
                    );
                  })}
                </svg>
              )}
              <div className="absolute inset-0 flex items-end" role="list" aria-label={`${title} by time`}>
                {times.map((t, i) => (
                  <div
                    key={t}
                    role="listitem"
                    tabIndex={0}
                    aria-label={`${axisTime(t, spanMs)}: ${series.map((s) => `${s.label} ${s.values[i] === null ? "none" : format(s.values[i]!)}`).join(", ")}`}
                    onMouseEnter={() => setAt(i)}
                    onFocus={() => setAt(i)}
                    onBlur={() => setAt(null)}
                    className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-end outline-none focus-visible:bg-raised/60"
                  >
                    {at === i && <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" aria-hidden="true" />}
                    {kind === "bars" && totals[i]! > 0 && (
                      <div className="flex w-full max-w-5 flex-col-reverse gap-0.5 px-px" style={{ height: `${(totals[i]! / top) * 100}%` }}>
                        {series
                          .filter((s) => (s.values[i] ?? 0) > 0)
                          .map((s, k, all) => (
                            <div
                              key={s.key}
                              className={cn("w-full min-h-0.5", k === all.length - 1 && "rounded-t-[3px]")}
                              style={{ flexGrow: s.values[i] ?? 0, flexBasis: 0, background: s.color }}
                            />
                          ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {at !== null && (
                <div
                  className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border border-line bg-bg px-2.5 py-2 text-xs shadow-lg"
                  style={at > times.length / 2 ? { right: `${100 - ((at + 0.5) / times.length) * 100}%`, marginRight: 8 } : { left: `${((at + 0.5) / times.length) * 100}%`, marginLeft: 8 }}
                  role="status"
                >
                  <p className="font-medium tabular-nums">{axisTime(times[at]!, spanMs)} UTC</p>
                  <ul className="mt-1 space-y-0.5">
                    {series.map((s) => (
                      <li key={s.key} className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-muted">
                          <span className="size-2 rounded-sm" style={{ background: s.color }} />
                          {s.label}
                        </span>
                        <span className="tabular-nums">{s.values[at] === null ? "—" : format(s.values[at]!)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
        {anything && (
          <div className="mt-1 flex justify-between pl-14 text-[0.6875rem] text-faint tabular-nums" aria-hidden="true">
            {times.map((t, i) => (i % labelEvery === 0 ? <span key={t}>{axisTime(t, spanMs)}</span> : null))}
          </div>
        )}
        {anything && (
          <details className="group mt-2 text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-faint hover:text-muted">
              <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
              Table
            </summary>
            <div className="mt-2 max-h-56 overflow-auto rounded-md border border-line">
              <table className="w-full tabular-nums">
                <thead className="sticky top-0 bg-raised text-left text-muted">
                  <tr>
                    <th className="px-2 py-1 font-medium">Time (UTC)</th>
                    {series.map((s) => (
                      <th key={s.key} className="px-2 py-1 text-right font-medium">
                        {s.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {times.map((t, i) => (
                    <tr key={t} className="border-t border-line">
                      <td className="px-2 py-1">{new Date(t / 1000).toISOString().slice(0, 16).replace("T", " ")}</td>
                      {series.map((s) => (
                        <td key={s.key} className="px-2 py-1 text-right">
                          {s.values[i] === null ? "—" : format(s.values[i]!)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>
    </Card>
  );
}

// ---- Badges ----------------------------------------------------------------------

export function StatusBadge({ status, outcome }: { status: number | null; outcome?: string | null }) {
  const failed = outcome && outcome !== "ok" && outcome !== "canceled" && outcome !== "responseStreamDisconnected";
  const badge = (
    <Badge tone={statusTone(status, outcome)} className="font-mono tabular-nums">
      {status ?? (failed ? "ERR" : "—")}
    </Badge>
  );
  return failed ? <Hint label={`Outcome: ${outcome}`}>{badge}</Hint> : badge;
}

export function LevelBadge({ level }: { level: LogSeverity }) {
  return (
    <Badge tone={LEVEL_TONE[level]} className="w-12 justify-center font-mono uppercase">
      {level}
    </Badge>
  );
}

/** Where a record came from: an app on g1t.page, or OpenTelemetry. */
export function SourceBadge({ source }: { source: "cloudflare" | "otlp" }) {
  return (
    <Hint label={source === "cloudflare" ? "From the app on g1t.page" : "Sent with OpenTelemetry"}>
      <Badge tone="neutral">{source === "cloudflare" ? "g1t.page" : "OTLP"}</Badge>
    </Hint>
  );
}

/** The live dot: a page following what arrives as it arrives. */
export function LiveDot({ on }: { on: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", on ? "text-success" : "text-faint")}>
      <Radio size={13} className={cn(on && "animate-pulse")} />
      {on ? "Live" : "Paused"}
    </span>
  );
}

/** A bar of how long something took, against the longest beside it. */
export function DurationBar({ ms, max, failed }: { ms: number; max: number; failed?: boolean }) {
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden="true">
      <span className={cn("absolute inset-y-0 left-0 rounded-full", failed ? "bg-danger" : "bg-accent")} style={{ width: `${Math.max(2, Math.min(100, (ms / (max || 1)) * 100))}%` }} />
    </span>
  );
}
