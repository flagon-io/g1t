/**
 * The daily signal: what a workspace's work says, worked out from the
 * work service's `workspaceSignals` (per repository, added up here) and
 * billing's usage. Home leads with it (the week's pulse and the findings
 * worth a look, each with its evidence and where to see it), and the
 * Workspace overview draws the rest: spend threaded to the work it
 * produced, what is moving and what is waiting, and quiet changes in who
 * works where. Every number is worked out here, so each definition is
 * tested on its own (signals.test.ts) and written down in the Home guide.
 * Nothing here ranks people or teams against each other or against other
 * workspaces: a workspace is compared with its own last weeks.
 * Imports only types.
 */
import type {
  ProviderCosts,
  RepoPath,
  SignalAuthor,
  SignalDay,
  SignalHarness,
  SignalItem,
  SignalMilestone,
  SignalPull,
  SignalWeek,
  Usage,
  WaitingPull,
  WorkspaceSignals,
} from "@g1t/contracts";

import { sessionsPath } from "./work-items.ts";

const DAY_MS = 86_400_000;

/** Weeks of history the pulse and the trends read. */
export const SIGNAL_WEEKS = 10;
/** Days of history the rhythm of the work draws: last week and this one. */
export const SIGNAL_DAYS = 14;
/** How far back pull requests are read: a milestone's build, and the quarter. */
export const SIGNAL_REACH_DAYS = 120;

// --- Days and weeks ---------------------------------------------------------------

/** `YYYY-MM-DD` of a time, in UTC. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);
}

/** The first day of each of `weeks` weeks of seven days, the last ending with `until`. */
export function weekStarts(until: string, weeks = SIGNAL_WEEKS): string[] {
  return Array.from({ length: weeks }, (_, i) => addDays(until, -7 * (weeks - 1 - i) - 6));
}

/** Each of `days` days ending with `until`. */
export function dayList(until: string, days = SIGNAL_DAYS): string[] {
  return Array.from({ length: days }, (_, i) => addDays(until, i - days + 1));
}

/** The first day of the quarter `day` is in. */
export function quarterStart(day: string): string {
  const month = Number(day.slice(5, 7));
  const first = month - ((month - 1) % 3);
  return `${day.slice(0, 4)}-${String(first).padStart(2, "0")}-01`;
}

/** What the loader asks the work service for, for a page drawn at `now`. */
export function signalsRange(now: number): { until: string; since: string; weeks: number; days: number; quarter: string } {
  const until = utcDay(now);
  const quarter = quarterStart(until);
  const reach = addDays(until, -SIGNAL_REACH_DAYS);
  return { until, since: quarter < reach ? quarter : reach, weeks: SIGNAL_WEEKS, days: SIGNAL_DAYS, quarter };
}

// --- Adding up batches ------------------------------------------------------------

export function emptySignals(): WorkspaceSignals {
  return {
    weeks: [],
    days: [],
    waiting: [],
    pulls: [],
    pullsCapped: false,
    sessionSpend: [],
    sessionSpendCapped: false,
    authors: [],
    harnesses: [],
    items: [],
    milestones: [],
  };
}

/** The batches' answers as one: rows are per repository, so they add; items and milestones once each. */
export function mergeSignals(batches: WorkspaceSignals[]): WorkspaceSignals {
  const all = emptySignals();
  const items = new Map<number, SignalItem>();
  const milestones = new Map<number, SignalMilestone>();
  for (const batch of batches) {
    all.weeks.push(...batch.weeks);
    all.days.push(...batch.days);
    all.waiting.push(...batch.waiting);
    all.pulls.push(...batch.pulls);
    all.sessionSpend!.push(...(batch.sessionSpend ?? []));
    all.sessionSpendCapped ||= batch.sessionSpendCapped ?? false;
    all.authors.push(...batch.authors);
    all.harnesses.push(...(batch.harnesses ?? []));
    all.pullsCapped ||= batch.pullsCapped;
    for (const item of batch.items) items.set(item.number, item);
    for (const milestone of batch.milestones) milestones.set(milestone.number, milestone);
  }
  all.waiting.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  all.pulls.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  all.items = [...items.values()];
  all.milestones = [...milestones.values()];
  return all;
}

/** One week's measures, every repository's added up. */
export type WeekTotals = Omit<SignalWeek, "repoId">;

const ZERO_WEEK = (start: string): WeekTotals => ({
  start,
  merged: 0,
  agentMerged: 0,
  agentReworked: 0,
  agentDrafted: 0,
  agentDraftSeconds: 0,
  reviewed: 0,
  reviewSeconds: 0,
  stalled: 0,
  sessionCostUsd: 0,
  agentCommits: 0,
});

/** Every week in `starts`, quiet ones too, for the repositories in `only` (every one when not given). */
export function weekTotals(rows: SignalWeek[], starts: string[], only?: ReadonlySet<string>): WeekTotals[] {
  const byStart = new Map(starts.map((start) => [start, ZERO_WEEK(start)]));
  for (const row of rows) {
    const week = byStart.get(row.start);
    if (!week || (only && !only.has(row.repoId))) continue;
    week.merged += row.merged;
    week.agentMerged += row.agentMerged;
    week.agentReworked += row.agentReworked;
    week.agentDrafted += row.agentDrafted;
    week.agentDraftSeconds += row.agentDraftSeconds;
    week.reviewed += row.reviewed;
    week.reviewSeconds += row.reviewSeconds;
    week.stalled += row.stalled;
    week.sessionCostUsd += row.sessionCostUsd ?? 0;
    week.agentCommits += row.agentCommits ?? 0;
  }
  return starts.map((start) => byStart.get(start)!);
}

/**
 * What the agents' usage came to in each week, from usage's `byDay`
 * (`YYYY-MM-DD/task`). Null when usage did not answer.
 */
export function weeklySpend(usage: Usage | null, starts: string[]): number[] | null {
  if (!usage) return null;
  const spend = starts.map(() => 0);
  for (const slice of usage.byDay) {
    const day = slice.key.slice(0, 10);
    // The week a day falls in: the last start on or before it.
    for (let i = starts.length - 1; i >= 0; i--) {
      if (day >= starts[i]! && day < addDays(starts[i]!, 7)) {
        spend[i]! += slice.micros;
        break;
      }
    }
  }
  return spend;
}

// --- Measures -------------------------------------------------------------------

/** Seconds a first review waited, on average, or null with none given. */
export function reviewWait(week: WeekTotals): number | null {
  return week.reviewed > 0 ? week.reviewSeconds / week.reviewed : null;
}

/** Seconds from an agent's session starting to its pull request opening, on average. */
export function draftTime(week: WeekTotals): number | null {
  return week.agentDrafted > 0 ? week.agentDraftSeconds / week.agentDrafted : null;
}

