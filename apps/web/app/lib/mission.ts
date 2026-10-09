/**
 * The arithmetic behind mission control and a project's overview: when the
 * viewer was last here, what moved since, how a burst of one agent's work
 * reads as one line, the week's pulse, and where each pull request stands
 * in its way to landing. Pure, so it is tested on its own; it imports only
 * types.
 */
import type { AgentRun, G1tEvent, Pull, QueueEntry, RepoPath } from "@g1t/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// --- Last seen ----------------------------------------------------------------

/** The cookie that remembers when the viewer was last on mission control. */
export const SEEN_COOKIE = "g1t_seen";
/** A gap this long between page views starts a new visit. */
export const VISIT_GAP_MS = 30 * MINUTE;

/**
 * Reads the last-seen cookie (`<previous visit>.<last view>`, in epoch ms)
 * and works out what to count from and what to write back. Views within
 * `VISIT_GAP_MS` of each other are one visit, so the page refreshing
 * itself does not reset what is new. `since` is null on a first visit.
 */
export function nextSeen(raw: string | null | undefined, now: number, gap = VISIT_GAP_MS): { since: number | null; value: string } {
  const [prevText, atText] = (raw ?? "").split(".");
  const prev = Number(prevText);
  const at = Number(atText);
  if (!Number.isFinite(at) || at <= 0 || at > now) return { since: null, value: `0.${now}` };
  if (now - at > gap) return { since: at, value: `${at}.${now}` };
  const since = Number.isFinite(prev) && prev > 0 && prev <= at ? prev : null;
  return { since, value: `${since ?? 0}.${now}` };
}

/** Reads one cookie from a `Cookie` header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** "Good morning", "Good afternoon" or "Good evening", for an hour of the day. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

/** The hour of the day in a time zone, or in UTC when it is unknown or invalid. */
export function hourIn(now: number, timeZone: string | null): number {
  try {
    const text = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: timeZone || "UTC" }).format(now);
    const hour = Number.parseInt(text, 10);
    return Number.isFinite(hour) ? hour % 24 : new Date(now).getUTCHours();
  } catch {
    return new Date(now).getUTCHours();
  }
}

