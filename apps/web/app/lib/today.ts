/**
 * Today, the workspace's front page: how the day's agent work went, what is
 * waiting on you, what the day cost, and the one place to start. Every
 * number is worked out here from what the services return, so each
 * definition is tested on its own (today.test.ts) and written down in the
 * Today guide (apps/docs/.../guides/today.md). Imports only types.
 */
import type { AgentSession, AgentSessionKind, InboxItem, Pull, RepoPath, Statement } from "@g1t/contracts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A day's date in a time zone, as `YYYY-MM-DD`; UTC when the zone is unknown or invalid. */
export function dayIn(at: number, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timeZone || "UTC" }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** The `YYYY-MM-DD` keys of the `count` days before `now`'s day, newest first. */
export function daysBefore(now: number, timeZone: string | null, count: number): string[] {
  const today = dayIn(now, timeZone);
  const keys: string[] = [];
  // Noon steps never skip or repeat a day across a clock change.
  for (let back = 1; keys.length < count && back < count + 3; back++) {
    const key = dayIn(now - back * DAY, timeZone);
    if (key !== today && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** "Oct 9", in the reader's time zone. */
export function shortDate(now: number, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timeZone || "UTC" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(now);
  }
}

// --- Today's tasks ------------------------------------------------------------

/**
 * How one of today's tasks went:
 * - `accepted`: an agent's pull request merged today without the agent being sent back to revise it.
 * - `fixed`: an agent's pull request merged today after one or more revisions.
 * - `finished`: an agent session that finished today. Sessions are not reviewed, so they are never `accepted`.
 * - `open`: still open, and worked on today.
 * - `dropped`: an agent's pull request closed today without merging, or a session that failed or was stopped today.
 */
export type TaskOutcome = "accepted" | "fixed" | "finished" | "open" | "dropped";

/** Where a task came from. */
export type TaskSource = "chat" | "schedule" | "colleague" | "code";

export const OUTCOME_LABEL: Record<TaskOutcome, string> = {
  accepted: "Accepted first time",
  fixed: "Fixed after review",
  finished: "Sessions finished",
  open: "Still open",
  dropped: "Didn't finish",
};

export const SOURCE_LABEL: Record<TaskSource, string> = {
  chat: "Chat",
  schedule: "Schedules",
  colleague: "Another agent",
  code: "Code",
};

/** One mark on the strip. */
export type DayTask = {
  key: string;
  outcome: TaskOutcome;
  source: TaskSource;
  /** Null for a session in a conversation the viewer is not in. */
  title: string | null;
  to: string | null;
  /** When it settled, or its latest activity while open: the strip's order. */
  at: number;
};

/** An agent's pull request with where it is: what Today reads from Code. */
export type CodePull = Pick<Pull, "number" | "title" | "status" | "mergedAt" | "createdAt" | "updatedAt"> & {
  repo: RepoPath;
  author: { username: string; kind?: string };
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
 * How an agent's pull request went on `day`, or null when it is not one of
 * that day's tasks. `revisions` counts its `revise` runs: each time g1t
 * sent the agent back for failed checks or a review.
 */
export function pullOutcome(pull: CodePull, revisions: number, day: string, timeZone: string | null): TaskOutcome | null {
  if (pull.status === "merged") {
    if (!pull.mergedAt || dayIn(Date.parse(pull.mergedAt), timeZone) !== day) return null;
    return revisions > 0 ? "fixed" : "accepted";
  }
  if (pull.status === "closed") return dayIn(Date.parse(pull.updatedAt), timeZone) === day ? "dropped" : null;
  // Draft or open: today's when it was worked on today.
  return dayIn(Date.parse(pull.updatedAt), timeZone) === day ? "open" : null;
}

const LIVE: ReadonlySet<string> = new Set(["queued", "working", "waiting", "needs_approval"]);

/**
 * How a session went today, or null when it is not one of today's tasks.
 * Only a session at the root of its tree counts: the subagents and
 * colleagues it brought in are part of its task.
 */
export function sessionOutcome(
  session: Pick<AgentSession, "parent_id" | "status" | "updated_at" | "finished_at">,
  day: string,
  timeZone: string | null,
): TaskOutcome | null {
  if (session.parent_id) return null;
  if (LIVE.has(session.status)) return dayIn(Date.parse(session.updated_at), timeZone) === day ? "open" : null;
  const ended = session.finished_at ?? session.updated_at;
  if (dayIn(Date.parse(ended), timeZone) !== day) return null;
  return session.status === "done" ? "finished" : "dropped";
}

export function sessionSource(kind: AgentSessionKind): TaskSource {
  return kind === "routine" ? "schedule" : kind === "chat" ? "chat" : "colleague";
}

/** The day's agent work, and how the last seven days compare. */
export type DayWork = {
  tasks: DayTask[];
  counts: Record<TaskOutcome, number>;
  /** Tasks by where they came from, most first; only sources with any. */
  sources: { source: TaskSource; count: number }[];
  /**
   * Accepted first time: of the agents' pull requests that merged or closed
   * today, the share that merged without a revision. Null with none.
   */
  rate: { value: number; of: number } | null;
  /** The same share over the seven days before today; null when there were none, or they could not all be read. */
  lastWeek: { value: number; of: number } | null;
  /** Whether Code was read: false for a member without Code access, or when Code did not answer. */
  code: "read" | "no_access" | "unavailable";
  /** Whether sessions were read. */
  sessions: "read" | "unavailable";
  /** True when a list was cut short before the start of the day, so some of today's tasks may be missing. */
  partial: boolean;
};

export type CodeWork = {
  pulls: CodePull[];
  /** `revise` runs per pull request (`pullKey`). */
  revisions: Record<string, number>;
  /** Whether every list read reached back eight days. */
  complete: boolean;
};

export type SessionWork = { sessions: AgentSession[]; complete: boolean };

/** Accepted first time over a set of settled outcomes: null when nothing settled. */
export function acceptance(outcomes: TaskOutcome[]): { value: number; of: number } | null {
  const settled = outcomes.filter((o) => o === "accepted" || o === "fixed" || o === "dropped");
  if (settled.length === 0) return null;
  return { value: settled.filter((o) => o === "accepted").length / settled.length, of: settled.length };
}

export function dayWork(input: {
  now: number;
  timeZone: string | null;
  slug: string;
  code: CodeWork | null | "no_access";
  sessions: SessionWork | null;
}): DayWork {
  const { now, timeZone, slug } = input;
  const today = dayIn(now, timeZone);
  const tasks: DayTask[] = [];
  let lastWeek: DayWork["lastWeek"] = null;
  const code = input.code;
  if (code && code !== "no_access") {
    const week = new Set(daysBefore(now, timeZone, 7));
    const earlier: TaskOutcome[] = [];
    for (const pull of code.pulls) {
      if (!isAgentPull(pull)) continue;
      const revisions = code.revisions[pullKey(pull.repo, pull.number)] ?? 0;
      const outcome = pullOutcome(pull, revisions, today, timeZone);
      const to = `/${pull.repo.namespace}/${pull.repo.name}/pull/${pull.number}`;
      if (outcome) {
        const at = Date.parse(pull.status === "merged" && pull.mergedAt ? pull.mergedAt : pull.updatedAt);
        tasks.push({ key: `pull:${pullKey(pull.repo, pull.number)}`, outcome, source: "code", title: pull.title, to, at });
        continue;
      }
      // The seven days before: merged or closed on one of them.
      if (pull.status === "merged" || pull.status === "closed") {
        const settled = pull.status === "merged" ? pull.mergedAt : pull.updatedAt;
        if (settled && week.has(dayIn(Date.parse(settled), timeZone))) {
          earlier.push(pull.status === "closed" ? "dropped" : revisions > 0 ? "fixed" : "accepted");
        }
      }
    }
    lastWeek = code.complete ? acceptance(earlier) : null;
  }
  for (const session of input.sessions?.sessions ?? []) {
    const outcome = sessionOutcome(session, today, timeZone);
    if (!outcome) continue;
    tasks.push({
      key: `session:${session.id}`,
      outcome,
      source: sessionSource(session.kind),
      title: session.visible ? session.title : null,
      to: `/${slug}/-/agents/${session.agent_handle}/sessions/${session.id}`,
      at: Date.parse(outcome === "open" ? session.updated_at : (session.finished_at ?? session.updated_at)),
    });
  }
  // Settled work first, in the order it settled; open work last.
  const order: Record<TaskOutcome, number> = { accepted: 0, fixed: 0, finished: 0, dropped: 0, open: 1 };
  tasks.sort((a, b) => order[a.outcome] - order[b.outcome] || a.at - b.at || a.key.localeCompare(b.key));
  const counts: Record<TaskOutcome, number> = { accepted: 0, fixed: 0, finished: 0, open: 0, dropped: 0 };
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
    lastWeek,
    code: code === "no_access" ? "no_access" : code ? "read" : "unavailable",
    sessions: input.sessions ? "read" : "unavailable",
    partial: (code != null && code !== "no_access" && !code.complete) || (input.sessions != null && !input.sessions.complete),
  };
}

/** The change in percentage points from the last seven days, rounded: "+6 pts", "−3 pts", "Same". */
export function trendLabel(rate: { value: number } | null, lastWeek: { value: number } | null): string | null {
  if (!rate || !lastWeek) return null;
  const points = Math.round(rate.value * 100) - Math.round(lastWeek.value * 100);
  if (points === 0) return "Same as the last 7 days";
  return `${points > 0 ? "+" : "−"}${Math.abs(points)} pts vs the last 7 days`;
}

// --- Needs attention ----------------------------------------------------------

/**
 * What a row is. Tiers, most pressing first:
 * 0. production is down to an older build (`deploy`), or the workspace hit its usage limit (`limit`);
 * 1. agent work that has stopped and can't go on without you;
 * 2. finished work waiting only for you (merge, review, an invitation, an agent asking);
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
  agent_waiting: 2,
  stuck: 3,
  runner: 3,
  notification: 4,
  chat: 5,
};

export type Stake = { text: string; tone: "danger" | "warn" | "accent" | null };

/** One row of Needs attention. */
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
  from: "code" | "agents" | "notifications" | "chat";
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
  limit: "Agents start nothing new past the workspace's usage limit, so everything else waits on it.",
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

/** Mission control's need row, as Today reads it (lib/mission-control.ts `NeedRow`). */
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

/** "$4.20", or "<$0.01" for a sliver. */
export function dollars(micros: number): string {
  const value = micros / 1_000_000;
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A session stopped at its spend cap that the viewer may approve more for. */
export function sessionCapRow(session: AgentSession, slug: string): AttentionRow {
  const cap = session.cap_micros;
  return {
    key: `session:${session.id}`,
    kind: "session_cap",
    title: session.visible ? session.title : `A session of @${session.agent_handle}`,
    detail: `@${session.agent_handle} stopped at its spend cap${session.channel_name ? ` in #${session.channel_name}` : ""}.`,
    stake: { text: cap != null ? `${dollars(session.charged_micros)} of ${dollars(cap)} cap` : `${dollars(session.charged_micros)} spent`, tone: "warn" },
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
      stake: { text: budget != null ? `${dollars(Math.max(0, budget - agent.spent_month_micros))} left` : "Budget used", tone: "danger" },
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

/** What Needs attention and Start here show, and which sources did not answer. */
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
  notifications: InboxItem[] | null;
  chat: ChatEntryLike[] | null;
}): Attention {
  const rows: AttentionRow[] = [];
  const missing: string[] = [];
  if (input.code) {
    if (input.codeNeeds) rows.push(...input.codeNeeds.map(codeRow));
    else missing.push("Code");
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

// --- Spent today --------------------------------------------------------------

/** Money in, which the statement lists but which is not spend. */
const MONEY_IN: ReadonlySet<string> = new Set(["Payments", "AI credit", "Credits from g1t", "Refunds", "Tax", "Card processing fees"]);

export type Spend = {
  /** The statement's day, `YYYY-MM-DD` in UTC. */
  day: string;
  /** Usage at price today, in micros. */
  totalMicros: number;
  /** A line per kind of charge, as the statement names it, most first. */
  lines: { kind: string; micros: number; count: number }[];
  /** Usage at price this month so far. */
  monthMicros: number;
};

/**
 * Today's spend from the month's statement grouped by day: each usage
 * line at its price (what was charged, plus what the plan, a trial, a pool
 * or a discount paid of it), leaving out money in. The statement's days are
 * UTC days.
 */
export function spendToday(statement: Pick<Statement, "groups" | "totals">, now: number): Spend {
  const day = new Date(now).toISOString().slice(0, 10);
  const group = statement.groups.find((g) => g.key === day);
  const lines = (group?.lines ?? [])
    .filter((line) => !MONEY_IN.has(line.kind))
    .map((line) => ({ kind: line.kind, micros: line.priceMicros ?? line.chargedMicros, count: line.count }))
    .filter((line) => line.micros > 0)
    .sort((a, b) => b.micros - a.micros || a.kind.localeCompare(b.kind));
  return {
    day,
    totalMicros: lines.reduce((sum, line) => sum + line.micros, 0),
    lines,
    monthMicros: statement.totals.priceMicros ?? statement.totals.chargedMicros,
  };
}

// --- The sentence -----------------------------------------------------------

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The one sentence under the heading: "Agents finished 35 tasks. 4 needed
 * a fix after review, and 6 are still open." Finished counts every task
 * that settled well: accepted, fixed, and sessions that finished.
 */
export function daySentence(work: Pick<DayWork, "counts" | "tasks">): string {
  if (work.tasks.length === 0) return "No agent work today yet.";
  const { accepted, fixed, finished, open, dropped } = work.counts;
  const done = accepted + fixed + finished;
  const parts: string[] = [];
  const first = done > 0 ? `Agents finished ${count(done, "task")}.` : "Agents haven't finished a task yet today.";
  const after: string[] = [];
  if (fixed > 0) after.push(`${fixed.toLocaleString("en-US")} needed a fix after review`);
  if (dropped > 0) after.push(`${dropped.toLocaleString("en-US")} didn't finish`);
  if (open > 0) after.push(`${open.toLocaleString("en-US")} ${open === 1 ? "is" : "are"} still open`);
  parts.push(first);
  if (after.length > 0) {
    const last = after.pop();
    const text = after.length > 0 ? `${after.join(", ")}, and ${last}` : String(last);
    parts.push(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
  }
  return parts.join(" ");
}

/** "8 things are waiting on you.", or that nothing is. */
export function waitingSentence(total: number): string {
  if (total === 0) return "Nothing is waiting on you.";
  return `${count(total, "thing")} ${total === 1 ? "is" : "are"} waiting on you.`;
}

/** How long something has waited: "45 min", "17 h", "2 d". */
export function waited(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
}
