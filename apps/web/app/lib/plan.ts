/**
 * Work's Plan: what the workspace is on now, what comes next and what can
 * wait, and the moves that change it. Where its pages are, how a drop or
 * a menu's move becomes a position (`before`, `after` or `top`), what a
 * move looks like before the work service answers, and how full Now is.
 * Pure, so it is tested under Node.
 */
import type { Appetite, Claim, Hill, Horizon, Plan, PlanGroup, PlanSuggestion, PlanWorkItemInput, WorkItem, WorkspaceSession } from "@g1t/contracts";

import { workPath } from "./work-items.ts";

// The contracts' `HORIZONS` and `APPETITES`, here so the tests run under
// Node, which imports only types from @g1t/contracts.

/** Every horizon, in the order work moves through them. */
export const HORIZONS: readonly Horizon[] = ["triage", "now", "next", "later", "set_aside"];
/** Every appetite, smallest first. */
export const APPETITES: readonly Appetite[] = ["small", "medium", "large"];
/** Every stage of a hill, in the order work goes over it (the contracts' `HILLS`). */
export const HILL_STEPS: readonly Hill[] = ["figuring_out", "decided", "building", "landing"];

/** The Plan, Work's first page. */
export function planPath(workspace: string, query = ""): string {
  return `${workPath(workspace)}${query ? `?${query}` : ""}`;
}

/** Triage: new work items nobody has placed yet. */
export function triagePath(workspace: string): string {
  return workPath(workspace, "triage");
}

/** All items: the Work list, with its filters (`state=closed&label=bug`). */
export function allItemsPath(workspace: string, query = ""): string {
  return `${workPath(workspace, "all")}${query ? `?${query}` : ""}`;
}

/** The All items list of what is set aside. */
export function setAsidePath(workspace: string): string {
  return allItemsPath(workspace, new URLSearchParams({ q: "horizon:set_aside" }).toString());
}

/**
 * The query parameters that belong to the Work list (lib/work-items.ts
 * `workFilters`, and the paging and sort it keeps): `-/work` with any of
 * them is an old link to the list, which is at `-/work/all` now.
 */
export const LIST_PARAMS = ["q", "label", "milestone", "assignee", "state", "repo", "role", "parent", "author", "horizon", "before", "sort", "page"] as const;

/** Where `-/work` with this query leads instead of the Plan: the list with the same query, or null to show the Plan. */
export function listRedirect(workspace: string, query: URLSearchParams): string | null {
  const kept = new URLSearchParams(query);
  kept.delete("_routes");
  kept.delete("index");
  if (!LIST_PARAMS.some((key) => kept.has(key))) return null;
  return allItemsPath(workspace, kept.toString());
}

/** How full Now is: its share of the cap (at most 1, for the bar) and whether it is at or past it. */
export type CapState = { count: number; cap: number; share: number; full: boolean; over: boolean };

export function capState(count: number, cap: number): CapState {
  const limit = Math.max(1, cap);
  return { count, cap: limit, share: Math.min(1, count / limit), full: count >= limit, over: count > limit };
}

/**
 * Where a move puts a work item among another horizon's (or its own)
 * items: before or after another, first, or (none set) where the horizon
 * puts it. At most one is set.
 */
export type Position = { before?: number; after?: number; top?: true };

/**
 * The position for dropping `dragged` into `list` (the numbers as shown,
 * top first, which may include `dragged` itself) at `index`, the gap it
 * lands in (0 is above the first, `list.length` below the last): before
 * the row it lands above, else after the last, else none (an empty list,
 * where the horizon alone says where). Null when it lands where it is.
 */
export function dropPosition(list: readonly number[], index: number, dragged: number): Position | null {
  const from = list.indexOf(dragged);
  if (from !== -1 && (index === from || index === from + 1)) return null;
  const rest = list.filter((number) => number !== dragged);
  const at = from !== -1 && from < index ? index - 1 : index;
  const clamped = Math.max(0, Math.min(at, rest.length));
  if (clamped < rest.length) return { before: rest[clamped]! };
  if (rest.length > 0) return { after: rest[rest.length - 1]! };
  return {};
}

