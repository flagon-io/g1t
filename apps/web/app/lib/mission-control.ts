/**
 * The shaping behind mission control's dashboard: why each thing needs the
 * viewer, what an agent already knows about it, the three tabs, the week
 * split into what agents landed alone and what a person merged, and the
 * one sentence under the greeting. Pure, so it is tested on its own; it
 * imports only types.
 */
import type { AgentRun, CheckStatus, ChangedFile, Lifecycle, RepoPath, RunKind, Stage } from "@g1t/contracts";

import type { Need } from "./mission";

const DAY = 24 * 60 * 60 * 1000;

/** Accounts that are g1t's own agents and machinery: `isAgent` in ./mission, kept here so this module imports only types. */
export function isAgent(name: string | null | undefined): boolean {
  return name === "g1t-agent" || name === "g1t" || (name ?? "").endsWith("-agent");
}

// --- Reasons ----------------------------------------------------------------

/** Why something is waiting on a person, as the chip beside it says. */
export type Reason = "blocking" | "asked_for_you" | "checks_failing" | "outside_guardrails" | "needs_review" | "stalled" | "ready_to_merge";

export const REASON_LABEL: Record<Reason, string> = {
  blocking: "Blocking",
  asked_for_you: "Asked for you",
  checks_failing: "Checks failing",
  outside_guardrails: "Outside guardrails",
  needs_review: "Needs review",
  stalled: "Stalled",
  ready_to_merge: "Ready to merge",
};

/**
 * The reason a need is shown, from its kind and, for a pull request g1t
 * stopped seeing through, the sentence it stopped with.
 */
export function reasonFor(need: Pick<Need, "kind" | "detail">): Reason {
  switch (need.kind) {
    case "limit":
    case "deploy":
    case "conflict":
      return "blocking";
    case "invitation":
    case "review":
      return "asked_for_you";
    case "checks":
      return "checks_failing";
    case "ready":
      return "ready_to_merge";
    case "stuck":
      return "stalled";
    case "stalled":
      return stallReason(need.detail);
  }
}

/** What a pull request's `needs_you` sentence says it is waiting for. */
export function stallReason(detail: string): Reason {
  if (/cost cap|time cap|unusual CPU/i.test(detail)) return "outside_guardrails";
  if (/conflict|could not (?:be )?merge/i.test(detail)) return "blocking";
  if (/checks? (?:still )?fail|still fails|could not be run/i.test(detail)) return "checks_failing";
  if (/approv|asked for changes|review (?:still|could not)/i.test(detail)) return "needs_review";
  return "stalled";
}

/** Why only a person can move it: the callout beside what the agent knows. */
export function whyFor(reason: Reason, need: Pick<Need, "kind" | "detail">): string {
  if (need.kind === "limit") return "Agents start nothing new past the workspace's usage limit. Only an owner can raise it or add a card.";
  if (need.kind === "deploy")
    return "Production still serves the build before this one. Every push to the default branch builds again, so this fails until what broke is fixed.";
  if (need.kind === "invitation") return "An invitation is to you. No one else can accept it.";
  if (need.kind === "review") return "You were asked to review it by name, so it waits for your verdict.";
  if (need.kind === "stuck")
    return "A running agent has stopped reporting. It may be working on something long, or stuck; a look at its session tells which.";
  switch (reason) {
    case "outside_guardrails":
      return "The run reached a limit set in Guardrails. g1t does not lift a cap on its own; a person raises it, then asks for the next step.";
    case "blocking":
      return "g1t could not land it and stopped rather than guess. A person decides how it lands, or whether it should.";
    case "checks_failing":
      return "The agent revised and the checks still fail, so g1t stopped sending it back instead of looping. Guide it, fix it yourself, or close it.";
    case "needs_review":
      return "This repository wants a person's verdict before it lands, and the agent has done what it can without one.";
    case "ready_to_merge":
      return "Checks passed and it was approved. This repository lands a change only when a person merges it.";
    case "stalled":
      return "The agent stopped and g1t does not start it again on its own. Ask for a review, a revision or a catch-up, or close it.";
    case "asked_for_you":
      return "It was put to you by name.";
  }
}

