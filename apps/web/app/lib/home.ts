/**
 * Home, the workspace's front page: where you're needed now, what happened
 * since you were last here, and what is running. It never depends on the
 * calendar: what needs you has no time window, and what happened is
 * counted over a span you choose, since your last visit by default. Every
 * number is worked out here from what the services return, so each
 * definition is tested on its own (home.test.ts) and written down in the
 * Home guide (apps/docs/.../guides/home.md). Imports only types.
 */
import type {
  AgentSession,
  AgentSessionKind,
  Deployment,
  InboxItem,
  InstallRequest,
  Memory,
  ProjectDeploys,
  Pull,
  RepoPath,
  Statement,
} from "@g1t/contracts";

import { money } from "./money.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A day's date in a time zone, as `YYYY-MM-DD`; UTC when the zone is unknown or invalid. */
export function dayIn(at: number, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timeZone || "UTC" }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** The hour of the day (0–23) in a time zone; UTC when it is unknown. */
export function hourIn(at: number, timeZone: string | null): number {
  const read = (zone: string) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: zone }).format(at)) % 24;
  try {
    return read(timeZone || "UTC");
  } catch {
    return read("UTC");
  }
}

function formatIn(at: number, timeZone: string | null, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timeZone || "UTC" }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at);
  }
}

/** "Oct 9", in the reader's time zone. */
export function shortDate(at: number, timeZone: string | null): string {
  return formatIn(at, timeZone, { month: "short", day: "numeric" });
}

// --- The span -----------------------------------------------------------------

/** Which span "what happened" covers: since your last visit, or a fixed one. */
export type WindowKey = "last" | "24h" | "7d";

export const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: "last", label: "Since last visit" },
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
];

/** The furthest back "since your last visit" looks. */
export const MAX_AWAY_DAYS = 14;

/** A `?window=` value, or the default: since your last visit. */
export function parseWindow(value: string | null | undefined): WindowKey {
  return value === "24h" || value === "7d" ? value : "last";
}

export type Span = {
  key: WindowKey;
  /** Epoch ms: the start of the span. */
  from: number;
  now: number;
  /** "Since Tuesday evening", "In the last 24 hours". */
  words: string;
  /** How long it covers: "3 days", "45 minutes". */
  length: string;
  /**
   * Why "since your last visit" covers something else: `first` when there
   * is no visit on record (it shows the last 24 hours), `capped` when the
   * last one was longer ago than MAX_AWAY_DAYS, `unknown` when it could
   * not be read (it shows the last 24 hours).
   */
  note: "first" | "capped" | "unknown" | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** How long a stretch of time is, roughly: "a moment", "40 minutes", "3 hours", "3 days", "2 weeks". */
export function duration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return "a moment";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 14) return plural(days, "day");
  return plural(Math.floor(days / 7), "week");
}

type Part = "night" | "morning" | "afternoon" | "evening";

/**
 * When `from` was, in words, from `now`: "a moment ago", "40 minutes ago",
 * "2 hours ago", "this morning", "last night", "yesterday evening",
 * "Tuesday evening", "Oct 2". The small hours belong to the night before:
 * 2 a.m. on Wednesday is Tuesday night.
 */
export function sinceWords(from: number, now: number, timeZone: string | null): string {
  const ago = now - from;
  if (ago < MINUTE) return "a moment ago";
  if (ago < HOUR) return `${plural(Math.floor(ago / MINUTE), "minute")} ago`;
  if (ago < 3 * HOUR) return Math.floor(ago / HOUR) === 1 ? "an hour ago" : `${Math.floor(ago / HOUR)} hours ago`;
  const hour = hourIn(from, timeZone);
  const part: Part = hour < 5 ? "night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  // The night is the evening's day's.
  const day = dayIn(part === "night" ? from - 6 * HOUR : from, timeZone);
  const today = dayIn(now, timeZone);
  const yesterday = dayIn(now - DAY, timeZone);
  const twoDaysAgo = dayIn(now - 2 * DAY, timeZone);
  if (day === today) return `this ${part === "night" ? "evening" : part}`;
  if (day === yesterday) return part === "night" ? "last night" : `yesterday ${part}`;
  if (part === "night" && day === twoDaysAgo) return "the night before last";
  if (ago < 6 * DAY) return `${formatIn(part === "night" ? from - 6 * HOUR : from, timeZone, { weekday: "long" })} ${part}`;
  return shortDate(from, timeZone);
}

/**
 * The span for `key`: since `lastSeen` (your last visit, kept by notify),
 * or the last 24 hours or 7 days. Since your last visit falls back to the
 * last 24 hours when there is none (`null`) or it could not be read
 * (`undefined`), and to MAX_AWAY_DAYS when it was longer ago.
 */
export function spanFor(key: WindowKey, now: number, lastSeen: number | null | undefined, timeZone: string | null): Span {
  if (key === "7d") return { key, from: now - 7 * DAY, now, words: "In the last 7 days", length: "7 days", note: null };
  if (key === "24h" || lastSeen == null || lastSeen > now) {
    const note = key !== "last" ? null : lastSeen === undefined ? "unknown" : "first";
    return { key, from: now - DAY, now, words: "In the last 24 hours", length: "24 hours", note };
  }
  const furthest = now - MAX_AWAY_DAYS * DAY;
  if (lastSeen < furthest) return { key, from: furthest, now, words: `In the last ${MAX_AWAY_DAYS} days`, length: `${MAX_AWAY_DAYS} days`, note: "capped" };
  return { key, from: lastSeen, now, words: `Since ${sinceWords(lastSeen, now, timeZone)}`, length: duration(now - lastSeen), note: null };
}