/** Moving `number` one place up in `list`: before the one above it. Null at the top, or when it is not there. */
export function moveUp(list: readonly number[], number: number): Position | null {
  const at = list.indexOf(number);
  return at > 0 ? { before: list[at - 1]! } : null;
}

/** Moving `number` one place down in `list`: after the one below it. Null at the bottom, or when it is not there. */
export function moveDown(list: readonly number[], number: number): Position | null {
  const at = list.indexOf(number);
  return at !== -1 && at < list.length - 1 ? { after: list[at + 1]! } : null;
}

/** A move in the plan, as a row's menu, a drop or Triage's buttons make it. */
export type Move = { number: number; horizon: Horizon } & Position;

/** What the Plan page shows: the plan, as `getPlan` read it. */
export type PlanView = Pick<Plan, "now" | "next" | "nextTotal" | "laterTotal" | "later" | "setAsideTotal" | "triageTotal">;

/**
 * The plan as it will be once `move` is made, to show before the work
 * service answers: the item leaves wherever it was and goes where the
 * move says, on Now or Next (or, past the top of Next shown, only into
 * its count), or into the count of the horizon it went to.
 */
export function applyMove(view: PlanView, move: Move, from?: WorkItem): PlanView {
  const found = view.now.find((item) => item.number === move.number) ?? view.next.find((item) => item.number === move.number) ?? from;
  const now = view.now.filter((item) => item.number !== move.number);
  const next = view.next.filter((item) => item.number !== move.number);
  const out: PlanView = { ...view, now, next };
  if (found?.horizon === move.horizon && !view.now.includes(found) && !view.next.includes(found)) return view;
  if (found?.horizon === "next") out.nextTotal -= 1;
  if (found?.horizon === "later") {
    out.laterTotal -= 1;
    out.later = bump(out.later, originPath(found), -1);
  }
  if (found?.horizon === "triage") out.triageTotal -= 1;
  if (move.horizon === "next") out.nextTotal += 1;
  if (move.horizon === "later") {
    out.laterTotal += 1;
    if (found) out.later = bump(out.later, originPath(found), 1);
  }
  if (move.horizon === "set_aside") out.setAsideTotal += 1;
  if (move.horizon === "triage") out.triageTotal += 1;
  if (!found || (move.horizon !== "now" && move.horizon !== "next")) return out;
  const moved: WorkItem = { ...found, horizon: move.horizon };
  const list = move.horizon === "now" ? now : next;
  // Next shows only its top: one placed below all of it that is shown is only counted.
  const whole = move.horizon === "now" || list.length >= out.nextTotal - 1;
  let at = -1;
  if (move.top) at = 0;
  else if (move.before != null) at = list.findIndex((item) => item.number === move.before);
  else if (move.after != null) {
    const below = list.findIndex((item) => item.number === move.after);
    at = below === -1 ? -1 : below + 1;
  }
  if (at !== -1) list.splice(at, 0, moved);
  else if (whole) list.push(moved);
  return out;
}

/** Later's groups with `by` more (or fewer) in `repo`'s; a group left with none goes. */
function bump(groups: readonly PlanGroup[], repo: string | null, by: number): PlanGroup[] {
  const same = (group: PlanGroup) => (group.repo ?? "").toLowerCase() === (repo ?? "").toLowerCase();
  if (!groups.some(same)) return by > 0 ? [...groups, { repo, count: by }] : [...groups];
  return groups.map((group) => (same(group) ? { ...group, count: group.count + by } : group)).filter((group) => group.count > 0);
}

/** The move a form posts (`moveForm`'s fields), or null when it is not one. */
export function moveFrom(form: Fields): Move | null {
  const number = Number(form.get("number"));
  const horizon = HORIZONS.find((one) => one === form.get("horizon"));
  if (!Number.isInteger(number) || number < 1 || !horizon) return null;
  if (form.get("top") === "1") return { number, horizon, top: true };
  const before = Number(form.get("before"));
  if (form.has("before") && before > 0) return { number, horizon, before };
  const after = Number(form.get("after"));
  if (form.has("after") && after > 0) return { number, horizon, after };
  return { number, horizon };
}