/** Reasons where nothing moves until a person acts on it. */
export const BLOCKING: ReadonlySet<Reason> = new Set<Reason>(["blocking"]);

// --- What the agent knows ---------------------------------------------------

export type FactTone = "good" | "warn" | "bad" | null;
export type Fact = { label: string; value: string; tone: FactTone };

const CHECKS: Record<CheckStatus, { text: string; tone: FactTone }> = {
  passed: { text: "Passed", tone: "good" },
  failed: { text: "Failing", tone: "bad" },
  errored: { text: "Could not run", tone: "bad" },
  running: { text: "Running", tone: null },
  queued: { text: "Queued", tone: null },
};

/** Test files, by the names test runners look for. */
export function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)\//i.test(path) || /[._-](test|spec)\.[a-z0-9]+$/i.test(path) || /_test\.(go|rs|py)$/i.test(path);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "$0.42", or "<$0.01" for a sliver. */
export function usd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/**
 * What is known about a pull request without opening it: its checks, how
 * much it changes, the tests it touches, how often the agent was sent back,
 * and what its runs cost. Only what is known is listed.
 */
export function pullFacts(input: {
  checkStatus: CheckStatus | null;
  files: ChangedFile[];
  lifecycle?: Pick<Lifecycle, "revisions"> | null;
  runs?: Pick<AgentRun, "costUsd" | "kind">[];
}): Fact[] {
  const facts: Fact[] = [];
  const checks = input.checkStatus ? CHECKS[input.checkStatus] : null;
  facts.push({ label: "Checks", value: checks?.text ?? "Not run", tone: checks?.tone ?? null });
  if (input.files.length > 0) {
    const added = input.files.reduce((sum, f) => sum + f.additions, 0);
    const removed = input.files.reduce((sum, f) => sum + f.deletions, 0);
    facts.push({ label: "Files changed", value: input.files.length.toLocaleString("en-US"), tone: null });
    facts.push({ label: "Lines", value: `+${added.toLocaleString("en-US")} −${removed.toLocaleString("en-US")}`, tone: null });
    const tests = input.files.filter((f) => isTestFile(f.path)).length;
    facts.push({ label: "Tests", value: tests > 0 ? plural(tests, "file") : "None touched", tone: tests > 0 ? "good" : "warn" });
  }
  if (input.lifecycle && input.lifecycle.revisions > 0) {
    facts.push({
      label: "Sent back",
      value: plural(input.lifecycle.revisions, "time"),
      tone: input.lifecycle.revisions > 1 ? "warn" : null,
    });
  }
  const agentRuns = (input.runs ?? []).filter((run) => run.kind !== "checks" && run.kind !== "queue" && run.kind !== "mergecheck");
  if (agentRuns.length > 0) {
    const costs = agentRuns.filter((run) => run.costUsd != null);
    const cost = costs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
    facts.push({
      label: "Agent runs",
      value: costs.length > 0 ? `${agentRuns.length} · ${usd(cost)}` : String(agentRuns.length),
      tone: null,
    });
  }
  return facts;
}

// --- Rows -------------------------------------------------------------------

/** Someone or something on a row: an agent, a person, or g1t itself. */
export type Who = { name: string; agent: boolean };

export const who = (name: string | null | undefined): Who | null => (name ? { name, agent: isAgent(name) } : null);

/** A form on mission control that acts without leaving it. */
export type QuickAction = { label: string; to: string; fields: Record<string, string>; done: string };

/** One thing that needs the viewer, with what is known about it. */
export type NeedRow = {
  key: string;
  reason: Reason;
  repo: RepoPath | null;
  /** "#41", when it is an issue or pull request. */
  ref: string | null;
  title: string;
  /** The ask, in one sentence. */
  ask: string;
  /** Who is waiting: the agent on it, or the person who asked. */
  by: Who | null;
  /** The person who started it, when an agent did the work. */
  for: string | null;
  at: number;
  to: string;
  open: string;
  facts: Fact[];
  why: string;
  quick: QuickAction | null;
  /** Somewhere else to act, when that is the next step. */
  link: { label: string; to: string } | null;
};

