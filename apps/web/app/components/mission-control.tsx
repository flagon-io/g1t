import { ArrowDownWideNarrow, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, ListTree, Plus, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useFetcher, useRouteLoaderData, useSearchParams } from "react-router";

import { trialClosed } from "../lib/trial";
import { type ActivityGroup, type Verb, greetingFor, isAgent } from "../lib/mission";
import {
  BLOCKING,
  type Fact,
  type LandedRow,
  type NeedRow,
  type QuickAction,
  REASON_LABEL,
  type Reason,
  type Sort,
  type Tab,
  type WaitingRow,
  type Week,
  type Who,
  change,
  dateLine,
  parseSort,
  parseTab,
  signedPercent,
  sortRows,
  usd,
  whyFor,
} from "../lib/mission-control";
import { cn } from "../lib/cn";
import { AgentComposer, type ComposerResult } from "./agent-composer";
import { AskComposer } from "./ask-composer";
import { AgentSetup } from "./agent-setup";
import { InboxNeedsCard } from "./inbox";
import type { ShellData } from "./shell";
import { useLiveRefresh } from "./agents";
import { Unavailable } from "./mission";
import { TokenUsagePanel } from "./token-usage";
import { Avatar, SubmitButton, TimeAgo } from "./ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "./ui/dropdown-menu";
import type { Loaded } from "../routes/home";

/*
 * Mission control: the home page of someone signed in. It answers where
 * the viewer is needed, what agents are doing, and what landed without
 * them. It is a chunk of its own, loaded only for them, so the signed-out
 * home page does not carry it. routes/home.tsx loads its data;
 * lib/mission-control.ts shapes it.
 */

/** The viewer's time zone, set by the page itself, so the greeting fits their day. */
const TZ_COOKIE = "g1t_tz";
/** Rows a tab shows before "See all". */
const ROWS = 6;