/** The share of an agent's merged pull requests a person asked for changes on, 0 to 1. */
export function reworkRate(week: WeekTotals): number | null {
  return week.agentMerged > 0 ? week.agentReworked / week.agentMerged : null;
}

/**
 * What agents landed in a week: their merged pull requests, and the
 * commits their sessions pushed outside any pull request (to the default
 * branch, most of all). A workspace that pushes straight to main lands
 * most of its work the second way.
 */
export function agentChanges(week: WeekTotals): number {
  return week.agentMerged + (week.agentCommits ?? 0);
}

/** Everything that landed in a week: merged pull requests, and agents' direct commits. */
export function allChanges(week: WeekTotals): number {
  return week.merged + (week.agentCommits ?? 0);
}

/** The share of what landed that was an agent's, 0 to 1. */
export function agentShare(week: WeekTotals): number | null {
  return allChanges(week) > 0 ? agentChanges(week) / allChanges(week) : null;
}

/** Usage per agent change (merge or direct commit), in micros. */
export function spendPerMerge(micros: number | null, week: WeekTotals): number | null {
  return micros != null && agentChanges(week) > 0 ? micros / agentChanges(week) : null;
}

// --- Words ------------------------------------------------------------------------

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** A count as a sentence starts it: "Three", or "12". */
export function countWord(n: number): string {
  return WORDS[n] ?? String(n);
}

/** A wait in words: "48 minutes", "5 hours", "2.1 days". */
export function spoken(seconds: number): string {
  if (seconds < 90) return "a minute";
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 1.5 * 3600) return "an hour";
  if (seconds < 20 * 3600) return `${Math.round(seconds / 3600)} hours`;
  if (seconds < 36 * 3600) return "a day";
  const days = seconds / 86400;
  return `${days < 10 ? days.toFixed(1).replace(/\.0$/, "") : Math.round(days)} days`;
}

/** A wait in a few characters, for figures: "48m", "5h", "2.1d". */
export function short(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0).replace(/\.0$/, "")}h`;
  return `${(seconds / 86400).toFixed(1).replace(/\.0$/, "")}d`;
}

export function percent(share: number | null): string {
  return share == null ? "—" : `${Math.round(share * 100)}%`;
}

/** Money in micros as the pulse shows it: whole dollars, compact from $10K. */
export function dollars(micros: number | null): string {
  if (micros == null) return "—";
  const value = micros / 1_000_000;
  if (value >= 10_000) return `$${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (value >= 10) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(2)}`;
}

/** The day a page is drawn on, as the daily signal heads it: "Sunday, October 18". */
export function signalDate(now: number, tz: string | null): string {
  const options: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  try {
    return new Date(now).toLocaleDateString("en-US", { ...options, timeZone: tz ?? "UTC" });
  } catch {
    return new Date(now).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
  }
}

/** A week's first day as a trend's point names it: "Oct 12". */
export function weekLabel(start: string): string {
  return new Date(`${start}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// --- The pulse --------------------------------------------------------------------

export type Tone = "good" | "bad" | "flat";

export type PulseTile = {
  key: "merges" | "spend" | "stalled" | "rework";
  label: string;
  /** This week's figure. */
  value: string;
  /** Against last week: the difference as a chip says it, and whether that is good news. */
  delta: { text: string; tone: Tone } | null;
  /** Each week's figure, oldest first; null for a week with nothing to measure. */
  series: (number | null)[];
  /** Each week's point, as its hover says it. */
  points: string[];
  /** What it counts, in a sentence. */
  hint: string;
  to: string;
};

function tone(change: number, upIsGood: boolean): Tone {
  if (change === 0) return "flat";
  return change > 0 === upIsGood ? "good" : "bad";
}

function signed(n: number, format: (abs: number) => string): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${format(Math.abs(n))}`;
}

function deltaOf(now: number | null, before: number | null, format: (abs: number) => string, upIsGood: boolean) {
  if (now == null || before == null) return null;
  const change = now - before;
  return { text: signed(change, format), tone: tone(change, upIsGood) };
}

export type PulseInput = {
  slug: string;
  weeks: WeekTotals[];
  /** Usage per week, aligned with `weeks`; null when usage did not answer. */
  spend: number[] | null;
};

/**
 * The past week in four figures, each against the week before and drawn
 * over the last ten: what agents landed (merges and direct commits), usage
 * per agent change, stalled changes, and how often people asked for
 * changes on an agent's merged work.
 */
export function pulse({ slug, weeks, spend }: PulseInput): PulseTile[] {
  const at = weeks.length - 1;
  const now = weeks[at];
  const before = weeks[at - 1] ?? null;
  if (!now) return [];
  const labels = weeks.map((week) => `Week of ${weekLabel(week.start)}`);
  const perMerge = weeks.map((week, i) => spendPerMerge(spend?.[i] ?? null, week));
  const rework = weeks.map(reworkRate);
  const count = (n: number) => String(Math.round(n));
  return [
    {
      key: "merges",
      label: "Landed by agents",
      value: String(agentChanges(now)),
      delta: deltaOf(agentChanges(now), before ? agentChanges(before) : null, count, true),
      series: weeks.map(agentChanges),
      points: weeks.map((week, i) => `${labels[i]}: ${week.agentMerged} merged, ${week.agentCommits ?? 0} pushed directly, of ${allChanges(week)} changes`),
      hint: "Agents' merged pull requests, and the commits their sessions pushed outside one",
      to: `/${slug}/-/home?window=7d#since`,
    },
    {
      key: "spend",
      label: "Cost per agent change",
      value: dollars(perMerge[at] ?? null),
      delta: deltaOf(perMerge[at] ?? null, before ? (perMerge[at - 1] ?? null) : null, (abs) => dollars(abs), false),
      series: perMerge,
      points: perMerge.map((micros, i) => `${labels[i]}: ${micros == null ? "no agent changes" : dollars(micros)}`),
      hint: "g1t's agent usage at price and harness sessions' cost at list price, over what agents landed",
      to: `/${slug}/-/settings/usage`,
    },
    {
      key: "stalled",
      label: "Gone quiet",
      value: String(now.stalled),
      delta: deltaOf(now.stalled, before?.stalled ?? null, count, false),
      series: weeks.map((week) => week.stalled),
      points: weeks.map((week, i) => `${labels[i]}: ${week.stalled} with nothing for three days`),
      hint: "Open pull requests with no push, comment, review, check or session for three days",
      to: `/${slug}/-/home#needed`,
    },
    {
      key: "rework",
      label: "Sent back",
      value: percent(rework[at] ?? null),
      delta: deltaOf(rework[at] ?? null, before ? (rework[at - 1] ?? null) : null, (abs) => `${(abs * 100).toFixed(1).replace(/\.0$/, "")} pts`, false),
      series: rework,
      points: rework.map((share, i) => `${labels[i]}: ${share == null ? "no agent merges" : percent(share)}`),
      hint: "Of the agent pull requests that merged, the share a person asked for changes on first",
      to: `/${slug}/-/insights`,
    },
  ];
}