/**
 * The repository a work item is filed in (its origin), by path; null for one
 * filed in the workspace, or in a repository since deleted, which Later
 * counts with the workspace's since it has nothing to open.
 */
export function originPath(item: Pick<WorkItem, "repos">): string | null {
  const origin = item.repos.find((repo) => repo.role === "origin");
  return (!origin?.deleted && origin?.path) || null;
}

/** The moves a row's menu offers, given where it is and whether the viewer may move work into or out of Now. */
export function menuHorizons(horizon: Horizon, canNow: boolean): Horizon[] {
  return HORIZONS.filter((one) => one !== horizon && (canNow || (one !== "now" && horizon !== "now")));
}

/** Who or what is on a work item: people (assignees, claimants, whoever runs a live session on it), and its live sessions. */
export type OnIt = { people: string[]; sessions: WorkspaceSession[] };

/** Who is on each of `items`, by number, from the workspace's active claims and live sessions, as the board says. */
export function onItems(items: readonly WorkItem[], claims: readonly Claim[], sessions: readonly WorkspaceSession[]): Record<number, OnIt> {
  const on: Record<number, OnIt> = {};
  for (const item of items) {
    const claimed = claims.filter((claim) => claim.item === item.number && claim.state === "active");
    const live = sessions.filter((session) => session.item === item.number && session.state !== "ended");
    const people = [...item.assignees, ...claimed.map((claim) => claim.actor.username), ...live.flatMap((session) => (session.actor ? [session.actor] : []))];
    on[item.number] = { people: [...new Set(people)], sessions: live };
  }
  return on;
}

/**
 * The work items that `items` wait on and whose state is not known from
 * `open` (the open ones already read), each once, the first `max`: the
 * ones to look up.
 */
export function blockersToRead(items: readonly Pick<WorkItem, "blockedBy">[], open: ReadonlySet<number>, max = 20): number[] {
  const wanted = new Set<number>();
  for (const item of items) for (const number of item.blockedBy) if (!open.has(number)) wanted.add(number);
  return [...wanted].slice(0, max);
}

/** What an item waits on: the work items it is blocked by that are not known to be closed. */
export function waitingOn(item: Pick<WorkItem, "blockedBy">, closed: ReadonlySet<number>): number[] {
  return item.blockedBy.filter((number) => !closed.has(number));
}

/** "waiting on #12", "waiting on #12, #14". */
export function waitingLabel(numbers: readonly number[]): string {
  return `waiting on ${numbers.map((number) => `#${number}`).join(", ")}`;
}

/** What each appetite means, in a few words. */
export const APPETITE_HINTS: Record<Appetite, string> = {
  small: "Small: one session",
  medium: "Medium: a few sessions, about a week",
  large: "Large: a phase, broken into smaller items before it moves to Now",
};

/** The appetites at once, for a hint beside a choice of them. */
export const APPETITE_SUMMARY = "S: one session. M: a few sessions, about a week. L: a phase, broken down before it moves to Now.";

/** What each horizon is for, in a few words. */
export const HORIZON_HINTS: Record<Horizon, string> = {
  triage: "New, and not placed yet",
  now: "What the workspace is on",
  next: "Ranked: the top is taken first",
  later: "Wanted, not ranked",
  set_aside: "Out of every view but search",
};

/** The most a budget may be, in dollars, as the work service allows. */
export const MAX_BUDGET_USD = 100_000;

/** A form's fields, as `FormData` has them. */
type Fields = { get(name: string): FormDataEntryValue | null; has(name: string): boolean };

/**
 * A move in the plan from a form: `horizon`, then one of `before`, `after`
 * (work item numbers) or `top=1`; `appetite` (`small`, `medium`, `large`,
 * or `none` to clear it); `budget` in dollars (empty clears it); `urgent`
 * (`1` or `0`). Only the fields given change. A string when the form says
 * something the plan cannot take.
 */