/** The agents' stages a pull request can wait in, as their chips say them. */
export const STAGE_CHIP: Record<Exclude<Stage, "needs_you" | "ready">, string> = {
  working: "Working",
  checking: "Checking",
  reviewing: "Reviewing",
  revising: "Revising",
  catching_up: "Catching up",
  answering: "Answering",
  queued: "In queue",
};

/** A run's kind, as its chip says it. */
export const RUN_LABEL: Record<RunKind, string> = {
  implement: "Working",
  revise: "Revising",
  review: "Reviewing",
  answer: "Answering",
  update: "Catching up",
  plan: "Planning",
  checks: "Checking",
  queue: "In queue",
  mergecheck: "Checking",
};

/** Something agents are doing, which the viewer can leave to them. */
export type WaitingRow = {
  key: string;
  repo: RepoPath;
  ref: string | null;
  title: string;
  chip: string;
  detail: string;
  by: Who | null;
  at: number;
  to: string;
  /** Whether a run is going on it right now. */
  live: boolean;
  /** The run going on it, to watch. */
  run: string | null;
  facts: Fact[];
};

const pathKey = (repo: RepoPath, number: number | null) => `${repo.namespace}/${repo.name}#${number ?? "-"}`.toLowerCase();

/**
 * What is in agents' hands: pull requests in an agent's stage, runs going
 * now, and drafts agents are still making. Each once, and nothing that is
 * already waiting on the viewer.
 */
export function waitingRows(input: {
  active: {
    pull: { number: number; title: string; agent: string; updatedAt: string; checkStatus: CheckStatus | null; files: ChangedFile[] };
    lifecycle: Lifecycle | null;
    repo: RepoPath;
  }[];
  live: Pick<
    AgentRun,
    "id" | "repo" | "number" | "title" | "kind" | "agent" | "step" | "costUsd" | "startedAt" | "createdAt" | "updatedAt"
  >[];
  drafts: {
    number: number;
    title: string;
    agent: string;
    updatedAt: string;
    checkStatus: CheckStatus | null;
    files: ChangedFile[];
    repo: RepoPath;
  }[];
  needKeys: ReadonlySet<string>;
}): WaitingRow[] {
  const rows = new Map<string, WaitingRow>();
  for (const { pull, lifecycle, repo } of input.active) {
    if (!lifecycle || lifecycle.stage === "needs_you" || lifecycle.stage === "ready") continue;
    const key = pathKey(repo, pull.number);
    if (input.needKeys.has(key)) continue;
    rows.set(key, {
      key,
      repo,
      ref: `#${pull.number}`,
      title: pull.title,
      chip: STAGE_CHIP[lifecycle.stage],
      detail: lifecycle.detail,
      by: who(pull.agent),
      at: Date.parse(pull.updatedAt),
      to: `/${repo.namespace}/${repo.name}/pull/${pull.number}`,
      live: false,
      run: null,
      facts: pullFacts({ checkStatus: pull.checkStatus, files: pull.files, lifecycle }),
    });
  }
  for (const run of input.live) {
    const key = run.number != null ? pathKey(run.repo, run.number) : `run:${run.id}`;
    if (input.needKeys.has(key)) continue;
    const runTo = `/${run.repo.namespace}/${run.repo.name}/agents/runs/${run.id}`;
    const existing = rows.get(key);
    const started = Date.parse(run.startedAt ?? run.createdAt);
    const runFacts: Fact[] = [
      { label: "Run", value: RUN_LABEL[run.kind], tone: null },
      ...(run.costUsd != null ? [{ label: "Cost so far", value: usd(run.costUsd), tone: null }] : []),
    ];
    if (existing) {
      existing.live = true;
      existing.run = runTo;
      if (run.step) existing.detail = run.step;
      existing.facts = [...runFacts, ...existing.facts.filter((f) => f.label !== "Run")];
      existing.at = Math.max(existing.at, Date.parse(run.updatedAt));
      continue;
    }
    rows.set(key, {
      key,
      repo: run.repo,
      ref: run.number != null ? `#${run.number}` : null,
      title: run.title ?? `${RUN_LABEL[run.kind]} in ${run.repo.name}`,
      chip: RUN_LABEL[run.kind],
      detail: run.step ?? "Starting.",
      by: who(run.agent),
      at: Number.isFinite(started) ? started : Date.parse(run.updatedAt),
      to: runTo,
      live: true,
      run: runTo,
      facts: runFacts,
    });
  }
  for (const draft of input.drafts) {
    const key = pathKey(draft.repo, draft.number);
    if (rows.has(key) || input.needKeys.has(key) || !isAgent(draft.agent)) continue;
    rows.set(key, {
      key,
      repo: draft.repo,
      ref: `#${draft.number}`,
      title: draft.title,
      chip: "Working",
      detail: `${draft.agent} is making the change.`,
      by: who(draft.agent),
      at: Date.parse(draft.updatedAt),
      to: `/${draft.repo.namespace}/${draft.repo.name}/pull/${draft.number}`,
      live: false,
      run: null,
      facts: pullFacts({ checkStatus: draft.checkStatus, files: draft.files }),
    });
  }
  // Running now first, then what moved most recently.
  return [...rows.values()].sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at);
}