const dollars = (micros: number) => `$${(Math.max(0, micros) / 1_000_000).toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// --- Small pieces -----------------------------------------------------------------

const CHIP_TONE: Record<Reason, string> = {
  blocking: "border-danger/35 bg-danger/10 text-danger",
  checks_failing: "border-danger/35 bg-danger/10 text-danger",
  outside_guardrails: "border-warn/35 bg-warn/10 text-warn",
  low_confidence: "border-warn/35 bg-warn/10 text-warn",
  stalled: "border-warn/35 bg-warn/10 text-warn",
  asked_for_you: "border-merged/35 bg-merged/10 text-merged",
  needs_review: "border-info/35 bg-info/10 text-info",
  ready_to_merge: "border-accent/35 bg-accent/10 text-accent",
};

function Chip({ children, tone }: { children: ReactNode; tone: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border px-1.5 py-px font-mono text-[0.625rem] font-medium tracking-wider whitespace-nowrap uppercase",
        tone,
      )}
    >
      {children}
    </span>
  );
}

/** A person or an agent, by name, wearing the mark that tells them apart. */
function Person({ who, size = 16, className }: { who: Who; size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Avatar name={who.name} size={size} />
      <span className="truncate">{who.name}</span>
    </span>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[0.625rem] font-medium tracking-[0.12em] text-faint uppercase">{children}</p>;
}

const FACT_TONE = { good: "text-accent", warn: "text-warn", bad: "text-danger" } as const;

function Facts({ facts }: { facts: Fact[] }) {
  if (facts.length === 0) return <p className="text-sm text-muted">Nothing more is known about it yet.</p>;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
      {facts.map((fact) => (
        <div key={fact.label} className={cn("min-w-0", fact.wide && "col-span-2")}>
          <dt className="text-xs text-faint">{fact.label}</dt>
          <dd
            className={cn(
              "mt-0.5 text-sm font-medium tabular-nums",
              fact.wide ? "leading-5" : "truncate",
              fact.tone ? FACT_TONE[fact.tone] : "text-fg-soft",
            )}
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A form that acts on a pull request from here: working until the action
 * has answered and the page has reloaded what it changed, then done, or
 * the error beside it.
 */
function QuickForm({ quick, variant = "quiet" }: { quick: QuickAction; variant?: "quiet" | "accent" }) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const [sent, setSent] = useState(false);
  const done = sent && fetcher.state === "idle" && !fetcher.data?.error;
  return (
    <fetcher.Form method="post" action={quick.to} onSubmit={() => setSent(true)} className="contents">
      {Object.entries(quick.fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton
        fetcher={fetcher}
        disabled={done}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-default",
          variant === "accent"
            ? "bg-merged text-bg hover:bg-[#c9bfff]"
            : "border border-line-strong text-fg/90 hover:bg-raised hover:text-fg",
          done && "border-accent/40 text-accent",
        )}
      >
        {done ? <Check size={14} /> : null}
        {done ? quick.done : quick.label}
      </SubmitButton>
      {fetcher.data?.error && <span className="basis-full text-xs text-danger">{fetcher.data.error}</span>}
    </fetcher.Form>
  );
}

function ProjectMark({ repo }: { repo: { namespace: string; name: string } | null }) {
  return <Avatar name={repo ? repo.name : "g1t"} size={32} square />;
}

/** A row that opens to what is known about it; the first one starts open. */
function Row({
  open,
  repo,
  by,
  title,
  sub,
  chip,
  at,
  children,
}: {
  open: boolean;
  repo: { namespace: string; name: string } | null;
  by: Who | null;
  title: ReactNode;
  sub: ReactNode;
  chip: ReactNode;
  at: number;
  children: ReactNode;
}) {
  return (
    <li>
      <details open={open} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors select-none hover:bg-raised/60 sm:px-5 [&::-webkit-details-marker]:hidden">
          <ProjectMark repo={repo} />
          <span className="min-w-0 grow">
            <span className="block truncate text-sm">{title}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
              <span className="shrink-0 font-medium text-fg-soft">{repo ? repo.name : "Workspace"}</span>
              {by && (
                <>
                  <span className="text-faint">·</span>
                  <Person who={by} size={14} className={cn("shrink-0", by.agent ? "text-merged" : "")} />
                </>
              )}
              {sub && (
                <>
                  <span className="text-faint">—</span>
                  <span className="truncate">{sub}</span>
                </>
              )}
            </span>
          </span>
          <span className="hidden sm:inline-flex">{chip}</span>
          <span className="hidden w-16 shrink-0 text-right text-xs text-faint sm:block">
            <TimeAgo at={at} />
          </span>
          <ChevronDown size={16} className="shrink-0 text-faint transition-transform group-open:rotate-180" />
        </summary>
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <div className="mb-3 flex items-center gap-2 sm:hidden">
            {chip}
            <span className="text-xs text-faint">
              <TimeAgo at={at} />
            </span>
          </div>
          {children}
        </div>
      </details>
    </li>
  );
}

function NeedCard({ row, first }: { row: NeedRow; first: boolean }) {
  const isPull = row.to.includes("/pull/");
  return (
    <Row
      open={first}
      repo={row.repo}
      by={row.by}
      title={
        <>
          <span className="font-medium">{row.title}</span>
          {row.ref && <span className="ml-1 font-mono text-xs text-faint">{row.ref}</span>}
        </>
      }
      sub={row.ask}
      chip={<Chip tone={CHIP_TONE[row.reason]}>{REASON_LABEL[row.reason]}</Chip>}
      at={row.at}
    >
      <div className="grid gap-4 rounded-xl border border-line bg-bg/50 p-4 md:grid-cols-2 md:gap-x-6 2xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.95fr)]">
        <div className="min-w-0">
          <Eyebrow>The ask</Eyebrow>
          <p className="mt-2 text-sm leading-6 text-fg-soft">{row.ask}</p>
          <p className="mt-2 text-xs leading-5 text-muted">
            <Link to={row.to} className="font-medium text-fg hover:underline">
              {row.repo ? `${row.repo.name}${row.ref ?? ""}` : row.title}
            </Link>
            {row.for && (
              <>
                {" "}
                · started for <span className="text-fg-soft">{row.for}</span>
              </>
            )}
          </p>
        </div>
        <div className="min-w-0">
          <Eyebrow>{row.by?.agent ? "What the agent already knows" : "What is known"}</Eyebrow>
          <div className="mt-2">
            <Facts facts={row.facts} />
          </div>
        </div>
        <div className="rounded-lg border border-warn/20 bg-warn/[0.06] p-3.5 md:col-span-2 2xl:col-span-1">
          <p className="text-xs font-semibold text-warn">Why this needs you</p>
          <p className="mt-1.5 text-sm leading-6 text-fg-soft">{row.why}</p>
          <p className="mt-2 text-xs text-faint">
            Started waiting <TimeAgo at={row.at} />
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          to={row.to}
          prefetch="intent"
          className="inline-flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-white"
        >
          Review and respond <ArrowUpRight size={14} />
        </Link>
        {row.quick && <QuickForm quick={row.quick} />}
        {row.link && (
          <Link
            to={row.link.to}
            className="inline-flex items-center rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-fg/90 hover:bg-raised hover:text-fg"
          >
            {row.link.label}
          </Link>
        )}
        {row.open !== row.to && (
          <Link to={row.open} prefetch="intent" className="px-2 py-1.5 text-sm text-muted hover:text-fg">
            {row.open.includes("/issues/") ? "Open issue" : isPull ? "See the changes" : "Open pull request"}
          </Link>
        )}
      </div>
    </Row>
  );
}

function WaitingCard({ row, first }: { row: WaitingRow; first: boolean }) {
  return (
    <Row
      open={first}
      repo={row.repo}
      by={row.by}
      title={
        <>
          <span className="font-medium">{row.title}</span>
          {row.ref && <span className="ml-1 font-mono text-xs text-faint">{row.ref}</span>}
        </>
      }
      sub={row.detail}
      chip={
        <Chip tone="border-line-strong bg-raised text-muted">
          {row.live && <span className="mr-1.5 size-1.5 animate-pulse rounded-full bg-accent" />}
          {row.chip}
        </Chip>
      }
      at={row.at}
    >
      <div className="grid gap-4 rounded-xl border border-line bg-bg/50 p-4 md:grid-cols-2 md:gap-6">
        <div className="min-w-0">
          <Eyebrow>{row.live ? "Doing now" : "Where it stands"}</Eyebrow>
          <p className="mt-2 text-sm leading-6 text-fg-soft">{row.detail}</p>
        </div>
        <div className="min-w-0">
          <Eyebrow>What is known</Eyebrow>
          <div className="mt-2">
            <Facts facts={row.facts} />
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          to={row.to}
          prefetch="intent"
          className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-fg/90 hover:bg-raised hover:text-fg"
        >
          {row.to.includes("/runs/") ? "Watch the run" : "Open pull request"} <ArrowUpRight size={14} />
        </Link>
        {row.run && row.run !== row.to && (
          <Link to={row.run} prefetch="intent" className="px-2 py-1.5 text-sm text-muted hover:text-fg">
            Watch the run
          </Link>
        )}
      </div>
    </Row>
  );
}

function LandedCard({ row, first }: { row: LandedRow; first: boolean }) {
  return (
    <Row
      open={first}
      repo={row.repo}
      by={row.byAgents ? { name: row.agent, agent: isAgent(row.agent) } : row.by}
      title={
        <>
          <span className="font-medium">{row.title}</span>
          <span className="ml-1 font-mono text-xs text-faint">{row.ref}</span>
        </>
      }
      sub={row.byAgents ? "landed without a person" : `merged by ${row.by?.name ?? "a person"}`}
      chip={
        row.byAgents ? (
          <Chip tone="border-merged/35 bg-merged/10 text-merged">By agents</Chip>
        ) : (
          <Chip tone="border-warn/35 bg-warn/10 text-warn">Needed a person</Chip>
        )
      }
      at={row.at}
    >
      <div className="grid gap-4 rounded-xl border border-line bg-bg/50 p-4 md:grid-cols-2 md:gap-6">
        <div className="min-w-0">
          <Eyebrow>How it landed</Eyebrow>
          <p className="mt-2 text-sm leading-6 text-fg-soft">
            {row.byAgents
              ? `g1t merged it once everything the repository asks for was met, with no one pressing merge.`
              : `${row.by?.name ?? "A person"} merged it.`}
            {row.agent && isAgent(row.agent) && ` ${row.agent} made the change.`}
          </p>
        </div>
        <div className="min-w-0">
          <Eyebrow>What changed</Eyebrow>
          <div className="mt-2">
            <Facts facts={row.facts} />
          </div>
        </div>
      </div>
      <div className="mt-3">
        <Link
          to={row.to}
          prefetch="intent"
          className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-fg/90 hover:bg-raised hover:text-fg"
        >
          Open pull request <ArrowUpRight size={14} />
        </Link>
      </div>
    </Row>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-line">{children}</ul>;
}

function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-5 py-10 text-center">
      <div className="mx-auto max-w-md text-sm leading-6 text-muted">{children}</div>
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

// --- The stat strip -----------------------------------------------------------------

function Stat({ label, value, hint, dot, title }: { label: string; value: string; hint: ReactNode; dot?: string; title?: string }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3.5 sm:px-5 sm:py-4" title={title}>
      <p className="flex items-center gap-1.5 truncate text-xs text-muted">
        {dot && <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />}
        {label}
      </p>
      <p className="mt-1 font-display text-2xl font-semibold tracking-tight tabular-nums sm:text-[1.75rem]">{value}</p>
      <p className="mt-0.5 truncate text-xs text-faint">{hint}</p>
    </div>
  );
}

// --- This week ----------------------------------------------------------------------

/** Seven days of landed changes, each split into what agents landed alone and what a person merged. */
function WeekChart({ week }: { week: Week }) {
  const max = Math.max(1, ...week.days.map((d) => d.agents + d.assisted + d.people));
  const height = 112;
  const delta = change(week.total, week.previous);
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="font-display text-3xl font-semibold tracking-tight tabular-nums">{week.total.toLocaleString("en-US")}</p>
          <p className="text-xs text-muted">changes landed in 7 days</p>
        </div>
        {delta != null ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ring-1",
              delta >= 0 ? "text-accent ring-accent/30" : "text-warn ring-warn/30",
            )}
          >
            {signedPercent(delta)} vs last week
          </span>
        ) : week.previous === 0 && week.total > 0 ? (
          <span className="text-xs text-faint">none the week before</span>
        ) : null}
      </div>
      {week.total === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm leading-6 text-muted">
          Nothing landed in the last 7 days. Each change that does shows here, by day: agents' changes that landed on their own, agents' that a person merged, and people's own.
        </p>
      ) : (
        <div className="relative mt-5" style={{ height: height + 20 }}>
          <div className="absolute inset-x-0 border-t border-line" style={{ top: height }} />
          <div className="absolute inset-x-0 top-0 flex items-end justify-between gap-1" style={{ height }}>
            {week.days.map((day, index) => {
              const total = day.agents + day.assisted + day.people;
              const bar = (n: number) => Math.max(3, Math.round((n / max) * (height - 4)));
              // Top to bottom: agents alone, agents with a person, people.
              const segments = [
                { n: day.agents, tone: "bg-merged" },
                { n: day.assisted, tone: "bg-warn" },
                { n: day.people, tone: "bg-info" },
              ].filter((segment) => segment.n > 0);
              const today = index === week.days.length - 1;
              return (
                <div key={day.key} className="group relative flex h-full flex-1 flex-col items-center justify-end">
                  {total > 0 && (
                    <span
                      className={cn(
                        "mb-1 text-[0.625rem] tabular-nums",
                        today ? "text-fg-soft" : "text-faint opacity-0 group-hover:opacity-100",
                      )}
                    >
                      {total}
                    </span>
                  )}
                  <div className="flex w-full max-w-6 flex-col items-stretch gap-[2px]">
                    {segments.map((segment, at) => (
                      <span key={segment.tone} className={cn("block", segment.tone, at === 0 && "rounded-t")} style={{ height: bar(segment.n) }} />
                    ))}
                    {total === 0 && <span className="block h-[2px] rounded-full bg-line-strong" />}
                  </div>
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs whitespace-nowrap shadow-lg shadow-black/40 group-hover:block">
                    <p className="font-medium text-fg">{day.label}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-muted">
                      <span className="size-1.5 rounded-full bg-merged" /> {day.agents} by agents on their own
                    </p>
                    <p className="flex items-center gap-1.5 text-muted">
                      <span className="size-1.5 rounded-full bg-warn" /> {day.assisted} by agents, merged by a person
                    </p>
                    <p className="flex items-center gap-1.5 text-muted">
                      <span className="size-1.5 rounded-full bg-info" /> {day.people} by people
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="absolute inset-x-0 bottom-0 flex justify-between gap-1">
            {week.days.map((day, index) => (
              <span
                key={day.key}
                className={cn(
                  "flex-1 text-center text-[0.6875rem]",
                  index === week.days.length - 1 ? "font-medium text-fg-soft" : "text-faint",
                )}
              >
                {day.label}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className={cn("mt-3 flex-wrap gap-x-4 gap-y-1 text-xs text-muted", week.total === 0 ? "hidden" : "flex")}>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-merged" /> Agents, on their own
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-warn" /> Agents, merged by a person
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-info" /> People
        </span>
      </div>
      {/* A table does not shrink to sr-only's 1px; its wrapper does. */}
      <div className="sr-only">
        <table>
          <caption>Changes landed each day</caption>
          <thead>
            <tr>
              <th>Day</th>
              <th>Agents, on their own</th>
              <th>Agents, merged by a person</th>
              <th>People</th>
            </tr>
          </thead>
          <tbody>
            {week.days.map((day) => (
              <tr key={day.key}>
                <td>{day.key}</td>
                <td>{day.agents}</td>
                <td>{day.assisted}</td>
                <td>{day.people}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Activity -----------------------------------------------------------------------

const VERB: Record<Verb, string> = {
  landed: "landed",
  opened_issue: "opened",
  closed_issue: "closed",
  started: "started on",
  ready: "marked ready",
  checks_passed: "checks passed on",
  checks_failed: "checks failed on",
  approved: "approved",
  changes_requested: "asked for changes on",
  commented: "commented on",
  asked: "was asked about",
  deployed: "deployed production",
  deploy_failed: "production build failed",
  learned: "learned",
};

/** One line of the feed: who, what, and the one thing it was about, by name. */
function FeedLine({ group, titles }: { group: ActivityGroup; titles: Record<string, string> }) {
  const part = group.parts[0];
  const base = `/${group.repo.namespace}/${group.repo.name}`;
  const actor = group.actor ?? "g1t";
  const agent = group.actor == null || isAgent(group.actor);
  const number = part.numbers[0];
  const title = number != null ? titles[`${group.repo.namespace}/${group.repo.name}#${number}`.toLowerCase()] : undefined;
  const more = group.parts.length - 1 + Math.max(0, part.numbers.length - 1);
  return (
    <li className="flex gap-2.5 py-2">
      <span className="mt-px">
        <Avatar name={actor} size={22} />
      </span>
      <span className="min-w-0 grow text-[0.8125rem] leading-5 text-muted">
        <span className={cn("font-medium", agent ? "text-merged" : "text-fg")}>{actor}</span> {VERB[part.verb]}{" "}
        {part.verb === "learned" ? (
          <Link to={part.to ?? `${base}/memory`} className="text-fg-soft hover:text-fg">
            “{part.texts[0]}”
          </Link>
        ) : number != null ? (
          <Link to={`${base}/issues/${number}`} prefetch="intent" className="text-fg-soft hover:text-fg">
            <span className="font-mono text-xs">#{number}</span>
            {title && <> {title}</>}
          </Link>
        ) : part.to ? (
          <Link to={part.to} className="text-fg-soft hover:text-fg">
            {group.repo.name}
          </Link>
        ) : null}
        {more > 0 && <span className="text-faint"> and {more} more</span>}
        <span className="block text-xs text-faint">
          <span className="font-mono">{group.repo.name}</span> · <TimeAgo at={group.at} />
        </span>
      </span>
    </li>
  );
}