/** What the composer's text makes: its first line the title, all of it the body when there is more. */
export function splitRequest(text: string, max = 200): { title: string; body: string } {
  const trimmed = text.trim();
  const [first = "", ...rest] = trimmed.split(/\r?\n/);
  let title = first.trim();
  if (title.length > max) {
    const cut = title.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    title = `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  const more = rest.join("\n").trim();
  // A shortened title loses words, so the body keeps all of it.
  return { title, body: title !== first.trim() ? trimmed : more };
}

// --- Activity ---------------------------------------------------------------

/** Accounts that are g1t's own agents and machinery. */
export function isAgent(name: string | null | undefined): boolean {
  return name === "g1t" || (name ?? "").endsWith("-agent");
}

export type Verb =
  | "landed"
  | "opened_issue"
  | "closed_issue"
  | "started"
  | "ready"
  | "checks_passed"
  | "checks_failed"
  | "approved"
  | "changes_requested"
  | "commented"
  | "asked"
  | "deployed"
  | "deploy_failed"
  | "pushed"
  | "learned";

/**
 * The event types `eventItem` makes a line of. Ask the log for these only:
 * a repository's newest events are mostly ones no line is made of (session
 * steps, queue and merge-check changes), which would otherwise fill the
 * page and leave nothing to show.
 */
export const FEED_EVENT_TYPES = [
  "pull.merged",
  "issue.opened",
  "issue.closed",
  "pull.opened",
  "pull.ready",
  "checks.completed",
  "review.completed",
  "comment.created",
  "agent.asked",
  "deployment_status.created",
] as const satisfies readonly G1tEvent["type"][];

/** With pushes to the default branch too, for one project's feed. */
export const PROJECT_FEED_EVENT_TYPES = [...FEED_EVENT_TYPES, "git.push"] as const satisfies readonly G1tEvent["type"][];

/** One thing that moved, as the feed shows it. */
export type ActivityItem = {
  id: string;
  /** Epoch ms. */
  at: number;
  repo: RepoPath;
  actor: string | null;
  verb: Verb;
  /** The issue or pull request it was about. */
  number: number | null;
  /** For a memory: what was learned. For a deploy: where. */
  text?: string;
  /** Where the line links, when it is not an issue or pull request. */
  to?: string;
};

/** An event from the log as a feed item, or null for those not worth a line. */
export function eventItem(event: G1tEvent, repo: RepoPath): ActivityItem | null {
  const base = { id: event.id, at: Date.parse(event.time), repo, actor: event.actor };
  switch (event.type) {
    case "pull.merged":
      return { ...base, verb: "landed", number: event.data.number };
    case "issue.opened":
      return { ...base, verb: "opened_issue", number: event.data.number };
    case "issue.closed":
      return event.data.resolvedBy != null ? null : { ...base, verb: "closed_issue", number: event.data.number };
    case "pull.opened":
      return { ...base, actor: event.data.agent || event.actor, verb: "started", number: event.data.number };
    case "pull.ready":
      return { ...base, verb: "ready", number: event.data.number };
    case "checks.completed":
      return { ...base, actor: null, verb: event.data.status === "passed" ? "checks_passed" : "checks_failed", number: event.data.number };
    case "review.completed":
      if (!event.data.verdict) return null;
      return { ...base, actor: "g1t", verb: event.data.verdict === "approve" ? "approved" : "changes_requested", number: event.data.number };
    case "comment.created":
      // An agent's advisory review is not a verdict, and its writer is the agent.
      if (event.data.agent) {
        return { ...base, actor: `${event.data.agent.displayName} (agent)`, verb: "commented", number: event.data.number };
      }
      if (event.data.verdict) {
        return { ...base, verb: event.data.verdict === "approve" ? "approved" : "changes_requested", number: event.data.number };
      }
      return { ...base, verb: "commented", number: event.data.number };
    case "agent.asked":
      return { ...base, verb: "asked", number: event.data.number };
    case "deployment_status.created": {
      // Production, once it is up or has failed: g1t.page builds, g1t
      // Actions jobs and deployments reported through the API alike.
      const { deployment, deploymentStatus } = event.data;
      if (!deployment.production_environment) return null;
      const state = deploymentStatus.state;
      if (state !== "success" && state !== "failure" && state !== "error") return null;
      return {
        ...base,
        verb: state === "success" ? "deployed" : "deploy_failed",
        number: null,
        to: `/${repo.namespace}/${repo.name}/deployments/${deployment.id}`,
      };
    }
    default:
      return null;
  }
}

/**
 * A push to the default branch as a feed line, or null for any other push
 * and for one that only landed a pull request (`merged`: the commits pull
 * requests' merges made), which already has its own line.
 */
export function pushItem(event: G1tEvent, repo: RepoPath, merged: ReadonlySet<string>): ActivityItem | null {
  if (event.type !== "git.push" || !event.data.defaultBranch || !event.data.ref.startsWith("refs/heads/")) return null;
  const after = event.data.after;
  if (!after || /^0+$/.test(after) || merged.has(after)) return null;
  return {
    id: event.id,
    at: Date.parse(event.time),
    repo,
    actor: event.actor,
    verb: "pushed",
    number: null,
    text: after.slice(0, 7),
    to: `/${repo.namespace}/${repo.name}/commit/${after}`,
  };
}

/** One project's events as its feed: every line `eventItem` makes, and its people's pushes. */
export function projectFeed(events: G1tEvent[], repo: RepoPath): ActivityItem[] {
  const merged = new Set(events.flatMap((event) => (event.type === "pull.merged" ? [event.data.commit] : [])));
  return events.flatMap((event) => eventItem(event, repo) ?? pushItem(event, repo, merged) ?? []);
}

/** Accounts that act for g1t itself, named in the log by fixed ids. */
const G1T_ACTORS: Record<string, string> = { usr_g1t_agent: "g1t", g1t_policy: "g1t" };
/** Who an account the lookup no longer knows was. */
export const DELETED_USER = "a deleted user";

/** An account id rather than a name: usernames never hold an underscore. */
const isAccountId = (actor: string) => actor.includes("_");

/** The account ids among `actors` to look up by name, once each. */
export function actorIds(actors: (string | null)[]): string[] {
  return [...new Set(actors.filter((actor): actor is string => actor != null && isAccountId(actor) && !(actor in G1T_ACTORS)))];
}

/**
 * An actor by name: an account id becomes its username, from `names` (the
 * identity service's lookup). An id it does not know is an account since
 * deleted; with no lookup at all, the actor is only "someone".
 */
export function nameActor(actor: string | null, names: Record<string, string> | null): string | null {
  if (actor == null || !isAccountId(actor)) return actor;
  return G1T_ACTORS[actor] ?? names?.[actor] ?? (names ? DELETED_USER : "someone");
}

/** Several things one actor did in one project in a short while, read as one line. */
export type ActivityGroup = {
  id: string;
  actor: string | null;
  repo: RepoPath;
  /** Newest and oldest, epoch ms. */
  at: number;
  from: number;
  /** Each kind of thing done, in the order first seen, with what it was done to. */
  parts: { verb: Verb; numbers: number[]; texts: string[]; to?: string }[];
  count: number;
};

const sameRepo = (a: RepoPath, b: RepoPath) =>
  a.namespace.toLowerCase() === b.namespace.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/**
 * Groups items, newest first, so that a run of things one actor did in one
 * project within `window` of the run's newest reads as one line.
 */
export function groupActivity(items: ActivityItem[], window = 45 * MINUTE): ActivityGroup[] {
  const sorted = [...items].sort((a, b) => b.at - a.at);
  const groups: ActivityGroup[] = [];
  for (const item of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.actor === item.actor && sameRepo(last.repo, item.repo) && last.at - item.at <= window) {
      let part = last.parts.find((p) => p.verb === item.verb);
      if (!part) {
        part = { verb: item.verb, numbers: [], texts: [], to: item.to };
        last.parts.push(part);
      }
      if (item.number != null && !part.numbers.includes(item.number)) part.numbers.push(item.number);
      if (item.text && !part.texts.includes(item.text)) part.texts.push(item.text);
      last.from = item.at;
      last.count += 1;
      continue;
    }
    groups.push({
      id: item.id,
      actor: item.actor,
      repo: item.repo,
      at: item.at,
      from: item.at,
      parts: [{ verb: item.verb, numbers: item.number != null ? [item.number] : [], texts: item.text ? [item.text] : [], to: item.to }],
      count: 1,
    });
  }
  return groups;
}

// --- Needs you --------------------------------------------------------------

export type NeedKind = "limit" | "deploy" | "invitation" | "stalled" | "conflict" | "review" | "stuck" | "runner" | "checks" | "ready";

/** Something waiting on the viewer, with where to act on it. */
export type Need = {
  key: string;
  kind: NeedKind;
  title: string;
  detail: string;
  to: string;
  action: string;
  /** Epoch ms: when it started waiting. */
  at: number;
  where: string | null;
};

const NEED_RANK: Record<NeedKind, number> = {
  limit: 0,
  deploy: 1,
  invitation: 1.5,
  conflict: 2,
  stalled: 3,
  stuck: 4,
  runner: 4,
  review: 5,
  checks: 6,
  ready: 7,
};

/** Most urgent first: by kind, then what has waited longest. One of each key. */
export function rankNeeds(needs: Need[]): Need[] {
  const seen = new Set<string>();
  return [...needs]
    .sort((a, b) => NEED_RANK[a.kind] - NEED_RANK[b.kind] || a.at - b.at)
    .filter((need) => (seen.has(need.key) ? false : (seen.add(need.key), true)));
}

/** How long something has waited, from minutes: "45 min", "17 h", "2 d". */
export function waitedFor(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  if (whole < 60) return `${whole} min`;
  if (whole < 24 * 60) return `${Math.floor(whole / 60)} h`;
  return `${Math.floor(whole / (24 * 60))} d`;
}

/** Whether a run has gone quiet: running with no new step for `quiet`. */
export function stuckMinutes(run: Pick<AgentRun, "status" | "updatedAt">, now: number, quiet = 10 * MINUTE): number | null {
  if (run.status !== "running") return null;
  const idle = now - Date.parse(run.updatedAt);
  return idle >= quiet ? Math.floor(idle / MINUTE) : null;
}

// --- Digest -----------------------------------------------------------------

export type DigestCounts = {
  landed: number;
  reviews: number;
  opened: number;
  deploys: number;
  failedDeploys: number;
  /** The longest an agent has been quiet, in minutes; null when none is. */
  stuck: number | null;
};

export type DigestPart = { text: string; tone: "fg" | "warn" | "danger" | "accent"; anchor: string };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What moved since the viewer was last here, as the pieces of a sentence. */
export function digestParts(c: DigestCounts): DigestPart[] {
  const parts: DigestPart[] = [];
  if (c.landed > 0) parts.push({ text: `${count(c.landed, "change", "changes")} landed`, tone: "accent", anchor: "activity" });
  if (c.reviews > 0) parts.push({ text: `${count(c.reviews, "pull request needs", "pull requests need")} your review`, tone: "warn", anchor: "your-pulls" });
  if (c.stuck != null) parts.push({ text: `an agent has been quiet for ${waitedFor(c.stuck)}`, tone: "warn", anchor: "live" });
  if (c.failedDeploys > 0) parts.push({ text: `${count(c.failedDeploys, "deploy", "deploys")} failed`, tone: "danger", anchor: "needs-you" });
  if (c.deploys > 0) parts.push({ text: `${count(c.deploys, "deploy", "deploys")} went out`, tone: "fg", anchor: "projects" });
  if (c.opened > 0) parts.push({ text: `${count(c.opened, "issue was", "issues were")} opened`, tone: "fg", anchor: "activity" });
  return parts;
}

// --- Pulse ------------------------------------------------------------------

/** Counts per day for the `days` days ending today (UTC), oldest first. */
export function dailyBuckets(points: { at: number; value?: number }[], days: number, now: number): number[] {
  const end = Math.floor(now / DAY);
  const buckets = new Array<number>(days).fill(0);
  for (const point of points) {
    const index = days - 1 - (end - Math.floor(point.at / DAY));
    if (index >= 0 && index < days) buckets[index] += point.value ?? 1;
  }
  return buckets;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The share of pull requests whose first run of checks passed, from the
 * `checks.completed` events of one or more projects. Null with none.
 */
export function firstPassRate(events: { repo: string; number: number; at: number; passed: boolean }[]): { rate: number | null; of: number } {
  const first = new Map<string, { at: number; passed: boolean }>();
  for (const event of events) {
    const key = `${event.repo}#${event.number}`;
    const seen = first.get(key);
    if (!seen || event.at < seen.at) first.set(key, { at: event.at, passed: event.passed });
  }
  if (first.size === 0) return { rate: null, of: 0 };
  const passed = [...first.values()].filter((run) => run.passed).length;
  return { rate: passed / first.size, of: first.size };
}

