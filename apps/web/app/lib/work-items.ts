/**
 * Work items as the site shows them: where Work's pages are, the filters
 * the Work list keeps in its address, and an item's repositories in a row
 * (lib/work-access.ts says who may do what to one). Pure, so it is tested
 * under Node.
 */
import type { Horizon, ItemRepo, LinkRole, OpenSubItems, SubItemProgress } from "@g1t/contracts";

import { tidyLabelName } from "./labels.ts";

export { itemPath } from "./refs.ts";

/**
 * Where an old address under a repository is now, when it named something
 * that moved to Work; null when it did not:
 *
 * - `/<owner>/<repo>/issues` is All work items filtered to the repository,
 *   keeping its filters (`?state=closed&label=bug`);
 * - `/<owner>/<repo>/issues/new` a new work item with it as the origin;
 * - `/<owner>/<repo>/issues/<n>` is `#n` read in the repository, which only
 *   the work service can say: `{ resolve: n }`;
 * - `/<owner>/<repo>/labels` and `/milestones[/<n>]` the workspace's
 *   (milestones were numbered again in the workspace, so an old one's
 *   number leads to the list).
 */
export function movedWorkPath(pathname: string, search = ""): string | { resolve: number } | null {
  const parts = pathname
    .replace(/\.data$/, "")
    .split("/")
    .filter(Boolean);
  const [owner, repo, section, rest, more] = parts;
  if (!owner || !repo || owner === "-" || repo === "-" || parts.length > 5) return null;
  const workspace = owner.toLowerCase();
  const old = new URLSearchParams(search);
  old.delete("_routes");
  switch (section) {
    case "issues": {
      if (rest === undefined) {
        const query = new URLSearchParams({ repo });
        for (const [key, value] of old) if (key !== "repo") query.append(key, value);
        return `${workPath(workspace, "all")}?${query.toString()}`;
      }
      if (more !== undefined) return null;
      if (rest === "new") return newItemPath(workspace, repo);
      const number = Number(rest);
      return /^\d+$/.test(rest) && number > 0 ? { resolve: number } : null;
    }
    case "labels":
      return rest === undefined ? workPath(workspace, "labels") : null;
    case "milestones":
      return more === undefined ? workPath(workspace, "milestones") : null;
  }
  return null;
}

/** Work's own pages, under the workspace. */
export function workPath(workspace: string, page = ""): string {
  return `/${workspace.toLowerCase()}/-/work${page ? `/${page}` : ""}`;
}

/** The Work list filtered to one repository of the workspace. */
export function repoWorkPath(workspace: string, repo: string): string {
  return `${workPath(workspace, "all")}?repo=${encodeURIComponent(repo)}`;
}

/**
 * Chat → Sessions: what agents are doing in the workspace, with filters
 * (`?repo=web&person=ana`). Sessions are Chat's, beside the people you
 * talk to; they were Work's before (`-/work/sessions`, which leads here).
 */
export function sessionsPath(workspace: string, filters: Record<string, string | null | undefined> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const text = query.toString();
  return `/${workspace.toLowerCase()}/-/chat/sessions${text ? `?${text}` : ""}`;
}

/** One session's page, in whichever of the workspace's repositories it runs. */
export function sessionPath(workspace: string, id: string): string {
  return `/${workspace.toLowerCase()}/-/chat/sessions/${encodeURIComponent(id)}`;
}

/** Where a session's address from when they were Work's is now: `/acme/-/work/sessions/ses_1` is `/acme/-/chat/sessions/ses_1`. */
export function movedSessionsPath(pathname: string, search = ""): string | null {
  const match = /^\/([^/]+)\/-\/work\/sessions(\/[^/]+)?\/?$/.exec(pathname);
  return match ? `/${match[1]!.toLowerCase()}/-/chat/sessions${match[2] ?? ""}${search}` : null;
}

/** A new work item, started from a repository (its origin) when `repo` is given, and as a sub-item of `parent`. */
export function newItemPath(workspace: string, repo?: string | null, parent?: number | null): string {
  const query = new URLSearchParams();
  if (repo) query.set("repo", repo);
  if (parent) query.set("parent", String(parent));
  const text = query.toString();
  return `${workPath(workspace, "new")}${text ? `?${text}` : ""}`;
}

/**
 * A work item's number as a person types it, `#212` or `212`: null for
 * nothing typed, undefined for anything that is not a number.
 */
