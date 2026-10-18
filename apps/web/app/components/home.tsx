/**
 * Home's parts (routes/workspace/home.tsx): Where you're needed, Start
 * here, what happened in the span (what people did, what landed, builds,
 * spend) and Running now. Each takes what
 * lib/home.ts worked out and only draws it; a row that arrived while the
 * page was open comes in (`animate-arrive`, lib/use-home-live.ts).
 */
import {
  AlertTriangle,
  ArrowRight,
  AtSign,
  Bell,
  CheckCheck,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Loader,
  Mail,
  Package,
  Rocket,
  Server,
  Sparkles,
  Tag,
  User,
  Users,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import {
  type Attention,
  type AttentionKind,
  type AttentionRow,
  type Away,
  type Digest,
  type DigestActor,
  type DigestColumn,
  type WorkKind,
  WORK_KINDS,
  WORK_LABEL,
  type LandedChange,
  type RunningRow,
  type ShipInfo,
  type Span,
  type Spend,
  type Stake,
  WINDOWS,
  agentLabel,
  explainQuestion,
  landedByDay,
  listOf,
  plural,
  shippedLabel,
  timeOfDay,
  waited,
  whenShort,
} from "../lib/home";
import { askG1t } from "../lib/ask";
import { useArrived } from "../lib/use-home-live";
import { cn } from "../lib/cn";
import { money } from "../lib/money";
import { CommitText } from "./commit-message";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { ButtonLink } from "./ui";
import { AgentMarker, Avatar } from "./ui/avatar";
import { Badge, type BadgeTone } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function Card({
  title,
  hint,
  link,
  children,
  className = "",
}: {
  title: ReactNode;
  /** A few words under the title. */
  hint?: string;
  link?: { label: string; to: string } | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-line bg-surface ${className}`}>
      <header className="flex items-start gap-2 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
        </div>
        {link && (
          <Link to={link.to} className="ml-auto inline-flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted hover:text-fg">
            {link.label}
            <ArrowRight size={12} />
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

export function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-5 pb-5 text-sm text-muted">{children}</p>;
}

function Missing({ names, what }: { names: string[]; what: string }) {
  if (names.length === 0) return null;
  return (
    <p className="flex items-center gap-1.5 border-t border-line px-5 py-2.5 text-xs text-faint">
      <AlertTriangle size={12} className="shrink-0" />
      {listOf(names)} didn&apos;t answer, so {what} isn&apos;t listed.
    </p>
  );
}

// --- The window switch ----------------------------------------------------------

/** Since last visit, last 24 hours, last 7 days: links, so the span is in the address and works without script. */
export function WindowSwitch({ span }: { span: Pick<Span, "key"> }) {
  return (
    <nav aria-label="What happened over" className="flex shrink-0 self-start rounded-lg border border-line bg-surface p-0.5">
      {WINDOWS.map((option) => {
        const current = option.key === span.key;
        return (
          <Link
            key={option.key}
            to={option.key === "last" ? "?" : `?window=${option.key}`}
            preventScrollReset
            aria-current={current ? "true" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
              current ? "bg-raised text-fg shadow-[0_0_0_1px_var(--color-line-strong)]" : "text-muted hover:text-fg",
            )}
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}

// --- Where you're needed ---------------------------------------------------------

const ICON: Record<AttentionKind, ReactNode> = {
  deploy: <Rocket size={16} className="text-danger" />,
  pull_blocked: <GitPullRequest size={16} className="text-warn" />,
  review: <GitPullRequest size={16} className="text-info" />,
  invitation: <Mail size={16} className="text-info" />,
  ready: <GitMerge size={16} className="text-success" />,
  runner: <Server size={16} className="text-warn" />,
  notification: <Bell size={16} className="text-warn" />,
  chat: <AtSign size={16} className="text-accent" />,
};

const STAKE_TONE: Record<NonNullable<Stake["tone"]> | "none", string> = {
  danger: "text-danger",
  warn: "text-warn",
  accent: "text-accent",
  none: "text-fg-soft",
};

function StakeText({ stake }: { stake: Stake }) {
  return <span className={`text-xs font-medium tabular-nums ${STAKE_TONE[stake.tone ?? "none"]}`}>{stake.text}</span>;
}

/** Rows shown before the rest fold away. */
const ROWS = 8;

/** A row that arrived while the page was open: in from above, lit for a moment. */
const ARRIVED = "animate-arrive motion-reduce:animate-none";

function NeedItem({ row, now, arrived }: { row: AttentionRow; now: number; arrived?: boolean }) {
  return (
    <li className={cn("flex items-start gap-3 border-t border-line px-5 py-3 first:border-t-0", arrived && ARRIVED)}>
      <span className="mt-0.5 shrink-0">{ICON[row.kind]}</span>
      <div className="min-w-0 grow">
        <Link to={row.action.to} className="line-clamp-2 text-sm font-semibold text-fg hover:underline sm:block sm:truncate">
          {row.title}
        </Link>
        <p className="truncate text-xs text-muted">{row.detail}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs sm:hidden">
          {row.stake && <StakeText stake={row.stake} />}
          {row.at > 0 && (
            <span className="text-faint" suppressHydrationWarning>
              waiting {waited(row.at, now)}
            </span>
          )}
        </div>
      </div>
      <div className="hidden max-w-48 shrink-0 pt-0.5 text-right whitespace-nowrap sm:block">
        {row.stake && <StakeText stake={row.stake} />}
        {row.at > 0 && (
          <div className="text-[0.6875rem] text-faint tabular-nums" suppressHydrationWarning>
            waiting {waited(row.at, now)}
          </div>
        )}
      </div>
      <ButtonLink to={row.action.to} variant="outline" size="xs" className="border-line-strong px-2.5 text-fg hover:border-accent/50 hover:bg-raised">
        {/* It opens the pull request, where it merges: "Merge" here would read as merging on the spot. */}
        {row.kind === "ready" ? "Open" : row.action.label}
      </ButtonLink>
    </li>
  );
}

/**
 * Everything waiting on you, most pressing and longest waiting first, with
 * the one g1t picked to start with on top and why; past the first few, the
 * rest fold away.
 */
export function NeedsList({ attention, now }: { attention: Attention; now: number }) {
  const { start, missing } = attention;
  const rows = start ? attention.rows.filter((row) => row.key !== start.row.key) : attention.rows;
  const arrived = useArrived(attention.rows.map((row) => row.key));
  return (
    <>
      {start ? (
        <StartRow start={start} now={now} arrived={arrived.has(start.row.key)} />
      ) : (
        attention.rows.length === 0 && (
          <Quiet>
            {missing.length > 0
              ? "Nothing needs you in what could be read."
              : "Nothing needs you. Reviews, invitations and messages for you show here as soon as they arrive."}
          </Quiet>
        )
      )}
      {rows.length > 0 && (
        <ul className={cn(start && "border-t border-line")}>
          {rows.slice(0, ROWS).map((row) => (
            <NeedItem key={row.key} row={row} now={now} arrived={arrived.has(row.key)} />
          ))}
        </ul>
      )}
      {rows.length > ROWS && (
        <details className="group border-t border-line">
          <summary className="cursor-pointer list-none px-5 py-2.5 text-xs font-medium text-fg-soft hover:text-fg">
            <span className="group-open:hidden">Show {(rows.length - ROWS).toLocaleString("en-US")} more</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className="border-t border-line">
            {rows.slice(ROWS).map((row) => (
              <NeedItem key={row.key} row={row} now={now} arrived={arrived.has(row.key)} />
            ))}
          </ul>
        </details>
      )}
      <Missing names={missing} what="what waits there" />
    </>
  );
}

export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-4 px-5 pb-5" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-4 rounded" />
          <div className="grow space-y-1.5">
            <Skeleton className="h-3.5" style={{ width: `${60 - i * 8}%` }} />
            <Skeleton className="h-3" style={{ width: `${80 - i * 10}%` }} />
          </div>
          <Skeleton className="h-7 w-16" />
        </div>
      ))}
    </div>
  );
}

// --- Start here -----------------------------------------------------------------

/** Rows about a pull request: Start here's button opens it, and says so, rather than naming the step (Merge, Review) it can't take there. */
const PULL_KINDS = new Set<AttentionKind>(["ready", "review", "pull_blocked"]);

/** The one g1t picked to start with: the first of Where you're needed, a step bigger, with why. */
function StartRow({ start, now, arrived }: { start: NonNullable<Attention["start"]>; now: number; arrived?: boolean }) {
  const { row } = start;
  const owner = row.owner ? (row.owner.agent ? `@${row.owner.name}` : row.owner.name) : null;
  return (
    <div className={cn("mx-3 mb-3 rounded-xl border border-accent/25 bg-accent/5 px-4 py-3.5", arrived && ARRIVED)}>
      <p className="text-[0.6875rem] font-medium tracking-wide text-accent uppercase">Start here · picked by g1t</p>
      <div className="mt-2 flex items-start gap-3">
        <span className="mt-0.5 shrink-0">{ICON[row.kind]}</span>
        <div className="min-w-0 grow">
          <Link to={row.action.to} className="text-[0.9375rem] leading-snug font-semibold text-fg hover:underline">
            {row.title}
          </Link>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted">{row.detail}</p>
          <p className="mt-2 text-xs leading-relaxed text-fg-soft">{start.why}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <ButtonLink to={row.action.to} variant="accent" size="sm">
              {PULL_KINDS.has(row.kind) ? "Open pull request" : row.action.label}
              <ArrowRight size={14} />
            </ButtonLink>
            <span className="flex flex-wrap items-center gap-x-2 text-xs text-faint">
              {row.stake && <StakeText stake={row.stake} />}
              {row.at > 0 && <span suppressHydrationWarning>waiting {waited(row.at, now)}</span>}
              {owner && (
                <span className="inline-flex items-center gap-1">
                  <User size={11} />
                  {owner}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- What people did in the span ------------------------------------------------

/** "in the span" said the way the span is: "since you were last here", "in the last 24 hours". */
function inSpan(span: Pick<Span, "key" | "note" | "words">): string {
  return span.key === "last" && span.note == null ? "since you were last here" : span.words.charAt(0).toLowerCase() + span.words.slice(1);
}

/** Each kind's colour: the chart's categorical slots, in WORK_KINDS order (app.css --color-series-*). */
const WORK_FILL: Record<WorkKind, string> = {
  pushes: "bg-series-1",
  pulls: "bg-series-2",
  items: "bg-series-3",
  shipped: "bg-series-4",
  docs: "bg-series-5",
  chat: "bg-series-6",
};

/** The most rows the chart shows; the rest are counted under it. */
const WHO_ROWS = 6;

/** What one actor's bar says, for a screen reader and the tooltip's lead. */
function actorWords(actor: DigestActor): string {
  const parts = WORK_KINDS.filter((kind) => actor.parts[kind]).map((kind) => `${WORK_LABEL[kind].toLowerCase()} ${actor.parts[kind]!.toLocaleString("en-US")}`);
  return `${actor.name}${actor.kind === "agent" ? " (agent)" : ""}: ${parts.join(", ")}`;
}

/**
 * Who did what: a row per person or agent, most active first, each a bar
 * split by kind of work and as long as their share of the busiest. A
 * segment names itself on hover; the legend under it is the totals.
 */
function WhoChart({ column }: { column: DigestColumn }) {
  const shown = column.actors.slice(0, WHO_ROWS);
  const more = column.actors.length - shown.length;
  const top = Math.max(1, ...shown.map((actor) => actor.count));
  return (
    <ul className="mt-4 space-y-2.5" aria-label="Who did what">
      {shown.map((actor) => (
        <li key={actor.key} className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_2.5rem] items-center gap-3" aria-label={actorWords(actor)}>
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={actor.name} size={20} agent={actor.kind === "agent"} ring="var(--color-surface)" />
            <span className="truncate text-sm text-fg">{actor.name}</span>
          </span>
          <span className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" style={{ width: `${Math.max(4, (actor.count / top) * 100)}%` }} aria-hidden>
            {WORK_KINDS.filter((kind) => actor.parts[kind]).map((kind) => (
              <Tooltip key={kind}>
                <TooltipTrigger asChild>
                  <span className={cn("h-full min-w-1 transition-opacity hover:opacity-80", WORK_FILL[kind])} style={{ flexGrow: actor.parts[kind] }} />
                </TooltipTrigger>
                <TooltipContent>
                  {actor.name} · {WORK_LABEL[kind]}: {actor.parts[kind]!.toLocaleString("en-US")}
                  {kind === "pushes" && actor.commits > 0 ? ` (${plural(actor.commits, "commit")})` : ""}
                </TooltipContent>
              </Tooltip>
            ))}
          </span>
          <span className="text-right text-xs text-muted tabular-nums">{actor.count.toLocaleString("en-US")}</span>
        </li>
      ))}
      {more > 0 && <li className="text-xs text-muted">and {plural(more, "more")}</li>}
    </ul>
  );
}

/** The legend: each kind with its colour, what it was in words, linked to where it is listed. */
function WorkLegend({ column }: { column: DigestColumn }) {
  return (
    <ul className="mt-4 grid gap-x-6 gap-y-1.5 border-t border-line pt-3 sm:grid-cols-2">
      {column.lines.map((line) => {
        const body = (
          <>
            <span className={cn("mt-1.25 size-2.5 shrink-0 rounded-[3px]", WORK_FILL[line.key])} aria-hidden />
            <span className="min-w-0">
              <span className="font-medium text-fg">{WORK_LABEL[line.key]}</span> <span className="text-muted">{line.text}</span>
            </span>
          </>
        );
        return (
          <li key={line.key} className="text-sm">
            {line.to ? (
              <Link to={line.to} className="group flex items-start gap-2 hover:[&_.text-muted]:text-fg-soft">
                {body}
              </Link>
            ) : (
              <span className="flex items-start gap-2">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "2 people · 1 agent". */
function whoCount(actors: DigestActor[]): string {
  const people = actors.filter((actor) => actor.kind === "person").length;
  const agents = actors.length - people;
  return [people > 0 ? plural(people, "person", "people") : null, agents > 0 ? plural(agents, "agent") : null].filter(Boolean).join(" · ");
}

/**
 * What people did in the span, the top of the span's card: lines with
 * counts linked to where each thing is listed, and the most active faces.
 * It says when it is empty, and which part didn't answer.
 */
export function PeopleSummary({ digest, span, code }: { digest: Digest | null; span: Pick<Span, "key" | "note" | "words">; code: boolean }) {
  const when = inSpan(span);
  if (!digest) {
    return (
      <div className="px-5 py-4">
        <p className="text-sm text-muted">What happened couldn&apos;t be read right now. It shows here once Code and Chat answer.</p>
      </div>
    );
  }
  const silent = digest.missing.filter((name) => name === "Code" || name === "Chat");
  const col = digest.people;
  return (
    <div className="px-5 py-4" aria-label="What people did">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Users size={15} className="text-muted" />
          People
        </h3>
        {col.actors.length > 0 && (
          <Badge tone="neutral" size="md" className="tabular-nums">
            {whoCount(col.actors)}
          </Badge>
        )}
      </div>
      {col.lines.length > 0 ? (
        <>
          {col.actors.length > 0 && <WhoChart column={col} />}
          <WorkLegend column={col} />
        </>
      ) : (
        <p className="mt-3 text-sm text-muted">
          {silent.length > 0
            ? `Nothing from what could be read ${when}.`
            : code
              ? `Nothing pushed, opened, merged, reviewed, edited or said ${when}.`
              : `No doc edited and nothing said ${when}.`}
        </p>
      )}
      {silent.length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-faint">
          <AlertTriangle size={12} className="shrink-0" />
          {listOf(silent)} didn&apos;t answer, so {silent.length === 1 ? "its part" : "their parts"} {silent.length === 1 ? "isn't" : "aren't"} counted.
        </p>
      )}
      {digest.partial && <p className="mt-3 text-xs text-faint">More happened than Home reads at once, so some counts are low.</p>}
    </div>
  );
}

export function SpanSkeleton() {
  return (
    <div className="space-y-3 px-5 py-4" aria-busy="true">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <Skeleton className="h-3.5 w-3/4" />
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="h-3.5 w-2/3" />
    </div>
  );
}

// --- Landed and builds -----------------------------------------------------------

/** Rows each list shows before the rest fold away. */
const LIST_ROWS = 5;

function When({ at, now, tz, timeOnly }: { at: number; now: number; tz: string | null; timeOnly?: boolean }) {
  return (
    <span className="shrink-0 text-xs text-faint tabular-nums" suppressHydrationWarning>
      {timeOnly ? timeOfDay(at, tz) : whenShort(at, now, tz)}
    </span>
  );
}

function Folded<T>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  return (
    <>
      <ul>{items.slice(0, LIST_ROWS).map(render)}</ul>
      {items.length > LIST_ROWS && (
        <details className="group border-t border-line">
          <summary className="cursor-pointer list-none px-5 py-2.5 text-xs font-medium text-fg-soft hover:text-fg">
            <span className="group-open:hidden">Show {(items.length - LIST_ROWS).toLocaleString("en-US")} more</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className="border-t border-line">{items.slice(LIST_ROWS).map(render)}</ul>
        </details>
      )}
    </>
  );
}

const rowClass = "flex items-center gap-3 border-t border-line px-5 py-2.5 first:border-t-0";

const LANDED_ICON: Record<LandedChange["kind"], ReactNode> = {
  merge: <GitMerge size={15} className="shrink-0 text-success" />,
  push: <GitCommitHorizontal size={15} className="shrink-0 text-success" />,
  deploy: <Rocket size={15} className="shrink-0 text-success" />,
  release: <Tag size={15} className="shrink-0 text-info" />,
  package: <Package size={15} className="shrink-0 text-info" />,
};

/** A few words on the card's line: how many of each kind landed. */
function landedHint(landed: LandedChange[]): string {
  const count = (kind: LandedChange["kind"]) => landed.filter((change) => change.kind === kind).length;
  const parts: string[] = [];
  const merged = count("merge");
  const pushes = count("push");
  const deploys = count("deploy");
  const published = count("release") + count("package");
  if (merged > 0) parts.push(`${merged.toLocaleString("en-US")} merged`);
  if (pushes > 0) parts.push(`${pushes.toLocaleString("en-US")} pushed direct`);
  if (deploys > 0) parts.push(`${deploys.toLocaleString("en-US")} ${deploys === 1 ? "deploy" : "deploys"}`);
  if (published > 0) parts.push(`${published.toLocaleString("en-US")} published`);
  return parts.join(" · ");
}

const SHIP_TONE: Record<ShipInfo["state"], BadgeTone> = {
  live: "success",
  deploying: "info",
  waiting: "neutral",
  failed: "danger",
};

/** Whether a merge or a push is live yet, linked to the deployment that shipped it (or the one under way, or the one that failed). */
function Shipped({ change }: { change: LandedChange }) {
  const ship = change.shipped;
  if (!ship) return null;
  const label = shippedLabel(ship, change);
  const badge = (
    <Badge tone={SHIP_TONE[ship.state]} className="relative z-10">
      {ship.state === "live" && <Rocket size={10} aria-hidden="true" />}
      {ship.state === "deploying" && <Loader size={10} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
      {label}
    </Badge>
  );
  return ship.to ? (
    <Link to={ship.to} className="relative z-10 rounded-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
      {badge}
    </Link>
  ) : (
    badge
  );
}

/** The agent marker on a change made in a harness session, linked to the session. */
function Agent({ change }: { change: LandedChange }) {
  const mark = change.agent;
  if (!mark) return null;
  const label = agentLabel(mark);
  const marker = <AgentMarker size={16} inline />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {mark.to ? (
          <Link
            to={mark.to}
            aria-label={label}
            className="relative z-10 inline-flex shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            {marker}
          </Link>
        ) : (
          <span role="img" aria-label={label} className="inline-flex shrink-0">
            {marker}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Explain one change that landed: what it did and why, in plain English, in the top bar's Ask (components/home-ask). */
function ExplainButton({ change }: { change: LandedChange }) {
  return (
    <Hint label="Explain this change in plain English">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Explain ${change.title}`}
        onClick={() => askG1t(explainQuestion(change))}
        className="shrink-0 text-muted hover:text-accent"
      >
        <Sparkles size={13} />
      </Button>
    </Hint>
  );
}

