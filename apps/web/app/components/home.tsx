/**
 * Home's parts (routes/workspace/home.tsx): Where you're needed, Start
 * here, what happened in the span (what people and agents did, what
 * landed, builds, decisions, spend) and Running now. Each takes what
 * lib/home.ts worked out and only draws it.
 */
import {
  AlertTriangle,
  ArrowRight,
  AtSign,
  Bell,
  Bot,
  CircleDollarSign,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Hourglass,
  Lightbulb,
  Loader,
  Mail,
  Package,
  Rocket,
  Server,
  Sparkles,
  Store,
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
  type DecisionRow,
  type DeployRow,
  type Digest,
  type DigestActor,
  type DigestColumn,
  type LandedChange,
  type RunningRow,
  type Span,
  type SpanWork,
  type Spend,
  type Stake,
  type TaskOutcome,
  OUTCOME_LABEL,
  SOURCE_LABEL,
  WINDOWS,
  listOf,
  trendLabel,
  waited,
  whenShort,
} from "../lib/home";
import { cn } from "../lib/cn";
import { money } from "../lib/money";
import { type AgentLike, AgentAvatar } from "./agent-avatar";
import { ButtonLink } from "./ui";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
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
  limit: <CircleDollarSign size={16} className="text-danger" />,
  deploy: <Rocket size={16} className="text-danger" />,
  session_cap: <CircleDollarSign size={16} className="text-warn" />,
  agent_budget: <CircleDollarSign size={16} className="text-danger" />,
  pull_blocked: <GitPullRequest size={16} className="text-warn" />,
  ready: <GitMerge size={16} className="text-accent" />,
  review: <GitPullRequest size={16} className="text-info" />,
  invitation: <Mail size={16} className="text-info" />,
  install_request: <Store size={16} className="text-info" />,
  agent_waiting: <Sparkles size={16} className="text-warn" />,
  stuck: <Hourglass size={16} className="text-warn" />,
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
        {row.action.label}
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
        <Quiet>{missing.length > 0 ? "Nothing needs you in what could be read." : "Nothing needs you. Reviews, approvals and messages for you show here as soon as they arrive."}</Quiet>
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
              <p className="text-[0.9375rem] leading-snug font-semibold text-fg">{start.row.title}</p>
              <p className="mt-1 line-clamp-2 text-xs text-muted">{start.row.detail}</p>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            {start.row.owner && (
              <>
                <dt className="text-muted">Owner</dt>
                <dd className="flex min-w-0 items-center gap-1.5 text-fg-soft">
                  {start.row.owner.agent ? <Bot size={12} className="shrink-0 text-accent" /> : <User size={12} className="shrink-0 text-muted" />}
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
            {start.row.action.label}
            <ArrowRight size={14} />
          </Link>
        </div>
      )}
    </Card>
  );
}

// --- The agents' work in the span -----------------------------------------------

/** Each outcome's mark: status colours, always beside a label in the legend. */
const MARK: Record<TaskOutcome, string> = {
  accepted: "bg-success",
  fixed: "bg-warn",
  finished: "bg-info",
  dropped: "bg-danger",
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

function Stat({ label, value, mark }: { label: string; value: number; mark?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {mark && <span className={`size-2 shrink-0 rounded-[2px] ${mark}`} aria-hidden />}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-xl font-semibold text-fg tabular-nums">{value.toLocaleString("en-US")}</div>
    </div>
  );
}

/** "in the span" said the way the span is: "since you were last here", "in the last 24 hours". */
function inSpan(span: Pick<Span, "key" | "note" | "words">): string {
  return span.key === "last" && span.note == null ? "since you were last here" : span.words.charAt(0).toLowerCase() + span.words.slice(1);
}

/** The faces of a column's most active, with a tooltip naming each, and how many more there were. */
const FACES = 5;

/** An agent's face by its member key, from the workspace's agents; g1t wears its mark. */
function faceOf(actor: DigestActor, faces: AgentLike[]): ReactNode {
  if (actor.kind === "agent") {
    const agent = faces.find((face) => `agent:${face.id}` === actor.key);
    return <AgentAvatar agent={agent ?? { handle: actor.name, builtin: actor.name === "g1t" }} size={22} />;
  }
  return <Avatar name={actor.name} size={22} />;
}

function Faces({ actors, faces }: { actors: DigestActor[]; faces: AgentLike[] }) {
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
                <span className="block">{faceOf(actor, faces)}</span>
              </TooltipTrigger>
              <TooltipContent>
                {actor.kind === "agent" ? `@${actor.name}` : actor.name} · {actor.count.toLocaleString("en-US")} {actor.count === 1 ? "thing" : "things"}
              </TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
      {more > 0 && <span className="text-xs text-muted">+{more.toLocaleString("en-US")}</span>}
    </div>
  );
}