/** The share of check runs that passed. Null with none. */
export function passRate(results: boolean[]): number | null {
  if (results.length === 0) return null;
  return results.filter(Boolean).length / results.length;
}

/**
 * A project's health from its recent workflow runs, for one that ships
 * without pull requests (whose checks are what `checks.completed` counts).
 * Only runs that finished and passed or failed count: cancelled and skipped
 * say nothing about the code. A run passed on the first try when its first
 * attempt is the one that passed.
 */
export function runHealth(runs: { attempt: number; status: string; conclusion: string | null }[]): { passRate: number | null; firstPass: { rate: number | null; of: number }; checkRuns: number } {
  const decided = runs.filter((run) => run.status === "completed" && (run.conclusion === "success" || run.conclusion === "failure"));
  const passed = decided.map((run) => run.conclusion === "success");
  const first = decided.filter((run) => run.conclusion === "success" && run.attempt <= 1).length;
  return { passRate: passRate(passed), firstPass: { rate: decided.length ? first / decided.length : null, of: decided.length }, checkRuns: decided.length };
}

/** How long from an issue being opened to its change landing, for each that did, in ms. */
export function issueToMerge(
  opened: { repo: string; number: number; at: number }[],
  merged: { repo: string; issue: number | null; at: number }[],
): number[] {
  const openedAt = new Map(opened.map((o) => [`${o.repo}#${o.number}`, o.at]));
  const spans: number[] = [];
  for (const m of merged) {
    if (m.issue == null) continue;
    const start = openedAt.get(`${m.repo}#${m.issue}`);
    if (start != null && m.at >= start) spans.push(m.at - start);
  }
  return spans;
}