// --- The findings -----------------------------------------------------------------

export type Signal = {
  key: string;
  /** The finding, in one sentence. */
  headline: string;
  /** The evidence, as short facts: "48 min to draft", "2.1 days to first review". */
  facts: string[];
  link: { label: string; to: string } | null;
  /** A measure over the weeks behind the finding, when it is a trend. */
  trend?: { values: (number | null)[]; points: string[]; caption: string; range: string };
  /** How much it matters today: findings are shown highest first. */
  weight: number;
  /** The UTC day it happened (`YYYY-MM-DD`), when it happened on one: Home pins it there on the week. */
  day?: string;
  /** What Ask is asked, to look into it. */
  ask: string;
};

export type SignalContext = {
  slug: string;
  now: number;
  repos: Record<string, RepoPath>;
  signals: WorkspaceSignals;
  weeks: WeekTotals[];
  /** The quarter's usage (by pull request and project); null when usage did not answer. */
  quarterUsage: Usage | null;
  quarter: string;
};

export function pullPath(repo: RepoPath, number: number): string {
  return `/${repo.namespace}/${repo.name}/pull/${number}`;
}

export function itemPath(slug: string, number: number): string {
  return `/${slug}/-/work/${number}`;
}

export function milestonePath(slug: string, number: number): string {
  return `/${slug}/-/work/milestones/${number}`;
}

function ago(now: number, at: string): number {
  return Math.max(0, (now - Date.parse(at)) / 1000);
}

/** Several work items wait on one change no one has reviewed: the one holding up the most. */
export function blockedSignal(ctx: SignalContext): Signal | null {
  const top = ctx.signals.waiting
    .filter((pull) => pull.blocks.length > 0 && ctx.repos[pull.repoId])
    .sort((a, b) => b.blocks.length - a.blocks.length || a.createdAt.localeCompare(b.createdAt))[0];
  if (!top) return null;
  const repo = ctx.repos[top.repoId]!;
  const n = top.blocks.length;
  const shown = top.blocks.slice(0, 3).map((number) => `#${number}`);
  return {
    key: "blocked",
    headline:
      n === 1
        ? `${repo.name}#${top.number} holds up a work item, and no one has reviewed it yet.`
        : `${repo.name}#${top.number} holds up ${countWord(n).toLowerCase()} work items, and no one has reviewed it yet.`,
    facts: [
      `${repo.name}#${top.number} ${top.title}`,
      `open ${spoken(ago(ctx.now, top.createdAt))}`,
      `holds up ${shown.join(", ")}${n > 3 ? ` and ${n - 3} more` : ""}`,
    ],
    link: { label: "See what's blocked", to: pullPath(repo, top.number) },
    weight: 60 + 8 * n,
    ask: `Why is ${repo.namespace}/${repo.name}#${top.number} still waiting for review, and what is waiting on it?`,
  };
}

/**
 * Agents draft quickly and the change then waits for a person: this
 * week's first reviews against how long the agents took to open them,
 * with first-review time over the weeks. Or, without that gap, first
 * reviews that slowed against the weeks before.
 */
export function reviewSignal(ctx: SignalContext): Signal | null {
  const weeks = ctx.weeks;
  const now = weeks[weeks.length - 1];
  if (!now) return null;
  const wait = reviewWait(now);
  if (wait == null) return null;
  const draft = draftTime(now);
  const series = weeks.map(reviewWait);
  const earlier = series.slice(0, -1).filter((value): value is number => value != null);
  const usual = earlier.length ? earlier.reduce((sum, value) => sum + value, 0) / earlier.length : null;
  const first = series.find((value) => value != null) ?? null;
  const trend = {
    values: series,
    points: series.map((value, i) => `Week of ${weekLabel(weeks[i]!.start)}: ${value == null ? "no first reviews" : short(value)}`),
    caption: "Time to first review",
    range: `${short(first)} → ${short(wait)} over ${weeks.length} weeks`,
  };
  const link = { label: "See the review queue", to: `/${ctx.slug}/-/home#needed` };
  if (draft != null && wait >= 4 * draft && wait >= 4 * 3600) {
    return {
      key: "review",
      headline: `Changes an agent drafts in ${draft < 3600 ? "under an hour" : spoken(draft)} are waiting ${spoken(wait)} for first review.`,
      facts: [`${short(draft)} to draft`, `${short(wait)} to first review`, "this week"],
      link,
      trend,
      weight: 40 + Math.min(40, (wait / Math.max(draft, 60)) * 2),
      ask: "Which agent pull requests are waiting longest for a first review, and who could review them?",
    };
  }
  if (usual != null && wait >= 1.5 * usual && wait - usual >= 2 * 3600) {
    return {
      key: "review",
      headline: `First reviews are taking ${spoken(wait)}, up from ${spoken(usual)} in the weeks before.`,
      facts: [`${now.reviewed} first reviews this week`, `${short(wait)} on average`],
      link,
      trend,
      weight: 30 + Math.min(30, (wait / usual) * 5),
      ask: "Why are first reviews slower this week than usual?",
    };
  }
  return null;
}

const MICROS = 1_000_000;

/** Whether a pull request's work falls in the quarter: opened in it, or merged in it. */
function inQuarter(pull: SignalPull, quarter: string): boolean {
  return pull.createdAt.slice(0, 10) >= quarter || (pull.mergedAt != null && pull.mergedAt.slice(0, 10) >= quarter);
}

/** What harness sessions with no pull request cost in one repository, for one work item or none. */
export type LooseSpend = { repoId: string; item: number | null; micros: number };

/**
 * What the quarter's agent work cost, by pull request (`namespace/name#number`)
 * and in all: g1t's metered usage on each pull request (usage's `byPull`), and
 * each pull request's share of what its harness sessions cost, estimated at
 * list price from their token usage. Harness sessions that count with no pull
 * request (a direct push, or work that never opened one) are in `loose`, by
 * repository and work item. The total also holds g1t usage on pull requests
 * the reading doesn't list. Null when usage did not answer.
 */
