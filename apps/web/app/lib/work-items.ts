/**
 * Work items as the site shows them: where Work's pages are, the filters
 * the Work list keeps in its address, and an item's repositories in a row
 * (lib/work-access.ts says who may do what to one). Pure, so it is tested
 * under Node.
 */
import type { ItemRepo, LinkRole } from "@g1t/contracts";

import { tidyLabelName } from "./labels.ts";

export { itemPath } from "./refs.ts";

/**
 * Where an old address under a repository is now, when it named something
 * that moved to Work; null when it did not:
 *
 * - `/<owner>/<repo>/issues` is the Work list filtered to the repository,
 *   keeping its filters (`?state=closed&label=bug`);
 * - `/<owner>/<repo>/issues/new` a new work item with it as the origin;
 * - `/<owner>/<repo>/issues/<n>` is `#n` read in the repository, which only
 *   the work service can say: `{ resolve: n }`;
 * - `/<owner>/<repo>/labels` and `/milestones[/<n>]` the workspace's
 *   (milestones were numbered again in the workspace, so an old one's
 *   number leads to the list).
 */
export function movedWorkPath(pathname: string, search = ""): string | { resolve: number } | null {
  const parts = pathname.replace(/\.data$/, "").split("/").filter(Boolean);
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
        return `${workPath(workspace)}?${query.toString()}`;
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
  return `${workPath(workspace)}?repo=${encodeURIComponent(repo)}`;
}

/** Work → Sessions: what is cooking in the workspace, with filters (`?repo=web&person=ana`). */
export function sessionsPath(workspace: string, filters: Record<string, string | null | undefined> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const text = query.toString();
  return `${workPath(workspace, "sessions")}${text ? `?${text}` : ""}`;
}

/** One session's page, in whichever of the workspace's repositories it runs. */
export function sessionPath(workspace: string, id: string): string {
  return `${workPath(workspace, "sessions")}/${encodeURIComponent(id)}`;
}

/** A new work item, started from a repository (its origin) when `repo` is given. */
export function newItemPath(workspace: string, repo?: string | null): string {
  return `${workPath(workspace, "new")}${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
}

export const LINK_ROLES: readonly LinkRole[] = ["origin", "target", "touched"];

/** What each role means, in a few words, as the list's filter and the item page say. */
export const ROLE_LABELS: Record<LinkRole, string> = {
  origin: "Origin",
  target: "Target",
  touched: "Touched",
};

/** The filters on the Work list, as its address keeps them. */
export type WorkFilters = {
  state: "open" | "closed";
  label: string;
  milestone: number | null;
  /** A username, or `@me` for the viewer. */
  assignee: string;
  /** A repository of the workspace, by name (`web`) or path (`acme/web`). */
  repo: string;
  role: LinkRole | null;
};

/**
 * The Work list's filters from its address: `?state=closed&label=bug&
 * milestone=3&assignee=ana&repo=web&role=target`, and the same written in
 * `q` (`is:closed label:bug repo:web role:target`), which wins.
 */
export function workFilters(query: URLSearchParams): WorkFilters {
  let label = query.get("label") ?? "";
  let milestone = Number(query.get("milestone")) || null;
  let state: "open" | "closed" = query.get("state") === "closed" ? "closed" : "open";
  let assignee = query.get("assignee") ?? "";
  let repo = query.get("repo") ?? "";
  let role = roleOf(query.get("role"));
  for (const [, key, quoted, plain] of (query.get("q") ?? "").matchAll(/(\w+):(?:"([^"]*)"|(\S+))/g)) {
    const value = quoted ?? plain ?? "";
    if (key === "label") label = value;
    else if (key === "milestone") milestone = Number(value) || null;
    else if (key === "is" && (value === "open" || value === "closed")) state = value;
    else if (key === "assignee") assignee = value;
    else if (key === "repo") repo = value;
    else if (key === "role") role = roleOf(value);
  }
  return {
    state,
    label: label ? tidyLabelName(label) : "",
    milestone,
    assignee: assignee.replace(/^@(?!me$)/, "").trim(),
    repo: repo.trim(),
    // A role says how a repository is linked: without one it means nothing.
    role: repo.trim() ? role : null,
  };
}

function roleOf(value: string | null | undefined): LinkRole | null {
  return LINK_ROLES.find((role) => role === value) ?? null;
}

/** Whether any filter but the state is set. */
export function filtered(filters: WorkFilters): boolean {
  return Boolean(filters.label || filters.milestone || filters.assignee || filters.repo);
}

/** How many filters but the state are set: the phone's Filters button shows it. */
export function filterCount(filters: WorkFilters): number {
  return [filters.label, filters.milestone, filters.assignee, filters.repo].filter(Boolean).length;
}

/** The filters as an address's query, in a steady order, leaving out what is unset. */
export function workQuery(filters: Partial<WorkFilters>): string {
  const params = new URLSearchParams();
  if (filters.state === "closed") params.set("state", "closed");
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.repo && filters.role) params.set("role", filters.role);
  if (filters.label) params.set("label", filters.label);
  if (filters.milestone) params.set("milestone", String(filters.milestone));
  if (filters.assignee) params.set("assignee", filters.assignee);
  return params.toString();
}

/** The Work list with `change` made to `filters`. */
export function workListPath(workspace: string, filters: Partial<WorkFilters>, change: Partial<WorkFilters> = {}): string {
  const query = workQuery({ ...filters, ...change });
  return `${workPath(workspace)}${query ? `?${query}` : ""}`;
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