export function planInput(form: Fields): PlanWorkItemInput | string {
  const input: PlanWorkItemInput = {};
  if (form.has("horizon")) {
    const horizon = HORIZONS.find((one) => one === form.get("horizon"));
    if (!horizon) return "Choose where it goes: Triage, Now, Next, Later or Set aside.";
    input.horizon = horizon;
  }
  const number = (name: string) => {
    const value = Number(form.get(name));
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  if (form.get("top") === "1") input.top = true;
  else if (form.has("before")) {
    const before = number("before");
    if (before == null) return "That position is not a work item.";
    input.before = before;
  } else if (form.has("after")) {
    const after = number("after");
    if (after == null) return "That position is not a work item.";
    input.after = after;
  }
  if (form.has("appetite")) {
    const value = String(form.get("appetite"));
    if (value === "none" || value === "") input.appetite = null;
    else {
      const appetite = APPETITES.find((one) => one === value);
      if (!appetite) return "Choose an appetite: S, M or L.";
      input.appetite = appetite;
    }
  }
  if (form.has("budget")) {
    const budget = parseBudget(String(form.get("budget") ?? ""));
    if (typeof budget === "string") return budget;
    input.budget_usd = budget;
  }
  if (form.has("urgent")) input.urgent = form.get("urgent") === "1";
  return input;
}

/** A budget as someone typed it (`40`, `$12.50`, `1,200`): dollars, null for none, or why it is not one. */
export function parseBudget(text: string): number | null | string {
  const tidy = text.replace(/[$,\s]/g, "");
  if (!tidy) return null;
  const value = Number(tidy);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_BUDGET_USD) {
    return `A budget is a number of dollars above 0 and up to ${MAX_BUDGET_USD.toLocaleString("en-US")}.`;
  }
  return Math.round(value * 100) / 100;
}

/** A budget as the plan shows it: `$40`, `$12.50`. */
export function budgetText(budget: number): string {
  return `$${budget.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(budget) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** A move as the form its fetcher posts. */
export function moveForm(move: Move): Record<string, string> {
  const form: Record<string, string> = { action: "plan", number: String(move.number), horizon: move.horizon };
  if (move.top) form.top = "1";
  else if (move.before != null) form.before = String(move.before);
  else if (move.after != null) form.after = String(move.after);
  return form;
}

/** How many more there are than are shown, as "n more"; null for none. */
export function moreText(shown: number, total: number): string | null {
  return total > shown ? `${(total - shown).toLocaleString("en-US")} more` : null;
}

// --- How Now stands -----------------------------------------------------------

const DAY_MS = 86_400_000;

/** Where `hill` is among its four stages: 0 (figuring it out) to 3 (landing). */
export function hillStep(hill: Hill): number {
  return Math.max(0, HILL_STEPS.indexOf(hill));
}

/** Whole days since `at` (RFC 3339), never fewer than 0; null when there is no time. */
export function daysSince(at: string | null | undefined, now: number): number | null {
  const time = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now - time) / DAY_MS));
}

/**
 * What a quiet row says: "Quiet for 6 days", counted from the last time
 * anything happened on it; "Quiet" alone when that is not known (or is
 * today, as clocks differ). Null
 * for one that is not quiet.
 */
export function quietText(progress: { quiet: boolean; activeAt: string | null }, now: number): string | null {
  if (!progress.quiet) return null;
  const days = daysSince(progress.activeAt, now);
  if (days == null || days < 1) return "Quiet";
  return `Quiet for ${days === 1 ? "1 day" : `${days.toLocaleString("en-US")} days`}`;
}

/** How each work item in Now stands, by number. */
export function progressOf<P extends { number: number }>(progress: readonly P[]): Record<number, P> {
  return Object.fromEntries(progress.map((one) => [one.number, one]));
}

/** Days with nothing happening before a work item in Now has gone quiet (the contracts' `QUIET_DAYS`). */
export const QUIET_AFTER_DAYS = 5;

/** The week's line about Now going quiet; null for none. */
export function quietLine(count: number): string | null {
  if (count <= 0) return null;
  const one = count === 1;
  return `${count.toLocaleString("en-US")} in Now ${one ? "has" : "have"} gone quiet, with nothing happening on ${one ? "it" : "them"} for ${QUIET_AFTER_DAYS} days or more.`;
}

/** The week's line about letting go; null for none set aside lately. */
export function setAsideLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count.toLocaleString("en-US")} set aside in the last 30 days, untouched for 90 days in Later`;
}

