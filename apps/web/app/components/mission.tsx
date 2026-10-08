/**
 * The pieces mission control and a project's overview are made of: panels
 * with a "View all", what needs the viewer, the activity feed with its
 * filters, the week's pulse with its sparklines, a project's pipeline and
 * its deploy history.
 */
import {
  ArrowRight,
  Brain,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CreditCard,
  Eye,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Hand,
  MessageCircleQuestion,
  MessageSquare,
  Play,
  Rocket,
  Swords,
  Terminal,
  TimerOff,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router";

import type { DeployStatus } from "@g1t/contracts";

import { cn } from "../lib/cn";
import { type ActivityGroup, type Need, type NeedKind, type Verb, isAgent, sparkPoints } from "../lib/mission";
import { Avatar, TimeAgo } from "./ui";
import { Hint } from "./ui/hint";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

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
}: {
  id?: string;
  title: ReactNode;
  icon?: ReactNode;
  count?: number | null;
  all?: { to: string; label?: string } | null;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn("scroll-mt-20", className)}>
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          {icon && <span className="text-faint">{icon}</span>}
          {title}
          {count != null && count > 0 && (
            <span className="rounded-full bg-line px-1.5 text-[0.6875rem] font-medium tabular-nums text-muted">{count}</span>
          )}
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
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Says a section could not be loaded, without taking the page down. */
export function Unavailable({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 rounded-xl border border-dashed border-line px-4 py-5 text-sm text-muted">
      <TriangleAlert size={14} className="text-warn" />
      {what} could not be loaded just now. It will be back on the next refresh.
    </p>
  );
}

/** A quiet, dashed empty state with an optional call to action. */
export function Quiet({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line px-4 py-5 text-sm text-muted">
      <span className="min-w-0 grow">{children}</span>
      {action}
    </div>
  );
}

// --- Needs you ----------------------------------------------------------------

const NEED: Record<NeedKind, { icon: ReactNode; tone: string; label: string }> = {
  limit: { icon: <CreditCard size={15} />, tone: "text-danger", label: "Usage" },
  deploy: { icon: <Rocket size={15} />, tone: "text-danger", label: "Production" },
  invitation: { icon: <UserPlus size={15} />, tone: "text-accent", label: "Invitation" },
  conflict: { icon: <Swords size={15} />, tone: "text-warn", label: "Conflict" },
  stalled: { icon: <Hand size={15} />, tone: "text-warn", label: "Stopped" },
  stuck: { icon: <TimerOff size={15} />, tone: "text-warn", label: "Quiet agent" },
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
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
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
      {needs.length > limit && (
        <button type="button" onClick={() => setAll(!all)} className="mt-2 text-xs text-muted hover:text-fg">
          {all ? "Show fewer" : `Show ${needs.length - limit} more`}
        </button>
      )}
    </>
  );
}

// --- Activity -----------------------------------------------------------------

const VERB: Record<Verb, { icon: ReactNode; tone: string; text: (n: string) => string }> = {
  landed: { icon: <GitMerge size={14} />, tone: "text-merged", text: (n) => `landed ${n}` },
  opened_issue: { icon: <CircleDot size={14} />, tone: "text-success", text: (n) => `opened ${n}` },
  closed_issue: { icon: <CircleSlash size={14} />, tone: "text-faint", text: (n) => `closed ${n}` },
  started: { icon: <Play size={14} />, tone: "text-accent", text: (n) => `started on ${n}` },
  ready: { icon: <GitPullRequest size={14} />, tone: "text-info", text: (n) => `marked ${n} ready for review` },
  checks_passed: { icon: <Terminal size={14} />, tone: "text-success", text: (n) => `checks passed on ${n}` },
  checks_failed: { icon: <Terminal size={14} />, tone: "text-danger", text: (n) => `checks failed on ${n}` },
  approved: { icon: <CircleCheck size={14} />, tone: "text-success", text: (n) => `approved ${n}` },
  changes_requested: { icon: <CircleSlash size={14} />, tone: "text-warn", text: (n) => `asked for changes on ${n}` },
  commented: { icon: <MessageSquare size={14} />, tone: "text-muted", text: (n) => `commented on ${n}` },
  asked: { icon: <MessageCircleQuestion size={14} />, tone: "text-accent", text: (n) => `asked the agent on ${n}` },
  deployed: { icon: <Rocket size={14} />, tone: "text-success", text: () => "deployed production" },
  deploy_failed: { icon: <Rocket size={14} />, tone: "text-danger", text: () => "production build failed" },
  pushed: { icon: <GitCommitHorizontal size={14} />, tone: "text-muted", text: () => "pushed to the default branch" },
  learned: { icon: <Brain size={14} />, tone: "text-accent", text: () => "learned" },
};

function Refs({ numbers, base }: { numbers: number[]; base: string }) {
  const shown = numbers.slice(0, 4);
  return (
    <>
      {shown.map((number, index) => (
        <span key={number}>
          {index > 0 && (index === shown.length - 1 && numbers.length <= 4 ? " and " : ", ")}
          <Link to={`${base}/issues/${number}`} prefetch="intent" className="font-medium text-fg hover:underline">
            #{number}
          </Link>
        </span>
      ))}
      {numbers.length > 4 && ` and ${numbers.length - 4} more`}
    </>
  );
}

