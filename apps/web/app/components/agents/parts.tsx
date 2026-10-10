import { CornerDownRight, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { AgentSession, SpendSlice } from "@g1t/contracts";

import { AgentAvatar } from "../agent-avatar";
import { Badge } from "../ui/badge";
import { Hint } from "../ui/hint";
import { TimeAgo } from "../ui";
import { Card } from "../ui/card";
import { cn } from "../../lib/cn";
import { money } from "../../lib/money";
import { kindLabel, meterTone, monthDays, sessionStatus, shareOf, shortDay, topSlices, whereLabel } from "./format";

/** Where a session's page is. */
export function sessionHref(slug: string, session: Pick<AgentSession, "id" | "agent_handle">): string {
  return `/${slug}/-/agents/${session.agent_handle}/sessions/${session.id}`;
}

/** A session's status as a chip; a soft pulse while it is moving. */
export function StatusChip({ status, className }: { status: string; className?: string }) {
  const chip = sessionStatus(status);
  return (
    <Badge tone={chip.tone} className={className}>
      {chip.moving && (
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      )}
      {chip.label}
    </Badge>
  );
}

/** Where a session came from: Chat, Routine, Helper or Subagent. */
export function KindBadge({ kind, subagent }: { kind: string; subagent?: string | null }) {
  return (
    <span className="inline-flex h-[1.125rem] shrink-0 items-center rounded-[5px] bg-raised px-1.5 text-[0.6875rem] font-medium text-muted ring-1 ring-line ring-inset">
      {kindLabel(kind)}
      {subagent ? <span className="ml-1 font-mono text-faint">{subagent}</span> : null}
    </span>
  );
}

const BAR: Record<"accent" | "warn" | "danger", string> = { accent: "bg-accent", warn: "bg-warn", danger: "bg-danger" };

/** Spend against a cap as a thin bar; a plain track with no cap. */
export function Meter({ spent, cap, label, className, size = "md" }: { spent: number; cap: number | null | undefined; label: string; className?: string; size?: "sm" | "md" }) {
  const share = shareOf(spent, cap);
  const width = share == null ? 0 : Math.min(100, Math.max(share * 100, spent > 0 ? 1.5 : 0));
  return (
    <div
      className={cn("overflow-hidden rounded-full bg-line", size === "sm" ? "h-1" : "h-2", className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={cap ?? undefined}
      aria-valuenow={spent}
    >
      {share != null && <div className={cn("h-full rounded-full transition-[width]", BAR[meterTone(share)])} style={{ width: `${width}%` }} />}
    </div>
  );
}

/** "$0.42 of $2.00", or just what it spent. */
export function SpendOfCap({ spent, cap }: { spent: number; cap: number | null | undefined }) {
  return (
    <span className="tabular-nums">
      {money(spent)}
      {cap != null && <span className="text-faint"> of {money(cap)}</span>}
    </span>
  );
}

/** A session someone else's conversation holds: it ran and what it cost, nothing more. */
export function PrivateTitle({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-muted italic", className)}>
      <Lock size={12} className="shrink-0 not-italic" aria-hidden="true" />A private session
    </span>
  );
}

/** "12 steps · 30 tools". */
export function stepsLine(session: Pick<AgentSession, "steps" | "tool_calls">): string {
  return `${session.steps} ${session.steps === 1 ? "step" : "steps"} · ${session.tool_calls} ${session.tool_calls === 1 ? "tool" : "tools"}`;
}

/**
 * One session as a list shows it: its title (or that it is private), kind,
 * status, who asked and where, steps and spend against its cap, and when.
 * `depth` indents a child under its parent.
 */
export function SessionRow({ slug, session, depth = 0, showAgent = false }: { slug: string; session: AgentSession; depth?: number; showAgent?: boolean }) {
  const title = session.visible ? <span className="truncate font-medium text-fg">{session.title || "Untitled session"}</span> : <PrivateTitle />;
  return (
    <li className="group relative">
      <div className="flex items-start gap-3 px-4 py-3 transition-colors group-hover:bg-raised/40" style={{ paddingLeft: `${1 + depth * 1.5}rem` }}>
        {depth > 0 && <CornerDownRight size={14} className="mt-1 shrink-0 text-faint" aria-hidden="true" />}
        {showAgent && (
          <span className="mt-0.5 shrink-0">
            <AgentAvatar agent={{ handle: session.agent_handle, avatar_seed: session.agent_avatar_seed, look: session.agent_look }} size={22} />
          </span>
        )}
        <div className="min-w-0 grow">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {session.visible ? (
              <Link to={sessionHref(slug, session)} className="min-w-0 truncate after:absolute after:inset-0 hover:underline">
                {title}
              </Link>
            ) : (
              title
            )}
            <KindBadge kind={session.kind} subagent={session.subagent} />
            <StatusChip status={session.status} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-faint">
            {showAgent && <span className="text-muted">{session.agent_name}</span>}
            {showAgent && <span aria-hidden="true">·</span>}
            {session.visible && session.asked_by_username && (
              <>
                <span>asked by @{session.asked_by_username}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            {session.visible && (
              <>
                <span>{whereLabel(session)}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span>{stepsLine(session)}</span>
            <span aria-hidden="true">·</span>
            <TimeAgo at={session.created_at} />
          </p>
          {session.visible && session.status_note && session.status !== "done" && <p className="mt-1 text-xs text-muted">{session.status_note}</p>}
        </div>
        <div className="hidden w-32 shrink-0 text-right sm:block">
          <p className="text-xs">
            <SpendOfCap spent={session.charged_micros} cap={session.cap_micros} />
          </p>
          {session.cap_micros != null && <Meter spent={session.charged_micros} cap={session.cap_micros} label="Spent of its cap" size="sm" className="mt-1.5" />}
        </div>
      </div>
    </li>
  );
}

/** A live session as a card: the agent, what it is doing, how far and what it has cost. */
export function SessionCard({ slug, session, action }: { slug: string; session: AgentSession; action?: ReactNode }) {
  return (
    <Card asChild className="relative flex flex-col p-4 transition-colors hover:border-line-strong">
      <li>
        <div className="flex items-center gap-2.5">
          <AgentAvatar agent={{ handle: session.agent_handle, avatar_seed: session.agent_avatar_seed, look: session.agent_look }} size={28} />
          <div className="min-w-0 grow leading-tight">
            <p className="truncate text-sm font-medium">{session.agent_name}</p>
            <p className="truncate text-xs text-faint">
              {whereLabel(session)}
              {session.asked_by_username ? ` · @${session.asked_by_username}` : ""}
            </p>
          </div>
          <StatusChip status={session.status} />
        </div>
        <Link to={sessionHref(slug, session)} className="mt-3 line-clamp-2 text-[0.9375rem] font-medium text-fg after:absolute after:inset-0 hover:underline">
          {session.visible ? session.title || "Untitled session" : "A private session"}
        </Link>
        {session.status_note && <p className="mt-1 line-clamp-2 text-xs text-muted">{session.status_note}</p>}
        <div className="mt-auto pt-4">
          <div className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>
              {stepsLine(session)} · <TimeAgo at={session.created_at} />
            </span>
            <SpendOfCap spent={session.charged_micros} cap={session.cap_micros} />
          </div>
          {session.cap_micros != null && <Meter spent={session.charged_micros} cap={session.cap_micros} label="Spent of its cap" size="sm" className="mt-2" />}
          {action && <div className="relative z-10 mt-3">{action}</div>}
        </div>
      </li>
    </Card>
  );
}

/** A titled panel, as the overview and Spend lay them out. */
export function Panel({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-line bg-surface", className)}>
      <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
        <h3 className="text-sm font-medium">{title}</h3>
        {aside && <span className="text-xs text-faint">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

/**
 * Where money went, ranked: each slice's name, a bar against the largest,
 * its count and its spend. Past five, the rest fold into one line.
 */
export function SliceList({
  slices,
  unit = "",
  empty = "Nothing spent yet this month.",
  href,
  icon,
}: {
  slices: SpendSlice[];
  /** What `count` counts: "sessions"; empty to leave it out. */
  unit?: string;
  empty?: string;
  href?: (slice: SpendSlice) => string | null;
  icon?: (slice: SpendSlice) => ReactNode;
}) {
  const shown = topSlices(slices.filter((s) => s.micros > 0 || s.count > 0));
  const max = Math.max(1, ...shown.map((s) => s.micros));
  if (shown.length === 0) return <p className="px-4 py-6 text-center text-sm text-faint">{empty}</p>;
  return (
    <ul className="divide-y divide-line/60">
      {shown.map((slice) => {
        const to = slice.key !== "__rest" ? href?.(slice) : null;
        const name = <span className="truncate">{slice.label}</span>;
        return (
          <li key={slice.key || "none"} className="px-4 py-2.5 text-sm">
            <div className="flex items-center gap-2">
              {slice.key !== "__rest" && icon?.(slice)}
              {to ? (
                <Link to={to} className="min-w-0 truncate hover:underline">
                  {name}
                </Link>
              ) : (
                <span className={cn("min-w-0 truncate", slice.key === "__rest" && "text-muted")}>{name}</span>
              )}
              <span className="ml-auto shrink-0 text-xs text-faint tabular-nums">{unit && `${slice.count} ${unit}`}</span>
              <span className="w-20 shrink-0 text-right tabular-nums">{money(slice.micros)}</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line/60" aria-hidden="true">
              <div className="h-full rounded-full bg-accent/80" style={{ width: `${Math.max((slice.micros / max) * 100, slice.micros > 0 ? 1 : 0)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Spend by day this month as bars, one per day, each with its amount on
 * hover or focus; a table for screen readers.
 */
export function DailyBars({ period, days, className }: { period: string; days: { day: string; micros: number }[]; className?: string }) {
  const all = monthDays(period, days);
  const max = Math.max(0, ...all.map((d) => d.micros));
  return (
    <div className={className}>
      <div className="flex h-24 items-end gap-0.5" aria-hidden="true">
        {all.map((d) => (
          <Hint key={d.day} label={`${shortDay(d.day)} · ${money(d.micros)}`}>
            <span className="flex h-full min-w-0 flex-1 items-end rounded-t-[3px] hover:bg-raised/60">
              <span
                className={cn("block w-full rounded-t-[3px]", d.micros > 0 ? "bg-accent/80" : "bg-line/70")}
                style={{ height: max > 0 && d.micros > 0 ? `${Math.max(4, (d.micros / max) * 100)}%` : "2px" }}
              />
            </span>
          </Hint>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[0.6875rem] text-faint" aria-hidden="true">
        <span>{all[0] ? shortDay(all[0].day) : ""}</span>
        <span>{all.length > 1 ? shortDay(all[all.length - 1]!.day) : ""}</span>
      </div>
      <table className="sr-only">
        <caption>Spend by day</caption>
        <tbody>
          {all.map((d) => (
            <tr key={d.day}>
              <th scope="row">{shortDay(d.day)}</th>
              <td>{money(d.micros)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A quiet empty state inside a panel or a tab. */
export function Quiet({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <Card tone="plain" className="border-dashed px-6 py-10 text-center">
      {icon && <span className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl bg-raised text-muted">{icon}</span>}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
    </Card>
  );
}
