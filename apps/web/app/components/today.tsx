/**
 * Today's parts (routes/workspace/home.tsx): the day's agent work, Needs
 * attention, Spent today and Start here. Each takes what lib/today.ts
 * worked out and only draws it.
 */
import {
  AlertTriangle,
  ArrowRight,
  AtSign,
  Bell,
  Bot,
  CircleDollarSign,
  GitMerge,
  GitPullRequest,
  Hourglass,
  Mail,
  Rocket,
  Server,
  Sparkles,
  User,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import {
  type Attention,
  type AttentionKind,
  type AttentionRow,
  type DayWork,
  type Spend,
  type Stake,
  type TaskOutcome,
  OUTCOME_LABEL,
  SOURCE_LABEL,
  dollars,
  trendLabel,
  waited,
} from "../lib/today";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function Card({ title, link, children, className = "" }: { title: ReactNode; link?: { label: string; to: string } | null; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-surface ${className}`}>
      <header className="flex items-center gap-2 px-5 pt-4 pb-3">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {link && (
          <Link to={link.to} className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
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

// --- The day's work -----------------------------------------------------------

/** Each outcome's mark: status colours, always beside a label in the legend. */
const MARK: Record<TaskOutcome, string> = {
  accepted: "bg-success",
  fixed: "bg-warn",
  finished: "bg-info",
  open: "bg-accent/45",
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

export function DayCard({ work }: { work: DayWork | null }) {
  if (!work) {
    return (
      <section className="rounded-2xl border border-line bg-surface p-5">
        <p className="text-sm text-muted">Today&apos;s agent work couldn&apos;t be read right now. It shows here once Agents answers.</p>
      </section>
    );
  }
  const { counts, rate, lastWeek, tasks } = work;
  const trend = trendLabel(rate, lastWeek);
  const up = rate && lastWeek ? Math.round(rate.value * 100) - Math.round(lastWeek.value * 100) : 0;
  // Without Code, nothing is reviewed: no accepted or fixed to count.
  const reviewed = work.code === "read";
  const shown = (Object.keys(MARK) as TaskOutcome[]).filter((o) => counts[o] > 0 || (reviewed && (o === "accepted" || o === "fixed")) || o === "open");
  return (
    <section className="grid overflow-hidden rounded-2xl border border-line bg-surface md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <div className="border-b border-line p-5 md:border-r md:border-b-0">
        {work.code === "no_access" ? (
          <>
            <h2 className="text-sm font-semibold text-fg">Finished today</h2>
            <div className="mt-2 text-5xl font-semibold tracking-tight text-fg tabular-nums">{(counts.accepted + counts.fixed + counts.finished).toLocaleString("en-US")}</div>
            <p className="mt-2 text-xs leading-relaxed text-muted">How much was accepted the first time is measured on pull requests, which are part of Code.</p>
          </>
        ) : (
          <>
            <h2 className="text-sm font-semibold text-fg">Accepted first time</h2>
            {rate ? (
              <>
                <div className="mt-2 text-5xl font-semibold tracking-tight text-fg tabular-nums">{percent(rate.value)}</div>
                <p className="mt-2 text-xs text-muted">
                  of {rate.of.toLocaleString("en-US")} agent {rate.of === 1 ? "pull request" : "pull requests"} merged or closed today
                </p>
                <p className={`mt-1.5 text-xs font-medium ${up > 0 ? "text-success" : up < 0 ? "text-warn" : "text-muted"}`}>
                  {trend ?? (work.code === "read" ? "Nothing settled in the last 7 days to compare." : "")}
                </p>
              </>
            ) : (
              <>
                <div className="mt-2 text-5xl font-semibold tracking-tight text-faint">—</div>
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {work.code === "unavailable" ? "Code didn't answer, so pull requests aren't counted." : "No agent pull request has merged or closed today yet."}
                  {lastWeek ? ` The last 7 days: ${percent(lastWeek.value)} of ${lastWeek.of}.` : ""}
                </p>
              </>
            )}
          </>
        )}
      </div>
      <div className="min-w-0 p-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Tasks today" value={tasks.length} />
          {reviewed ? (
            <>
              <Stat label="Accepted first time" value={counts.accepted} mark={MARK.accepted} />
              <Stat label="Fixed after review" value={counts.fixed} mark={MARK.fixed} />
            </>
          ) : (
            <>
              <Stat label="Sessions finished" value={counts.finished} mark={MARK.finished} />
              <Stat label="Didn't finish" value={counts.dropped} mark={MARK.dropped} />
            </>
          )}
          <Stat label="Still open" value={counts.open} mark={MARK.open} />
        </div>
        {tasks.length === 0 ? (
          <p className="mt-5 text-sm text-muted">No agent work today yet.</p>
        ) : (
          <div className="mt-5">
            <ul className="flex flex-wrap gap-[3px]" aria-label="Today's tasks">
              {tasks.map((task) => (
                <li key={task.key}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {task.to ? (
                        <Link to={task.to} aria-label={`${task.title ?? "A session"}: ${OUTCOME_LABEL[task.outcome]}`} className={`block h-6 w-2.5 rounded-[3px] ${MARK[task.outcome]} transition-opacity hover:opacity-70`} />
                      ) : (
                        <span className={`block h-6 w-2.5 rounded-[3px] ${MARK[task.outcome]}`} />
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
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
              <span className="text-faint">Every mark is one of today&apos;s tasks</span>
              {shown.map((outcome) => (
                <span key={outcome} className="inline-flex items-center gap-1.5">
                  <span className={`size-2 rounded-[2px] ${MARK[outcome]}`} aria-hidden />
                  {OUTCOME_LABEL[outcome]} <span className="text-fg-soft tabular-nums">{counts[outcome]}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {(work.partial || work.sessions === "unavailable" || work.code === "unavailable") && (
          <p className="mt-3 text-xs text-faint">
            {work.sessions === "unavailable"
              ? "Agent sessions couldn't be read, so only pull requests are counted. "
              : work.code === "unavailable"
                ? "Code didn't answer, so only agent sessions are counted. "
                : ""}
            {work.partial ? "A list was cut short, so some of today's tasks may be missing." : ""}
          </p>
        )}
      </div>
    </section>
  );
}

export function DaySkeleton() {
  return (
    <section className="grid rounded-2xl border border-line bg-surface md:grid-cols-[15rem_1fr]" aria-busy="true">
      <div className="space-y-3 border-b border-line p-5 md:border-r md:border-b-0">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-12 w-24" />
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="space-y-5 p-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-5 w-8" />
            </div>
          ))}
        </div>
        <Skeleton className="h-6 w-3/4" />
      </div>
    </section>
  );
}

// --- Needs attention -----------------------------------------------------------

const ICON: Record<AttentionKind, ReactNode> = {
  limit: <CircleDollarSign size={16} className="text-danger" />,
  deploy: <Rocket size={16} className="text-danger" />,
  session_cap: <CircleDollarSign size={16} className="text-warn" />,
  agent_budget: <CircleDollarSign size={16} className="text-danger" />,
  pull_blocked: <GitPullRequest size={16} className="text-warn" />,
  ready: <GitMerge size={16} className="text-accent" />,
  review: <GitPullRequest size={16} className="text-info" />,
  invitation: <Mail size={16} className="text-info" />,
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

/** Most rows Needs attention shows. */
const ROWS = 6;

function AttentionItem({ row }: { row: AttentionRow }) {
  return (
    <li className="flex items-start gap-3 border-t border-line px-5 py-3 first:border-t-0">
      <span className="mt-0.5 shrink-0">{ICON[row.kind]}</span>
      <div className="min-w-0 grow">
        <Link to={row.action.to} className="block truncate text-sm font-semibold text-fg hover:underline">
          {row.title}
        </Link>
        <p className="truncate text-xs text-muted">{row.detail}</p>
        {row.stake && (
          <div className="mt-1 sm:hidden">
            <StakeText stake={row.stake} />
          </div>
        )}
      </div>
      <div className="hidden max-w-48 shrink-0 pt-0.5 text-right whitespace-nowrap sm:block">{row.stake && <StakeText stake={row.stake} />}</div>
      <Link
        to={row.action.to}
        className="inline-flex h-7 shrink-0 items-center rounded-md border border-line-strong px-2.5 text-xs font-medium text-fg transition-colors hover:border-accent/50 hover:bg-raised"
      >
        {row.action.label}
      </Link>
    </li>
  );
}

export function AttentionList({ attention }: { attention: Attention }) {
  const { rows, missing } = attention;
  return (
    <>
      {rows.length === 0 ? (
        <Quiet>{missing.length > 0 ? "Nothing is waiting on you in what could be read." : "Nothing is waiting on you."}</Quiet>
      ) : (
        <ul>
          {rows.slice(0, ROWS).map((row) => (
            <AttentionItem key={row.key} row={row} />
          ))}
        </ul>
      )}
      {rows.length > ROWS && (
        <p className="border-t border-line px-5 py-2.5 text-xs text-muted">
          {(rows.length - ROWS).toLocaleString("en-US")} more in{" "}
          <Link to="/notifications" className="text-fg-soft underline-offset-2 hover:underline">
            Notifications
          </Link>
          , Chat and Code.
        </p>
      )}
      {missing.length > 0 && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-2.5 text-xs text-faint">
          <AlertTriangle size={12} className="shrink-0" />
          {listOf(missing)} didn&apos;t answer, so what waits there isn&apos;t listed.
        </p>
      )}
    </>
  );
}

const listOf = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

export function Sources({ work }: { work: DayWork | null }) {
  return (
    <div className="border-t border-line px-5 py-4">
      <h3 className="text-xs font-semibold text-fg-soft">Where today&apos;s work came from</h3>
      {!work ? (
        <p className="mt-2 text-xs text-muted">Couldn&apos;t be read right now.</p>
      ) : work.sources.length === 0 ? (
        <p className="mt-2 text-xs text-muted">No agent work today yet.</p>
      ) : (
        <ul className="mt-2.5 flex flex-wrap gap-2">
          {work.sources.map(({ source, count }) => (
            <li key={source} className="inline-flex items-center gap-2 rounded-lg border border-line bg-raised/40 px-2.5 py-1.5 text-xs">
              <span className="text-muted">{SOURCE_LABEL[source]}</span>
              <span className="font-semibold text-fg tabular-nums">{count.toLocaleString("en-US")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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

// --- Spent today --------------------------------------------------------------

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

export function SpendCard({ spend, slug }: { spend: Spend | null; slug: string }) {
  return (
    <Card title="Spent today" link={{ label: "Billing", to: `/${slug}/-/billing` }}>
      {!spend ? (
        <Quiet>Billing didn&apos;t answer, so today&apos;s spend can&apos;t be shown right now.</Quiet>
      ) : (
        <div className="px-5 pb-5">
          <div className="text-3xl font-semibold tracking-tight text-fg tabular-nums">{dollars(spend.totalMicros)}</div>
          <p className="mt-1 text-xs text-muted">{dollars(spend.monthMicros)} this month so far</p>
          {spend.lines.length === 0 ? (
            <p className="mt-4 text-sm text-muted">Nothing on today&apos;s statement yet.</p>
          ) : (
            <>
              <div className="mt-4 flex h-2.5 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Today's spend by kind of charge">
                {spend.lines.map((line) => (
                  <span key={line.kind} className={`h-full min-w-[3px] ${kindColour(line.kind)}`} style={{ flexGrow: line.micros }} />
                ))}
              </div>
              <ul className="mt-3 space-y-2">
                {spend.lines.map((line) => (
                  <li key={line.kind} className="flex items-center gap-2 text-sm">
                    <span className={`size-2 shrink-0 rounded-[2px] ${kindColour(line.kind)}`} aria-hidden />
                    <span className="min-w-0 grow truncate text-fg-soft">{line.kind}</span>
                    <span className="text-fg tabular-nums">{dollars(line.micros)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-4 text-[0.6875rem] leading-relaxed text-faint">At price, as your statement shows it. Statement days run midnight to midnight UTC.</p>
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

// --- Start here ---------------------------------------------------------------

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
        <Quiet>{attention.missing.length > 0 ? "Nothing to pick from what could be read." : "Nothing is waiting on you, so there's nothing to pick."}</Quiet>
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
