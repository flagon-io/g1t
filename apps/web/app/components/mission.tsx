/**
 * The pieces mission control and a project's overview are made of: panels
 * with a "View all", what needs the viewer, the week's pulse with its
 * sparklines, and a project's deploy history.
 */
import { ArrowRight, Eye, GitMerge, Hand, Rocket, Swords, Terminal, TimerOff, TriangleAlert, UserPlus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";

import type { DeployStatus } from "@g1t/contracts";

import { cn } from "../lib/cn";
import { type Need, type NeedKind, sparkPoints } from "../lib/mission";
import { Boundary } from "./boundary";
import { TimeAgo } from "./ui";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";

// --- Panels -------------------------------------------------------------------

/** A titled section, with a count and a link to everything it summarises. */
export function Panel({
  id,
  title,
  icon,
  count,
  all,
  extra,
  children,
  className,
  what,
}: {
  id?: string;
  title: ReactNode;
  /** What it shows, in a few words, said if it fails to draw; its title when that is text. */
  what?: string;
  icon?: ReactNode;
  count?: number | null;
  all?: { to: string; label?: string } | null;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn("scroll-mt-[calc(var(--topbar-h)+1rem)]", className)}>
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          {icon && <span className="text-faint">{icon}</span>}
          {title}
          {count != null && count > 0 && <span className="rounded-full bg-line px-1.5 text-[0.6875rem] font-medium tabular-nums text-muted">{count}</span>}
        </h2>
        <span className="grow" />
        {extra}
        {all && (
          <Link to={all.to} prefetch="intent" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
            {all.label ?? "View all"}
            <ArrowRight size={12} />
          </Link>
        )}
      </div>
      <div className="mt-3">
        <Boundary what={what ?? (typeof title === "string" ? title : "This section")}>{children}</Boundary>
      </div>
    </section>
  );
}

export { Unavailable } from "./boundary";

/** A quiet, dashed empty state with an optional call to action. */
export function Quiet({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <Card tone="plain" className="flex flex-wrap items-center gap-3 border-dashed px-4 py-5 text-sm text-muted">
      <span className="min-w-0 grow">{children}</span>
      {action}
    </Card>
  );
}

// --- Needs you ----------------------------------------------------------------

const NEED: Record<NeedKind, { icon: ReactNode; tone: string; label: string }> = {
  deploy: { icon: <Rocket size={15} />, tone: "text-danger", label: "Production" },
  invitation: { icon: <UserPlus size={15} />, tone: "text-accent", label: "Invitation" },
  conflict: { icon: <Swords size={15} />, tone: "text-warn", label: "Conflict" },
  stalled: { icon: <Hand size={15} />, tone: "text-warn", label: "Stopped" },
  stuck: { icon: <TimerOff size={15} />, tone: "text-warn", label: "Quiet run" },
  runner: { icon: <TimerOff size={15} />, tone: "text-warn", label: "No runner" },
  review: { icon: <Eye size={15} />, tone: "text-info", label: "Review" },
  checks: { icon: <Terminal size={15} />, tone: "text-danger", label: "Checks" },
  ready: { icon: <GitMerge size={15} />, tone: "text-success", label: "Ready" },
};