function LandedItem({ change, now, tz, timeOnly, arrived }: { change: LandedChange; now: number; tz: string | null; timeOnly?: boolean; arrived?: boolean }) {
  return (
    <li className={cn(rowClass, "items-start", arrived && ARRIVED)}>
      <span className="mt-0.5 shrink-0">{change.failed ? <Rocket size={15} className="shrink-0 text-danger" /> : LANDED_ICON[change.kind]}</span>
      <div className="min-w-0 grow">
        <div className="flex min-w-0 items-center gap-1.5">
          {change.refsIn ? (
            // A commit's subject: its `#12`s link to what they name, the rest to the commit.
            <span className="line-clamp-2 text-sm text-fg sm:truncate">
              <CommitText text={change.title} base={`/${change.refsIn}`} to={change.to} linkClassName="hover:underline" />
            </span>
          ) : (
            <Link to={change.to} className="line-clamp-2 text-sm text-fg hover:underline sm:truncate">
              {change.title}
            </Link>
          )}
          <Agent change={change} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 truncate text-xs text-muted">{change.detail}</p>
          <Shipped change={change} />
        </div>
      </div>
      <ExplainButton change={change} />
      <When at={change.at} now={now} tz={tz} timeOnly={timeOnly} />
    </li>
  );
}

/** How many of the span's merges and pushes are live, deploying, waiting or failed: the feed's line. */
function shipFacts(landed: LandedChange[]): { key: string; text: string; tone: BadgeTone }[] {
  const count = (state: ShipInfo["state"]) => landed.filter((change) => change.shipped?.state === state).length;
  const failed = count("failed") + landed.filter((change) => change.failed).length;
  const facts: { key: string; text: string; tone: BadgeTone }[] = [];
  if (count("live") > 0) facts.push({ key: "live", text: `${count("live").toLocaleString("en-US")} live`, tone: "success" });
  if (count("deploying") > 0) facts.push({ key: "deploying", text: `${count("deploying").toLocaleString("en-US")} deploying`, tone: "info" });
  if (count("waiting") > 0) facts.push({ key: "waiting", text: `${count("waiting").toLocaleString("en-US")} waiting to deploy`, tone: "neutral" });
  if (failed > 0) facts.push({ key: "failed", text: `${failed.toLocaleString("en-US")} deploy failed`, tone: "danger" });
  return facts;
}