export function itemNumberOf(text: string | null | undefined): number | null | undefined {
  const word = (text ?? "").trim().replace(/^#/, "");
  if (!word) return null;
  return /^\d+$/.test(word) && Number(word) > 0 ? Number(word) : undefined;
}

export const LINK_ROLES: readonly LinkRole[] = ["origin", "target", "touched"];

/** What each role means, in a few words, as the list's filter and the item page say. */
export const ROLE_LABELS: Record<LinkRole, string> = {
  origin: "Origin",
  target: "Target",
  touched: "Touched",
};

/** The plan's horizons the list filters by, in the order work moves through them (`HORIZONS` in contracts). */
export const LIST_HORIZONS: readonly Horizon[] = ["now", "next", "later", "triage", "set_aside"];

/** Each horizon's name, as the list's filter and its rows say it (`horizonLabel` in contracts). */
export const HORIZON_LABELS: Record<Horizon, string> = { triage: "Triage", now: "Now", next: "Next", later: "Later", set_aside: "Set aside" };

/** The filters on the Work list, as its address keeps them. */
export type WorkFilters = {
  state: "open" | "closed";
  /** Only open ones on this horizon of the plan, in the plan's order. */
  horizon: Horizon | null;
  label: string;
  milestone: number | null;
  /** A username, or `@me` for the viewer. */
  assignee: string;
  /** A repository of the workspace, by name (`web`) or path (`acme/web`). */
  repo: string;
  role: LinkRole | null;
  /** Only the sub-items of the work item of this number. */
  parent: number | null;
};

/**
 * The Work list's filters from its address: `?state=closed&label=bug&
 * milestone=3&assignee=ana&repo=web&role=target&horizon=now&parent=212`, and
 * the same written in `q` (`is:closed label:bug repo:web role:target
 * horizon:now parent:#212`, or `is:now` for a horizon), which wins. A horizon holds only open work
 * items, so with one the state is open.
 */
export function workFilters(query: URLSearchParams): WorkFilters {
  let horizon = horizonOf(query.get("horizon"));
  let label = query.get("label") ?? "";
  let milestone = Number(query.get("milestone")) || null;
  let state: "open" | "closed" = query.get("state") === "closed" ? "closed" : "open";
  let assignee = query.get("assignee") ?? "";
  let repo = query.get("repo") ?? "";
  let role = roleOf(query.get("role"));
  let parent = itemNumberOf(query.get("parent")) ?? null;
  for (const [, key, quoted, plain] of (query.get("q") ?? "").matchAll(/(\w+):(?:"([^"]*)"|(\S+))/g)) {
    const value = quoted ?? plain ?? "";
    if (key === "label") label = value;
    else if (key === "milestone") milestone = Number(value) || null;
    else if (key === "is" && (value === "open" || value === "closed")) state = value;
    else if (key === "is" && horizonOf(value)) horizon = horizonOf(value);
    else if (key === "horizon") horizon = horizonOf(value);
    else if (key === "assignee") assignee = value;
    else if (key === "repo") repo = value;
    else if (key === "role") role = roleOf(value);
    else if (key === "parent") parent = itemNumberOf(value) ?? null;
  }
  return {
    state: horizon ? "open" : state,
    horizon,
    label: label ? tidyLabelName(label) : "",
    milestone,
    assignee: assignee.replace(/^@(?!me$)/, "").trim(),
    repo: repo.trim(),
    // A role says how a repository is linked: without one it means nothing.
    role: repo.trim() ? role : null,
    parent,
  };
}

function roleOf(value: string | null | undefined): LinkRole | null {
  return LINK_ROLES.find((role) => role === value) ?? null;
}

/** A horizon as the address writes it: `now`, `set_aside` (or `set-aside`), any case. */
function horizonOf(value: string | null | undefined): Horizon | null {
  const wanted = value?.trim().toLowerCase().replace(/-/g, "_");
  return LIST_HORIZONS.find((horizon) => horizon === wanted) ?? null;
}

/**
 * What an empty Work list says: the repository it is filtered to, when
 * that is its only filter; that nothing matches, for any other; else that
 * there are none in this state.
 */
export function emptyListTitle(filters: WorkFilters, repoName: string | null): string {
  const others = filters.label || filters.milestone || filters.assignee;
  if (filters.horizon && !filters.repo && !others && !filters.parent) return `Nothing in ${HORIZON_LABELS[filters.horizon]}`;
  if (repoName && !filters.horizon && !others && !filters.parent) return `No ${filters.state} work items linked to ${repoName}`;
  if (filters.parent && !filters.horizon && !filters.repo && !others) return `No ${filters.state} sub-items of #${filters.parent}`;
  if (filtered(filters)) return `No ${filters.state} work items match these filters`;
  return filters.state === "open" ? "No open work items" : "No closed work items";
}

/** Whether any filter but the state is set. */
export function filtered(filters: WorkFilters): boolean {
  return Boolean(filters.horizon || filters.label || filters.milestone || filters.assignee || filters.repo || filters.parent);
}

/** How many filters but the state are set: the phone's Filters button shows it. */
export function filterCount(filters: WorkFilters): number {
  return [filters.horizon, filters.label, filters.milestone, filters.assignee, filters.repo, filters.parent].filter(Boolean).length;
}

/** The filters as an address's query, in a steady order, leaving out what is unset. */
export function workQuery(filters: Partial<WorkFilters>): string {
  const params = new URLSearchParams();
  if (filters.horizon) params.set("horizon", filters.horizon);
  else if (filters.state === "closed") params.set("state", "closed");
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.repo && filters.role) params.set("role", filters.role);
  if (filters.label) params.set("label", filters.label);
  if (filters.milestone) params.set("milestone", String(filters.milestone));
  if (filters.assignee) params.set("assignee", filters.assignee);
  if (filters.parent) params.set("parent", String(filters.parent));
  return params.toString();
}

