/**
 * The shaping behind Code's Overview: why each thing needs the viewer,
 * what is known about it, the tabs, the week of landed changes, and the
 * one sentence under the title. Pure, so it is tested on its own; it
 * imports only types.
 */
import type { CheckStatus, ChangedFile, RepoPath } from "@g1t/contracts";

import type { Need } from "./mission";

const DAY = 24 * 60 * 60 * 1000;

/** Accounts that are g1t's own machinery: `isAgent` in ./mission, kept here so this module imports only types. Older rows still name them. */
export function isAgent(name: string | null | undefined): boolean {
  return name === "g1t" || (name ?? "").endsWith("-agent");
}

// --- Reasons ----------------------------------------------------------------

/** Why something is waiting on a person, as the chip beside it says. */
export type Reason = "blocking" | "invited" | "needs_review" | "checks_failing" | "stalled";

export const REASON_LABEL: Record<Reason, string> = {
  blocking: "Blocking",
  invited: "Invitation",
  needs_review: "Review requested",
  checks_failing: "Checks failing",
  stalled: "Stalled",
};

/** The reason a need is shown, from its kind. */
export function reasonFor(need: Pick<Need, "kind">): Reason {
  switch (need.kind) {
    case "deploy":
    case "conflict":
      return "blocking";
    case "invitation":
      return "invited";
    case "review":
    case "ready":
      return "needs_review";
    case "checks":
      return "checks_failing";
    case "stalled":
    case "stuck":
    case "runner":
      return "stalled";
  }
}

/** Why only a person can move it: the callout beside what is known. */
export function whyFor(reason: Reason, need: Pick<Need, "kind">): string {
  if (need.kind === "deploy")
    return "Production still serves the build before this one. Every push to the default branch builds again, so this fails until what broke is fixed.";
  if (need.kind === "invitation") return "An invitation is to you. No one else can accept it.";
  if (need.kind === "review") return "You were asked to review it by name, so it waits for your verdict.";
  if (need.kind === "runner")
    return "The job runs only on a self-hosted runner with those labels, and none is connected. It starts as soon as one is; nothing else picks it up.";
  switch (reason) {
    case "blocking":
      return "Nothing moves until someone decides how it lands, or whether it should.";
    case "checks_failing":
      return "It was taken out of the merge queue because its checks failed with what was ahead of it. Push a fix, then merge it again.";
    case "needs_review":
      return "It waits for a verdict before it can land.";
    case "invited":
      return "It is addressed to you.";
    case "stalled":
      return "It has stopped moving and needs a look.";
  }
}

/** Reasons where nothing moves until a person acts on it. */
export const BLOCKING: ReadonlySet<Reason> = new Set<Reason>(["blocking"]);

// --- What is known ----------------------------------------------------------

export type FactTone = "good" | "warn" | "bad" | null;
/** One thing known; a `wide` one takes the whole row and wraps. */
export type Fact = { label: string; value: string; tone: FactTone; wide?: boolean };

/** How the checks the default branch requires stand on a pull request, from what a list knows without opening it. */
export function checksFact(checkStatus: CheckStatus | null): Fact {
  const fact = (value: string, tone: FactTone): Fact => ({ label: "Required checks", value, tone });
  if (checkStatus === "failed") return fact("Failed in the merge queue", "bad");
  if (checkStatus === "passed") return fact("Passing", "good");
  if (checkStatus === "queued" || checkStatus === "running") return fact("Running", null);
  return fact("Not known yet", null);
}

/** Test files, by the names test runners look for. */
export function isTestFile(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|spec)\//i.test(path) ||
    /[._-](test|spec)\.[a-z0-9]+$/i.test(path) ||
    /_test\.(go|rs|py)$/i.test(path) ||
    // A file named for what it is: test.js, tests.py, spec.rb.
    /(^|\/)(tests?|specs?)\.[a-z0-9]+$/i.test(path)
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * What is known about a pull request without opening it: its checks, how
 * much it changes and the tests it touches. Only what is known is listed.
 */
