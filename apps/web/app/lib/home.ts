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
  ActivityDigest,
  ActorCount,
  ChatActivity,
  Commit,
  Deployment,
  Harness,
  InboxItem,
  ProjectDeploys,
  Pull,
  PullSessions,
  RepoDigest,
  RepoPath,
  ShipState,
  ShippedRepo,
  Statement,
  WorkflowRun,
} from "@g1t/contracts";

import { HARNESS_NAMES } from "./coordination.ts";
import { type PushRecord, pushedByPerson, pushedCommits } from "./mission-control.ts";
import { settledLine } from "./inbox.ts";
import { sessionPath } from "./work-items.ts";

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

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

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

// --- Code read for the span -----------------------------------------------------

/** A pull request with where it is: what Home reads from Code. */
export type CodePull = Pick<Pull, "number" | "title" | "status" | "mergedAt" | "createdAt" | "updatedAt"> & {
  repo: RepoPath;
  /** The repository's id, and the commit the merge put on the base branch: what deployments ship. */
  repoId?: string;
  mergeCommit?: string | null;
  author: { username: string; kind?: string };
  /** Who merged it, when it merged. */
  mergedBy?: string | null;
};

/** Whether a pull request was opened by g1t itself, as older ones were: shown as `@g1t`. */
export function isAgentPull(pull: { author: { username: string; kind?: string } }): boolean {
  const name = pull.author.username;
  return pull.author.kind === "agent" || name === "g1t" || name.endsWith("-agent");
}

/** `acme/web#12`, lowercase: how a pull request is matched. */
export function pullKey(repo: RepoPath, number: number): string {
  return `${repo.namespace}/${repo.name}#${number}`.toLowerCase();
}

export type CodeWork = {
  pulls: CodePull[];
  /** Whether every list read reached back to 7 days before the span. */
  complete: boolean;
};

// --- People in the span -----------------------------------------------------------

/**
 * Who an actor is. Actors are member keys, as the events and chat services
 * return them: `user:<id>` for an account, `agent:<id>` for an agent of
 * older rows, `""` for nobody (a push an import made). g1t itself and
 * older agents are not people; everyone else is. `agents` names more keys
 * that are agents' (accounts of kind `agent`), when known.
 */
export type ActorKind = "person" | "agent";

/** g1t's own account, as events name it (identity's `AGENT_ID`). */
export const G1T_ACTOR = "user:usr_g1t_agent";

export function actorKind(key: string, agents?: ReadonlySet<string>): ActorKind {
  return key.startsWith("agent:") || key.startsWith("system:") || key === G1T_ACTOR || isRobotKey(key) || agents?.has(key) ? "agent" : "person";
}

/**
 * A member key that names a robot under `user:`: an agent of older rows by
 * its own id, a workspace (its own token, or g1t's upkeep as it), or `g1t`.
 * Events name a workspace this way (services/events digest).
 */
export function isRobotKey(key: string): boolean {
  return key.startsWith("user:agt_") || key.startsWith("user:wsp_") || key === "user:g1t";
}

/** Whether a username is g1t's own: g1t, or an agent account of older rows. */
export function isAgentName(name: string | null | undefined): boolean {
  return name === "g1t" || (name != null && name.endsWith("-agent"));
}

/** A repository as the digest's links and lines need it. */
export type RepoRef = RepoPath & { defaultBranch: string };

/**
 * The kinds of work the span's chart is split into, in the order the
 * legend and each bar show them (and the chart's colour slots).
 */
