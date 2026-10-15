/**
 * Home's parts (routes/workspace/home.tsx): Where you're needed, Start
 * here, what happened in the span (what people did, what landed, builds,
 * spend) and Running now. Each takes what
 * lib/home.ts worked out and only draws it.
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
  type DeployRow,
  type Digest,
  type DigestActor,
  type DigestColumn,
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
  shippedLabel,
  timeOfDay,
  waited,
  whenShort,
} from "../lib/home";
import { askG1t } from "../lib/ask";
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

function NeedItem({ row, now }: { row: AttentionRow; now: number }) {
  return (
    <li className="flex items-start gap-3 border-t border-line px-5 py-3 first:border-t-0">
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

/** Everything waiting on you, most pressing and longest waiting first; past the first few, the rest fold away. */
export function NeedsList({ attention, now }: { attention: Attention; now: number }) {
  const { rows, missing } = attention;
  return (
    <>
      {rows.length === 0 ? (
        <Quiet>{missing.length > 0 ? "Nothing needs you in what could be read." : "Nothing needs you. Reviews, invitations and messages for you show here as soon as they arrive."}</Quiet>
      ) : (
        <ul>
          {rows.slice(0, ROWS).map((row) => (
            <NeedItem key={row.key} row={row} now={now} />
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
              <NeedItem key={row.key} row={row} now={now} />
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

export function StartHere({ attention, now }: { attention: Attention; now: number }) {
  const start = attention.start;
  return (
    <Card
      title={
        <>
          Start here <span className="font-normal text-faint">· picked by g1t</span>
        </>
      }
    >
      {!start ? (
        <Quiet>{attention.missing.length > 0 ? "Nothing to pick from what could be read." : "Nothing needs you, so there's nothing to pick."}</Quiet>
      ) : (
        <div className="px-5 pb-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0">{ICON[start.row.kind]}</span>
            <div className="min-w-0">
              <Link to={start.row.action.to} className="text-[0.9375rem] leading-snug font-semibold text-fg hover:underline">
                {start.row.title}
              </Link>
              <p className="mt-1 line-clamp-2 text-xs text-muted">{start.row.detail}</p>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            {start.row.owner && (
              <>
                <dt className="text-muted">Owner</dt>
                <dd className="flex min-w-0 items-center gap-1.5 text-fg-soft">
                  <User size={12} className="shrink-0 text-muted" />
                  <span className="truncate">{start.row.owner.agent ? `@${start.row.owner.name}` : start.row.owner.name}</span>
                </dd>
              </>
            )}
            <dt className="text-muted">Next</dt>
            <dd className="text-fg-soft">{start.row.action.label}</dd>
            {start.row.at > 0 && (
              <>
                <dt className="text-muted">Waiting</dt>
                <dd className="text-fg-soft" suppressHydrationWarning>
                  {waited(start.row.at, now)}
                </dd>
              </>
            )}
            {start.row.stake && (
              <>
                <dt className="text-muted">At stake</dt>
                <dd>
                  <StakeText stake={start.row.stake} />
                </dd>
              </>
            )}
          </dl>
          <p className="mt-4 rounded-lg bg-raised/60 px-3 py-2.5 text-xs leading-relaxed text-fg-soft">
            <span className="font-medium text-fg">Why this one: </span>
            {start.why}
          </p>
          <Link
            to={start.row.action.to}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-bg transition-colors hover:bg-accent-hover"
          >
            {PULL_KINDS.has(start.row.kind) ? "Open pull request" : start.row.action.label}
            <ArrowRight size={14} />
          </Link>
        </div>
      )}
    </Card>
  );
}

// --- What people did in the span ------------------------------------------------

/** "in the span" said the way the span is: "since you were last here", "in the last 24 hours". */
function inSpan(span: Pick<Span, "key" | "note" | "words">): string {
  return span.key === "last" && span.note == null ? "since you were last here" : span.words.charAt(0).toLowerCase() + span.words.slice(1);
}

/** The faces of the most active, with a tooltip naming each, and how many more there were. */
const FACES = 5;

function Faces({ actors }: { actors: DigestActor[] }) {
  if (actors.length === 0) return null;
  const shown = actors.slice(0, FACES);
  const more = actors.length - shown.length;
  return (
    <div className="flex items-center gap-1.5">
      <ul className="flex -space-x-1.5" aria-label="Most active">
        {shown.map((actor) => (
          <li key={actor.key} className="rounded-full ring-2 ring-surface">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block">
                  <Avatar name={actor.name} size={22} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {actor.name} · {actor.count.toLocaleString("en-US")} {actor.count === 1 ? "thing" : "things"}
              </TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
      {more > 0 && <span className="text-xs text-muted">+{more.toLocaleString("en-US")}</span>}
    </div>
  );
}

/** The lines: each what was done, with its count in the words, linked to where it is listed. */
function Lines({ column }: { column: DigestColumn }) {
  return (
    <ul className="mt-3 space-y-1.5">
      {column.lines.map((line) => (
        <li key={line.key} className="flex items-start gap-2 text-sm text-fg">
          <span className="mt-1.75 size-1.5 shrink-0 rounded-full bg-fg-soft/60" aria-hidden />
          {line.to ? (
            <Link to={line.to} className="hover:underline">
              {line.text}
            </Link>
          ) : (
            <span>{line.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * What people did in the span: lines with counts linked to where each
 * thing is listed, and the most active faces. It says when it is empty,
 * and which part didn't answer.
 */
export function PeopleCard({ digest, span, code }: { digest: Digest | null; span: Pick<Span, "key" | "note" | "words">; code: boolean }) {
  const when = inSpan(span);
  if (!digest) {
    return (
      <section className="rounded-2xl border border-line bg-surface p-5">
        <p className="text-sm text-muted">What happened couldn&apos;t be read right now. It shows here once Code and Chat answer.</p>
      </section>
    );
  }
  const silent = digest.missing.filter((name) => name === "Code" || name === "Chat");
  const col = digest.people;
  return (
    <section className="rounded-2xl border border-line bg-surface p-5" aria-label="What people did">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Users size={15} className="text-muted" />
          People
        </h3>
        {col.actors.length > 0 && (
          <Badge tone="neutral" size="md" className="tabular-nums">
            {col.actors.length.toLocaleString("en-US")} active
          </Badge>
        )}
        <span className="ml-auto">
          <Faces actors={col.actors} />
        </span>
      </div>
      {col.lines.length > 0 ? (
        <Lines column={col} />
      ) : (
        <p className="mt-3 text-sm text-muted">
          {silent.length > 0
            ? `Nothing from what could be read ${when}.`
            : code
              ? `Nobody pushed, opened, merged, reviewed, edited a doc or said anything ${when}.`
              : `Nobody edited a doc or said anything ${when}.`}
        </p>
      )}
      {silent.length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-faint">
          <AlertTriangle size={12} className="shrink-0" />
          {listOf(silent)} didn&apos;t answer, so {silent.length === 1 ? "its part" : "their parts"} {silent.length === 1 ? "isn't" : "aren't"} counted.
        </p>
      )}
      {digest.partial && <p className="mt-3 text-xs text-faint">More happened than Home reads at once, so some counts are low.</p>}
    </section>
  );
}

export function SpanSkeleton() {
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-surface p-5" aria-busy="true">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <Skeleton className="h-3.5 w-3/4" />
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="h-3.5 w-2/3" />
    </section>
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
          <Link to={mark.to} aria-label={label} className="relative z-10 inline-flex shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
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
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Explain ${change.title}`} onClick={() => askG1t(explainQuestion(change))} className="shrink-0 text-muted hover:text-accent">
        <Sparkles size={13} />
      </Button>
    </Hint>
  );
}

function LandedItem({ change, now, tz, timeOnly }: { change: LandedChange; now: number; tz: string | null; timeOnly?: boolean }) {
  return (
    <li className={cn(rowClass, "items-start")}>
      <span className="mt-0.5 shrink-0">{LANDED_ICON[change.kind]}</span>
      <div className="min-w-0 grow">
        <div className="flex min-w-0 items-center gap-1.5">
          {change.refsIn ? (
            // A commit's subject: its `#12`s link to their issues, the rest to the commit.
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

/**
 * Everything that landed in the span, newest first: pull requests merged,
 * commits pushed straight to a default branch, production builds that went
 * live, releases and package versions published. Each merge and push says
 * whether it is live yet, and one made in a harness session carries the
 * agent marker. Over the last 7 days, day by day.
 */
export function LandedCard({
  landed,
  missing,
  code,
  now,
  tz,
  byDay = false,
}: {
  landed: LandedChange[] | null;
  missing: string[];
  code: boolean;
  now: number;
  tz: string | null;
  byDay?: boolean;
}) {
  if (!code) return null;
  const render = (change: LandedChange) => <LandedItem key={change.key} change={change} now={now} tz={tz} timeOnly={byDay} />;
  return (
    <Card title="Landed" hint={landed && landed.length > 0 ? landedHint(landed) : undefined}>
      {!landed ? (
        <Quiet>Code didn&apos;t answer, so what landed can&apos;t be listed right now.</Quiet>
      ) : landed.length === 0 ? (
        <Quiet>{missing.length > 0 ? "Nothing landed in what could be read." : "Nothing merged, pushed to a default branch, deployed to production or published in this span."}</Quiet>
      ) : byDay ? (
        landedByDay(landed, now, tz).map((day) => (
          <section key={day.key} aria-label={day.label} className="border-t border-line first-of-type:border-t-0">
            <h3 className="flex items-baseline gap-2 bg-raised/40 px-5 py-1.5 text-xs font-medium text-fg-soft">
              {day.label}
              <span className="font-normal text-faint tabular-nums">{day.rows.length.toLocaleString("en-US")}</span>
            </h3>
            <Folded items={day.rows} render={render} />
          </section>
        ))
      ) : (
        <Folded items={landed} render={render} />
      )}
      {landed && <Missing names={missing} what="everything that landed" />}
    </Card>
  );
}

// --- While you were away -----------------------------------------------------------

/**
 * What g1t settled for you since you were last here (a later run passed,
 * it merged, it deployed), what shipped, and what still needs you: the
 * counts on one line, then each thing that settled and why.
 */
export function AwayCard({ away, span, now }: { away: Away | null; span: Pick<Span, "key" | "note" | "words">; now: number }) {
  const title = span.key === "last" && span.note == null ? "While you were away" : "Settled for you";
  if (!away) {
    return (
      <Card title={title}>
        <Quiet>Your notifications couldn&apos;t be read, so what settled can&apos;t be listed right now.</Quiet>
      </Card>
    );
  }
  const facts: { key: string; text: string; tone: BadgeTone; to: string | null }[] = [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  facts.push({ key: "settled", text: `${plural(away.settled.length, "notification")} settled`, tone: away.settled.length > 0 ? "success" : "neutral", to: "/notifications?view=done" });
  if (away.shipped > 0) facts.push({ key: "shipped", text: `${plural(away.shipped, "change")} live`, tone: "success", to: null });
  if (away.deploying > 0) facts.push({ key: "deploying", text: `${away.deploying.toLocaleString("en-US")} deploying`, tone: "info", to: null });
  if (away.waiting > 0) facts.push({ key: "waiting", text: `${away.waiting.toLocaleString("en-US")} waiting to deploy`, tone: "neutral", to: null });
  if (away.failed > 0) facts.push({ key: "failed", text: `${away.failed.toLocaleString("en-US")} deploy failed`, tone: "danger", to: null });
  facts.push({ key: "needs", text: away.needs > 0 ? `${plural(away.needs, "thing")} still ${away.needs === 1 ? "needs" : "need"} you` : "Nothing needs you", tone: away.needs > 0 ? "warn" : "neutral", to: "#needed" });
  return (
    <Card title={title} hint="What finished by itself, and what is live" link={{ label: "Done", to: "/notifications?view=done" }}>
      <ul className="flex flex-wrap gap-1.5 px-5 pb-3" aria-label="In short">
        {facts.map((fact) => (
          <li key={fact.key}>
            {fact.to ? (
              <Link to={fact.to} className="rounded-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                <Badge tone={fact.tone} size="md">
                  {fact.text}
                </Badge>
              </Link>
            ) : (
              <Badge tone={fact.tone} size="md">
                {fact.text}
              </Badge>
            )}
          </li>
        ))}
      </ul>
      {away.settled.length > 0 && (
        <div className="border-t border-line">
          <Folded
            items={away.settled}
            render={(row) => (
              <li key={row.key} className={rowClass}>
                <CheckCheck size={15} className="shrink-0 text-success" aria-hidden="true" />
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
                  {waited(row.at, now)} ago
                </span>
              </li>
            )}
          />
        </div>
      )}
    </Card>
  );
}

export function DeploysCard({ deploys, complete, code, now, tz }: { deploys: DeployRow[] | null; complete: boolean; code: boolean; now: number; tz: string | null }) {
  // A workspace that doesn't deploy has nothing to say here.
  if (!code || (deploys && deploys.length === 0)) return null;
  const failed = deploys?.filter((row) => row.outcome === "failed").length ?? 0;
  return (
    <Card title="Deploys" hint={deploys ? `${deploys.length.toLocaleString("en-US")} finished${failed ? ` · ${failed} failed` : ""}` : undefined}>
      {!deploys ? (
        <Quiet>Deployments didn&apos;t answer, so builds can&apos;t be listed right now.</Quiet>
      ) : (
        <Folded
          items={deploys}
          render={(row) => (
            <li key={row.key} className={rowClass}>
              <Rocket size={15} className={cn("shrink-0", row.outcome === "failed" ? "text-danger" : "text-success")} />
              <div className="min-w-0 grow">
                <Link to={row.to} className="block truncate text-sm text-fg hover:underline">
                  {row.kind === "production" ? "Production" : `Preview of ${row.branch ?? "a branch"}`} of {row.project}
                  <span className={cn("ml-2 text-xs font-medium", row.outcome === "failed" ? "text-danger" : "text-success")}>
                    {row.outcome === "failed" ? "Failed" : "Went live"}
                  </span>
                </Link>
                <p className="truncate text-xs text-muted">
                  <span className="font-mono">{row.commit}</span> · by {row.by}
                </p>
              </div>
              <When at={row.at} now={now} tz={tz} />
            </li>
          )}
        />
      )}
      {deploys && !complete && <p className="border-t border-line px-5 py-2.5 text-xs text-faint">Some projects&apos; builds couldn&apos;t be read.</p>}
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
          <div className="text-3xl font-semibold tracking-tight text-fg tabular-nums">{money(spend.totalMicros)}</div>
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
          <p className="mt-4 text-[0.6875rem] leading-relaxed text-faint">
            At price, as your statement shows it. The statement keeps whole days, midnight to midnight UTC, so this counts from the start of the day the span began.
          </p>
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
  return (
    <>
      {rows.length === 0 ? (
        <Quiet>{missing.length > 0 ? "Nothing is running in what could be read." : "Nothing is running. Workflow runs and builds show here while they go."}</Quiet>
      ) : (
        <Folded
          items={rows}
          render={(row) => (
            <li key={row.key} className={rowClass}>
              <span className="shrink-0">{RUNNING_ICON[row.kind]}</span>
              <div className="min-w-0 grow">
                <Link to={row.to} className="block truncate text-sm text-fg hover:underline">
                  {row.title}
                </Link>
                <p className="truncate text-xs text-muted">{row.detail}</p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-xs text-fg-soft">
                <Loader size={11} className="animate-spin text-accent motion-reduce:animate-none" aria-hidden />
                {row.status}
              </span>
              <span className="hidden w-14 shrink-0 text-right text-xs text-faint tabular-nums sm:inline" suppressHydrationWarning>
                {waited(row.at, now)}
              </span>
            </li>
          )}
        />
      )}
      <Missing names={missing} what="everything running" />
    </>
  );
}