/** Whether `at` (epoch ms or RFC 3339) falls in the span. */
export function within(at: number | string | null | undefined, span: Pick<Span, "from" | "now">): boolean {
  if (at == null) return false;
  const ms = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(ms) && ms >= span.from && ms <= span.now;
}

// --- Agent work in the span ---------------------------------------------------

/**
 * How one piece of agent work that settled in the span went:
 * - `accepted`: an agent's pull request merged without the agent being sent back to revise it.
 * - `fixed`: an agent's pull request merged after one or more revisions.
 * - `finished`: an agent session that finished. Sessions are not reviewed, so they are never `accepted`.
 * - `dropped`: an agent's pull request closed without merging, or a session that failed or was stopped.
 * Work still going is not here: it is under Running now.
 */
export type TaskOutcome = "accepted" | "fixed" | "finished" | "dropped";

/** Where a task came from. */
export type TaskSource = "chat" | "schedule" | "colleague" | "code";

export const OUTCOME_LABEL: Record<TaskOutcome, string> = {
  accepted: "Accepted first time",
  fixed: "Fixed after review",
  finished: "Sessions finished",
  dropped: "Didn't finish",
};

export const SOURCE_LABEL: Record<TaskSource, string> = {
  chat: "Chat",
  schedule: "Schedules",
  colleague: "Another agent",
  code: "Code",
};

/** One mark on the strip. */
export type WorkTask = {
  key: string;
  outcome: TaskOutcome;
  source: TaskSource;
  /** Null for a session in a conversation the viewer is not in. */
  title: string | null;
  to: string | null;
  /** When it settled: the strip's order. */
  at: number;
};

/** A pull request with where it is: what Home reads from Code. */
export type CodePull = Pick<Pull, "number" | "title" | "status" | "mergedAt" | "createdAt" | "updatedAt"> & {
  repo: RepoPath;
  author: { username: string; kind?: string };
  /** Who merged it, when it merged. */
  mergedBy?: string | null;
};

/** Whether a pull request is an agent's change: g1t made it, or an agent account opened it. */
export function isAgentPull(pull: { author: { username: string; kind?: string } }): boolean {
  const name = pull.author.username;
  return pull.author.kind === "agent" || name === "g1t" || name.endsWith("-agent");
}

/** `acme/web#12`, lowercase: how a pull request and its runs are matched. */
export function pullKey(repo: RepoPath, number: number): string {
  return `${repo.namespace}/${repo.name}#${number}`.toLowerCase();
}

/**
 * How an agent's pull request settled in the span, or null when it did not
 * settle in it. `revisions` counts its `revise` runs: each time g1t sent
 * the agent back for failed checks or a review.
 */
export function pullOutcome(pull: CodePull, revisions: number, span: Pick<Span, "from" | "now">): TaskOutcome | null {
  if (pull.status === "merged") return within(pull.mergedAt, span) ? (revisions > 0 ? "fixed" : "accepted") : null;
  if (pull.status === "closed") return within(pull.updatedAt, span) ? "dropped" : null;
  return null;
}

const LIVE: ReadonlySet<string> = new Set(["queued", "working", "waiting", "needs_approval"]);

/**
 * How a session settled in the span, or null. Only a session at the root
 * of its tree counts: the subagents and colleagues it brought in are part
 * of its task.
 */
export function sessionOutcome(
  session: Pick<AgentSession, "parent_id" | "status" | "updated_at" | "finished_at">,
  span: Pick<Span, "from" | "now">,
): TaskOutcome | null {
  if (session.parent_id || LIVE.has(session.status)) return null;
  if (!within(session.finished_at ?? session.updated_at, span)) return null;
  return session.status === "done" ? "finished" : "dropped";
}

export function sessionSource(kind: AgentSessionKind): TaskSource {
  return kind === "routine" ? "schedule" : kind === "chat" ? "chat" : "colleague";
}

/** The agents' work that settled in the span, and how the 7 days before it compare. */
export type SpanWork = {
  tasks: WorkTask[];
  counts: Record<TaskOutcome, number>;
  /** Tasks by where they came from, most first; only sources with any. */
  sources: { source: TaskSource; count: number }[];
  /**
   * Accepted first time: of the agents' pull requests that merged or closed
   * in the span, the share that merged without a revision. Null with none.
   */
  rate: { value: number; of: number } | null;
  /** The same share over the 7 days before the span; null when there were none, or they could not all be read. */
  before: { value: number; of: number } | null;
  /** Whether Code was read: false for a member without Code access, or when Code did not answer. */
  code: "read" | "no_access" | "unavailable";
  /** Whether sessions were read. */
  sessions: "read" | "unavailable";
  /** True when a list was cut short before the start of the span, so some work may be missing. */
  partial: boolean;
};

export type CodeWork = {
  pulls: CodePull[];
  /** `revise` runs per pull request (`pullKey`). */
  revisions: Record<string, number>;
  /** Whether every list read reached back to 7 days before the span. */
  complete: boolean;
};

export type SessionWork = { sessions: AgentSession[]; complete: boolean };