/**
 * Everything that landed in the span, newest first, in the span's card:
 * pull requests merged, commits pushed straight to a default branch,
 * releases and package versions published, and production builds no merge
 * or push already speaks for (`landedDeploys`). Each merge and push says
 * whether it is live yet, and one made in a harness session carries the
 * agent marker. Over the last 7 days, day by day.
 */
export function LandedFeed({
  landed,
  missing,
  code,
  now,
  tz,
  byDay = false,
  scope,
}: {
  landed: LandedChange[] | null;
  missing: string[];
  code: boolean;
  now: number;
  tz: string | null;
  byDay?: boolean;
  /** The span: switching it lists other things, which are not arrivals. */
  scope?: string;
}) {
  const arrived = useArrived(landed?.map((change) => change.key) ?? [], scope);
  if (!code) return null;
  const render = (change: LandedChange) => <LandedItem key={change.key} change={change} now={now} tz={tz} timeOnly={byDay} arrived={arrived.has(change.key)} />;
  const facts = landed ? shipFacts(landed) : [];
  return (
    <div className="border-t border-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 pt-3.5 pb-2">
        <h3 className="text-sm font-semibold text-fg">Landed</h3>
        {landed && landed.length > 0 && <span className="text-xs text-muted">{landedHint(landed)}</span>}
        {facts.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 sm:ml-auto" aria-label="Deployed">
            {facts.map((fact) => (
              <li key={fact.key}>
                <Badge tone={fact.tone}>{fact.text}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!landed ? (
        <Quiet>Code didn&apos;t answer, so what landed can&apos;t be listed right now.</Quiet>
      ) : landed.length === 0 ? (
        <Quiet>
          {missing.length > 0
            ? "Nothing landed in what could be read."
            : "Nothing merged, pushed to a default branch, deployed to production or published in this span."}
        </Quiet>
      ) : byDay ? (
        landedByDay(landed, now, tz).map((day) => (
          <section key={day.key} aria-label={day.label} className="border-t border-line">
            <h4 className="flex items-baseline gap-2 bg-raised/40 px-5 py-1.5 text-xs font-medium text-fg-soft">
              {day.label}
              <span className="font-normal text-faint tabular-nums">{day.rows.length.toLocaleString("en-US")}</span>
            </h4>
            <Folded items={day.rows} render={render} />
          </section>
        ))
      ) : (
        <div className="border-t border-line">
          <Folded items={landed} render={render} />
        </div>
      )}
      {landed && <Missing names={missing} what="everything that landed" />}
    </div>
  );
}

// --- Settled for you ---------------------------------------------------------------

/**
 * Your notifications that settled by themselves in the span (a later run
 * passed, it merged, it deployed), each with why: in the side column.
 * What shipped is the Landed feed's; what still needs you, Where you're
 * needed.
 */
export function SettledCard({ away, now }: { away: Away | null; now: number }) {
  const count = away?.settled.length ?? 0;
  return (
    <Card
      title="Settled for you"
      hint={away ? (count > 0 ? `${count.toLocaleString("en-US")} finished by themselves` : "Nothing finished by itself") : undefined}
      link={{ label: "Done", to: "/notifications/done" }}
    >
      {!away ? (
        <Quiet>Your notifications couldn&apos;t be read, so what settled can&apos;t be listed right now.</Quiet>
      ) : count === 0 ? null : (
        <div className="border-t border-line">
          <Folded
            items={away.settled}
            render={(row) => (
              <li key={row.key} className={cn(rowClass, "items-start px-4")}>
                <CheckCheck size={14} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
                <div className="min-w-0 grow">
                  <Link to={row.to} className="block truncate text-sm text-fg hover:underline">
                    {row.title}
                  </Link>
                  <p className="truncate text-xs text-muted">
                    <span className="text-fg-soft">{row.why}</span>
                    {row.where && ` · ${row.where}`}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-faint tabular-nums" suppressHydrationWarning>
                  {waited(row.at, now)}
                </span>
              </li>
            )}
          />
        </div>
      )}
    </Card>
  );
}

// --- Spend in the span ------------------------------------------------------------

/**
 * Each kind of charge keeps its colour, whatever its rank: sandboxes and
 * runners one, hosting another, storage and the rest grey.
 */
function kindColour(kind: string): string {
  if (/sandbox|runner/i.test(kind)) return "bg-info";
  if (/deploy|domain/i.test(kind)) return "bg-fg-soft";
  if (/storage|git|cache|package/i.test(kind)) return "bg-muted";
  return "bg-faint";
}

const utcDay = (day: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(Date.parse(`${day}T12:00:00Z`));

export function SpendCard({ spend, slug, span }: { spend: Spend | null; slug: string; span: Pick<Span, "key" | "note" | "words"> }) {
  return (
    <Card title="Spent" link={{ label: "Billing", to: `/${slug}/-/billing` }}>
      {!spend ? (
        <Quiet>Billing didn&apos;t answer, so spend can&apos;t be shown right now.</Quiet>
      ) : (
        <div className="px-5 pb-5">
          <div className="text-2xl font-semibold tracking-tight text-fg tabular-nums">{money(spend.totalMicros)}</div>
          <p className="mt-1 text-xs text-muted">
            {spend.from === spend.to ? utcDay(spend.from) : `${utcDay(spend.from)} – ${utcDay(spend.to)}`}
            {spend.monthMicros != null && ` · ${money(spend.monthMicros)} this month so far`}
          </p>
          {spend.lines.length === 0 ? (
            <p className="mt-4 text-sm text-muted">Nothing on the statement {inSpan(span)}.</p>
          ) : (
            <>
              <div className="mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Spend by kind of charge">
                {spend.lines.map((line) => (
                  <span key={line.kind} className={`h-full min-w-0.75 ${kindColour(line.kind)}`} style={{ flexGrow: line.micros }} />
                ))}
              </div>
              <ul className="mt-3 space-y-2">
                {spend.lines.map((line) => (
                  <li key={line.kind} className="flex items-center gap-2 text-sm">
                    <span className={`size-2 shrink-0 rounded-xs ${kindColour(line.kind)}`} aria-hidden />
                    <span className="min-w-0 grow truncate text-fg-soft">{line.kind}</span>
                    <span className="text-fg tabular-nums">{money(line.micros)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-4 text-[0.6875rem] leading-relaxed text-faint">At price, by whole UTC days from the day the span began.</p>
        </div>
      )}
    </Card>
  );
}

export function SpendSkeleton() {
  return (
    <div className="space-y-3 px-5 pb-5" aria-busy="true">
      <Skeleton className="h-8 w-28" />
      <Skeleton className="h-2.5 w-full rounded-full" />
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

// --- Running now -------------------------------------------------------------------

const RUNNING_ICON: Record<RunningRow["kind"], ReactNode> = {
  workflow: <Workflow size={15} className="text-info" />,
  deploy: <Rocket size={15} className="text-info" />,
};

export function RunningList({ rows, missing, now }: { rows: RunningRow[]; missing: string[]; now: number }) {
  const arrived = useArrived(rows.map((row) => row.key));
  return (
    <>
      {rows.length === 0 ? (
        <Quiet>
          {missing.length > 0 ? "Nothing is running in what could be read." : "Nothing is running. Workflow runs and builds show here while they go."}
        </Quiet>
      ) : (
        <Folded
          items={rows}
          render={(row) => (
            // In the side column: the title gets the width, its state and how long under it.
            <li key={row.key} className={cn(rowClass, "items-start px-4", arrived.has(row.key) && ARRIVED)}>
              <span className="mt-0.5 shrink-0">{RUNNING_ICON[row.kind]}</span>
              <div className="min-w-0 grow">
                <Link to={row.to} className="line-clamp-2 text-sm text-fg hover:underline">
                  {row.title}
                </Link>
                <p className="truncate text-xs text-muted">{row.detail}</p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-soft">
                  <Loader size={11} className="animate-spin text-accent motion-reduce:animate-none" aria-hidden />
                  {row.status}
                  <span className="text-faint tabular-nums" suppressHydrationWarning>
                    · {waited(row.at, now)}
                  </span>
                </p>
              </div>
            </li>
          )}
        />
      )}
      <Missing names={missing} what="everything running" />
    </>
  );
}