export function quarterSpend(
  ctx: Pick<SignalContext, "repos" | "signals" | "quarterUsage" | "quarter">,
): { byPull: Map<string, number>; loose: LooseSpend[]; total: number; sessions: number } | null {
  if (!ctx.quarterUsage) return null;
  const byPull = new Map<string, number>();
  let total = 0;
  for (const slice of ctx.quarterUsage.byPull) {
    const key = slice.key.toLowerCase();
    byPull.set(key, (byPull.get(key) ?? 0) + slice.micros);
    total += slice.micros;
  }
  let sessions = 0;
  for (const pull of ctx.signals.pulls) {
    const repo = ctx.repos[pull.repoId];
    const micros = Math.round((pull.sessionCostUsd ?? 0) * MICROS);
    if (!repo || micros <= 0 || !inQuarter(pull, ctx.quarter)) continue;
    const key = pullKey(repo, pull.number);
    byPull.set(key, (byPull.get(key) ?? 0) + micros);
    total += micros;
    sessions += micros;
  }
  const loose = new Map<string, LooseSpend>();
  for (const row of ctx.signals.sessionSpend ?? []) {
    const micros = Math.round(row.sessionCostUsd * MICROS);
    if (!ctx.repos[row.repoId] || micros <= 0 || row.day < ctx.quarter) continue;
    const key = `${row.repoId}#${row.item ?? ""}`;
    const entry = loose.get(key) ?? { repoId: row.repoId, item: row.item, micros: 0 };
    entry.micros += micros;
    loose.set(key, entry);
    total += micros;
    sessions += micros;
  }
  return { byPull, loose: [...loose.values()], total, sessions };
}

/**
 * Whether one person does the workspace's work: no more than one person
 * started a session or merged a pull request in its repositories.
 */
export function onePerson(signals: WorkspaceSignals): boolean {
  const people = new Set([...signals.harnesses, ...signals.authors].map((row) => row.ownerId));
  return people.size <= 1;
}

function pullKey(repo: RepoPath, number: number): string {
  return `${repo.namespace}/${repo.name}#${number}`.toLowerCase();
}

/** Where the quarter's agent usage went, by milestone (else work item, else project): the biggest share. */
export function spendSignal(ctx: SignalContext): Signal | null {
  const quarter = quarterSpend(ctx);
  if (!quarter || quarter.total <= 0) return null;
  const { byPull: spend, total } = quarter;
  const items = new Map(ctx.signals.items.map((item) => [item.number, item]));
  const milestones = new Map(ctx.signals.milestones.map((milestone) => [milestone.number, milestone]));
  const groups = new Map<string, { label: string; to: string; micros: number }>();
  const add = (repoId: string, repo: RepoPath, itemNumber: number | null, milestoneNumber: number | null, micros: number) => {
    const item = itemNumber != null ? items.get(itemNumber) : undefined;
    const milestone = (milestoneNumber ?? item?.milestone) != null ? milestones.get((milestoneNumber ?? item?.milestone)!) : undefined;
    const group = milestone
      ? { key: `m${milestone.number}`, label: milestone.title, to: milestonePath(ctx.slug, milestone.number) }
      : item
        ? { key: `i${item.number}`, label: item.title, to: itemPath(ctx.slug, item.number) }
        : { key: `r${repoId}`, label: repo.name, to: `/${repo.namespace}/${repo.name}` };
    const entry = groups.get(group.key) ?? { label: group.label, to: group.to, micros: 0 };
    entry.micros += micros;
    groups.set(group.key, entry);
  };
  for (const pull of ctx.signals.pulls) {
    const repo = ctx.repos[pull.repoId];
    if (!repo) continue;
    const micros = spend.get(pullKey(repo, pull.number));
    if (!micros) continue;
    add(pull.repoId, repo, pull.item, pull.milestone, micros);
  }
  // Sessions with no pull request: by the work item they did, else their repository.
  for (const row of quarter.loose) add(row.repoId, ctx.repos[row.repoId]!, row.item, null, row.micros);
  const top = [...groups.values()].sort((a, b) => b.micros - a.micros)[0];
  if (!top) return null;
  const share = top.micros / total;
  // With one group, there is nothing to compare it with, unless one person does all the work.
  if (share < 0.35 || (groups.size < 2 && !onePerson(ctx.signals))) return null;
  const amount = share >= 0.995 ? "all" : share > 0.5 ? "more than half" : share > 1 / 3 ? "more than a third" : `${Math.round(share * 100)}%`;
  return {
    key: "spend",
    headline: `${top.label.charAt(0).toUpperCase()}${top.label.slice(1)} took ${amount} of the agent spend this quarter.`,
    facts: [`${dollars(top.micros)} of ${dollars(total)}`, "quarter to date"],
    link: { label: "See the spend", to: `/${ctx.slug}/-/home#spend` },
    weight: 25 + share * 40,
    ask: `What has the agent spend on ${top.label} produced this quarter?`,
  };
}

const WEEK_MS = 7 * DAY_MS;

/** A milestone closed in the last week, against its due date, with what it took. */
export function shippedSignal(ctx: SignalContext): Signal | null {
  const recent = ctx.signals.milestones
    .filter((milestone) => milestone.state === "closed" && milestone.closedAt && ctx.now - Date.parse(milestone.closedAt) <= WEEK_MS)
    .sort((a, b) => b.closedAt!.localeCompare(a.closedAt!))[0];
  if (!recent) return null;
  const closed = Date.parse(recent.closedAt!);
  const pulls = ctx.signals.pulls.filter((pull) => pull.milestone === recent.number && pull.status === "merged");
  const started = Math.min(Date.parse(recent.createdAt), ...pulls.map((pull) => Date.parse(pull.createdAt)));
  const weeksIn = Math.max(1, Math.round((closed - started) / WEEK_MS));
  const projects = new Set(pulls.map((pull) => pull.repoId)).size;
  const weekday = new Date(closed).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  let schedule = "";
  let weight = 35;
  if (recent.dueOn) {
    const early = Math.round((Date.parse(`${recent.dueOn}T23:59:59Z`) - closed) / DAY_MS);
    if (early >= 14) {
      schedule = `, ${countWord(Math.round(early / 7)).toLowerCase()} weeks ahead of schedule`;
      weight = 45;
    } else if (early >= 2) schedule = `, ${early} days ahead of schedule`;
    else if (early >= 0) schedule = ", on schedule";
    else schedule = `, ${spoken(-early * 86400)} late`;
  }
  return {
    key: "shipped",
    headline: `${recent.title} closed ${weekday}${schedule}.`,
    day: recent.closedAt!.slice(0, 10),
    facts: [
      `${weeksIn} ${weeksIn === 1 ? "week" : "weeks"} in build`,
      `${pulls.length} ${pulls.length === 1 ? "change" : "changes"}`,
      ...(projects > 0 ? [`${projects} ${projects === 1 ? "repository" : "repositories"}`] : []),
    ],
    link: { label: "See the work", to: milestonePath(ctx.slug, recent.number) },
    weight,
    ask: `Summarize what shipped in the milestone ${recent.title}.`,
  };
}