/** Accepted first time over a set of settled outcomes: null when no pull request settled. */
export function acceptance(outcomes: TaskOutcome[]): { value: number; of: number } | null {
  const settled = outcomes.filter((o) => o === "accepted" || o === "fixed" || o === "dropped");
  if (settled.length === 0) return null;
  return { value: settled.filter((o) => o === "accepted").length / settled.length, of: settled.length };
}

export function spanWork(input: {
  span: Pick<Span, "from" | "now">;
  slug: string;
  code: CodeWork | null | "no_access";
  sessions: SessionWork | null;
}): SpanWork {
  const { span, slug } = input;
  const tasks: WorkTask[] = [];
  let before: SpanWork["before"] = null;
  const code = input.code;
  if (code && code !== "no_access") {
    const prior = { from: span.from - 7 * DAY, now: span.from - 1 };
    const earlier: TaskOutcome[] = [];
    for (const pull of code.pulls) {
      if (!isAgentPull(pull)) continue;
      const revisions = code.revisions[pullKey(pull.repo, pull.number)] ?? 0;
      const to = `/${pull.repo.namespace}/${pull.repo.name}/pull/${pull.number}`;
      const outcome = pullOutcome(pull, revisions, span);
      if (outcome) {
        const at = Date.parse(pull.status === "merged" && pull.mergedAt ? pull.mergedAt : pull.updatedAt);
        tasks.push({ key: `pull:${pullKey(pull.repo, pull.number)}`, outcome, source: "code", title: pull.title, to, at });
        continue;
      }
      const then = pullOutcome(pull, revisions, prior);
      if (then) earlier.push(then);
    }
    before = code.complete ? acceptance(earlier) : null;
  }
  for (const session of input.sessions?.sessions ?? []) {
    const outcome = sessionOutcome(session, span);
    if (!outcome) continue;
    tasks.push({
      key: `session:${session.id}`,
      outcome,
      source: sessionSource(session.kind),
      title: session.visible ? session.title : null,
      to: `/${slug}/-/agents/${session.agent_handle}/sessions/${session.id}`,
      at: Date.parse(session.finished_at ?? session.updated_at),
    });
  }
  // In the order they settled.
  tasks.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const counts: Record<TaskOutcome, number> = { accepted: 0, fixed: 0, finished: 0, dropped: 0 };
  const bySource = new Map<TaskSource, number>();
  for (const task of tasks) {
    counts[task.outcome]++;
    bySource.set(task.source, (bySource.get(task.source) ?? 0) + 1);
  }
  const sourceOrder: TaskSource[] = ["chat", "code", "schedule", "colleague"];
  return {
    tasks,
    counts,
    sources: [...bySource]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count || sourceOrder.indexOf(a.source) - sourceOrder.indexOf(b.source)),
    rate: acceptance(tasks.filter((t) => t.source === "code").map((t) => t.outcome)),
    before,
    code: code === "no_access" ? "no_access" : code ? "read" : "unavailable",
    sessions: input.sessions ? "read" : "unavailable",
    partial: (code != null && code !== "no_access" && !code.complete) || (input.sessions != null && !input.sessions.complete),
  };
}

/** The change in percentage points from the 7 days before, rounded: "+6 pts vs the 7 days before", "Same as the 7 days before". */
export function trendLabel(rate: { value: number } | null, before: { value: number } | null): string | null {
  if (!rate || !before) return null;
  const points = Math.round(rate.value * 100) - Math.round(before.value * 100);
  if (points === 0) return "Same as the 7 days before";
  return `${points > 0 ? "+" : "−"}${Math.abs(points)} pts vs the 7 days before`;
}

// --- What else happened in the span -------------------------------------------

/** A change that landed: a pull request merged, by a person or an agent. */
export type LandedChange = {
  key: string;
  title: string;
  repo: RepoPath;
  number: number;
  to: string;
  at: number;
  /** An agent's change, or a person's. */
  agent: boolean;
  author: string;
  mergedBy: string | null;
};