/** All work items (Work's list, beside the plan at `-/work`) with `change` made to `filters`. */
export function workListPath(workspace: string, filters: Partial<WorkFilters>, change: Partial<WorkFilters> = {}): string {
  const query = workQuery({ ...filters, ...change });
  return `${workPath(workspace, "all")}${query ? `?${query}` : ""}`;
}

/**
 * Where the list is in its pages, from its address: `before`, the lowest
 * number the page above showed (none on the first page), and `newer`, the
 * `before` of each page above it, so Newer can step back one page at a
 * time (the work service pages only downward).
 */
export type ListPage = { before: number | null; newer: number[] };

const cursor = (value: string) => (/^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null);

export function listPage(query: URLSearchParams): ListPage {
  const before = cursor(query.get("before") ?? "");
  if (before == null) return { before: null, newer: [] };
  const newer = (query.get("newer") ?? "")
    .split(/[.,]/)
    .map(cursor)
    .filter((value): value is number => value != null && value > before);
  return { before, newer };
}

/**
 * The address of the page below (`older`, from the lowest number shown)
 * or above (`newer`), as a query that keeps `filters`: relative, so it
 * works wherever the list is served.
 */
export function pageQuery(filters: Partial<WorkFilters>, at: ListPage, to: { older: number } | "newer"): string {
  const params = new URLSearchParams(workQuery(filters));
  if (to === "newer") {
    const before = at.newer.at(-1);
    if (before != null) {
      params.set("before", String(before));
      if (at.newer.length > 1) params.set("newer", at.newer.slice(0, -1).join("."));
    }
  } else {
    params.set("before", String(to.older));
    const newer = at.before == null ? [] : [...at.newer, at.before];
    if (newer.length > 0) params.set("newer", newer.join("."));
  }
  const text = params.toString();
  return `?${text}`;
}

/** A repository filter as the work service takes it: `web` is the workspace's `web`. */
export function repoFilter(workspace: string, repo: string): { namespace: string; name: string } | null {
  const parts = repo.split("/").filter(Boolean);
  if (parts.length === 1) return { namespace: workspace.toLowerCase(), name: parts[0]! };
  if (parts.length === 2) return { namespace: parts[0]!.toLowerCase(), name: parts[1]! };
  return null;
}

/** A repository's name in its workspace: `web` for `acme/web` in `acme`, the whole path elsewhere. */
/** What a link to a repository that is gone, with no path kept, is called. */
export const DELETED_REPO = "deleted repository";

export function shortPath(path: string, workspace: string): string {
  // A repository deleted before work items had no path left to keep.
  if (!path) return DELETED_REPO;
  const [namespace, name] = path.split("/");
  return name && namespace?.toLowerCase() === workspace.toLowerCase() ? name : path;
}

/**
 * An item's repositories as a row of chips that fits a phone: the first
 * `max` (origin first, as the service lists them), then how many more.
 */
export function repoChips(repos: ItemRepo[], max = 2): { shown: ItemRepo[]; more: number } {
  return { shown: repos.slice(0, max), more: Math.max(0, repos.length - max) };
}

/** An item's origin repository, if it has one. */
export function originOf(repos: ItemRepo[]): ItemRepo | null {
  return repos.find((repo) => repo.role === "origin") ?? null;
}

/** How far along a parent's sub-items are, in words: "3 of 7 done". */
export function subItemsDone(progress: SubItemProgress): string {
  return `${progress.done} of ${progress.total} done`;
}

/** How far along a parent's sub-items are, as a percentage for a bar. */
export function subItemsShare(progress: SubItemProgress): number {
  return progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
}

/** What closing a work item with open sub-items does with them, from its form: none chosen, or a choice and where to move them. */
export function closeSubItemsOf(form: { get(name: string): unknown }): { subItems: OpenSubItems; moveTo?: number } | string | null {
  const choice = String(form.get("sub_items") ?? "");
  if (choice === "leave" || choice === "close") return { subItems: choice };
  if (choice !== "move") return null;
  const to = itemNumberOf(String(form.get("move_to") ?? ""));
  if (!to) return "Say which work item to move them to, such as #212.";
  return { subItems: "move", moveTo: to };
}