/** The key a need is known by when matching it to agents' work. */
export const needPathKey = pathKey;

// --- Landed -----------------------------------------------------------------

/** A merged pull request, as the week counts it. */
export type Merged = {
  repo: RepoPath;
  number: number;
  title: string;
  agent: string;
  mergedBy: string | null;
  mergedAt: string;
  files: ChangedFile[];
};

/**
 * Whether a change landed without a person: g1t merged it, by auto-merge or
 * from the merge queue, rather than someone pressing merge.
 */
export function landedByAgents(change: Pick<Merged, "mergedBy">): boolean {
  return change.mergedBy == null || isAgent(change.mergedBy);
}

/** A day's date in a time zone, as `YYYY-MM-DD`; UTC when the zone is unknown. */
export function dayKey(at: number, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timeZone || "UTC" }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export type WeekDay = { key: string; label: string; agents: number; people: number };

export type Week = {
  days: WeekDay[];
  /** Changes landed in the last seven days, and how many without a person. */
  total: number;
  byAgents: number;
  /** The seven days before, or null when the lists read do not reach back that far. */
  previous: number | null;
};

/**
 * The last seven days in the viewer's zone, oldest first, each split into
 * what agents landed alone and what a person merged, and the week before
 * as one number. `complete` says whether what was read reaches back two
 * weeks; when it does not, the week before is not guessed.
 */
export function weekOf(changes: Pick<Merged, "mergedAt" | "mergedBy">[], now: number, timeZone: string | null, complete = true): Week {
  const days: WeekDay[] = [];
  const index = new Map<string, number>();
  for (let back = 6; back >= 0; back -= 1) {
    const at = now - back * DAY;
    const key = dayKey(at, timeZone);
    if (index.has(key)) continue;
    index.set(key, days.length);
    let label: string;
    try {
      label = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timeZone || "UTC" }).format(at);
    } catch {
      label = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(at);
    }
    days.push({ key, label, agents: 0, people: 0 });
  }
  const oldest = days[0]?.key ?? "";
  const twoWeeks = dayKey(now - 13 * DAY, timeZone);
  let previous = 0;
  for (const change of changes) {
    const at = Date.parse(change.mergedAt);
    if (!Number.isFinite(at) || at > now) continue;
    const key = dayKey(at, timeZone);
    const slot = index.get(key);
    if (slot != null) {
      if (landedByAgents(change)) days[slot].agents += 1;
      else days[slot].people += 1;
    } else if (key < oldest && key >= twoWeeks) {
      previous += 1;
    }
  }
  const byAgents = days.reduce((sum, day) => sum + day.agents, 0);
  const total = byAgents + days.reduce((sum, day) => sum + day.people, 0);
  return { days, total, byAgents, previous: complete ? previous : null };
}