/** Hours agents spent at work since `since`, counting runs still going up to `now`. */
export function agentHours(runs: Pick<AgentRun, "kind" | "startedAt" | "finishedAt">[], since: number, now: number): number {
  let ms = 0;
  for (const run of runs) {
    if (!run.startedAt || run.kind === "checks" || run.kind === "queue" || run.kind === "mergecheck") continue;
    const start = Math.max(Date.parse(run.startedAt), since);
    const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
    if (end > start) ms += end - start;
  }
  return ms / HOUR;
}

/** "3h", "2d 4h", "40m": a span in the largest units that read well. */
export function formatSpan(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  const days = Math.floor(ms / DAY);
  const hours = Math.round((ms % DAY) / HOUR);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * Points for a sparkline `width` by `height`: the values spread across the
 * width, scaled so the largest touches the top and zero sits on the
 * bottom, with `pad` kept clear for the line's width.
 */
export function sparkPoints(values: number[], width: number, height: number, pad = 2): [number, number][] {
  if (values.length === 0) return [];
  const max = Math.max(...values, 0);
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  return values.map((value, index) => {
    const x = values.length > 1 ? pad + index * step : width / 2;
    const y = max > 0 ? height - pad - (Math.max(0, value) / max) * (height - pad * 2) : height - pad;
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  });
}

// --- A project's pipeline ---------------------------------------------------

export type PipelineStage = "working" | "checking" | "reviewing" | "queue" | "landed";

export const PIPELINE: { stage: PipelineStage; label: string }[] = [
  { stage: "working", label: "Working" },
  { stage: "checking", label: "Checking" },
  { stage: "reviewing", label: "Reviewing" },
  { stage: "queue", label: "Queue" },
  { stage: "landed", label: "Landed" },
];

/**
 * Where a pull request stands on its way to landing, from what a list of
 * pull requests says about it, the run at work on it, the merge queue, and
 * for one g1t sees through, its lifecycle (waiting on its checks).
 */
export function pipelineStage(
  pull: Pick<Pull, "status" | "checkStatus" | "number">,
  run: Pick<AgentRun, "kind"> | undefined,
  queued: Set<number>,
  lifecycle?: { stage: string } | null,
): PipelineStage {
  if (pull.status === "merged") return "landed";
  if (queued.has(pull.number)) return "queue";
  if (run) {
    if (run.kind === "checks") return "checking";
    if (run.kind === "review") return "reviewing";
    if (run.kind === "queue") return "queue";
    return "working";
  }
  if (pull.status === "draft") return "working";
  if (lifecycle?.stage === "checking") return "checking";
  if (pull.checkStatus === "queued" || pull.checkStatus === "running") return "checking";
  return "reviewing";
}

/** The numbers of the pull requests waiting or being tested in a merge queue. */
export function queuedNumbers(entries: Pick<QueueEntry, "number" | "state">[]): Set<number> {
  return new Set(entries.filter((e) => e.state === "waiting" || e.state === "testing" || e.state === "passed").map((e) => e.number));
}

/** Open issues by how long they have been open. */
export function ageBuckets(created: string[], now: number): { label: string; count: number }[] {
  const buckets = [
    { label: "Under a day", max: DAY, count: 0 },
    { label: "Under a week", max: 7 * DAY, count: 0 },
    { label: "Under a month", max: 30 * DAY, count: 0 },
    { label: "Older", max: Number.POSITIVE_INFINITY, count: 0 },
  ];
  for (const at of created) {
    const age = now - Date.parse(at);
    const bucket = buckets.find((b) => age < b.max) ?? buckets[buckets.length - 1];
    bucket.count += 1;
  }
  return buckets.map(({ label, count }) => ({ label, count }));
}

export const TIME = { MINUTE, HOUR, DAY };