/** More changes stalled than last week. */
export function stalledSignal(ctx: SignalContext): Signal | null {
  const now = ctx.weeks[ctx.weeks.length - 1];
  const before = ctx.weeks[ctx.weeks.length - 2];
  if (!now || !before) return null;
  const more = now.stalled - before.stalled;
  if (more < 3 || now.stalled < 1.25 * before.stalled) return null;
  return {
    key: "stalled",
    headline: `${countWord(now.stalled)} open changes have gone three days with nothing happening, ${more} more than last week.`,
    facts: [`${before.stalled} last week`, `${now.stalled} now`],
    link: { label: "See what's stalled", to: `/${ctx.slug}/-/home#needed` },
    trend: {
      values: ctx.weeks.map((week) => week.stalled),
      points: ctx.weeks.map((week) => `Week of ${weekLabel(week.start)}: ${week.stalled}`),
      caption: "Gone quiet",
      range: `${ctx.weeks[0]!.stalled} → ${now.stalled} over ${ctx.weeks.length} weeks`,
    },
    weight: 30 + Math.min(25, more * 2),
    ask: "Which pull requests have stalled this week, and what are they waiting on?",
  };
}

/** People asking for changes on agents' work more often, or less, than the weeks before. */
export function reworkSignal(ctx: SignalContext): Signal | null {
  const now = ctx.weeks[ctx.weeks.length - 1];
  if (!now || now.agentMerged < 5) return null;
  const rate = reworkRate(now)!;
  const earlier = ctx.weeks.slice(-5, -1);
  const merged = earlier.reduce((sum, week) => sum + week.agentMerged, 0);
  if (merged < 5) return null;
  const usual = earlier.reduce((sum, week) => sum + week.agentReworked, 0) / merged;
  const change = rate - usual;
  if (Math.abs(change) < 0.08) return null;
  const up = change > 0;
  return {
    key: "rework",
    headline: up
      ? `People asked for changes on ${percent(rate)} of agents' merged work this week, up from ${percent(usual)}.`
      : `Agents' work is landing with fewer requests for changes: ${percent(rate)} this week, down from ${percent(usual)}.`,
    facts: [`${now.agentReworked} of ${now.agentMerged} agent merges reworked`, "against the four weeks before"],
    link: { label: "See Insights", to: `/${ctx.slug}/-/insights` },
    weight: up ? 30 + change * 100 : 15 + Math.abs(change) * 60,
    ask: up ? "What did reviewers ask agents to change this week?" : "What changed in how agents' work is reviewed this week?",
  };
}

// --- Who works where --------------------------------------------------------------

/** People who never merged to a project before, now have: in the last `days`, with merges elsewhere first. */
export type NewGround = { ownerId: string; name: string; repoId: string; firstMergedAt: string; elsewhere: number };

export function newGround(authors: SignalAuthor[], now: number, days = 14): NewGround[] {
  const byOwner = new Map<string, SignalAuthor[]>();
  for (const row of authors) byOwner.set(row.ownerId, [...(byOwner.get(row.ownerId) ?? []), row]);
  const found: NewGround[] = [];
  for (const rows of byOwner.values()) {
    for (const row of rows) {
      if (now - Date.parse(row.firstMergedAt) > days * DAY_MS) continue;
      // Merges elsewhere before this one: someone new to the project, not new to the workspace.
      const elsewhere = rows
        .filter((other) => other.repoId !== row.repoId && other.firstMergedAt < row.firstMergedAt)
        .reduce((sum, other) => sum + other.merged, 0);
      if (elsewhere >= 3) found.push({ ownerId: row.ownerId, name: row.ownerName, repoId: row.repoId, firstMergedAt: row.firstMergedAt, elsewhere });
    }
  }
  return found.sort((a, b) => b.firstMergedAt.localeCompare(a.firstMergedAt));
}

/**
 * A project where one person has done most of the recent work: their
 * share of its merges in the last 90 days, and whoever else has started
 * merging there in the last 30 (knowledge spreading, or not yet). Only in
 * a workspace where three people or more merged lately.
 */
export type Silo = {
  repoId: string;
  ownerId: string;
  name: string;
  share: number;
  theirs: number;
  recent: number;
  joining: { ownerId: string; name: string }[];
};

export function silos(authors: SignalAuthor[], now: number, { minRecent = 6, minShare = 0.75, minPeople = 3 } = {}): Silo[] {
  // Fewer than `minPeople` people merging anywhere lately: every project rests on someone, and saying so tells nothing.
  const people = new Set(authors.filter((row) => row.recent > 0).map((row) => row.ownerId));
  if (people.size < minPeople) return [];
  const byRepo = new Map<string, SignalAuthor[]>();
  for (const row of authors) byRepo.set(row.repoId, [...(byRepo.get(row.repoId) ?? []), row]);
  const found: Silo[] = [];
  for (const [repoId, rows] of byRepo) {
    const recent = rows.reduce((sum, row) => sum + row.recent, 0);
    if (recent < minRecent) continue;
    const top = [...rows].sort((a, b) => b.recent - a.recent)[0]!;
    const share = top.recent / recent;
    if (share < minShare) continue;
    const joining = rows
      .filter((row) => row.ownerId !== top.ownerId && row.recent > 0 && now - Date.parse(row.firstMergedAt) <= 30 * DAY_MS)
      .map((row) => ({ ownerId: row.ownerId, name: row.ownerName }));
    found.push({ repoId, ownerId: top.ownerId, name: top.ownerName, share, theirs: top.recent, recent, joining });
  }
  return found.sort((a, b) => b.recent * b.share - a.recent * a.share);
}

/** People whose first merged agent pull request came in the last `days`, after merging their own work before. */
export type NewHabit = { ownerId: string; name: string; firstAgentAt: string; repoId: string; byHand: number };

export function newHabits(pulls: SignalPull[], now: number, days = 14): NewHabit[] {
  const byOwner = new Map<string, SignalPull[]>();
  for (const pull of pulls) if (pull.status === "merged" && pull.mergedAt) byOwner.set(pull.ownerId, [...(byOwner.get(pull.ownerId) ?? []), pull]);
  const found: NewHabit[] = [];
  for (const merged of byOwner.values()) {
    merged.sort((a, b) => a.mergedAt!.localeCompare(b.mergedAt!));
    const first = merged.find((pull) => pull.agent);
    if (!first || now - Date.parse(first.mergedAt!) > days * DAY_MS) continue;
    const byHand = merged.filter((pull) => !pull.agent && pull.mergedAt! < first.mergedAt!).length;
    if (byHand >= 3) found.push({ ownerId: first.ownerId, name: first.ownerName, firstAgentAt: first.mergedAt!, repoId: first.repoId, byHand });
  }
  return found.sort((a, b) => b.firstAgentAt.localeCompare(a.firstAgentAt));
}