// --- Get started --------------------------------------------------------------------

type Step = { done: boolean; title: string; about: string; to: string | null; action: string };

/** The first things to do, ticked off as they are done, until work has been handed to agents. */
function GetStarted({ steps }: { steps: Step[] }) {
  const left = steps.filter((step) => !step.done).length;
  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight">Get started</h2>
        <span className="text-xs text-muted">
          {steps.length - left} of {steps.length} done
        </span>
      </div>
      <ol className="mt-4 space-y-2">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={cn("flex items-start gap-3 rounded-lg px-3 py-2.5", step.done ? "" : "bg-bg/50 ring-1 ring-line")}
          >
            <span
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-medium",
                step.done ? "bg-accent text-bg" : "text-muted ring-1 ring-line-strong",
              )}
            >
              {step.done ? <Check size={12} /> : index + 1}
            </span>
            <span className="min-w-0 grow">
              <span className={cn("block text-sm font-medium", step.done && "text-muted line-through decoration-faint")}>{step.title}</span>
              {!step.done && <span className="mt-0.5 block text-xs leading-5 text-muted">{step.about}</span>}
            </span>
            {!step.done && step.to && (
              <Link
                to={step.to}
                className="shrink-0 rounded-md bg-fg px-2.5 py-1 text-xs font-medium text-bg transition-colors hover:bg-white"
              >
                {step.action}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// --- The page -----------------------------------------------------------------------

const TAB_LABEL: Record<Tab, string> = { needs: "Needs you", waiting: "Waiting on agents", landed: "Landed today" };
const TAB_SHORT: Record<Tab, string> = { needs: "Needs you", waiting: "Waiting", landed: "Today" };
const SORT_LABEL: Record<Sort, string> = { impact: "By impact", newest: "Newest" };

export default function MissionControl({ loaderData, delegated = null }: { loaderData: Loaded; delegated?: ComposerResult }) {
  const shell = useRouteLoaderData("root")?.shell as ShellData | null | undefined;
  const loaded: Loaded = loaderData;
  const [params] = useSearchParams();
  // Agents are at work, so the page changes without anyone touching it.
  useLiveRefresh(loaded.changing);
  const [greeting, setGreeting] = useState(loaded.greeting);
  const [date, setDate] = useState(loaded.date);
  useEffect(() => {
    // The greeting and date follow the viewer's own clock, and the server
    // learns their zone for next time.
    setGreeting(greetingFor(new Date().getHours()));
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setDate(dateLine(Date.now(), zone ?? null));
      if (zone) document.cookie = `${TZ_COOKIE}=${encodeURIComponent(zone)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    } catch {
      // Nothing to remember.
    }
  }, []);

  const { viewer, repos, waiting, landed, liveTotal, week, groups, titles, stats, canRunAgents, trial } = loaded;
  const workspace = shell?.workspace?.slug ?? loaded.workspace ?? viewer.workspaces?.[0]?.slug ?? null;

  // The usage limit, as the sidebar knows it, heads the list when it bites.
  const limit = shell?.limit && !shell.limit.comped && shell.limit.state !== "ok" && workspace ? shell.limit : null;
  const limitRow: NeedRow[] = limit
    ? [
        (() => {
          const detail =
            limit.state === "stopped"
              ? "No new agent starts until the limit is raised or a card is added."
              : `${dollars(limit.exposureMicros)} of ${dollars(limit.ceilingMicros ?? 0)} used. Add a card so work keeps going.`;
          return {
            key: "limit",
            reason: "blocking" as const,
            repo: null,
            ref: null,
            title: limit.state === "stopped" ? "Agents are stopped: the usage limit was reached" : "Usage is nearing its limit",
            ask: detail,
            by: null,
            for: null,
            at: Date.now(),
            to: `/${workspace}/-/billing`,
            open: `/${workspace}/-/billing`,
            facts: [
              { label: "Used", value: `${dollars(limit.exposureMicros)} of ${dollars(limit.ceilingMicros ?? 0)}`, tone: "warn" as const },
            ],
            why: whyFor("blocking", { kind: "limit", detail }),
            quick: null,
            link: null,
          };
        })(),
      ]
    : [];
  const needs = [...limitRow, ...loaded.needs];
  const blocking = needs.filter((row) => BLOCKING.has(row.reason)).length;

  const counts: Record<Tab, number> = { needs: needs.length, waiting: waiting.length, landed: landed.length };
  const tab = parseTab(params.get("tab")) ?? "needs";
  const sort = parseSort(params.get("sort"));
  const all = params.get("all") === "1";
  const everyActivity = params.get("activity") === "all";
  const link = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value == null) next.delete(key);
      else next.set(key, value);
    }
    const text = next.toString();
    return text ? `?${text}` : "/";
  };

  const steps: Step[] = [
    {
      done: Boolean(workspace),
      title: "Create a workspace",
      about: "Projects, people and agent credit live in one.",
      to: "/workspaces/new",
      action: "Create",
    },
    {
      done: repos.length > 0,
      title: "Add a project",
      about: "Create a repository, or import one by its address. Push to it with git as usual.",
      to: workspace ? `/new?workspace=${workspace}` : "/new",
      action: "Add",
    },
    trial?.open
      ? {
          done: true,
          title: "Try g1t free",
          about: trial.granted
            ? `This workspace has ${dollars(trial.limitMicros - trial.usedMicros)} of its ${dollars(trial.limitMicros)} trial credit left, for g1t's models and sandboxes.`
            : `This workspace gets ${dollars(trial.limitMicros)} of trial credit, for g1t's models and sandboxes, the first time g1t works here.`,
          to: workspace ? `/${workspace}/-/integrations` : null,
          action: "Connect",
        }
      : canRunAgents
        ? {
            done: Boolean(shell?.free) || shell?.limit == null || shell.limit.comped || shell.limit.state === "ok",
            title: "Keep work running",
            about:
              "Usage is charged after it runs. Add a card under Billing, so g1t charges it as you near your limit instead of stopping work.",
            to: workspace ? `/${workspace}/-/billing` : null,
            action: "Billing",
          }
        : {
            done: false,
            title: "Connect a model",
            about: `${
              trialClosed(trial, workspace ?? "This workspace") ? `${trialClosed(trial, workspace ?? "This workspace")} ` : ""
            }Agents need a model to think with. Connect your Anthropic or OpenAI key, or any compatible endpoint.`,
            to: workspace ? `/${workspace}/-/integrations` : null,
            action: "Connect",
          },
    {
      done: loaded.handedOff,
      title: "Hand off an outcome",
      about:
        "Open an issue and assign it to g1t, or write an outcome on a project's Plans page and let a planner split it into issues.",
      to: repos[0] ? `/${repos[0].namespace}/${repos[0].name}/plans` : null,
      action: "Write one",
    },
  ];
  const starting = steps.some((step) => !step.done);
  const noProjects = repos.length === 0;

  const rows = tab === "needs" ? sortRows(needs, sort) : tab === "waiting" ? sortRows(waiting, sort) : sortRows(landed, sort);
  const shown = all ? rows : rows.slice(0, ROWS);
  // Of the agents' own changes only: people's work is not theirs to land.
  const share = week.agentChanges > 0 ? week.byAgents / week.agentChanges : null;
  const delta = change(week.total, week.previous);
  const feed = everyActivity ? groups : groups.slice(0, 8);

  // "Put an agent on it" first, with "New issue" beside it as before: one
  // split control, the agent the main way in.
  const newIssue =
    repos.length > 0 ? (
      <div className="flex items-stretch">
        <AgentComposer
          repos={repos}
          open={params.get("agent") === "new" || delegated != null}
          result={delegated}
          note={
            canRunAgents ? null : (
              <>
                Agents need a model first.{" "}
                {workspace && (
                  <Link to={`/${workspace}/-/integrations`} className="font-medium text-fg hover:underline">
                    Connect one
                  </Link>
                )}
                . The issue still opens.
              </>
            )
          }
        >
          <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-l-md border border-line-strong bg-raised px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-line/60 group-open/composer:bg-line/60">
            <Sparkles size={14} className="text-merged" /> Put an agent on it
          </span>
        </AgentComposer>
      <DropdownMenu>
        <DropdownMenuTrigger className="-ml-px inline-flex items-center gap-1.5 rounded-r-md border border-line-strong px-3 py-2 text-sm font-medium text-fg/90 transition-colors hover:bg-raised hover:text-fg">
          <Plus size={14} /> New issue
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
          <DropdownMenuLabel>In which project?</DropdownMenuLabel>
          {repos.map((repo) => (
            <DropdownMenuItem key={repo.name} asChild>
              <Link to={`/${repo.namespace}/${repo.name}/issues/new`}>
                <Avatar name={repo.name} size={18} square />
                {repo.name}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    ) : (
      <Link
        to={workspace ? `/new?workspace=${workspace}` : "/new"}
        className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-3 py-2 text-sm font-medium text-fg/90 hover:bg-raised hover:text-fg"
      >
        <Plus size={14} /> New project
      </Link>
    );

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight sm:text-[2rem]" suppressHydrationWarning>
            {greeting}, {loaded.name}
          </h1>
          <p className="mt-1.5 text-sm text-muted" suppressHydrationWarning>
            <span className="text-fg-soft">{date}</span> · {loaded.summary}
          </p>
        </div>
      </header>

      {/* The agent is not on yet; the actions under it do the work today. */}
      <AskComposer>
        {newIssue}
        {repos.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-3 py-2 text-sm font-medium text-fg/90 transition-colors hover:bg-raised hover:text-fg">
              <ListTree size={14} /> Plan work
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
              <DropdownMenuLabel>Plan in which project?</DropdownMenuLabel>
              {repos.map((repo) => (
                <DropdownMenuItem key={repo.name} asChild>
                  <Link to={`/${repo.namespace}/${repo.name}/plans`}>
                    <Avatar name={repo.name} size={18} square />
                    {repo.name}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {needs.length > 0 && (
          <Link
            to={`${link({ tab: "needs", all: null })}#work`}
            preventScrollReset
            className="inline-flex items-center gap-1.5 rounded-md bg-merged px-3.5 py-2 text-sm font-semibold text-bg transition-colors hover:bg-[#c9bfff]"
          >
            Review {needs.length} that need{needs.length === 1 ? "s" : ""} you <ArrowRight size={14} />
          </Link>
        )}
      </AskComposer>

      {starting && <GetStarted steps={steps} />}

      <section
        aria-label="At a glance"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-5"
      >
        <Stat
          label="Projects"
          value={stats.projects == null ? "—" : String(stats.projects)}
          hint={
            stats.projectsThisMonth == null
              ? "in this workspace"
              : stats.projectsThisMonth > 0
                ? `+${stats.projectsThisMonth} this month`
                : "none new this month"
          }
        />
        <Stat
          label="Agents"
          value={loaded.runsLoaded || !workspace ? String(liveTotal) : "—"}
          dot={liveTotal > 0 ? "bg-accent animate-pulse" : undefined}
          hint={
            liveTotal > 0
              ? `live now · ${stats.agentHours < 10 ? stats.agentHours.toFixed(1) : Math.round(stats.agentHours)}h this week`
              : stats.agentHours > 0
                ? `none live · ${stats.agentHours < 10 ? stats.agentHours.toFixed(1) : Math.round(stats.agentHours)}h this week`
                : "none live now"
          }
        />
        <Stat
          label="Changes this week"
          value={loaded.perRepoLoaded ? String(week.total) : "—"}
          hint={
            delta != null ? `${signedPercent(delta)} vs last week` : week.previous === 0 ? "none the week before" : "merged pull requests"
          }
        />
        <Stat
          label="Landed without you"
          dot="bg-merged"
          value={share == null ? "—" : `${Math.round(share * 100)}%`}
          hint={share == null ? "no agent changes yet" : `${week.byAgents} of ${week.agentChanges} agent changes`}
          title="Of the changes agents wrote, those g1t merged by auto-merge or the merge queue, with no person pressing merge. People's own changes are not counted."
        />
        <div className="col-span-2 lg:col-span-1">
          <Stat
            label="Needs you"
            dot="bg-warn"
            value={String(needs.length)}
            hint={blocking > 0 ? `${blocking} blocking` : needs.length > 0 ? "nothing blocking" : "all clear"}
          />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
        <section id="work" className="min-w-0 scroll-mt-20 self-start overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex items-center gap-2 border-b border-line px-2 sm:px-3">
            <nav className="-mb-px flex min-w-0 grow gap-1 overflow-x-auto [scrollbar-width:none]" aria-label="Mission control">
              {(["needs", "waiting", "landed"] as const).map((value) => (
                <Link
                  key={value}
                  to={link({ tab: value, all: null })}
                  preventScrollReset
                  aria-current={tab === value ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-3 text-sm whitespace-nowrap transition-colors sm:px-2.5",
                    tab === value ? "border-merged font-medium text-fg" : "border-transparent text-muted hover:text-fg",
                  )}
                >
                  <span className="sm:hidden">{TAB_SHORT[value]}</span>
                  <span className="hidden sm:inline">{TAB_LABEL[value]}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[0.6875rem] tabular-nums",
                      tab === value && value === "needs" && counts.needs > 0 ? "bg-warn/15 text-warn" : "bg-line text-muted",
                    )}
                  >
                    {counts[value]}
                  </span>
                </Link>
              ))}
            </nav>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-raised hover:text-fg"
                aria-label="Sort"
              >
                <ArrowDownWideNarrow size={14} />
                <span className="hidden sm:inline">{SORT_LABEL[sort]}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(["impact", "newest"] as const).map((value) => (
                  <DropdownMenuItem key={value} asChild>
                    <Link to={link({ sort: value === "impact" ? null : value })} preventScrollReset>
                      {sort === value ? <Check /> : <span className="size-4" />}
                      {SORT_LABEL[value]}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {!loaded.perRepoLoaded && tab !== "waiting" ? (
            <div className="p-4">
              <Unavailable what={tab === "needs" ? "Some of what needs you" : "What landed"} />
            </div>
          ) : null}

          {tab === "needs" &&
            (needs.length === 0 ? (
              noProjects ? (
                <Empty
                  action={
                    <Link
                      to={workspace ? `/new?workspace=${workspace}` : "/new"}
                      className="rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-bg hover:bg-white"
                    >
                      Create or import a project
                    </Link>
                  }
                >
                  <p className="font-medium text-fg">No projects yet</p>
                  <p className="mt-1">
                    Create a repository or import one. Assign its issues to g1t, and what needs you shows up here.
                  </p>
                </Empty>
              ) : (
                <>
                  <Empty>
                    <p className="font-medium text-fg">Nothing needs you</p>
                    <p className="mt-1">
                      Agents are handling everything.{" "}
                      {landed.length > 0
                        ? "Here's what they landed today."
                        : "Reviews, stopped work and failed deploys show up here first."}
                    </p>
                  </Empty>
                  {landed.length > 0 && (
                    <div className="border-t border-line">
                      <List>
                        {landed.slice(0, ROWS).map((row) => (
                          <LandedCard key={row.key} row={row} first={false} />
                        ))}
                      </List>
                    </div>
                  )}
                </>
              )
            ) : (
              <List>
                {(shown as NeedRow[]).map((row, index) => (
                  <NeedCard key={row.key} row={row} first={index === 0} />
                ))}
              </List>
            ))}

          {tab === "waiting" &&
            (!loaded.runsLoaded && workspace ? (
              <div className="p-4">
                <Unavailable what="Agent runs" />
              </div>
            ) : waiting.length === 0 ? (
              <Empty>
                <p className="font-medium text-fg">No agent is at work right now</p>
                <p className="mt-1">Assign an issue to g1t and one starts on it in seconds. Its run shows here while it works.</p>
              </Empty>
            ) : (
              <List>
                {(shown as WaitingRow[]).map((row, index) => (
                  <WaitingCard key={row.key} row={row} first={index === 0} />
                ))}
              </List>
            ))}

          {tab === "landed" &&
            loaded.perRepoLoaded &&
            (landed.length === 0 ? (
              <Empty>
                <p className="font-medium text-fg">Nothing has landed today yet</p>
                <p className="mt-1">
                  {week.total > 0
                    ? `${plural(week.total, "change")} landed in the last 7 days.`
                    : "Merged pull requests show up here the moment they land."}
                </p>
              </Empty>
            ) : (
              <List>
                {(shown as LandedRow[]).map((row, index) => (
                  <LandedCard key={row.key} row={row} first={index === 0} />
                ))}
              </List>
            ))}

          {rows.length > ROWS && (
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-muted sm:px-5">
              <span>
                Showing {shown.length} of {rows.length}
              </span>
              <Link
                to={link({ all: all ? null : "1" })}
                preventScrollReset
                className="inline-flex items-center gap-1 font-medium text-fg-soft hover:text-fg"
              >
                {all ? "Show fewer" : "See all"} <ChevronRight size={12} />
              </Link>
            </div>
          )}
        </section>

        <aside className="min-w-0 space-y-6">
          <InboxNeedsCard items={loaderData.inboxNeeds.items} total={loaderData.inboxNeeds.total} />
          <section className="rounded-xl border border-line bg-surface p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold tracking-tight">This week</h2>
              {workspace && (
                <Link to={`/${workspace}/-/agents`} className="text-xs text-muted hover:text-fg">
                  Fleet
                </Link>
              )}
            </div>
            <div className="mt-4">{loaded.perRepoLoaded ? <WeekChart week={week} /> : <Unavailable what="The week" />}</div>
            {workspace && stats.weekCost > 0 && (
              <Link
                to={`/${workspace}/-/usage`}
                className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs text-muted hover:text-fg"
              >
                <span>Usage at price this week: {usd(stats.weekCost)}</span>
                <ChevronRight size={12} />
              </Link>
            )}
          </section>

          {workspace && (
            <TokenUsagePanel
              workspace={loaderData.tokens.workspace}
              mine={loaderData.tokens.mine}
              usageHref={`/${workspace}/-/usage`}
            />
          )}

          <section id="activity" className="scroll-mt-20 rounded-xl border border-line bg-surface p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold tracking-tight">Activity</h2>
              {groups.length > 8 && (
                <Link
                  to={`${link({ activity: everyActivity ? null : "all" })}#activity`}
                  preventScrollReset
                  className="inline-flex items-center gap-0.5 text-xs text-muted hover:text-fg"
                >
                  {everyActivity ? "Less" : "All activity"} <ChevronRight size={12} />
                </Link>
              )}
            </div>
            <p className="mt-1 flex items-center gap-3 text-[0.6875rem] text-faint">
              <span className="inline-flex items-center gap-1.5">
                <Avatar name="g1t" size={12} /> agents
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Avatar name={viewer.username} size={12} /> people
              </span>
            </p>
            {!loaded.perRepoLoaded ? (
              <div className="mt-3">
                <Unavailable what="Activity" />
              </div>
            ) : feed.length === 0 ? (
              <p className="mt-3 text-sm leading-6 text-muted">
                Nothing has moved yet. Merges, deploys, checks, reviews and what agents learn show up here.
              </p>
            ) : (
              <ol className="mt-2 divide-y divide-line/70">
                {feed.map((group) => (
                  <FeedLine key={group.id} group={group} titles={titles} />
                ))}
              </ol>
            )}
          </section>

          <section className="rounded-xl border border-line bg-surface p-5">
            <h2 className="text-sm font-semibold">Connect your own agent</h2>
            <p className="mt-1.5 text-xs leading-5 text-muted">
              Add g1t to your coding agent. It signs in through your browser; there is no token to copy.
            </p>
            <AgentSetup className="mt-3" />
            <Link
              to="https://docs.g1t.sh/guides/bring-your-own-agent/"
              className="mt-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
            >
              How it works <ArrowRight size={12} />
            </Link>
          </section>
        </aside>
      </div>
    </main>
  );
}