/** What is waiting on the viewer, most urgent first, each with its next step. */
export function NeedsList({ needs, limit = 8 }: { needs: Need[]; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? needs : needs.slice(0, limit);
  return (
    <>
      <Card asChild divided className="overflow-hidden">
        <ul>
          {shown.map((need) => {
            const look = NEED[need.kind];
            return (
              <li key={need.key} className="flex items-start gap-3 px-4 py-3">
                <Hint label={look.label}>
                  <span className={cn("mt-0.5 shrink-0", look.tone)}>
                    {look.icon}
                    <span className="sr-only">{look.label}</span>
                  </span>
                </Hint>
                <span className="min-w-0 grow">
                  <Link to={need.to} prefetch="intent" className="block truncate text-sm font-medium hover:text-accent">
                    {need.title}
                  </Link>
                  <span className="mt-0.5 block text-xs leading-5 text-muted">
                    {need.where && <span className="font-mono text-faint">{need.where} · </span>}
                    {need.detail}
                  </span>
                </span>
                <span className="hidden shrink-0 pt-0.5 text-xs text-faint sm:block">
                  <TimeAgo at={need.at} />
                </span>
                <Link
                  to={need.to}
                  prefetch="intent"
                  className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-fg/85 transition-colors hover:border-line-strong hover:bg-raised hover:text-fg"
                >
                  {need.action}
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
      {needs.length > limit && (
        <Button type="button" onClick={() => setAll(!all)} variant="link" size="inline" className="mt-2 text-xs text-muted hover:text-fg font-normal">
          {all ? "Show fewer" : `Show ${needs.length - limit} more`}
        </Button>
      )}
    </>
  );
}

// --- Pulse --------------------------------------------------------------------

const DAY_LABEL = (offset: number) => {
  const date = new Date(Date.now() - offset * 86_400_000);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
};

/**
 * A week of one measure as a small line, the last day marked. Each day
 * has a hover target that says its value.
 */
export function Sparkline({
  values,
  format,
  width = 96,
  height = 28,
}: {
  values: number[];
  format: (value: number) => string;
  width?: number;
  height?: number;
}) {
  const points = sparkPoints(values, width, height, 3);
  if (points.length === 0) return null;
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const area = `${line} L${points[points.length - 1][0]},${height} L${points[0][0]},${height} Z`;
  const [lastX, lastY] = points[points.length - 1];
  const slot = width / values.length;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible text-accent"
      role="img"
      aria-label={values.map(format).join(", ")}
    >
      <path d={area} fill="currentColor" opacity={0.12} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={3} fill="currentColor" stroke="var(--color-surface)" strokeWidth={2} />
      {values.map((value, index) => (
        <rect key={index} x={index * slot} y={0} width={slot} height={height} fill="transparent" className="hover:fill-fg/5">
          <title>{`${DAY_LABEL(values.length - 1 - index)}: ${format(value)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

/** One measure of the week: a headline number, what it means, and its line. */
export function PulseTile({
  label,
  value,
  hint,
  values,
  format,
  to,
}: {
  label: string;
  value: string;
  hint?: string;
  values?: number[];
  format?: (value: number) => string;
  to?: string;
}) {
  const body = (
    <>
      <p className="truncate text-xs text-muted">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        {values && format && values.some((v) => v > 0) && (
          <span className="mb-1">
            <Sparkline values={values} format={format} width={56} height={22} />
          </span>
        )}
      </div>
      <Hint label={hint}>
        <p className="mt-1.5 truncate text-[0.6875rem] text-faint">{hint}</p>
      </Hint>
    </>
  );
  const box = "block rounded-xl border border-line bg-surface p-4 transition-colors";
  return to ? (
    <Link to={to} className={`${box} hover:border-line-strong`}>
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  );
}

// --- Deploys ------------------------------------------------------------------

const STRIP_TONE: Record<DeployStatus, string> = {
  ready: "bg-success",
  // Served once, until a newer build or a take-down: it worked.
  replaced: "bg-success/45",
  down: "bg-line-strong",
  failed: "bg-danger",
  building: "bg-warn animate-pulse",
  queued: "bg-line-strong animate-pulse",
  skipped: "bg-line",
};

/** The last builds as a row of bars, oldest on the left; each links to its build. */
export function DeployStrip({
  builds,
  base,
  slots = 20,
}: {
  builds: { id: string; status: DeployStatus; kind: string; commit: string; createdAt: string }[];
  base: string;
  slots?: number;
}) {
  const shown = builds.slice(0, slots).reverse();
  return (
    <div className="flex h-8 items-end gap-0.75" aria-label="Recent builds, oldest first">
      {Array.from({ length: slots - shown.length }, (_, i) => (
        <span key={`empty-${i}`} className="h-2 flex-1 rounded-sm bg-line/60" />
      ))}
      {shown.map((build) => {
        const about = `${build.kind === "production" ? "Production" : "Preview"} · ${build.commit.slice(0, 7)} · ${build.status} · ${new Date(build.createdAt).toLocaleString("en-US")}`;
        return (
          <Hint key={build.id} label={about}>
            <Link
              to={`${base}/deployments/${build.id}`}
              aria-label={about}
              className={cn("flex-1 rounded-sm transition-opacity hover:opacity-80", STRIP_TONE[build.status], build.kind === "production" ? "h-8" : "h-5")}
            />
          </Hint>
        );
      })}
    </div>
  );
}

/** A small meter for a share, 0 to 1. */
export function Meter({ value, tone = "bg-success" }: { value: number | null; tone?: string }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-line">
      {value != null && <span className={cn("block h-full rounded-full", tone)} style={{ width: `${Math.round(value * 100)}%` }} />}
    </span>
  );
}

export function percent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}