/**
 * A way of working catching on: a harness that someone took up first,
 * then at least two more people started using in the last `days`, at
 * least two weeks after them. Over the repositories in `only` (a team's),
 * or all of them; the newest spread first.
 */
export type Spread = {
  harness: string;
  first: { ownerId: string; name: string; at: string };
  recent: { ownerId: string; name: string; at: string }[];
  people: number;
};

export function spreading(harnesses: SignalHarness[], now: number, { days = 30, only }: { days?: number; only?: ReadonlySet<string> } = {}): Spread[] {
  // Each person's first session with each harness, over the repositories asked about.
  const firsts = new Map<string, Map<string, { ownerId: string; name: string; at: string }>>();
  for (const row of harnesses) {
    if (only && !only.has(row.repoId)) continue;
    const people = firsts.get(row.harness) ?? new Map();
    const known = people.get(row.ownerId);
    if (!known || row.firstAt < known.at) people.set(row.ownerId, { ownerId: row.ownerId, name: row.ownerName, at: row.firstAt });
    firsts.set(row.harness, people);
  }
  const found: Spread[] = [];
  for (const [harness, people] of firsts) {
    const order = [...people.values()].sort((a, b) => a.at.localeCompare(b.at));
    const first = order[0]!;
    const recent = order.filter((person) => now - Date.parse(person.at) <= days * DAY_MS && Date.parse(person.at) - Date.parse(first.at) >= 14 * DAY_MS);
    if (recent.length >= 2) found.push({ harness, first, recent, people: order.length });
  }
  return found.sort((a, b) => b.recent[b.recent.length - 1]!.at.localeCompare(a.recent[a.recent.length - 1]!.at));
}

const HARNESS_WORDS: Record<string, string> = {
  claude_code: "Claude Code",
  claude_managed_agents: "Claude Managed Agents",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
};

/** A harness as a sentence names it. */
export function harnessWords(harness: string): string {
  return HARNESS_WORDS[harness] ?? "another harness";
}

/** Names in a sentence: "ana", "ana and bo", "ana, bo and 2 others". */
export function namesWords(names: string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, max - 1).join(", ")} and ${names.length - max + 1} others`;
}

/** A practice catching on, as a finding. */
export function spreadSignal(ctx: SignalContext): Signal | null {
  const spread = spreading(ctx.signals.harnesses ?? [], ctx.now)[0];
  if (!spread) return null;
  const tool = harnessWords(spread.harness);
  return {
    key: "spread",
    headline: `${tool} is catching on: ${namesWords(spread.recent.map((person) => person.name))} started using it this month, after ${spread.first.name}.`,
    facts: [
      `${spread.people} people use it now`,
      `${spread.first.name} first, ${spoken(Math.max(0, (Date.parse(spread.recent[0]!.at) - Date.parse(spread.first.at)) / 1000))} before the next`,
    ],
    link: { label: "See the sessions", to: sessionsPath(ctx.slug) },
    weight: 22 + Math.min(12, spread.recent.length * 3),
    ask: `How have ${namesWords(spread.recent.map((person) => person.name))} been using ${tool}, and what did ${spread.first.name} do with it first?`,
  };
}

/** The quiet changes as one finding: someone moving into a project one person has carried, else anyone new to one. */
export function groundSignal(ctx: SignalContext): Signal | null {
  const spreading = silos(ctx.signals.authors, ctx.now).find((silo) => silo.joining.length > 0 && ctx.repos[silo.repoId]);
  if (spreading) {
    const repo = ctx.repos[spreading.repoId]!;
    const joiner = spreading.joining[0]!;
    return {
      key: "ground",
      headline: `${joiner.name} is starting to work in ${repo.name}, which ${spreading.name} has carried almost alone.`,
      facts: [`${spreading.theirs} of ${spreading.recent} merges in 90 days were ${spreading.name}'s`, `${joiner.name} started this month`],
      link: { label: "See the people", to: `/${ctx.slug}/-/home#quiet` },
      weight: 28,
      ask: `What has ${joiner.name} worked on in ${repo.namespace}/${repo.name} so far?`,
    };
  }
  const moved = newGround(ctx.signals.authors, ctx.now, 7).filter((row) => ctx.repos[row.repoId]);
  if (moved.length === 0) return null;
  const first = moved[0]!;
  const repo = ctx.repos[first.repoId]!;
  const others = new Set(moved.map((row) => row.ownerId)).size - 1;
  return {
    key: "ground",
    headline:
      others > 0
        ? `${first.name} and ${others === 1 ? "one other person" : `${others} others`} merged their first change to a repository new to them this week.`
        : `${first.name} merged a first change to ${repo.name} this week, new ground for them.`,
    facts: [`${first.elsewhere} merges elsewhere before`, `first in ${repo.name}`],
    link: { label: "See the people", to: `/${ctx.slug}/-/home#quiet` },
    weight: 20 + Math.min(10, others * 3),
    day: first.firstMergedAt.slice(0, 10),
    ask: `What did ${first.name} change in ${repo.namespace}/${repo.name}?`,
  };
}

const FINDINGS = [blockedSignal, reviewSignal, shippedSignal, spendSignal, stalledSignal, reworkSignal, groundSignal, spreadSignal];

/** Every finding worth a look today, the one that matters most first. A finding that cannot be worked out is left out. */
export function findings(ctx: SignalContext): Signal[] {
  const found: Signal[] = [];
  for (const make of FINDINGS) {
    try {
      const signal = make(ctx);
      if (signal) found.push(signal);
    } catch {
      // One finding's arithmetic never takes the rest down.
    }
  }
  return found.sort((a, b) => b.weight - a.weight);
}

/**
 * The week in a sentence: what landed and how much of it was agents'. It
 * says nothing about what needs anyone; Home leads with that on its own.
 */
export function weekSummary(week: WeekTotals | undefined): string {
  const landed = week ? allChanges(week) : 0;
  if (!week || landed === 0) return "Nothing has landed this week yet.";
  const share = agentShare(week);
  return `${countWord(landed)} ${landed === 1 ? "change" : "changes"} landed this week${share ? `, ${percent(share)} of them by agents` : ""}.`;
}

/** One day on Home's week: what landed, agents' and people's, and the sessions started. */
export type DayBar = { day: string; agent: number; people: number; sessions: number };

/**
 * The last `count` UTC days to `now`, oldest first, every repository's
 * rows added up; a day with nothing in it is zeros. Agents' are their
 * merged pull requests and the commits their sessions pushed directly;
 * people's, the other merged pull requests.
 */