export function pullFacts(input: { checkStatus: CheckStatus | null; files: ChangedFile[] }): Fact[] {
  const facts: Fact[] = [checksFact(input.checkStatus)];
  if (input.files.length > 0) {
    const added = input.files.reduce((sum, f) => sum + f.additions, 0);
    const removed = input.files.reduce((sum, f) => sum + f.deletions, 0);
    facts.push({ label: "Files changed", value: input.files.length.toLocaleString("en-US"), tone: null });
    facts.push({ label: "Lines", value: `+${added.toLocaleString("en-US")} −${removed.toLocaleString("en-US")}`, tone: null });
    const tests = input.files.filter((f) => isTestFile(f.path)).length;
    facts.push({ label: "Tests", value: tests > 0 ? plural(tests, "file") : "None touched", tone: tests > 0 ? "good" : "warn" });
  }
  return facts;
}

// --- Rows -------------------------------------------------------------------

/** Someone on a row: a person, or g1t itself on older rows. */
export type Who = { name: string; agent: boolean };

export const who = (name: string | null | undefined): Who | null => (name ? { name, agent: isAgent(name) } : null);

/** A form on the page that acts without leaving it. */
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
  /** Who is waiting: the author, or the person who asked. */
  by: Who | null;
  at: number;
  to: string;
  open: string;
  facts: Fact[];
  why: string;
  quick: QuickAction | null;
  /** Somewhere else to act, when that is the next step. */
  link: { label: string; to: string } | null;
};

const pathKey = (repo: RepoPath, number: number | null) => `${repo.namespace}/${repo.name}#${number ?? "-"}`.toLowerCase();

// --- Landed -----------------------------------------------------------------

/**
 * The accounts g1t itself acts as on the event log: the account older rows
 * name, and the policy that merges and pushes for it. An event's `actor`
 * is an account id, so this is what tells g1t apart, whatever name a
 * commit carries.
 */
export const G1T_ACCOUNT_IDS: ReadonlySet<string> = new Set(["usr_g1t_agent", "g1t_policy"]);

/** A `git.push` from the log, as far as placing its commits needs it. */
export type PushRecord = {
  time: string;
  /** The account that pushed; null when the log does not say. */
  actor?: string | null;
  data: { after: string; before?: string; causedByJob?: string };
};

/**
 * Whether a person pushed: not g1t itself (by the account that signed in
 * to push), and not a workflow job's own token.
 */
export function pushedByPerson(push: Pick<PushRecord, "actor" | "data">): boolean {
  if (push.data.causedByJob) return false;
  return !(push.actor && G1T_ACCOUNT_IDS.has(push.actor));
}

/**
 * The commits a person's push to the default branch brought, from the
 * history at its `after` (newest first) back to its `before`: their own,
 * not merges (a pull request landing) and not g1t's (`byG1t`: a commit
 * g1t wrote, told by its author address, which a person may fast-forward
 * onto the branch). A push whose `before` is not in what was read gives
 * what was read. Who pushed is the caller's to decide (`pushedByPerson`);
 * a commit's author name says nothing about it.
 */
export function pushedCommits<C extends { hash: string; parents: string[] }>(
  history: C[],
  before: string | undefined,
  byG1t: (commit: C) => boolean = () => false,
): C[] {
  const end = before ? history.findIndex((commit) => commit.hash === before) : -1;
  const brought = end === -1 ? history : history.slice(0, end);
  return brought.filter((commit) => commit.parents.length <= 1 && !byG1t(commit));
}

/**
 * Each commit of `history` (newest first) a person's push in `pushes`
 * (newest first) brought, at that push's time. A commit pushed twice
 * (after a force push, say) counts once, at its first landing; a push
 * whose `after` is no longer in the history (rewritten) brings nothing,
 * and g1t's own pushes bring nothing here: pull requests count those.
 */
export function placePushes<C extends { hash: string; parents: string[] }>(
  history: C[],
  pushes: PushRecord[],
  byG1t: (commit: C) => boolean = () => false,
): { hash: string; at: string }[] {
  const index = new Map(history.map((commit, i) => [commit.hash, i]));
  // Each commit's first landing: the time, or null when g1t landed it.
  const seen = new Map<string, string | null>();
  for (const push of [...pushes].reverse()) {
    const start = index.get(push.data.after);
    if (start === undefined) continue;
    const end = push.data.before ? index.get(push.data.before) : undefined;
    const range = history.slice(start, end ?? history.length);
    const at = pushedByPerson(push) ? push.time : null;
    for (const commit of pushedCommits(range, undefined, byG1t)) {
      if (!seen.has(commit.hash)) seen.set(commit.hash, at);
    }
  }
  return [...seen].flatMap(([hash, at]) => (at ? [{ hash, at }] : []));
}