/** Triage's banner on the Plan: how many wait, and how many of them have waited more than a week. */
export function triageLine(total: number, waiting: number): string {
  const wait = total === 1 ? "1 new work item waits" : `${total.toLocaleString("en-US")} new work items wait`;
  const long =
    waiting <= 0
      ? ""
      : waiting >= total
        ? total === 1
          ? " It has waited more than a week."
          : " All have waited more than a week."
        : ` ${waiting.toLocaleString("en-US")} of them have waited more than a week.`;
  return `${wait} in Triage to be placed.${long}`;
}

// --- Triage's suggestions -------------------------------------------------------

/** A suggestion in a few words: "Next · M". */
export function suggestionText(suggestion: Pick<PlanSuggestion, "horizon" | "appetite">): string {
  const horizon = { triage: "Triage", now: "Now", next: "Next", later: "Later", set_aside: "Set aside" }[suggestion.horizon];
  const size = suggestion.appetite ? ` · ${suggestion.appetite === "small" ? "S" : suggestion.appetite === "medium" ? "M" : "L"}` : "";
  return `${horizon}${size}`;
}

/**
 * Accepting a suggestion, as the form a fetcher posts (`planInput` reads
 * it): its horizon, where the horizon puts new work (the bottom of Next),
 * and its appetite when it has one.
 */
export function acceptForm(suggestion: Pick<PlanSuggestion, "horizon" | "appetite">): Record<string, string> {
  const form: Record<string, string> = { horizon: suggestion.horizon };
  if (suggestion.appetite) form.appetite = suggestion.appetite;
  return form;
}

/** Whether the viewer may accept a suggestion: moving into Now takes more than placing work elsewhere. */
export function canAccept(suggestion: Pick<PlanSuggestion, "horizon">, canNow: boolean): boolean {
  return suggestion.horizon !== "triage" && (suggestion.horizon !== "now" || canNow);
}

/** The comment a work item closed as a duplicate gets. */
export function duplicateComment(of: number): string {
  return `Duplicate of #${of}`;
}

/** The Plan's own options, as its address keeps them: every item of Next (`all=1`), and sub-items under their parent (`group=1`). */
export type PlanOptions = { all: boolean; group: boolean };

export function planOptions(query: URLSearchParams): PlanOptions {
  return { all: query.get("all") === "1", group: query.get("group") === "1" };
}

/** The Plan with `change` made to its options. */
export function planOptionsPath(workspace: string, options: PlanOptions, change: Partial<PlanOptions> = {}): string {
  const next = { ...options, ...change };
  const query = new URLSearchParams();
  if (next.all) query.set("all", "1");
  if (next.group) query.set("group", "1");
  return planPath(workspace, query.toString());
}

/** A row of a horizon with its sub-items grouped: the item, how deep it sits under a parent, and where it stands in the horizon's own order. */
export type GroupedRow<T> = { item: T; depth: number; index: number };

/**
 * A horizon's items with each sub-item under its parent, when its parent
 * is in the same horizon; the rest stay where they are. Parents keep the
 * horizon's order, and so do the sub-items under each. Grouping only
 * draws them so: it moves nothing in the plan.
 */
export function groupSubItems<T extends Pick<WorkItem, "number" | "parent">>(items: readonly T[]): GroupedRow<T>[] {
  const here = new Set(items.map((item) => item.number));
  const under = new Map<number, number[]>();
  const tops: number[] = [];
  items.forEach((item, index) => {
    const parent = item.parent;
    if (parent != null && parent !== item.number && here.has(parent)) under.set(parent, [...(under.get(parent) ?? []), index]);
    else tops.push(index);
  });
  const rows: GroupedRow<T>[] = [];
  const seen = new Set<number>();
  const visit = (index: number, depth: number) => {
    if (seen.has(index)) return;
    seen.add(index);
    const item = items[index]!;
    rows.push({ item, depth, index });
    for (const child of under.get(item.number) ?? []) visit(child, depth + 1);
  };
  for (const index of tops) visit(index, 0);
  // Parents in a loop, which the work service refuses but an old read could hold, start from the first of them.
  items.forEach((_, index) => visit(index, 0));
  return rows;
}