/** One group as a sentence: "landed #4 and #3; started on #5". */
function GroupLine({ group }: { group: ActivityGroup }) {
  const base = `/${group.repo.namespace}/${group.repo.name}`;
  return (
    <>
      {group.parts.map((part, index) => {
        const look = VERB[part.verb];
        const [before, after] = look.text("\u0000").split("\u0000");
        return (
          <span key={part.verb}>
            {index > 0 && "; "}
            {part.verb === "learned" ? (
              <>
                learned{" "}
                <Link to={part.to ?? `${base}/memory`} className="text-fg-soft hover:text-fg">
                  “{part.texts[0]}”
                </Link>
                {part.texts.length > 1 && ` and ${part.texts.length - 1} more`}
              </>
            ) : part.numbers.length > 0 ? (
              <>
                {before}
                <Refs numbers={part.numbers} base={base} />
                {after}
              </>
            ) : part.to ? (
              <Link to={part.to} className="hover:text-fg">
                {look.text("")}
              </Link>
            ) : (
              look.text("")
            )}
          </span>
        );
      })}
    </>
  );
}

type Who = "all" | "agents" | "people";

/**
 * What moved across projects, newest first, a burst of one actor's work
 * as one line, filterable by project and by who did it.
 */
export function ActivityFeed({
  groups,
  showRepo = true,
  limit = 14,
  empty,
}: {
  groups: ActivityGroup[];
  showRepo?: boolean;
  limit?: number;
  empty: ReactNode;
}) {
  const [project, setProject] = useState("all");
  const [who, setWho] = useState<Who>("all");
  const [person, setPerson] = useState("all");
  const [more, setMore] = useState(false);
  const projects = useMemo(
    () => [...new Set(groups.map((g) => `${g.repo.namespace}/${g.repo.name}`))].sort(),
    [groups],
  );
  const people = useMemo(
    () => [...new Set(groups.map((g) => g.actor).filter((a): a is string => a != null))].sort(),
    [groups],
  );
  const filtered = groups.filter(
    (g) =>
      (project === "all" || `${g.repo.namespace}/${g.repo.name}` === project) &&
      (person === "all" || g.actor === person) &&
      (who === "all" || (who === "agents" ? g.actor == null || isAgent(g.actor) : g.actor != null && !isAgent(g.actor))),
  );
  const shown = more ? filtered : filtered.slice(0, limit);
  return (
    <div>
      {groups.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-line bg-bg p-0.5 text-xs">
            {(["all", "agents", "people"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setWho(value)}
                className={cn(
                  "rounded-md px-2.5 py-1 font-medium capitalize transition-colors",
                  who === value ? "bg-raised text-fg" : "text-muted hover:text-fg",
                )}
              >
                {value === "all" ? "Everyone" : value}
              </button>
            ))}
          </div>
          {showRepo && projects.length > 1 && (
            <Select value={project} onValueChange={setProject}>
              <SelectTrigger size="sm" className="w-auto max-w-56" aria-label="Project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name.split("/")[1]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {people.length > 1 && (
            <Select value={person} onValueChange={setPerson}>
              <SelectTrigger size="sm" className="w-auto max-w-48" aria-label="Who">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Anyone</SelectItem>
                {people.map((name) => (
                  <SelectItem key={name} value={name} icon={<Avatar name={name} size={16} />}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      {shown.length === 0 ? (
        <Quiet>{groups.length === 0 ? empty : "Nothing matches these filters."}</Quiet>
      ) : (
        <ol className="relative space-y-0.5 before:absolute before:top-3 before:bottom-3 before:left-[0.9375rem] before:w-px before:bg-line">
          {shown.map((group) => {
            const look = VERB[group.parts[0].verb];
            const agent = group.actor == null || isAgent(group.actor);
            return (
              <li key={group.id} className="relative flex items-start gap-3 rounded-lg px-1 py-1.5 text-sm">
                <span
                  className={cn(
                    "relative z-10 mt-0.5 flex size-[1.375rem] shrink-0 items-center justify-center rounded-full bg-bg ring-1 ring-line",
                    look.tone,
                  )}
                >
                  {look.icon}
                </span>
                <span className="min-w-0 grow leading-6 text-muted">
                  {group.actor ? (
                    <span className={cn("mr-1.5 inline-flex items-center gap-1.5 align-middle font-medium", agent ? "text-accent" : "text-fg")}>
                      <Avatar name={group.actor} size={16} />
                      {group.actor}
                    </span>
                  ) : (
                    <span className="mr-1 text-fg-soft">g1t:</span>
                  )}
                  <GroupLine group={group} />
                  {showRepo && (
                    <Link
                      to={`/${group.repo.namespace}/${group.repo.name}`}
                      className="ml-1.5 font-mono text-xs text-faint hover:text-muted"
                    >
                      {group.repo.name}
                    </Link>
                  )}
                  {group.count > 2 && <span className="ml-1.5 text-xs text-faint">· {group.count} events</span>}
                </span>
                <span className="shrink-0 pt-0.5 text-xs text-faint">
                  <TimeAgo at={group.at} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {filtered.length > limit && (
        <button type="button" onClick={() => setMore(!more)} className="mt-2 text-xs text-muted hover:text-fg">
          {more ? "Show fewer" : `Show ${filtered.length - limit} more`}
        </button>
      )}
    </div>
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
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible text-accent" role="img" aria-label={values.map(format).join(", ")}>
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
    <div className="flex h-8 items-end gap-[3px]" aria-label="Recent builds, oldest first">
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