/** The change from one number to another, as a share; null from nothing. */
export function change(current: number, previous: number | null): number | null {
  if (previous == null || previous === 0) return null;
  return (current - previous) / previous;
}

/** "+18%", "−5%", "0%". */
export function signedPercent(share: number): string {
  const n = Math.round(share * 100);
  return n > 0 ? `+${n}%` : n < 0 ? `−${Math.abs(n)}%` : "0%";
}

/**
 * Whether the merged pull requests read for one repository reach back to
 * `since`: the list is not full, or its oldest goes back that far.
 */
export function reachesBack(list: { mergedAt: string | null; updatedAt: string }[], since: number, page: number): boolean {
  if (list.length < page) return true;
  const oldest = Math.min(...list.map((pull) => Date.parse(pull.mergedAt ?? pull.updatedAt)).filter(Number.isFinite));
  return oldest <= since;
}

/** One change that landed, as the third tab lists it. */
export type LandedRow = {
  key: string;
  repo: RepoPath;
  ref: string;
  title: string;
  by: Who | null;
  agent: string;
  byAgents: boolean;
  at: number;
  to: string;
  facts: Fact[];
};

/** What landed on the viewer's calendar day, newest first. */
export function landedToday(changes: Merged[], now: number, timeZone: string | null): LandedRow[] {
  const today = dayKey(now, timeZone);
  return changes
    .filter((change) => dayKey(Date.parse(change.mergedAt), timeZone) === today)
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .map((change) => ({
      key: pathKey(change.repo, change.number),
      repo: change.repo,
      ref: `#${change.number}`,
      title: change.title,
      by: who(change.mergedBy ?? "g1t"),
      agent: change.agent,
      byAgents: landedByAgents(change),
      at: Date.parse(change.mergedAt),
      to: `/${change.repo.namespace}/${change.repo.name}/pull/${change.number}`,
      facts: pullFacts({ checkStatus: "passed", files: change.files }).filter((fact) => fact.label !== "Checks"),
    }));
}

// --- Tabs and sorting -------------------------------------------------------

export type Tab = "needs" | "waiting" | "landed";
export type Sort = "impact" | "newest";

export const TABS: Tab[] = ["needs", "waiting", "landed"];

export function parseTab(value: string | null): Tab | null {
  return value === "needs" || value === "waiting" || value === "landed" ? value : null;
}

export function parseSort(value: string | null): Sort {
  return value === "newest" ? "newest" : "impact";
}

/** Rows in the order chosen: as ranked (most urgent first), or newest first. */
export function sortRows<T extends { at: number }>(rows: T[], sort: Sort): T[] {
  return sort === "newest" ? [...rows].sort((a, b) => b.at - a.at) : rows;
}

// --- The summary ------------------------------------------------------------

/** The sentence under the greeting: the week, honestly, in one line. */
export function summaryLine(input: { total: number; byAgents: number; live: number; needs: number }): string {
  const { total, byAgents, live, needs } = input;
  if (total > 0) {
    const landed =
      byAgents === total
        ? `Agents landed all ${plural(total, "change")} this week without you.`
        : byAgents === 0
          ? `${plural(total, "change")} landed this week, each merged by a person.`
          : `Agents landed ${byAgents} of ${plural(total, "change")} this week without you.`;
    return landed;
  }
  if (live > 0) return `${plural(live, "agent is", "agents are")} at work. Nothing has landed this week yet.`;
  if (needs > 0) return "Nothing has landed this week. What is waiting on you is below.";
  return "Nothing has landed this week yet. Assign an issue to g1t-agent and it starts in seconds.";
}

/** "Monday, Oct 5", in the viewer's zone. */
export function dateLine(now: number, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = { weekday: "long", month: "short", day: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timeZone || "UTC" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(now);
  }
}