/** One column's lines: each what was done, with its count in the words, linked to where it is listed. */
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

/** The agents' acceptance, in a compact row: the counts, the share accepted first time and its trend, and a mark per task. */
function Acceptance({ work, span }: { work: SpanWork; span: Pick<Span, "key" | "note" | "words"> }) {
  const { counts, rate, before, tasks } = work;
  const trend = trendLabel(rate, before);
  const up = rate && before ? Math.round(rate.value * 100) - Math.round(before.value * 100) : 0;
  // Without Code, nothing is reviewed: no accepted or fixed to count.
  const reviewed = work.code === "read";
  const shown = (Object.keys(MARK) as TaskOutcome[]).filter((o) => counts[o] > 0 || (reviewed && (o === "accepted" || o === "fixed")));
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="grid grid-cols-3 gap-3">
        {reviewed ? (
          <>
            <Stat label="Accepted first time" value={counts.accepted} mark={MARK.accepted} />
            <Stat label="Fixed after review" value={counts.fixed} mark={MARK.fixed} />
          </>
        ) : (
          <>
            <Stat label="Sessions finished" value={counts.finished} mark={MARK.finished} />
            <Stat label="Tasks settled" value={tasks.length} />
          </>
        )}
        <Stat label="Didn't finish" value={counts.dropped} mark={MARK.dropped} />
      </div>
      {reviewed && (
        <p className="mt-2 text-xs text-muted">
          {rate ? (
            <>
              <span className="font-medium text-fg">{percent(rate.value)}</span> of {rate.of.toLocaleString("en-US")} agent {rate.of === 1 ? "pull request" : "pull requests"} accepted first time
              {trend && <span className={cn("ml-1.5 font-medium", up > 0 ? "text-success" : up < 0 ? "text-warn" : "text-muted")}>{trend}</span>}
            </>
          ) : (
            <>
              No agent pull request merged or closed {inSpan(span)}.{before ? ` The 7 days before: ${percent(before.value)} of ${before.of}.` : ""}
            </>
          )}
        </p>
      )}
      {tasks.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-0.75" aria-label="Agent work that settled, one mark per task, in the order they settled">
          {tasks.map((task) => (
            <li key={task.key}>
              <Tooltip>
                <TooltipTrigger asChild>
                  {task.to ? (
                    <Link to={task.to} aria-label={`${task.title ?? "A session"}: ${OUTCOME_LABEL[task.outcome]}`} className={`block h-4 w-2 rounded-xs ${MARK[task.outcome]} transition-opacity hover:opacity-70`} />
                  ) : (
                    <span className={`block h-4 w-2 rounded-xs ${MARK[task.outcome]}`} />
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  <span className="block font-medium">{task.title ?? "A session in a conversation you're not in"}</span>
                  <span className="text-muted">
                    {OUTCOME_LABEL[task.outcome]} · {SOURCE_LABEL[task.source]}
                  </span>
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      {tasks.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-muted">
          {shown.map((outcome) => (
            <span key={outcome} className="inline-flex items-center gap-1">
              <span className={`size-1.5 rounded-xs ${MARK[outcome]}`} aria-hidden />
              {OUTCOME_LABEL[outcome]} <span className="text-fg-soft tabular-nums">{counts[outcome]}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What people did and what agents did in the span, side by side: lines
 * with counts linked to where each thing is listed, the most active faces,
 * and in the Agents column how their work was received. Each column says
 * when it is empty, and which part didn't answer.
 */
export function PeopleAgentsCard({
  digest,
  work,
  span,
  faces,
  code,
}: {
  digest: Digest | null;
  work: SpanWork | null;
  span: Pick<Span, "key" | "note" | "words">;
  faces: AgentLike[];
  code: boolean;
}) {
  const when = inSpan(span);
  if (!digest) {
    return (
      <section className="rounded-2xl border border-line bg-surface p-5">
        <p className="text-sm text-muted">What happened couldn&apos;t be read right now. It shows here once Code, Chat and Agents answer.</p>
      </section>
    );
  }
  const missing = (names: string[]) => names.filter((name) => digest.missing.includes(name));
  const peopleMissing = missing(["Code", "Chat"]);
  const agentsMissing = missing(["Code", "Chat", "Agents"]);
  const column = (title: string, icon: ReactNode, col: DigestColumn, silent: string[], empty: string, children?: ReactNode) => (
    <div className="min-w-0 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
          {icon}
          {title}
        </h3>
        {col.actors.length > 0 && (
          <Badge tone="neutral" size="md" className="tabular-nums">
            {col.actors.length.toLocaleString("en-US")} active
          </Badge>
        )}
        <span className="ml-auto">
          <Faces actors={col.actors} faces={faces} />
        </span>
      </div>
      {col.lines.length > 0 ? <Lines column={col} /> : <p className="mt-3 text-sm text-muted">{silent.length > 0 ? `Nothing from what could be read ${when}.` : empty}</p>}
      {silent.length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-faint">
          <AlertTriangle size={12} className="shrink-0" />
          {listOf(silent)} didn&apos;t answer, so {silent.length === 1 ? "its part" : "their parts"} {silent.length === 1 ? "isn't" : "aren't"} counted.
        </p>
      )}
      {children}
    </div>
  );
  return (
    <section className="grid overflow-hidden rounded-2xl border border-line bg-surface md:grid-cols-2 md:divide-x md:divide-line" aria-label="What people and agents did">
      <div className="border-b border-line md:border-b-0">
        {column(
          "People",
          <Users size={15} className="text-muted" />,
          digest.people,
          peopleMissing,
          code ? `Nobody pushed, opened, merged, reviewed, edited a doc or said anything ${when}.` : `Nobody edited a doc or said anything ${when}.`,
        )}
      </div>
      <div>
        {column(
          "Agents",
          <Bot size={15} className="text-accent" />,
          digest.agents,
          agentsMissing,
          `No agent settled a task, pushed, opened a pull request or replied ${when}.`,
          <>
            {work && (work.tasks.length > 0 || work.code === "read") && <Acceptance work={work} span={span} />}
            {work?.partial && <p className="mt-3 text-xs text-faint">A list was cut short, so some agent work may be missing.</p>}
          </>,
        )}
      </div>
      {digest.partial && !work?.partial && <p className="border-t border-line px-5 py-2.5 text-xs text-faint md:col-span-2">More happened than Home reads at once, so some counts are low.</p>}
    </section>
  );
}

export function SpanSkeleton() {
  return (
    <section className="grid rounded-2xl border border-line bg-surface md:grid-cols-2 md:divide-x md:divide-line" aria-busy="true">
      {[0, 1].map((column) => (
        <div key={column} className={cn("space-y-3 p-5", column === 0 && "border-b border-line md:border-b-0")}>
          <div className="flex items-center justify-between">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ))}
    </section>
  );
}

export function Sources({ work }: { work: SpanWork | null }) {
  if (!work || work.sources.length === 0) return null;
  return (
    <Card title="Where the work came from">
      <ul className="flex flex-wrap gap-2 px-5 pb-5">
        {work.sources.map(({ source, count }) => (
          <li key={source} className="inline-flex items-center gap-2 rounded-lg border border-line bg-raised/40 px-2.5 py-1.5 text-xs">
            <span className="text-muted">{SOURCE_LABEL[source]}</span>
            <span className="font-semibold text-fg tabular-nums">{count.toLocaleString("en-US")}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Landed, builds and decisions -------------------------------------------------

/** Rows each list shows before the rest fold away. */
const LIST_ROWS = 5;

function When({ at, now, tz }: { at: number; now: number; tz: string | null }) {
  return (
    <span className="shrink-0 text-xs text-faint tabular-nums" suppressHydrationWarning>
      {whenShort(at, now, tz)}
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

const LANDED_ICON: Record<LandedChange["kind"], (agent: boolean) => ReactNode> = {
  merge: (agent) => <GitMerge size={15} className={cn("shrink-0", agent ? "text-accent" : "text-success")} />,
  push: (agent) => <GitCommitHorizontal size={15} className={cn("shrink-0", agent ? "text-accent" : "text-success")} />,
  deploy: () => <Rocket size={15} className="shrink-0 text-success" />,
  release: () => <Tag size={15} className="shrink-0 text-info" />,
  package: () => <Package size={15} className="shrink-0 text-info" />,
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
  const agents = landed.filter((change) => change.agent).length;
  parts.push(`${agents.toLocaleString("en-US")} by agents`);
  return parts.join(" · ");
}

/**
 * Everything that landed in the span, newest first: pull requests merged,
 * commits pushed straight to a default branch, production builds that went
 * live, releases and package versions published.
 */
export function LandedCard({ landed, missing, code, now, tz }: { landed: LandedChange[] | null; missing: string[]; code: boolean; now: number; tz: string | null }) {
  if (!code) return null;
  return (
    <Card title="Landed" hint={landed && landed.length > 0 ? landedHint(landed) : undefined}>
      {!landed ? (
        <Quiet>Code didn&apos;t answer, so what landed can&apos;t be listed right now.</Quiet>
      ) : landed.length === 0 ? (
        <Quiet>{missing.length > 0 ? "Nothing landed in what could be read." : "Nothing merged, pushed to a default branch, deployed to production or published in this span."}</Quiet>
      ) : (
        <Folded
          items={landed}
          render={(change) => (
            <li key={change.key} className={rowClass}>
              {LANDED_ICON[change.kind](change.agent)}
              <div className="min-w-0 grow">
                <Link to={change.to} className="block truncate text-sm text-fg hover:underline">
                  {change.title}
                </Link>
                <p className="truncate text-xs text-muted">{change.detail}</p>
              </div>
              <When at={change.at} now={now} tz={tz} />
            </li>
          )}
        />
      )}
      {landed && <Missing names={missing} what="everything that landed" />}
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

export function DecisionsCard({
  decisions,
  read,
  now,
  tz,
}: {
  decisions: DecisionRow[] | null;
  read: { memories: boolean; requests: boolean } | null;
  now: number;
  tz: string | null;
}) {
  if (!decisions || decisions.length === 0) return null;
  const missing = [...(read && !read.memories ? ["Memory"] : []), ...(read && !read.requests ? ["The Marketplace"] : [])];
  return (
    <Card title="Decisions" hint="Recorded in the workspace's memory, and requests answered">
      <Folded
        items={decisions}
        render={(row) => (
          <li key={row.key} className={rowClass}>
            {row.kind === "memory" ? <Lightbulb size={15} className="shrink-0 text-warn" /> : <Store size={15} className="shrink-0 text-info" />}
            <div className="min-w-0 grow">
              <Link to={row.to} className="line-clamp-2 text-sm text-fg hover:underline">
                {row.text}
              </Link>
              {row.by && <p className="truncate text-xs text-muted">by {row.by}</p>}
            </div>
            <When at={row.at} now={now} tz={tz} />
          </li>
        )}
      />
      <Missing names={missing} what="every decision" />
    </Card>
  );
}

// --- Spend in the span ------------------------------------------------------------

/**
 * Each kind of charge keeps its colour, whatever its rank: models one,
 * sandboxes and runners another, hosting a third, storage and the rest grey.
 */
function kindColour(kind: string): string {
  if (/agent|model|gateway/i.test(kind)) return "bg-accent";
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
              <div className="mt-4 flex h-2.5 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Spend by kind of charge">
                {spend.lines.map((line) => (
                  <span key={line.kind} className={`h-full min-w-[3px] ${kindColour(line.kind)}`} style={{ flexGrow: line.micros }} />
                ))}
              </div>
              <ul className="mt-3 space-y-2">
                {spend.lines.map((line) => (
                  <li key={line.kind} className="flex items-center gap-2 text-sm">
                    <span className={`size-2 shrink-0 rounded-[2px] ${kindColour(line.kind)}`} aria-hidden />
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
  session: <Sparkles size={15} className="text-accent" />,
  change: <GitPullRequest size={15} className="text-info" />,
  workflow: <Workflow size={15} className="text-info" />,
  deploy: <Rocket size={15} className="text-info" />,
};

export function RunningList({ rows, missing, now }: { rows: RunningRow[]; missing: string[]; now: number }) {
  return (
    <>
      {rows.length === 0 ? (
        <Quiet>{missing.length > 0 ? "Nothing is running in what could be read." : "Nothing is running. Agent sessions, agents' changes, workflow runs and builds show here while they go."}</Quiet>
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
