/**
 * A workspace's Projects page, for a workspace with hundreds of them: what
 * the address asks for (a search, filters, a sort, a view and a page), and
 * the list that answers it. Read from and written to the address, so a
 * filtered list can be shared, bookmarked and gone back to.
 */

import type { Project, ProjectEcosystem } from "@g1t/contracts";

export type ProjectSort = "updated" | "name" | "active" | "pushed";
export type ProjectView = "list" | "grid";

export type ProjectQuery = {
  /** Words in the name, slug or description. */
  q: string;
  visibility: "all" | "public" | "private";
  kind: "all" | "app" | "library";
  /** A language, from the manifests at the project's root. */
  language: string | null;
  /** Only projects with Deployments on. */
  deployments: boolean;
  /** Archived projects: left out (the default), shown too, or only them. */
  archived: "hide" | "include" | "only";
  sort: ProjectSort;
  view: ProjectView;
  /** 1 first. */
  page: number;
};

/** Projects to a page. */
export const PAGE_SIZE = 30;

export const DEFAULT_QUERY: ProjectQuery = {
  q: "",
  visibility: "all",
  kind: "all",
  language: null,
  deployments: false,
  archived: "hide",
  sort: "updated",
  view: "list",
  page: 1,
};

export const SORTS: { value: ProjectSort; label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "pushed", label: "Recently pushed" },
  { value: "active", label: "Most active" },
  { value: "name", label: "Name" },
];

/** The language a project's manifests say it is written in. */
export const LANGUAGE_OF: Record<ProjectEcosystem, string> = {
  npm: "JavaScript",
  cargo: "Rust",
  go: "Go",
  composer: "PHP",
  python: "Python",
};

/** What the list needs of a project, with whether its Deployments are on. */
export type Listed = Pick<
  Project,
  "id" | "slug" | "name" | "description" | "private" | "archived" | "kind" | "ecosystem" | "updatedAt" | "pushedAt" | "activity"
> & { deploying: boolean };

const one = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;

/** What the address asks for; anything it does not say, or says wrong, is the default. */
export function readProjectQuery(params: URLSearchParams): ProjectQuery {
  const page = Number.parseInt(params.get("page") ?? "", 10);
  return {
    q: (params.get("q") ?? "").trim().slice(0, 100),
    visibility: one(params.get("visibility"), ["all", "public", "private"] as const, "all"),
    kind: one(params.get("kind"), ["all", "app", "library"] as const, "all"),
    language: params.get("language")?.trim() || null,
    deployments: params.get("deployments") === "on",
    archived: one(params.get("archived"), ["hide", "include", "only"] as const, "hide"),
    sort: one(params.get("sort"), ["updated", "name", "active", "pushed"] as const, "updated"),
    view: one(params.get("view"), ["list", "grid"] as const, "list"),
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/**
 * The address for `query` with `change` made, leaving out what is the
 * default. Changing anything but the page goes back to the first page.
 */
export function projectQueryString(query: ProjectQuery, change: Partial<ProjectQuery> = {}): string {
  const next = { ...query, ...change };
  if (!("page" in change)) next.page = 1;
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.visibility !== "all") params.set("visibility", next.visibility);
  if (next.kind !== "all") params.set("kind", next.kind);
  if (next.language) params.set("language", next.language);
  if (next.deployments) params.set("deployments", "on");
  if (next.archived !== "hide") params.set("archived", next.archived);
  if (next.sort !== "updated") params.set("sort", next.sort);
  if (next.view !== "list") params.set("view", next.view);
  if (next.page > 1) params.set("page", String(next.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Whether anything narrows the list, beyond leaving archived projects out. */
export function isFiltered(query: ProjectQuery): boolean {
  return Boolean(
    query.q || query.visibility !== "all" || query.kind !== "all" || query.language || query.deployments || query.archived !== "hide",
  );
}

/** When it last changed: its own settings, or a push, whichever is later. */
export function lastUpdated(project: Pick<Listed, "updatedAt" | "pushedAt">): string {
  return project.pushedAt && project.pushedAt > project.updatedAt ? project.pushedAt : project.updatedAt;
}

function matches(project: Listed, words: string[]): boolean {
  const text = `${project.name} ${project.slug} ${project.description ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** The projects `query` asks for, in its order, before paging. */
export function filterProjects(projects: Listed[], query: ProjectQuery): Listed[] {
  const words = query.q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = projects.filter(
    (project) =>
      (query.archived === "include" || (query.archived === "only") === project.archived) &&
      (query.visibility === "all" || (query.visibility === "private") === project.private) &&
      (query.kind === "all" || project.kind === query.kind) &&
      (!query.language || (project.ecosystem != null && LANGUAGE_OF[project.ecosystem] === query.language)) &&
      (!query.deployments || project.deploying) &&
      (words.length === 0 || matches(project, words)),
  );
  return sortProjects(shown, query.sort, words);
}

const byName = (a: Listed, b: Listed) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.slug.localeCompare(b.slug);

/**
 * In `sort`'s order, ties by name. While searching, a name that starts
 * with what was typed comes first.
 */
export function sortProjects(projects: Listed[], sort: ProjectSort, words: string[] = []): Listed[] {
  const first = words[0];
  const leads = (project: Listed) =>
    first != null && (project.name.toLowerCase().startsWith(first) || project.slug.startsWith(first)) ? 0 : 1;
  const order: Record<ProjectSort, (a: Listed, b: Listed) => number> = {
    name: byName,
    updated: (a, b) => lastUpdated(b).localeCompare(lastUpdated(a)),
    pushed: (a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""),
    active: (a, b) => b.activity - a.activity,
  };
  return [...projects].sort((a, b) => leads(a) - leads(b) || order[sort](a, b) || byName(a, b));
}

/** One page of them, and where it sits among the rest. */
export function pageOf<T>(list: T[], page: number, size = PAGE_SIZE): { items: T[]; page: number; pages: number; from: number; to: number } {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  const items = list.slice(start, start + size);
  return { items, page: current, pages, from: items.length ? start + 1 : 0, to: start + items.length };
}

export type Facets = {
  visibility: { public: number; private: number };
  kind: { app: number; library: number };
  languages: { name: string; count: number }[];
  deploying: number;
  archived: number;
};

/** How many of the workspace's projects each filter would show, before any is chosen. */
export function facetsOf(projects: Listed[]): Facets {
  const languages = new Map<string, number>();
  const facets: Facets = { visibility: { public: 0, private: 0 }, kind: { app: 0, library: 0 }, languages: [], deploying: 0, archived: 0 };
  for (const project of projects) {
    facets.visibility[project.private ? "private" : "public"]++;
    facets.kind[project.kind]++;
    if (project.deploying) facets.deploying++;
    if (project.archived) facets.archived++;
    if (project.ecosystem) {
      const language = LANGUAGE_OF[project.ecosystem];
      languages.set(language, (languages.get(language) ?? 0) + 1);
    }
  }
  facets.languages = [...languages].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return facets;
}

/**
 * The index of the row to move to from `at` by key, in a list of `count`
 * rows: arrows and j/k move one, Home and End to either end. Null for any
 * other key.
 */
export function nextRow(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
    case "j":
      return Math.min(count - 1, at + 1);
    case "ArrowUp":
    case "k":
      return Math.max(0, at - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