export function dayBars(days: Pick<SignalDay, "day" | "merged" | "agentMerged" | "agentCommits" | "sessions">[], now: number, count = SIGNAL_DAYS): DayBar[] {
  const until = utcDay(now);
  const bars = new Map<string, DayBar>();
  for (let i = count - 1; i >= 0; i--) {
    const day = addDays(until, -i);
    bars.set(day, { day, agent: 0, people: 0, sessions: 0 });
  }
  for (const row of days) {
    const bar = bars.get(row.day);
    if (!bar) continue;
    bar.agent += row.agentMerged + (row.agentCommits ?? 0);
    bar.people += Math.max(0, row.merged - row.agentMerged);
    bar.sessions += row.sessions;
  }
  return [...bars.values()];
}

/** What Home shows of the work: the week's figures, its days, and the findings, most important first. */
export type DailySignal = {
  tiles: PulseTile[];
  findings: Signal[];
  /** The week in a sentence (`weekSummary`). */
  summary: string;
  days: DayBar[];
  complete: boolean;
};

export function dailySignal(data: {
  slug: string;
  now: number;
  repos: Record<string, RepoPath>;
  signals: WorkspaceSignals;
  complete: boolean;
  weeks: WeekTotals[];
  spend: number[] | null;
  quarterUsage: Usage | null;
  range: { quarter: string };
}): DailySignal {
  return {
    tiles: pulse({ slug: data.slug, weeks: data.weeks, spend: data.spend }),
    findings: findings({
      slug: data.slug,
      now: data.now,
      repos: data.repos,
      signals: data.signals,
      weeks: data.weeks,
      quarterUsage: data.quarterUsage,
      quarter: data.range.quarter,
    }),
    summary: weekSummary(data.weeks[data.weeks.length - 1]),
    days: dayBars(data.signals.days, data.now),
    complete: data.complete,
  };
}

// --- Spend threaded to the work ---------------------------------------------------

/** How much of a node's work was an agent's: 0 (none) to 4 (nearly all), the flow's five steps. */
/** How much of a flow node's work was an agent's: its pull requests', or all of it when only sessions with none cost anything. */
export function flowAgentShare(node: Pick<FlowNode, "pulls" | "agent" | "micros">): number {
  if (node.pulls > 0) return node.agent / node.pulls;
  return node.micros > 0 ? 1 : 0;
}

export function agentStep(share: number): 0 | 1 | 2 | 3 | 4 {
  if (share < 0.2) return 0;
  if (share < 0.4) return 1;
  if (share < 0.6) return 2;
  if (share < 0.8) return 3;
  return 4;
}

export type FlowPull = {
  key: string;
  repo: string;
  number: number;
  title: string;
  agent: boolean;
  /** For an agent's: why g1t says so (`SignalPull.agentRule`). */
  agentRule?: string | null;
  micros: number;
  status: SignalPull["status"];
  to: string;
};

export type FlowNode = {
  key: string;
  label: string;
  /** Where its own page is, when it has one. */
  to: string | null;
  pulls: number;
  agent: number;
  micros: number;
  /** Of `micros`, what harness sessions with no pull request cost. */
  direct: number;
  children: FlowNode[];
  /** Its pull requests, for the last level: the costliest (else newest) first. */
  list?: FlowPull[];
};

/** Nodes a column shows before the rest fold into one. */
export const FLOW_NODES = 5;
/** Pull requests listed for a change set. */
export const FLOW_PULLS = 7;

function fold(nodes: FlowNode[], label: string): FlowNode[] {
  nodes.sort((a, b) => b.micros - a.micros || b.pulls - a.pulls);
  if (nodes.length <= FLOW_NODES) return nodes;
  const rest = nodes.slice(FLOW_NODES - 1);
  const other: FlowNode = {
    key: `other:${rest.map((node) => node.key).join(",")}`.slice(0, 120),
    label,
    to: null,
    pulls: rest.reduce((sum, node) => sum + node.pulls, 0),
    agent: rest.reduce((sum, node) => sum + node.agent, 0),
    micros: rest.reduce((sum, node) => sum + node.micros, 0),
    direct: rest.reduce((sum, node) => sum + node.direct, 0),
    children: fold(
      rest.flatMap((node) => node.children),
      label,
    ),
    list: rest.flatMap((node) => node.list ?? []).slice(0, FLOW_PULLS),
  };
  return [...nodes.slice(0, FLOW_NODES - 1), other];
}

/**
 * The quarter's work as a tree: milestone, work item, the work item's
 * pull requests in each project (its change set there), and the pull
 * requests, each node with its pull requests, how many were an agent's,
 * and what the agents' usage on them came to. Work with no milestone or
 * no work item has a node of its own. What harness sessions with no pull
 * request cost goes to their work item's change set in their repository
 * (`direct`), with no pull requests of its own.
 */
export function spendFlow(ctx: Pick<SignalContext, "slug" | "repos" | "signals" | "quarterUsage" | "quarter">): FlowNode[] {
  const quarter = quarterSpend(ctx);
  const spend = quarter?.byPull ?? new Map<string, number>();
  const items = new Map(ctx.signals.items.map((item) => [item.number, item]));
  const milestones = new Map(ctx.signals.milestones.map((milestone) => [milestone.number, milestone]));
  type Build = FlowNode & { index: Map<string, Build> };
  const make = (key: string, label: string, to: string | null): Build => ({
    key,
    label,
    to,
    pulls: 0,
    agent: 0,
    micros: 0,
    direct: 0,
    children: [],
    index: new Map(),
  });
  const roots = new Map<string, Build>();
  const child = (parent: Map<string, Build>, key: string, label: string, to: string | null) => {
    let node = parent.get(key);
    if (!node) parent.set(key, (node = make(key, label, to)));
    return node;
  };
  const pathOf = (repoId: string, repo: RepoPath, itemNumber: number | null, milestoneNumber: number | null): Build[] => {
    const item = itemNumber != null ? items.get(itemNumber) : undefined;
    const milestone = milestoneNumber != null ? milestones.get(milestoneNumber) : undefined;
    const path = [
      child(roots, milestone ? `m${milestone.number}` : "m-", milestone?.title ?? "No milestone", milestone ? milestonePath(ctx.slug, milestone.number) : null),
    ];
    path.push(
      child(
        path[0]!.index,
        `${path[0]!.key}/${item ? `i${item.number}` : "i-"}`,
        item ? item.title : "No work item",
        item ? itemPath(ctx.slug, item.number) : null,
      ),
    );
    path.push(child(path[1]!.index, `${path[1]!.key}/${repoId}`, repo.name, `/${repo.namespace}/${repo.name}`));
    return path;
  };
  for (const pull of ctx.signals.pulls) {
    const repo = ctx.repos[pull.repoId];
    if (!repo) continue;
    if (pull.createdAt.slice(0, 10) < ctx.quarter && !(pull.mergedAt && pull.mergedAt.slice(0, 10) >= ctx.quarter)) continue;
    const micros = spend.get(pullKey(repo, pull.number)) ?? 0;
    const path = pathOf(pull.repoId, repo, pull.item, pull.milestone);
    for (const node of path) {
      node.pulls += 1;
      node.agent += pull.agent ? 1 : 0;
      node.micros += micros;
    }
    const set = path[2]!;
    (set.list ??= []).push({
      key: pullKey(repo, pull.number),
      repo: repo.name,
      number: pull.number,
      title: pull.title,
      agent: pull.agent,
      agentRule: pull.agentRule ?? null,
      micros,
      status: pull.status,
      to: pullPath(repo, pull.number),
    });
  }
  for (const row of quarter?.loose ?? []) {
    const item = row.item != null ? items.get(row.item) : undefined;
    for (const node of pathOf(row.repoId, ctx.repos[row.repoId]!, row.item, item?.milestone ?? null)) {
      node.micros += row.micros;
      node.direct += row.micros;
    }
  }
  const finish = (nodes: Map<string, Build>, label: string, depth: number): FlowNode[] =>
    fold(
      [...nodes.values()].map(({ index, ...node }) => ({
        ...node,
        children: depth < 2 ? finish(index, depth === 0 ? "Other work items" : "Other repositories", depth + 1) : [],
        list: node.list?.sort((a, b) => b.micros - a.micros || b.number - a.number).slice(0, FLOW_PULLS),
      })),
      label,
    );
  return finish(roots, "Other milestones", 0);
}