export const WORK_KINDS = ["pushes", "pulls", "items", "shipped", "docs", "chat"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** Each kind's name in the legend. */
export const WORK_LABEL: Record<WorkKind, string> = {
  pushes: "Pushes",
  pulls: "Pull requests",
  items: "Work items",
  shipped: "Shipped",
  docs: "Docs",
  chat: "Chat",
};

/** A person, or an agent, who did something in the span: a row of the chart. */
export type DigestActor = {
  key: string;
  /** Their username; g1t for g1t; `unknown account` when it could not be read. */
  name: string;
  kind: ActorKind;
  /** How many things they did, over every kind: the order of the rows. */
  count: number;
  /** The same things by kind (a push counts once, however many commits). */
  parts: Partial<Record<WorkKind, number>>;
  /** Commits in their pushes. */
  commits: number;
};

/** One kind of work: what was done, with its count, and where that is listed. */
export type DigestLine = {
  key: WorkKind;
  text: string;
  /** Things of this kind, in the bars' units. */
  count: number;
  to: string | null;
};

export type DigestColumn = {
  lines: DigestLine[];
  /** Most active first: people and agents, each marked. */
  actors: DigestActor[];
};

/** What the sentence under the heading needs. */
export type DigestSummary = {
  /** Distinct people (not agents) who did anything. */
  people: number;
  /** Commits people pushed. */
  commits: number;
  /** Pull requests people merged. */
  merged: number;
  /** Messages people sent. */
  said: number;
  /** Whether anything at all was counted. */
  anything: boolean;
  /** Whether what people did could be read at all (events and chat both silent: no). */
  peopleRead: boolean;
};

export type Digest = {
  people: DigestColumn;
  summary: DigestSummary;
  /** Sources that did not answer, by name, for the card to say so: Code, Chat. */
  missing: string[];
  /** True when a source was cut short, so some counts are low. */
  partial: boolean;
};

export type DigestInput = {
  slug: string;
  /** The workspace's repositories by id: for links, and to count projects. */
  repos: Record<string, RepoRef>;
  /** Events' digest; null when events did not answer. Without Code access it has no repositories. */
  activity: ActivityDigest | null;
  /** Chat's; null when chat did not answer. */
  chat: ChatActivity | null;
  /** Names for member keys: a username. */
  names: Record<string, string>;
  /** Keys of accounts that are not people, beyond g1t. */
  agentKeys?: ReadonlySet<string>;
  code: boolean;
};

const people = (n: number) => plural(n, "person", "people");

/** `a, b and c`. */
export const listOf = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** What people did, from a tally: how many, and by whom (non-empty keys). */
function part(counts: ActorCount[], agents?: ReadonlySet<string>): { count: number; actors: Map<string, number> } {
  const actors = new Map<string, number>();
  let count = 0;
  for (const entry of counts) {
    if (actorKind(entry.actor, agents) !== "person") continue;
    count += entry.count;
    if (entry.actor) actors.set(entry.actor, (actors.get(entry.actor) ?? 0) + entry.count);
  }
  return { count, actors };
}

/** Where a line points: the one project's page, or the workspace's projects when several. */
function placeFor(slug: string, repos: Record<string, RepoRef>, repoIds: Iterable<string>, page: string): string {
  const ids = [...new Set(repoIds)];
  const only = ids.length === 1 ? repos[ids[0]!] : null;
  return only ? `/${only.namespace}/${only.name}/${page}` : `/${slug}/-/repositories`;
}

/** `3 opened, 5 merged`: the non-zero counts, `#` standing for each. */
function counted(parts: [number, string][]): string {
  return parts
    .filter(([count]) => count > 0)
    .map(([count, words]) => words.replace("#", count.toLocaleString("en-US")))
    .join(", ");
}

/**
 * What was done in the span, by kind, with counts and links, and who did
 * it: people and agents both, each marked, so g1t and the agents show
 * beside the people instead of being left out (or showing as nobody).
 * g1t's keys (its account, its chat key, a workspace acting as it) are one
 * row. Pure: everything comes from the services' counts and the names
 * looked up for them.
 */
export function digestColumn(input: DigestInput): DigestColumn {
  const { slug, repos, activity, chat, names, agentKeys } = input;
  const lines: DigestLine[] = [];
  const rows = new Map<string, DigestActor>();
  const row = (key: string): DigestActor | null => {
    if (!key) return null;
    const kind = actorKind(key, agentKeys);
    const name = names[key] ?? (kind === "agent" ? (key.endsWith(":g1t") || key === G1T_ACTOR ? "g1t" : "agent") : "unknown account");
    const id = name === "g1t" ? "g1t" : key;
    let found = rows.get(id);
    if (!found) {
      found = { key: id, name, kind, count: 0, parts: {}, commits: 0 };
      rows.set(id, found);
    }
    return found;
  };
  /** Credits each actor with their part of a tally; the tally's total. */
  const credit = (kind: WorkKind, counts: ActorCount[]) => {
    let total = 0;
    for (const { actor, count } of counts) {
      total += count;
      const who = row(actor);
      if (!who) continue;
      who.count += count;
      who.parts[kind] = (who.parts[kind] ?? 0) + count;
    }
    return total;
  };

  if (activity) {
    // Pushes: commits, projects, and who.
    const pushed = new Set<string>();
    let commits = 0;
    let pushes = 0;
    for (const repo of activity.repos) {
      for (const by of repo.pushes.by) {
        if (by.count === 0) continue;
        pushed.add(repo.repo_id);
        commits += by.commits;
        pushes += credit("pushes", [{ actor: by.actor, count: by.count }]);
        const who = row(by.actor);
        if (who) who.commits += by.commits;
      }
    }
    if (pushes > 0) {
      lines.push({
        key: "pushes",
        text: `${plural(commits, "commit")} to ${plural(pushed.size, "project")}`,
        count: pushes,
        to: placeFor(slug, repos, pushed, "activity"),
      });
    }

    // The other kinds, summed over projects: how many, and where.
    const sum = (kind: WorkKind, pick: (repo: RepoDigest) => ActorCount[]) => {
      let count = 0;
      const repoIds: string[] = [];
      for (const repo of activity.repos) {
        const n = credit(kind, pick(repo));
        if (n === 0) continue;
        count += n;
        repoIds.push(repo.repo_id);
      }
      return { count, repoIds };
    };

    const opened = sum("pulls", (repo) => repo.pulls.opened);
    const merged = sum("pulls", (repo) => repo.pulls.merged);
    const closed = sum("pulls", (repo) => repo.pulls.closed);
    const reviews = sum("pulls", (repo) => repo.reviews);
    const pulls = opened.count + merged.count + closed.count + reviews.count;
    if (pulls > 0) {
      const text = counted([
        [opened.count, "# opened"],
        [merged.count, "# merged"],
        [closed.count, "# closed without merging"],
        [reviews.count, "# reviewed"],
      ]);
      lines.push({
        key: "pulls",
        text,
        count: pulls,
        to: placeFor(slug, repos, [...opened.repoIds, ...merged.repoIds, ...closed.repoIds, ...reviews.repoIds], "pulls"),
      });
    }

    const itemsOpened = sum("items", (repo) => repo.items.opened);
    const itemsClosed = sum("items", (repo) => repo.items.closed);
    const comments = sum("items", (repo) => repo.comments);
    const items = itemsOpened.count + itemsClosed.count + comments.count;
    if (items > 0) {
      const text = counted([
        [itemsOpened.count, "# opened"],
        [itemsClosed.count, "# closed"],
        [comments.count, comments.count === 1 ? "# comment" : "# comments"],
      ]);
      // Work items are the workspace's: its Work list, filtered to the one project they were in, if one.
      const ids = new Set([...itemsOpened.repoIds, ...itemsClosed.repoIds, ...comments.repoIds]);
      const only = ids.size === 1 ? repos[[...ids][0]!] : null;
      lines.push({ key: "items", text, count: items, to: only ? `/${slug}/-/work?repo=${encodeURIComponent(only.name)}` : `/${slug}/-/work` });
    }

    const succeeded = sum("shipped", (repo) => repo.deployments.succeeded);
    const failed = sum("shipped", (repo) => repo.deployments.failed);
    const releases = sum("shipped", (repo) => tallyOf(repo.releases.map((release) => release.actor)));
    const packages = sum("shipped", (repo) => tallyOf(repo.packages.map((pkg) => pkg.actor)));
    const shipped = succeeded.count + failed.count + releases.count + packages.count;
    if (shipped > 0) {
      const text = counted([
        [succeeded.count, succeeded.count === 1 ? "# deploy" : "# deploys"],
        [failed.count, "# failed"],
        [releases.count, releases.count === 1 ? "# release" : "# releases"],
        [packages.count, packages.count === 1 ? "# package version" : "# package versions"],
      ]);
      const deployed = [...succeeded.repoIds, ...failed.repoIds];
      const to =
        deployed.length > 0
          ? placeFor(slug, repos, deployed, "deployments")
          : releases.count > 0
            ? placeFor(slug, repos, releases.repoIds, "releases")
            : `/${slug}/-/packages`;
      lines.push({ key: "shipped", text, count: shipped, to });
    }

    // Artifacts: made, and whose content changed.
    if (activity.folios) {
      const made = credit("docs", activity.folios.created);
      const edits: ActorCount[] = [];
      let edited = 0;
      let allDocs = true;
      for (const folio of activity.folios.edited) {
        if (folio.authors.length === 0) continue;
        edited += 1;
        if (folio.kind !== "doc") allDocs = false;
        for (const author of folio.authors) edits.push({ actor: author, count: 1 });
      }
      credit("docs", edits);
      const what = (count: number) => plural(count, allDocs ? "doc" : "artifact");
      if (made + edited > 0) {
        const parts: string[] = [];
        if (made > 0) parts.push(`${what(made)} created`);
        if (edited > 0) parts.push(`${what(edited)} edited`);
        lines.push({ key: "docs", text: parts.join(", "), count: made + edits.length, to: `/${slug}/-/artifacts` });
      }
    }
  }

  // Chat: what was said.
  if (chat) {
    const said = credit(
      "chat",
      chat.authors.map((author) => ({ actor: author.key, count: author.messages })),
    );
    if (said > 0) {
      lines.push({ key: "chat", text: `${plural(said, "message")} in ${plural(chat.channels, "conversation")}`, count: said, to: `/${slug}/-/chat` });
    }
  }

  const actors = [...rows.values()].filter((actor) => actor.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { lines, actors };
}

/** A tally with one of each actor, for lists that name an actor per item. */
function tallyOf(actors: string[]): ActorCount[] {
  const counts = new Map<string, number>();
  for (const actor of actors) counts.set(actor, (counts.get(actor) ?? 0) + 1);
  return [...counts].map(([actor, count]) => ({ actor, count }));
}

/** What people did, what the sentence needs, and which sources were silent. */
export function digestOf(input: DigestInput): Digest {
  const column = digestColumn(input);
  const missing: string[] = [];
  if (input.code && !input.activity) missing.push("Code");
  if (!input.chat) missing.push("Chat");
  let commits = 0;
  let merged = 0;
  for (const repo of input.activity?.repos ?? []) {
    for (const by of repo.pushes.by) if (actorKind(by.actor, input.agentKeys) === "person") commits += by.commits;
    merged += part(repo.pulls.merged, input.agentKeys).count;
  }
  const said = part(
    (input.chat?.authors ?? []).map((author) => ({ actor: author.key, count: author.messages })),
    input.agentKeys,
  ).count;
  return {
    people: column,
    summary: {
      people: column.actors.filter((actor) => actor.kind === "person").length,
      commits,
      merged,
      said,
      anything: column.lines.length > 0,
      peopleRead: input.activity != null || input.chat != null,
    },
    missing,
    partial: input.activity != null && !input.activity.complete,
  };
}

// --- What landed in the span -----------------------------------------------------

/**
 * A change that landed: a pull request merged; commits pushed straight to
 * a default branch; a production build that went live; a release or a
 * package version published.
 */
export type LandedChange = {
  key: string;
  kind: "merge" | "push" | "deploy" | "release" | "package";
  title: string;
  /** One line under it: where, and by whom. */
  detail: string;
  to: string;
  at: number;
  /** A merge's or a push's commit on the default branch, and its repository's id: what a deployment ships. */
  sha?: string | null;
  repoId?: string | null;
  /** Whether it is live yet (`withShipped`); null when its project does not deploy, or it could not be read. */
  shipped?: ShipInfo | null;
  /** Made in a harness session (`withSessions`, or a `G1t-Session:` trailer): the agent marker, and the session. */
  agent?: AgentMark | null;
  /** A title that is a commit's subject: its repository (`owner/name`), which its `#12`s are read in. */
  refsIn?: string;
  /** A production build that failed (`landedDeploys`). */
  failed?: boolean;
};

/** Whether a change is live: shipped by a production deployment, on its way, waiting, or the deployment after it failed. */
export type ShipInfo = {
  state: ShipState;
  /** Epoch ms: when the deployment that shipped it went live. */
  at: number | null;
  /** The deployment (or the run that deploys it). */
  to: string | null;
};

/** A change made in a harness session: which harness when known, and the session's page. */
export type AgentMark = { harness: Harness | null; to: string | null };

/** Every pull request that merged in the span, newest first. */
export function landedIn(pulls: CodePull[], span: Pick<Span, "from" | "now">): LandedChange[] {
  return pulls
    .filter((pull) => pull.status === "merged" && within(pull.mergedAt, span))
    .map((pull) => {
      const agent = isAgentPull(pull);
      const mergedBy = pull.mergedBy && pull.mergedBy !== pull.author.username ? `, merged by ${pull.mergedBy}` : "";
      return {
        key: `landed:${pullKey(pull.repo, pull.number)}`,
        kind: "merge" as const,
        title: pull.title,
        detail: `${pull.repo.name}#${pull.number} · by ${agent ? `@${pull.author.username}` : pull.author.username}${mergedBy}`,
        to: `/${pull.repo.namespace}/${pull.repo.name}/pull/${pull.number}`,
        at: Date.parse(pull.mergedAt!),
        sha: pull.mergeCommit ?? null,
        repoId: pull.repoId ?? null,
      };
    })
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** The names behind member keys, for a line: `ana and bo`, `@margo`, `an import` for nobody. */
function namesOf(keys: string[], names: Record<string, string>, agentKeys?: ReadonlySet<string>): string {
  const shown = keys.map((key) => {
    if (!key) return "an import";
    const name = names[key] ?? (key === G1T_ACTOR ? "g1t" : "someone");
    return actorKind(key, agentKeys) === "agent" ? `@${name}` : name;
  });
  return listOf([...new Set(shown)]);
}

/**
 * Commits pushed straight to a default branch, one row per project with
 * any: what landed without a pull request. Releases and package versions
 * published, one row each. Pushes within the span only: the digest was
 * asked for the span.
 */
export function landedFromActivity(
  activity: ActivityDigest | null,
  repos: Record<string, RepoRef>,
  names: Record<string, string>,
  slug: string,
  agentKeys?: ReadonlySet<string>,
): LandedChange[] {
  const rows: LandedChange[] = [];
  for (const repo of activity?.repos ?? []) {
    const path = repos[repo.repo_id];
    if (!path) continue;
    const direct = repo.pushes.default_branch;
    if (direct.count > 0 && direct.last_at) {
      const by = direct.by.map((entry) => entry.actor);
      rows.push({
        key: `push:${repo.repo_id}`,
        kind: "push",
        title: `${plural(direct.commits, "commit")} pushed to ${path.defaultBranch}`,
        detail: `${path.name} · ${plural(direct.count, "push", "pushes")} by ${namesOf(by, names, agentKeys)}`,
        to: `/${path.namespace}/${path.name}/activity`,
        at: Date.parse(direct.last_at),
      });
    }
    for (const release of repo.releases) {
      rows.push({
        key: `release:${repo.repo_id}:${release.tag}`,
        kind: "release",
        title: release.name ? `${release.tag} · ${release.name}` : release.tag,
        detail: `${path.name} · released by ${namesOf([release.actor], names, agentKeys)}`,
        to: `/${path.namespace}/${path.name}/releases/tag/${encodeURIComponent(release.tag)}`,
        at: Date.parse(release.at),
      });
    }
    for (const pkg of repo.packages) {
      rows.push({
        key: `package:${repo.repo_id}:${pkg.ecosystem}:${pkg.name}:${pkg.version}`,
        kind: "package",
        title: `${pkg.name} ${pkg.version}`,
        detail: `${pkg.ecosystem} package · published by ${namesOf([pkg.actor], names, agentKeys)}`,
        to: `/${slug}/-/packages`,
        at: Date.parse(pkg.at),
      });
    }
  }
  return rows;
}

/**
 * Production builds of the span as landed changes, only where nothing on
 * the list already says so: a merge or push whose live label links to the
 * build (`shipped.to`), or whose commit it built. So a build that shipped
 * a merge is that merge's "Live" label, not a row of its own; a redeploy,
 * a rollback or a build of a project whose pushes weren't read is a row,
 * and so is one that failed (`failed`). Previews stay on their project's
 * Deployments.
 */
export function landedDeploys(deploys: DeployRow[], shown: readonly LandedChange[] = []): LandedChange[] {
  const said = (row: DeployRow) =>
    shown.some((change) => (change.shipped?.to != null && change.shipped.to === row.to) || (!!change.sha && !!row.commit && change.sha.startsWith(row.commit)));
  return deploys
    .filter((row) => row.kind === "production" && !said(row))
    .map((row) => ({
      key: `landed:${row.key}`,
      kind: "deploy" as const,
      title: row.outcome === "failed" ? `Production of ${row.project} failed to deploy` : `Production of ${row.project} went live`,
      detail: `${row.commit} · by ${row.by ?? "someone"}`,
      to: row.to,
      at: row.at,
      ...(row.outcome === "failed" ? { failed: true } : {}),
    }));
}

/** Everything that landed, newest first. */
export function landed(parts: LandedChange[][]): LandedChange[] {
  return parts.flat().sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

// --- Pushes straight to a default branch, each ---------------------------------

/** A push to a default branch, with the history it brought read back. */
export type DirectPush = {
  repoId: string;
  repo: RepoRef;
  push: PushRecord & { id: string };
  /** Who pushed, by name; `someone` when it could not be read. */
  by: string;
};

/** The sessions a commit message names in `G1t-Session:` trailers. */
export function sessionTrailers(message: string): string[] {
  const ids = [...message.matchAll(/^G1t-Session:\s*(ses_[0-9a-z]+)\s*$/gim)].map((match) => match[1]!.toLowerCase());
  return [...new Set(ids)];
}

/** A commit message's first line. */
const subject = (message: string) => message.split("\n", 1)[0]!.trim();

/**
 * Each person's push to a default branch in the span, newest first, as a
 * landed change: its commit when it brought one ("Fix the bell's count"),
 * else how many; the session a commit names in a `G1t-Session:` trailer
 * as its agent mark. `history` is each repository's default branch read
 * back from its newest push, newest first; a push whose commits are not
 * in it (rewritten since) is left out, and so is g1t's own (a pull
 * request landing: Landed lists the merge).
 */
export function pushRows(
  pushes: DirectPush[],
  history: Record<string, Pick<Commit, "hash" | "parents" | "message">[]>,
  span: Pick<Span, "from" | "now">,
  byG1t: (commit: Pick<Commit, "hash" | "parents" | "message">) => boolean = () => false,
): LandedChange[] {
  const rows: LandedChange[] = [];
  for (const { repoId, repo, push, by } of pushes) {
    if (!pushedByPerson(push) || !within(push.time, span)) continue;
    const commits = history[repoId] ?? [];
    const start = commits.findIndex((commit) => commit.hash === push.data.after);
    if (start === -1) continue;
    const brought = pushedCommits(commits.slice(start), push.data.before, byG1t);
    if (brought.length === 0) continue;
    const newest = brought[0]!;
    const session = brought.flatMap((commit) => sessionTrailers(commit.message))[0] ?? null;
    const branch = repo.defaultBranch;
    rows.push({
      key: `push:${repoId}:${push.id}`,
      kind: "push",
      title: brought.length === 1 ? subject(newest.message) || `1 commit pushed to ${branch}` : `${plural(brought.length, "commit")} pushed to ${branch}`,
      detail: `${repo.name} · ${brought.length === 1 ? `pushed to ${branch}` : subject(newest.message)} · by ${by}`,
      to: brought.length === 1 ? `/${repo.namespace}/${repo.name}/commit/${newest.hash}` : `/${repo.namespace}/${repo.name}/activity`,
      at: Date.parse(push.time),
      sha: push.data.after,
      repoId,
      agent: session ? { harness: null, to: sessionPath(repo.namespace, session) } : null,
      ...(brought.length === 1 && subject(newest.message) ? { refsIn: `${repo.namespace}/${repo.name}` } : {}),
    });
  }
  return rows;
}

// --- Shipped: merge to deploy --------------------------------------------------

/**
 * Each merge and push with whether it is live yet, from what deployments
 * recorded as production deployed (`shipped`). A project that does not
 * deploy says nothing; a change deployments did not answer for keeps none.
 */
export function withShipped(rows: LandedChange[], answers: ShippedRepo[] | null): LandedChange[] {
  if (!answers) return rows;
  const byRepo = new Map(answers.map((answer) => [answer.repo_id, answer]));
  return rows.map((row) => {
    if (!row.sha || !row.repoId || (row.kind !== "merge" && row.kind !== "push")) return row;
    const answer = byRepo.get(row.repoId);
    const commit = answer?.deploys ? answer.commits.find((c) => c.sha === row.sha) : null;
    if (!commit) return row;
    return { ...row, shipped: { state: commit.state, at: commit.deployed_at ? Date.parse(commit.deployed_at) : null, to: commit.url } };
  });
}

/** What to ask deployments: each repository's merges and pushes with their commit and when they landed. */
export function shippedAsks(rows: LandedChange[]): { repo_id: string; commits: { sha: string; landed_at: string }[] }[] {
  const byRepo = new Map<string, { sha: string; landed_at: string }[]>();
  for (const row of rows) {
    if (!row.sha || !row.repoId || (row.kind !== "merge" && row.kind !== "push")) continue;
    const list = byRepo.get(row.repoId) ?? [];
    list.push({ sha: row.sha, landed_at: new Date(row.at).toISOString() });
    byRepo.set(row.repoId, list);
  }
  return [...byRepo].map(([repo_id, commits]) => ({ repo_id, commits }));
}

/** How long something took, short: "1 min", "45 min", "3 h", "2 d". */
function took(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** "Live 9 min after merge", "Waiting to deploy", "Deploying", "Deploy failed". */
export function shippedLabel(ship: ShipInfo, row: Pick<LandedChange, "kind" | "at">): string {
  switch (ship.state) {
    case "live":
      return ship.at != null ? `Live ${took(ship.at - row.at)} after ${row.kind === "merge" ? "merge" : "push"}` : "Live";
    case "deploying":
      return "Deploying";
    case "failed":
      return "Deploy failed";
    default:
      return "Waiting to deploy";
  }
}

// --- Done with an agent --------------------------------------------------------

/**
 * Each merged pull request with the harness session that made it, when
 * work tied one to it (`pullSessions`): the first, by when it started.
 */
export function withSessions(rows: LandedChange[], sessions: { repo: RepoPath; pulls: PullSessions[] }[] | null): LandedChange[] {
  if (!sessions) return rows;
  const found = new Map<string, AgentMark>();
  for (const { repo, pulls } of sessions) {
    for (const pull of pulls) {
      const first = pull.sessions[0];
      if (first) found.set(`landed:${pullKey(repo, pull.number)}`, { harness: first.harness, to: sessionPath(repo.namespace, first.id) });
    }
  }
  return rows.map((row) => (row.agent || !found.has(row.key) ? row : { ...row, agent: found.get(row.key)! }));
}

/** The agent mark's words: "Made in a Claude Code session", or "Made in a session". */
export function agentLabel(mark: AgentMark): string {
  return mark.harness ? `Made in a ${HARNESS_NAMES[mark.harness] ?? "harness"} session` : "Made in a session";
}

// --- Day by day ----------------------------------------------------------------

/** What landed on one day, newest first: "Today", "Yesterday", "Mon, Oct 12". */
export type LandedDay = { key: string; label: string; rows: LandedChange[] };

/** What landed, by the day it landed in the reader's time zone, newest day first. */
export function landedByDay(rows: LandedChange[], now: number, timeZone: string | null): LandedDay[] {
  const days: LandedDay[] = [];
  const today = dayIn(now, timeZone);
  const yesterday = dayIn(now - DAY, timeZone);
  for (const row of [...rows].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))) {
    const key = dayIn(row.at, timeZone);
    let day = days.find((d) => d.key === key);
    if (!day) {
      const label =
        key === today ? "Today" : key === yesterday ? "Yesterday" : formatIn(row.at, timeZone, { weekday: "short", month: "short", day: "numeric" });
      day = { key, label, rows: [] };
      days.push(day);
    }
    day.rows.push(row);
  }
  return days;
}

// --- While you were away -------------------------------------------------------

/** Something that settled by itself in the span: what it was, why it settled, where. */
export type SettledRow = { key: string; title: string; why: string; where: string | null; to: string; at: number };

/** What g1t settled for you, what shipped, and what still needs you, in the span. */
export type Away = {
  settled: SettledRow[];
  /** Merges and pushes in the span that went live, are waiting, deploying, or whose deployment failed. */
  shipped: number;
  waiting: number;
  deploying: number;
  failed: number;
  /** Rows in Where you're needed. */
  needs: number;
};

/**
 * Your notifications that settled by themselves in the span (a later run
 * passed, it merged, it deployed), newest first; one marked done by hand
 * is yours, not g1t's. Only this workspace's, and none about a repository
 * for a member without Code access.
 */
export function settledIn(items: InboxItem[] | null, slug: string, code: boolean, span: Pick<Span, "from" | "now">): SettledRow[] {
  return (items ?? [])
    .filter((item) => item.doneAt != null && settledLine(item) && within(item.doneAt, span))
    .filter((item) => (item.workspace ?? item.repo?.split("/")[0] ?? "").toLowerCase() === slug && (code || !item.repo))
    .map((item) => ({
      key: `settled:${item.id}`,
      // A work item's or pull request's own title; else the entry's ("CI failed on main in acme/web").
      title: item.number != null ? item.body || item.title : item.title,
      why: settledLine(item),
      where: item.repo ? `${item.repo}${item.number != null ? `#${item.number}` : ""}` : null,
      to: item.url,
      at: Date.parse(item.doneAt!),
    }))
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

export function awayOf(input: { settled: SettledRow[]; landed: LandedChange[] | null; needs: number }): Away {
  const count = (state: ShipState) => (input.landed ?? []).filter((row) => row.shipped?.state === state).length;
  return {
    settled: input.settled,
    shipped: count("live"),
    waiting: count("waiting"),
    deploying: count("deploying"),
    failed: count("failed"),
    needs: input.needs,
  };
}

/** A deployment's maker as a member key: an id becomes `user:<id>`, a key stays as it is. */
export function deployActorKey(createdBy: string | null | undefined): string | null {
  const by = (createdBy ?? "").trim();
  if (!by) return null;
  return /^(user|agent):/.test(by) ? by : `user:${by}`;
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
  /** Who made it, as a name (`@g1t` for g1t itself); null when the deployment does not say. */
  by: string | null;
};

/**
 * Builds that finished in the span, newest first: production builds each,
 * and previews too. A build that went live and was replaced since still
 * went live. Skipped builds are left out.
 */
export function deploysIn(
  projects: { slug: string; deployments: Deployment[] }[],
  workspace: string,
  span: Pick<Span, "from" | "now">,
  names: Record<string, string> = {},
  agentKeys?: ReadonlySet<string>,
): DeployRow[] {
  const rows: DeployRow[] = [];
  for (const project of projects) {
    for (const deploy of project.deployments) {
      // Who made it: the deployment names them by id, so it reads as a name, or as someone when identity doesn't know it.
      const key = deployActorKey(deploy.createdBy);
      const ended = deploy.finishedAt ?? null;
      if (!within(ended, span)) continue;
      const outcome =
        deploy.status === "failed" ? "failed" : deploy.status === "ready" || deploy.status === "replaced" || deploy.status === "down" ? "live" : null;
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
        by: key ? namesOf([key], names, agentKeys) : null,
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

// --- Running now ----------------------------------------------------------------

/** Something going right now: a workflow run or a build. */
export type RunningRow = {
  key: string;
  kind: "workflow" | "deploy";
  title: string;
  /** One line: who and where. */
  detail: string;
  /** "Running", "Queued", "Building". */
  status: string;
  /** Epoch ms: when it started. */
  at: number;
  to: string;
};

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

const RUN_STATUS: Partial<Record<WorkflowRun["status"], string>> = {
  pending: "Queued",
  queued: "Queued",
  action_required: "Needs approval",
  in_progress: "Running",
  waiting: "Waiting",
};

/** Workflow runs not finished, in the projects read: queued, waiting, running, or waiting for approval. */
export function runningWorkflows(projects: { repo: RepoPath; runs: WorkflowRun[] }[]): RunningRow[] {
  return projects.flatMap(({ repo, runs }) =>
    runs.flatMap((run) => {
      const status = RUN_STATUS[run.status];
      if (!status) return [];
      return [
        {
          key: `workflow:${repo.namespace}/${repo.name}:${run.id}`.toLowerCase(),
          kind: "workflow" as const,
          title: run.title ? `${run.name}: ${run.title}` : run.name,
          detail: `${repo.namespace}/${repo.name} ${run.ref.replace(/^refs\/heads\//, "")}${run.actor ? ` · by ${run.actor}` : ""}`,
          status,
          at: Date.parse(run.startedAt ?? run.createdAt),
          to: `/${repo.namespace}/${repo.name}/actions/runs/${run.id}`,
        },
      ];
    }),
  );
}

/** Everything running, longest-going first within each kind: workflow runs, then builds. */
export function running(parts: RunningRow[][]): RunningRow[] {
  const order = { workflow: 0, deploy: 1 } as const;
  return parts.flat().sort((a, b) => order[a.kind] - order[b.kind] || a.at - b.at || a.key.localeCompare(b.key));
}

// --- Needs you ------------------------------------------------------------------

/**
 * What a row is. Tiers, most pressing first:
 * 0. production is down to an older build (`deploy`);
 * 1. a change that can't land until someone acts on it (`pull_blocked`);
 * 2. something waiting only for you (a review, an invitation, your pull
 *    request that is ready to merge);
 * 3. a job waiting for a runner that is not there;
 * 4. an unread notification that is a warning or a failure;
 * 5. a mention or a direct message.
 */
export type AttentionKind = "deploy" | "pull_blocked" | "review" | "invitation" | "ready" | "runner" | "notification" | "chat";

export const TIER: Record<AttentionKind, number> = {
  deploy: 0,
  pull_blocked: 1,
  review: 2,
  invitation: 2,
  ready: 2,
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
  /** Who is on it: the person who asked, or g1t on older rows. */
  owner: { name: string; agent: boolean } | null;
  /** Epoch ms: when it started waiting. */
  at: number;
  /** Where it came from, for a member without Code access never `code`. */
  from: "code" | "notifications" | "chat";
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
  deploy: "Production is serving an older build until this is fixed, so it comes before anything else.",
  pull_blocked: "This change can't land until someone fixes it.",
  review: "You were asked by name, so it waits for your verdict.",
  invitation: "It is addressed to you; no one else can answer it.",
  ready: "Everything it needs is met; it lands when you merge it.",
  runner: "A job is waiting for a runner that is not there.",
  notification: "It is the most pressing unread notification.",
  chat: "Nothing else is waiting, and this is the oldest message for you.",
};

// --- Rows from each source ----------------------------------------------------

/** A Code Overview need row, as Home reads it (lib/mission-control.ts `NeedRow`). */
export type CodeNeed = {
  key: string;
  reason: string;
  repo: RepoPath | null;
  ref: string | null;
  title: string;
  ask: string;
  by: { name: string; agent: boolean } | null;
  at: number;
  to: string;
  facts: { label: string; value: string; tone: string | null }[];
};

const fact = (need: CodeNeed, label: string) => need.facts.find((f) => f.label === label)?.value ?? null;

const REASON_STAKE: Record<string, Stake> = {
  blocking: { text: "Blocking", tone: "danger" },
  checks_failing: { text: "Checks failing", tone: "danger" },
  needs_review: { text: "Needs a verdict", tone: "warn" },
  stalled: { text: "Stalled", tone: "warn" },
};

/** A Code need (failed deploy, pull request, review, invitation, runner) as a row. */
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
      return {
        ...base,
        kind: "runner",
        stake: { text: `Waiting ${fact(need, "Waiting") ?? ""}`.trim(), tone: "warn" },
        action: { label: "Look", to: need.to },
      };
    // Your pull request, which meets everything its branch asks for.
    case "ready":
      return { ...base, kind: "ready", stake: { text: "Ready to merge", tone: null }, action: { label: "Merge", to: need.to } };
    default:
      return {
        ...base,
        kind: "pull_blocked",
        stake: REASON_STAKE[need.reason] ?? { text: "Waiting on you", tone: "warn" },
        action: { label: need.reason === "needs_review" ? "Review" : "Look", to: need.to },
      };
  }
}

const NOTIFICATION_STAKE: Record<string, string> = {
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
 * gets none about a repository. A reason this page does not know (older
 * ones included) reads as a plain notification.
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
    owner: item.actor ? { name: item.actor, agent: isAgentName(item.actor) } : null,
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
  notifications: InboxItem[] | null;
  chat: ChatEntryLike[] | null;
}): Attention {
  const rows: AttentionRow[] = [];
  const missing: string[] = [];
  if (input.code) {
    if (input.codeNeeds) rows.push(...input.codeNeeds.map(codeRow));
    else missing.push("Code");
  }
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
 * the month's usage not yet closed included: the figure Usage
 * shows, so Home shows no other.
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
 * The sentence under the heading, honest about what happened: "Since
 * Tuesday evening, 3 people pushed 41 commits and merged 5 changes, and
 * 12 changes landed." What people did comes first (commits and merges;
 * else what they said), then everything that landed. When nothing at all
 * was counted: "Quiet since Tuesday evening: nothing pushed, merged,
 * deployed or said." When what people did could not be read, it says so.
 */
export function spanSentence(span: Pick<Span, "words">, digest: Pick<Digest, "summary"> | null, landed: number | null): string {
  const lead = span.words;
  if (!digest) return `${lead}, what happened couldn't be read.`;
  const { people: count, commits, merged, said, anything, peopleRead } = digest.summary;
  const landedCount = landed ?? 0;
  if (!anything && landedCount === 0) {
    if (!peopleRead) return `${lead}, what people did couldn't be read.`;
    return `Quiet ${lead.charAt(0).toLowerCase()}${lead.slice(1)}: nothing pushed, merged, deployed or said.`;
  }
  const parts: string[] = [];
  if (count > 0) {
    if (commits > 0 || merged > 0) {
      const did: string[] = [];
      if (commits > 0) did.push(`pushed ${plural(commits, "commit")}`);
      if (merged > 0) did.push(`merged ${plural(merged, "change")}`);
      parts.push(`${people(count)} ${did.join(" and ")}`);
    } else if (said > 0) parts.push(`${people(count)} sent ${plural(said, "message")}`);
    else parts.push(`${people(count)} ${count === 1 ? "was" : "were"} active`);
  }
  if (landedCount > 0) parts.push(`${plural(landedCount, "change")} landed`);
  const tail = peopleRead ? "" : "; what people did couldn't be read";
  if (parts.length === 0) return `${lead}, work went on, but nothing landed${tail}.`;
  const joined = parts.length > 2 ? `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}` : parts.join(" and ");
  return `${lead}, ${joined}${tail}.`;
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

/** "3:40 PM": the time of day alone, for a row under its day's heading. */
export function timeOfDay(at: number, timeZone: string | null): string {
  return formatIn(at, timeZone, { hour: "numeric", minute: "2-digit" });
}

/** "3:40 PM" when it is the same day as `now`, else "Oct 7". */
export function whenShort(at: number, now: number, timeZone: string | null): string {
  if (dayIn(at, timeZone) === dayIn(now, timeZone)) return formatIn(at, timeZone, { hour: "numeric", minute: "2-digit" });
  return now - at < 6 * DAY ? formatIn(at, timeZone, { weekday: "short", hour: "numeric" }) : shortDate(at, timeZone);
}

// --- Asking g1t from Home ------------------------------------------------------------

type AskedSpan = Pick<Span, "key" | "note" | "words" | "from" | "now">;

/** The span as a person would say it: "since I was last here (2:12 PM)", "in the last 24 hours". */
function spanSaid(span: AskedSpan, timeZone: string | null): string {
  if (span.key === "last" && span.note == null) return `since I was last here (${whenShort(span.from, span.now, timeZone)})`;
  return `${span.words.charAt(0).toLowerCase()}${span.words.slice(1)}`;
}

/**
 * Home's Summarize: what changed in the span, in plain English, as a person
 * would ask it. g1t is told the page and the viewer's zone, and its prompt
 * says how to read what shipped (services/integrations ask.rs).
 */
export function summarizeQuestion(span: AskedSpan, timeZone: string | null): string {
  return `Summarize what changed ${spanSaid(span, timeZone)} in plain English.`;
}

/** What a change's page is, in words: "pull request #47 in acme/web", "commit f2c1aa0 in acme/web"; else its path. */
export function changeRef(to: string): string {
  const pull = to.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (pull) return `pull request #${pull[3]} in ${pull[1]}/${pull[2]}`;
  const commit = to.match(/^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/i);
  if (commit) return `commit ${commit[3]!.slice(0, 7)} in ${commit[1]}/${commit[2]}`;
  return to;
}

/** A Landed row's Explain: what one change did and why, in plain English. */
export function explainQuestion(change: Pick<LandedChange, "kind" | "title" | "to">): string {
  if (change.kind === "deploy") return `What went out in this deployment (${change.to}), in plain English?`;
  if (change.kind === "release" || change.kind === "package") return `What's new in ${change.title} (${change.to}), in plain English?`;
  return `Explain ${changeRef(change.to)} in plain English: what changed, why, and is it live?`;
}

/** What Home's Ask box offers to ask first, after Summarize: a label, and the question it asks. */
export const HOME_STARTERS: { label: string; question: string }[] = [
  { label: "What needs me first?", question: "What needs me first? Most urgent first, one line each on what to do." },
  { label: "What shipped today?", question: "What shipped today? What's live, what's still deploying, and what failed." },
  { label: "Who's working on what?", question: "Who's working on what right now, and is anything stuck?" },
];