/** Every pull request that merged in the span, newest first. */
export function landedIn(pulls: CodePull[], span: Pick<Span, "from" | "now">): LandedChange[] {
  return pulls
    .filter((pull) => pull.status === "merged" && within(pull.mergedAt, span))
    .map((pull) => ({
      key: `landed:${pullKey(pull.repo, pull.number)}`,
      title: pull.title,
      repo: pull.repo,
      number: pull.number,
      to: `/${pull.repo.namespace}/${pull.repo.name}/pull/${pull.number}`,
      at: Date.parse(pull.mergedAt!),
      agent: isAgentPull(pull),
      author: pull.author.username,
      mergedBy: pull.mergedBy ?? null,
    }))
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** A build that finished in the span. */
export type DeployRow = {
  key: string;
  project: string;
  kind: Deployment["kind"];
  /** `live`: built and served (it may have been replaced since); `failed`: it did not build. */
  outcome: "live" | "failed";
  commit: string;
  branch: string | null;
  at: number;
  to: string;
  by: string;
};

/**
 * Builds that finished in the span, newest first: production builds each,
 * and previews too. A build that went live and was replaced since still
 * went live. Skipped builds are left out.
 */
export function deploysIn(projects: { slug: string; deployments: Deployment[] }[], workspace: string, span: Pick<Span, "from" | "now">): DeployRow[] {
  const rows: DeployRow[] = [];
  for (const project of projects) {
    for (const deploy of project.deployments) {
      const ended = deploy.finishedAt ?? null;
      if (!within(ended, span)) continue;
      const outcome = deploy.status === "failed" ? "failed" : deploy.status === "ready" || deploy.status === "replaced" || deploy.status === "down" ? "live" : null;
      if (!outcome) continue;
      rows.push({
        key: `deploy:${project.slug}:${deploy.id}`,
        project: project.slug,
        kind: deploy.kind,
        outcome,
        commit: deploy.commit.slice(0, 7),
        branch: deploy.branch,
        at: Date.parse(ended!),
        to: `/${workspace}/${project.slug}/deployments/${deploy.id}`,
        by: deploy.createdBy,
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** A decision made in the span: one an agent or a person recorded in the workspace's memory, or a request an owner answered. */
export type DecisionRow = {
  key: string;
  text: string;
  by: string | null;
  at: number;
  to: string;
  kind: "memory" | "request";
};

export function decisionsIn(
  input: { memories: Memory[] | null; requests: InstallRequest[] | null },
  slug: string,
  span: Pick<Span, "from" | "now">,
): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (const memory of input.memories ?? []) {
    if (memory.kind !== "decision" || (memory.status != null && memory.status !== "kept") || !within(memory.createdAt, span)) continue;
    rows.push({ key: `memory:${memory.id}`, text: memory.text, by: memory.createdBy, at: Date.parse(memory.createdAt), to: `/${slug}/-/memory`, kind: "memory" });
  }
  for (const request of input.requests ?? []) {
    if (request.status === "open" || !within(request.resolved_at, span)) continue;
    rows.push({
      key: `request:${request.id}`,
      text: `${request.status === "done" ? "Added" : "Turned down"} ${request.name}, which ${request.requested_by} asked for`,
      by: request.resolved_by,
      at: Date.parse(request.resolved_at!),
      to: `/${slug}/-/marketplace/requests`,
      kind: "request",
    });
  }
  return rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

// --- Running now ----------------------------------------------------------------

/** Something going right now: a session, an agent's change, a build. */
export type RunningRow = {
  key: string;
  kind: "session" | "change" | "deploy";
  title: string;
  /** One line: who and where. */
  detail: string;
  /** "Working", "Queued", "Building". */
  status: string;
  /** Epoch ms: when it started. */
  at: number;
  to: string;
};

const SESSION_STATUS: Record<string, string> = { queued: "Queued", working: "Working", waiting: "Waiting on its helpers" };

/** Live sessions at the root of their tree; one stopped at its cap waits on a person and is under Needs you instead. */
export function runningSessions(sessions: AgentSession[], slug: string): RunningRow[] {
  return sessions
    .filter((session) => !session.parent_id && SESSION_STATUS[session.status])
    .map((session) => ({
      key: `session:${session.id}`,
      kind: "session" as const,
      title: session.visible ? session.title : "A session in a conversation you're not in",
      detail: `@${session.agent_handle}${session.channel_name ? ` in #${session.channel_name}` : ""}`,
      status: SESSION_STATUS[session.status]!,
      at: Date.parse(session.created_at),
      to: `/${slug}/-/agents/${session.agent_handle}/sessions/${session.id}`,
    }));
}

/** Mission control's "waiting on agents" row, as Home reads it (lib/mission-control.ts `WaitingRow`). */
export type AgentChange = { key: string; repo: RepoPath; ref: string | null; title: string; chip: string; by: { name: string } | null; at: number; to: string };

export function runningChanges(changes: AgentChange[]): RunningRow[] {
  return changes.map((change) => ({
    key: `change:${change.key}`,
    kind: "change" as const,
    title: change.title,
    detail: `${change.by ? `@${change.by.name} · ` : ""}${change.repo.namespace}/${change.repo.name}${change.ref ? ` ${change.ref}` : ""}`,
    status: change.chip,
    at: change.at,
    to: change.to,
  }));
}

/** Builds queued or going now, one per project (its newest). */
export function runningDeploys(overview: ProjectDeploys[], slug: string): RunningRow[] {
  return overview.flatMap((project) => {
    const latest = project.latest;
    if (!latest || (latest.status !== "queued" && latest.status !== "building")) return [];
    return [
      {
        key: `deploy:${project.slug}:${latest.id}`,
        kind: "deploy" as const,
        title: `${latest.kind === "production" ? "Production" : `Preview of ${latest.branch ?? "a branch"}`} of ${project.slug}`,
        detail: `${latest.commit.slice(0, 7)} · by ${latest.createdBy}`,
        status: latest.status === "queued" ? "Queued" : "Building",
        at: Date.parse(latest.createdAt),
        to: `/${slug}/${project.slug}/deployments/${latest.id}`,
      },
    ];
  });
}

/** Everything running, longest-going first within each kind: sessions, then changes, then builds. */
export function running(parts: RunningRow[][]): RunningRow[] {
  const order = { session: 0, change: 1, deploy: 2 } as const;
  return parts.flat().sort((a, b) => order[a.kind] - order[b.kind] || a.at - b.at || a.key.localeCompare(b.key));
}

// --- Needs you ------------------------------------------------------------------

/**
 * What a row is. Tiers, most pressing first:
 * 0. production is down to an older build (`deploy`), or the workspace's agents used up its agent budget (`limit`);
 * 1. agent work that has stopped and can't go on without you;
 * 2. finished work waiting only for you (merge, review, an invitation, an agent asking, a request to add something);
 * 3. something stuck that may need a look;
 * 4. an unread notification that is a warning or a failure;
 * 5. a mention or a direct message.
 */
export type AttentionKind =
  | "limit"
  | "deploy"
  | "session_cap"
  | "agent_budget"
  | "pull_blocked"
  | "ready"
  | "review"
  | "invitation"
  | "install_request"
  | "agent_waiting"
  | "stuck"
  | "runner"
  | "notification"
  | "chat";

export const TIER: Record<AttentionKind, number> = {
  limit: 0,
  deploy: 0,
  session_cap: 1,
  agent_budget: 1,
  pull_blocked: 1,
  ready: 2,
  review: 2,
  invitation: 2,
  install_request: 2,
  agent_waiting: 2,
  stuck: 3,
  runner: 3,
  notification: 4,
  chat: 5,
};

export type Stake = { text: string; tone: "danger" | "warn" | "accent" | null };

/** One row of Needs you. */
export type AttentionRow = {
  key: string;
  kind: AttentionKind;
  title: string;
  /** One line: what it is and where. */
  detail: string;
  /** What is at stake, in a few words. */
  stake: Stake | null;
  /** The action, right there. */
  action: { label: string; to: string };
  /** Who is on it: the agent, or the person who asked. */
  owner: { name: string; agent: boolean } | null;
  /** Epoch ms: when it started waiting. */
  at: number;
  /** Where it came from, for a member without Code access never `code`. */
  from: "code" | "agents" | "notifications" | "chat" | "marketplace";
};

/**
 * Most pressing first: by tier, then what has waited longest, then by key
 * so the order never depends on the order rows were read. One of each key,
 * and one of each place: a notification about a pull request already on
 * the list is left out.
 */
export function rankAttention(rows: AttentionRow[]): AttentionRow[] {
  const sorted = [...rows].sort((a, b) => TIER[a.kind] - TIER[b.kind] || a.at - b.at || a.key.localeCompare(b.key));
  const keys = new Set<string>();
  const places = new Set<string>();
  return sorted.filter((row) => {
    const place = row.action.to.split(/[?#]/)[0];
    if (keys.has(row.key) || (row.kind === "notification" && places.has(place))) return false;
    keys.add(row.key);
    places.add(place);
    return true;
  });
}

/** Start here: the first row by `rankAttention`, with why it was picked. */
export function startHere(ranked: AttentionRow[]): { row: AttentionRow; why: string } | null {
  const row = ranked[0];
  if (!row) return null;
  const sameTier = ranked.filter((other) => TIER[other.kind] === TIER[row.kind]).length;
  const tail = sameTier > 1 ? ` Of the ${sameTier} like it, it has waited longest.` : "";
  return { row, why: `${WHY[row.kind]}${tail}` };
}

const WHY: Record<AttentionKind, string> = {
  limit: "Agents start nothing new past the workspace's agent budget, so everything else waits on it.",
  install_request: "A member asked for it, and only an owner can add it or turn it down.",
  deploy: "Production is serving an older build until this is fixed, so it comes before anything else.",
  session_cap: "An agent stopped at its spend cap and does nothing more until someone approves more.",
  agent_budget: "An agent used up its budget and takes no new work until it is raised.",
  pull_blocked: "An agent stopped on this change and won't go on until a person decides.",
  ready: "The work is done and only waits for you to land it.",
  review: "You were asked by name, so it waits for your verdict.",
  invitation: "It is addressed to you; no one else can answer it.",
  agent_waiting: "An agent is waiting on you to go on.",
  stuck: "A running agent has stopped reporting and may be stuck.",
  runner: "A job is waiting for a runner that is not there.",
  notification: "It is the most pressing unread notification.",
  chat: "Nothing else is waiting, and this is the oldest message for you.",
};

// --- Rows from each source ----------------------------------------------------

/** Mission control's need row, as Home reads it (lib/mission-control.ts `NeedRow`). */
export type CodeNeed = {
  key: string;
  reason: string;
  repo: RepoPath | null;
  ref: string | null;
  title: string;
  ask: string;
  by: { name: string; agent: boolean } | null;
  for: string | null;
  at: number;
  to: string;
  facts: { label: string; value: string; tone: string | null }[];
};

const fact = (need: CodeNeed, label: string) => need.facts.find((f) => f.label === label)?.value ?? null;

const REASON_STAKE: Record<string, Stake> = {
  blocking: { text: "Blocking", tone: "danger" },
  checks_failing: { text: "Checks failing", tone: "danger" },
  outside_guardrails: { text: "Over a guardrail", tone: "warn" },
  low_confidence: { text: "Low confidence", tone: "warn" },
  needs_review: { text: "Needs a verdict", tone: "warn" },
  stalled: { text: "Stalled", tone: "warn" },
};

/** A Code need (failed deploy, pull request, review, invitation, stuck run, runner) as a row. */
export function codeRow(need: CodeNeed): AttentionRow {
  const prefix = need.key.split(":")[0];
  const where = need.repo ? `${need.repo.namespace}/${need.repo.name}${need.ref ? ` ${need.ref}` : ""}` : null;
  const detail = where ? `${where} · ${need.ask}` : need.ask;
  const owner = need.by;
  const base = { key: need.key, title: need.title, detail, owner, at: need.at, from: "code" as const };
  switch (prefix) {
    case "deploy":
      return {
        ...base,
        kind: "deploy",
        stake: { text: fact(need, "Production") === "Not live yet" ? "Not live yet" : "Production on an older build", tone: "danger" },
        action: { label: "See the build", to: need.to },
      };
    case "invitation":
      return { ...base, kind: "invitation", stake: { text: `${fact(need, "Role") ?? "A"} role`, tone: null }, action: { label: "Respond", to: need.to } };
    case "review": {
      const lines = fact(need, "Lines");
      return { ...base, kind: "review", stake: { text: lines ?? "Your review", tone: null }, action: { label: "Review", to: need.to } };
    }
    case "runner":
      return { ...base, kind: "runner", stake: { text: `Waiting ${fact(need, "Waiting") ?? ""}`.trim(), tone: "warn" }, action: { label: "Look", to: need.to } };
    case "run": {
      const cost = fact(need, "Cost so far");
      return {
        ...base,
        kind: "stuck",
        stake: { text: cost ? `${cost} so far` : `Quiet ${fact(need, "Quiet for") ?? ""}`.trim(), tone: "warn" },
        action: { label: "Look", to: need.to },
      };
    }
    default: {
      if (need.reason === "ready_to_merge") {
        const files = fact(need, "Files changed");
        return {
          ...base,
          kind: "ready",
          stake: { text: files ? `${files} ${files === "1" ? "file" : "files"} to land` : "Ready to land", tone: "accent" },
          action: { label: "Merge", to: need.to },
        };
      }
      return {
        ...base,
        kind: "pull_blocked",
        stake: REASON_STAKE[need.reason] ?? { text: "Waiting on you", tone: "warn" },
        action: { label: need.reason === "low_confidence" || need.reason === "needs_review" ? "Review" : "Decide", to: need.to },
      };
    }
  }
}

/** A session stopped at its spend cap that the viewer may approve more for. */
export function sessionCapRow(session: AgentSession, slug: string): AttentionRow {
  const cap = session.cap_micros;
  return {
    key: `session:${session.id}`,
    kind: "session_cap",
    title: session.visible ? session.title : `A session of @${session.agent_handle}`,
    detail: `@${session.agent_handle} stopped at its spend cap${session.channel_name ? ` in #${session.channel_name}` : ""}.`,
    stake: { text: cap != null ? `${money(session.charged_micros)} of ${money(cap)} cap` : `${money(session.charged_micros)} spent`, tone: "warn" },
    action: { label: "Approve more", to: `/${slug}/-/agents/${session.agent_handle}/sessions/${session.id}` },
    owner: { name: session.agent_handle, agent: true },
    at: Date.parse(session.updated_at),
    from: "agents",
  };
}

export type AgentLike = {
  id: string;
  handle: string;
  display_name: string;
  status: string;
  spent_month_micros: number;
  budget: { monthly_micros: number | null };
  updated_at: string;
};

/** An agent out of budget (for those who may raise it), or waiting on someone. */
export function agentRow(agent: AgentLike, slug: string): AttentionRow | null {
  const base = {
    key: `agent:${agent.id}`,
    owner: { name: agent.handle, agent: true },
    at: Date.parse(agent.updated_at),
    from: "agents" as const,
  };
  if (agent.status === "out_of_budget") {
    const budget = agent.budget.monthly_micros;
    return {
      ...base,
      kind: "agent_budget",
      title: `${agent.display_name} is out of budget`,
      detail: `@${agent.handle} takes no new work this month until its budget is raised.`,
      stake: { text: budget != null ? `${money(Math.max(0, budget - agent.spent_month_micros))} left` : "Budget used", tone: "danger" },
      action: { label: "Raise the budget", to: `/${slug}/-/agents/${agent.handle}/spend` },
    };
  }
  if (agent.status === "waiting") {
    return {
      ...base,
      kind: "agent_waiting",
      title: `${agent.display_name} is waiting`,
      detail: `@${agent.handle} is waiting before it goes on.`,
      stake: null,
      action: { label: "Open", to: `/${slug}/-/agents/${agent.handle}` },
    };
  }
  return null;
}

const NOTIFICATION_STAKE: Record<string, string> = {
  agent: "Agent waiting",
  review_requested: "Review requested",
  assign: "Assigned to you",
  mention: "Mentioned",
  team_mention: "Team mentioned",
  ci_activity: "CI activity",
  security_alert: "Security alert",
  state_change: "State changed",
  author: "Your work",
  comment: "Comment",
  manual: "Subscribed",
  subscribed: "Watching",
};

/**
 * An unread notification that is a warning (someone or something is
 * waiting) or a failure, in this workspace. A member without Code access
 * gets none about a repository.
 */
export function notificationRow(item: InboxItem, slug: string, code: boolean): AttentionRow | null {
  if (item.readAt != null || item.doneAt != null) return null;
  if (item.severity !== "warning" && item.severity !== "error") return null;
  const inWorkspace = (item.workspace ?? item.repo?.split("/")[0] ?? "").toLowerCase() === slug;
  if (!inWorkspace) return null;
  if (!code && item.repo) return null;
  return {
    key: `notification:${item.id}`,
    kind: "notification",
    title: item.body || item.title,
    detail: item.body ? item.title : (item.repo ?? "A notification"),
    stake: { text: NOTIFICATION_STAKE[item.reason] ?? "Notification", tone: item.severity === "error" ? "danger" : "warn" },
    action: { label: "Open", to: item.url },
    owner: item.actor ? { name: item.actor, agent: item.actor === "g1t" || item.actor.endsWith("-agent") } : null,
    at: Date.parse(item.updatedAt),
    from: "notifications",
  };
}

export type ChatEntryLike = {
  channel: { id: string; kind: "channel" | "dm"; name: string | null; last_message_at?: string | null };
  title: string;
  muted: boolean;
  unread: number;
  mentions: number;
};

/** A conversation with a mention of you, or a direct message you haven't read. */
export function chatRow(entry: ChatEntryLike, slug: string): AttentionRow | null {
  if (entry.muted) return null;
  if (!(entry.mentions > 0 || (entry.channel.kind === "dm" && entry.unread > 0))) return null;
  const to = entry.channel.kind === "dm" || !entry.channel.name ? `/${slug}/-/chat/dm/${entry.channel.id}` : `/${slug}/-/chat/${entry.channel.name}`;
  const dm = entry.channel.kind === "dm";
  return {
    key: `chat:${entry.channel.id}`,
    kind: "chat",
    title: dm ? entry.title : `#${entry.title}`,
    detail: dm ? "A direct message you haven't read." : "You were mentioned.",
    stake: {
      text: entry.mentions > 0 ? `${entry.mentions} ${entry.mentions === 1 ? "mention" : "mentions"}` : `${entry.unread} unread`,
      tone: entry.mentions > 0 ? "accent" : null,
    },
    action: { label: "Reply", to },
    owner: null,
    at: entry.channel.last_message_at ? Date.parse(entry.channel.last_message_at) : 0,
    from: "chat",
  };
}

/** A member's open request to add something from the Marketplace, for an owner. */
export function installRequestRow(request: InstallRequest, slug: string): AttentionRow | null {
  if (request.status !== "open") return null;
  return {
    key: `request:${request.id}`,
    kind: "install_request",
    title: `${request.requested_by} asked to add ${request.name}`,
    detail: request.note ? `“${request.note}”` : "A request to add it from the Marketplace.",
    stake: { text: "Only owners can add it", tone: null },
    action: { label: "Review the request", to: `/${slug}/-/marketplace/requests` },
    owner: { name: request.requested_by, agent: false },
    at: Date.parse(request.requested_at),
    from: "marketplace",
  };
}

/**
 * The workspace's agents at 100% of its monthly agent budget, for those who
 * may raise it. `since` is when it was reached as far as is known: the
 * newest session that stopped at its cap, else the start of the month.
 */
export function limitRow(input: { alert: number | null; spentMicros: number; since: number }, slug: string): AttentionRow | null {
  if (input.alert == null || input.alert < 100) return null;
  return {
    key: "limit:agents",
    kind: "limit",
    title: "Agents used up the workspace's budget",
    detail: `${money(input.spentMicros)} spent this month. Agents start nothing new until the budget is raised or the month turns.`,
    stake: { text: "No new agent work", tone: "danger" },
    action: { label: "Raise the budget", to: `/${slug}/-/spend` },
    owner: null,
    at: input.since,
    from: "agents",
  };
}

/** What Needs you and Start here show, and which sources did not answer. */
export type Attention = {
  rows: AttentionRow[];
  start: { row: AttentionRow; why: string } | null;
  /** Sources that did not answer, by name, for the card to say so. */
  missing: string[];
};

export function attention(input: {
  slug: string;
  code: boolean;
  codeNeeds: CodeNeed[] | null;
  capped: AgentSession[] | null;
  agents: AgentLike[] | null;
  canManage: boolean;
  /** The workspace's agent budget, for those who may manage agents; null for anyone else. */
  limit?: { alert: number | null; spentMicros: number; since: number } | null;
  /** Install requests, when the viewer may answer them (an owner); null otherwise or when they couldn't be read. */
  requests?: InstallRequest[] | null;
  notifications: InboxItem[] | null;
  chat: ChatEntryLike[] | null;
}): Attention {
  const rows: AttentionRow[] = [];
  const missing: string[] = [];
  if (input.code) {
    if (input.codeNeeds) rows.push(...input.codeNeeds.map(codeRow));
    else missing.push("Code");
  }
  if (input.limit && input.canManage) {
    const row = limitRow(input.limit, input.slug);
    if (row) rows.push(row);
  }
  for (const request of input.requests ?? []) {
    const row = installRequestRow(request, input.slug);
    if (row) rows.push(row);
  }
  if (input.capped) rows.push(...input.capped.map((session) => sessionCapRow(session, input.slug)));
  if (input.agents) {
    const cappedAgents = new Set((input.capped ?? []).map((s) => s.agent_handle));
    for (const agent of input.agents) {
      if (agent.status === "out_of_budget" && !input.canManage) continue;
      if (agent.status === "waiting" && cappedAgents.has(agent.handle)) continue;
      const row = agentRow(agent, input.slug);
      if (row) rows.push(row);
    }
  }
  if (input.capped == null || input.agents == null) missing.push("Agents");
  if (input.notifications) {
    for (const item of input.notifications) {
      const row = notificationRow(item, input.slug, input.code);
      if (row) rows.push(row);
    }
  } else missing.push("Notifications");
  if (input.chat) {
    for (const entry of input.chat) {
      const row = chatRow(entry, input.slug);
      if (row) rows.push(row);
    }
  } else missing.push("Chat");
  const ranked = rankAttention(rows);
  return { rows: ranked, start: startHere(ranked), missing };
}

// --- Spend in the span ----------------------------------------------------------

/** Money in, which the statement lists but which is not spend. */
const MONEY_IN: ReadonlySet<string> = new Set(["Payments", "AI credit", "Credits from g1t", "Refunds", "Tax", "Card processing fees"]);

export type Spend = {
  /** The statement days counted, `YYYY-MM-DD` in UTC, first and last. */
  from: string;
  to: string;
  /** Usage at price over those days, in micros. */
  totalMicros: number;
  /** A line per kind of charge, as the statement names it, most first. */
  lines: { kind: string; micros: number; count: number }[];
  /** Usage at price this month so far, the top bar's and Usage's figure; null when it could not be read. */
  monthMicros: number | null;
};

/** The UTC months (`YYYY-MM`) the span touches, oldest first: the statements Home reads. */
export function spanMonths(span: Pick<Span, "from" | "now">): string[] {
  const months: string[] = [];
  const first = new Date(span.from);
  let year = first.getUTCFullYear();
  let month = first.getUTCMonth();
  const last = new Date(span.now).toISOString().slice(0, 7);
  for (let i = 0; i < 3; i++) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}`;
    months.push(key);
    if (key >= last) break;
    month++;
    if (month === 12) {
      month = 0;
      year++;
    }
  }
  return months;
}

/**
 * The span's spend from the statements grouped by day: each usage line at
 * its price (what was charged, plus what the plan, a trial, a pool or a
 * discount paid of it), leaving out money in. The statement keeps whole
 * UTC days, so the span is counted from the start of the UTC day it began.
 * `statements` is the months of `spanMonths`, the current one last.
 * `monthMicros` is this month so far as billing's usage report counts it,
 * the month's usage not yet closed included: the figure the top bar's
 * pill, Spend and Usage show, so Home shows no other.
 */
export function spendIn(statements: Pick<Statement, "groups" | "totals">[], span: Pick<Span, "from" | "now">, monthMicros: number | null): Spend {
  const from = new Date(span.from).toISOString().slice(0, 10);
  const to = new Date(span.now).toISOString().slice(0, 10);
  const byKind = new Map<string, { micros: number; count: number }>();
  for (const statement of statements) {
    for (const group of statement.groups) {
      if (group.key < from || group.key > to) continue;
      for (const line of group.lines) {
        if (MONEY_IN.has(line.kind)) continue;
        const micros = line.priceMicros ?? line.chargedMicros;
        const kept = byKind.get(line.kind) ?? { micros: 0, count: 0 };
        byKind.set(line.kind, { micros: kept.micros + micros, count: kept.count + line.count });
      }
    }
  }
  const lines = [...byKind]
    .map(([kind, value]) => ({ kind, ...value }))
    .filter((line) => line.micros > 0)
    .sort((a, b) => b.micros - a.micros || a.kind.localeCompare(b.kind));
  return {
    from,
    to,
    totalMicros: lines.reduce((sum, line) => sum + line.micros, 0),
    lines,
    monthMicros,
  };
}

// --- The sentence -----------------------------------------------------------

/**
 * The sentence under the heading: "Since Tuesday evening, agents finished
 * 35 tasks and 12 changes landed. 4 needed a fix after review." Finished
 * counts every task that settled well: accepted, fixed, and sessions that
 * finished.
 */
export function spanSentence(span: Pick<Span, "words">, work: Pick<SpanWork, "counts" | "tasks"> | null, landed: number | null): string {
  const lead = span.words;
  if (!work) return `${lead}, agent work couldn't be read.`;
  const { accepted, fixed, finished, dropped } = work.counts;
  const done = accepted + fixed + finished;
  const changes = landed && landed > 0 ? `${plural(landed, "change")} landed` : null;
  if (work.tasks.length === 0 && !changes) return `${lead}, nothing new has settled.`;
  const first =
    done > 0
      ? `${lead}, agents finished ${plural(done, "task")}${changes ? ` and ${changes}` : ""}.`
      : changes
        ? `${lead}, ${changes}${work.tasks.length > 0 ? "; agents finished none of their tasks" : ""}.`
        : `${lead}, agents finished no tasks.`;
  const after: string[] = [];
  if (fixed > 0) after.push(`${fixed.toLocaleString("en-US")} needed a fix after review`);
  if (dropped > 0) after.push(`${dropped.toLocaleString("en-US")} didn't finish`);
  if (after.length === 0) return first;
  const text = after.length > 1 ? `${after[0]}, and ${after[1]}` : after[0]!;
  return `${first} ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** "8 things need you.", or that nothing does. */
export function waitingSentence(total: number): string {
  if (total === 0) return "Nothing needs you right now.";
  return `${plural(total, "thing")} ${total === 1 ? "needs" : "need"} you.`;
}

/** How long something has waited: "45 min", "17 h", "2 d". */
export function waited(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
}

/** "3:40 PM" when it is the same day as `now`, else "Oct 7". */
export function whenShort(at: number, now: number, timeZone: string | null): string {
  if (dayIn(at, timeZone) === dayIn(now, timeZone)) return formatIn(at, timeZone, { hour: "numeric", minute: "2-digit" });
  return now - at < 6 * DAY ? formatIn(at, timeZone, { weekday: "short", hour: "numeric" }) : shortDate(at, timeZone);
}