// --- The rhythm of the work -------------------------------------------------------

export type RhythmDay = { day: string; opened: number; merged: number; reworked: number; reviews: number; sessions: number; commits: number };

export type RhythmRow = {
  key: string;
  label: string;
  /** "3 people", or what the row is. */
  note: string;
  to: string;
  days: RhythmDay[];
  /** Everything in the fortnight, to rank and to say so. */
  total: number;
};

export type Group = { key: string; label: string; note: string; to: string; repoIds: string[] };

/** Rows of the rhythm: each group's days, quiet days too; busiest first, at most `max`. */
export function rhythm(days: SignalDay[], list: string[], groups: Group[], max = 6): RhythmRow[] {
  const rows = groups.map((group) => {
    const ids = new Set(group.repoIds);
    const byDay = new Map(list.map((day) => [day, { day, opened: 0, merged: 0, reworked: 0, reviews: 0, sessions: 0, commits: 0 }]));
    for (const row of days) {
      const day = byDay.get(row.day);
      if (!day || !ids.has(row.repoId)) continue;
      day.opened += row.opened;
      day.merged += row.merged;
      day.reworked += row.reworked;
      day.reviews += row.reviews;
      day.sessions += row.sessions;
      day.commits += row.agentCommits ?? 0;
    }
    const out = list.map((day) => byDay.get(day)!);
    const total = out.reduce((sum, day) => sum + day.opened + day.merged + day.reworked + day.reviews + day.sessions + day.commits, 0);
    return { key: group.key, label: group.label, note: group.note, to: group.to, days: out, total };
  });
  return rows
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, max);
}

/** A row's week, added up, as its hover and its line say it. */
export function rhythmSum(days: RhythmDay[]) {
  return days.reduce(
    (sum, day) => ({
      opened: sum.opened + day.opened,
      merged: sum.merged + day.merged,
      reworked: sum.reworked + day.reworked,
      reviews: sum.reviews + day.reviews,
      sessions: sum.sessions + day.sessions,
      commits: sum.commits + day.commits,
    }),
    { opened: 0, merged: 0, reworked: 0, reviews: 0, sessions: 0, commits: 0 },
  );
}

/** How a row's this week compares with its last, in a few words. */
export function rhythmLine(row: RhythmRow): string {
  const half = Math.floor(row.days.length / 2);
  const last = rhythmSum(row.days.slice(0, half));
  const now = rhythmSum(row.days.slice(half));
  const prs = (sum: ReturnType<typeof rhythmSum>) => sum.opened + sum.merged + sum.commits;
  if (prs(now) === 0 && prs(last) > 0) return "Quiet this week after a busy last week";
  if (now.reviews === 0 && now.opened > 0) return `${now.opened} opened this week, no reviews yet`;
  if (prs(now) > 1.5 * prs(last) && prs(now) >= 4) return "Busier than last week";
  if (now.reworked > Math.max(2, last.reworked * 2)) return "More rework than last week";
  return `${now.merged + now.commits} landed this week, ${last.merged + last.commits} last week`;
}

export type WaitingRow = WaitingPull & { repo: RepoPath; to: string };

/** The unreviewed pull requests with their paths, for the Workspace overview's waiting list. */
export function waitingRows(waiting: WaitingPull[], repos: Record<string, RepoPath>, max = 8): WaitingRow[] {
  return waiting
    .filter((pull) => repos[pull.repoId])
    .slice(0, max)
    .map((pull) => ({ ...pull, repo: repos[pull.repoId]!, to: pullPath(repos[pull.repoId]!, pull.number) }));
}

// --- What providers reported ------------------------------------------------------

export type ProviderQuarter = {
  /** Providers connected, with what each reported since the quarter began, the most first. */
  providers: { provider: string; micros: number }[];
  total: number;
  /** Every connection's last read worked and reaches back to the quarter. */
  complete: boolean;
};

/**
 * What the connected providers' cost reports say the organization spent
 * since `quarter` began: their whole bill, agents' work g1t sees and
 * everything else, in US dollars (a provider that reports credits, such as
 * Devin, is left out: credits aren't dollars). Null when none is connected.
 */
export function providerQuarter(costs: ProviderCosts | null, quarter: string): ProviderQuarter | null {
  // As `COST_PROVIDERS[provider].dollars` says (not imported: this file loads without the contracts' runtime).
  const dollars = (provider: string) => provider !== "devin";
  const connections = costs?.connections.filter((connection) => dollars(connection.provider)) ?? [];
  if (!costs || connections.length === 0) return null;
  const by = new Map<string, number>(connections.map((connection) => [connection.provider, 0]));
  for (const day of costs.days) {
    if (day.day >= quarter && (day.unit ?? "usd") === "usd" && by.has(day.provider)) by.set(day.provider, (by.get(day.provider) ?? 0) + day.micros);
  }
  const providers = [...by].map(([provider, micros]) => ({ provider, micros })).sort((a, b) => b.micros - a.micros);
  return { providers, total: providers.reduce((sum, row) => sum + row.micros, 0), complete: costs.complete };
}