/**
 * Whether a read of the default branch reaches back far enough to place
 * every push, newest first: it holds the oldest push's `before`, or it is
 * the whole branch. A shorter read than `asked` is the whole branch.
 */
export function historyCovers(history: { hash: string }[], pushes: PushRecord[], asked: number): boolean {
  if (history.length < asked) return true;
  const oldest = pushes.at(-1)?.data.before;
  return oldest != null && history.some((commit) => commit.hash === oldest);
}

/** A merged pull request, as the week counts it. */
export type Merged = {
  repo: RepoPath;
  number: number;
  title: string;
  mergedBy: string | null;
  mergedAt: string;
  files: ChangedFile[];
};

/**
 * Whether a change landed without anyone pressing merge: g1t merged it, by
 * auto-merge or from the merge queue.
 */
export function mergedAutomatically(change: Pick<Merged, "mergedBy">): boolean {
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

/** One day's landed changes. */
export type WeekDay = { key: string; label: string; count: number };

export type Week = {
  days: WeekDay[];
  /** Changes landed in the last seven days. */
  total: number;
  /** The seven days before, or null when the lists read do not reach back that far. */
  previous: number | null;
};

/**
 * The last seven days in the viewer's zone, oldest first, each with how
 * many changes landed, and the week before as one number. `complete` says
 * whether what was read reaches back two weeks; when it does not, the week
 * before is not guessed.
 */
export function weekOf(changes: Pick<Merged, "mergedAt">[], now: number, timeZone: string | null, complete = true): Week {
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
    days.push({ key, label, count: 0 });
  }
  const oldest = days[0]?.key ?? "";
  const twoWeeks = dayKey(now - 13 * DAY, timeZone);
  let previous = 0;
  for (const change of changes) {
    const at = Date.parse(change.mergedAt);
    if (!Number.isFinite(at) || at > now) continue;
    const key = dayKey(at, timeZone);
    const slot = index.get(key);
    if (slot != null) days[slot].count += 1;
    else if (key < oldest && key >= twoWeeks) previous += 1;
  }
  return { days, total: days.reduce((sum, day) => sum + day.count, 0), previous: complete ? previous : null };
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

/** One change that landed, as the Landed tab lists it. */
export type LandedRow = {
  key: string;
  repo: RepoPath;
  ref: string;
  title: string;
  /** Who merged it; g1t for a change that merged automatically. */
  by: Who | null;
  automatic: boolean;
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
      automatic: mergedAutomatically(change),
      at: Date.parse(change.mergedAt),
      to: `/${change.repo.namespace}/${change.repo.name}/pull/${change.number}`,
      facts: pullFacts({ checkStatus: "passed", files: change.files }).filter((fact) => fact.label !== "Required checks"),
    }));
}

// --- Tabs and sorting -------------------------------------------------------

export type Tab = "needs" | "landed";
export type Sort = "impact" | "newest";

export const TABS: Tab[] = ["needs", "landed"];

export function parseTab(value: string | null): Tab | null {
  return value === "needs" || value === "landed" ? value : null;
}

export function parseSort(value: string | null): Sort {
  return value === "newest" ? "newest" : "impact";
}

/** Rows in the order chosen: as ranked (most urgent first), or newest first. */
export function sortRows<T extends { at: number }>(rows: T[], sort: Sort): T[] {
  return sort === "newest" ? [...rows].sort((a, b) => b.at - a.at) : rows;
}

// --- The summary ------------------------------------------------------------

/** The sentence under the title: the week, in one line. */
export function summaryLine(input: { total: number; needs: number }): string {
  const { total, needs } = input;
  if (total > 0) return `${plural(total, "change")} landed in the last 7 days.`;
  if (needs > 0) return "Nothing has landed this week. What is waiting on you is below.";
  return "Nothing has landed this week yet.";
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
