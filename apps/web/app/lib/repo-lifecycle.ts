// Pure helpers for a repository's lifecycle pages: renaming, archiving,
// deleting and restoring, and the workspace's list of repositories. Kept
// free of services so they can be tested with `node --test`.

/** Whether what someone typed names the repository `full` (`owner/name`), ignoring case and spaces around it. */
export function confirmsName(typed: string | null | undefined, full: string): boolean {
  return (typed ?? "").trim().toLowerCase() === full.trim().toLowerCase();
}

/** The repositories a list shows: all of them, the public or private ones, or the archived ones. */
export type RepoFilter = "all" | "public" | "private" | "archived";

export const REPO_FILTERS: { value: RepoFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "public", label: "Public" },
  { value: "private", label: "Private" },
  { value: "archived", label: "Archived" },
];

/** A filter from an address's `?filter=`, `all` for anything else. */
export function parseFilter(value: string | null | undefined): RepoFilter {
  return REPO_FILTERS.some((f) => f.value === value) ? (value as RepoFilter) : "all";
}

/** What filtering needs to know about a repository. */
export type Filterable = {
  name: string;
  description?: string | null;
  topics?: string[];
  isPrivate: boolean;
  archivedAt?: string | null;
};

/**
 * The repositories that pass `filter` and match `query`: every word of it
 * appears in the name, the description or a topic. Order is kept.
 */
export function filterRepos<T extends Filterable>(repos: T[], filter: RepoFilter, query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return repos.filter((repo) => {
    if (filter === "public" && repo.isPrivate) return false;
    if (filter === "private" && !repo.isPrivate) return false;
    if (filter === "archived" && !repo.archivedAt) return false;
    if (words.length === 0) return true;
    const text = [repo.name, repo.description ?? "", ...(repo.topics ?? [])].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** How many repositories each filter shows, for the counts beside them. */
export function filterCounts(repos: Filterable[]): Record<RepoFilter, number> {
  return {
    all: repos.length,
    public: repos.filter((r) => !r.isPrivate).length,
    private: repos.filter((r) => r.isPrivate).length,
    archived: repos.filter((r) => r.archivedAt).length,
  };
}

/** How one repository of a bulk action went. */
export type BulkResult = { name: string; ok: boolean; error?: string };

/**
 * One line about a bulk action: how many were done, and for each that was
 * not, its name and why. `done` is the past tense, such as "archived".
 */
export function summariseBulk(results: BulkResult[], done: string): { message: string; failures: string[] } {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const noun = (n: number) => (n === 1 ? "repository" : "repositories");
  const parts: string[] = [];
  if (ok > 0) parts.push(`${ok} ${noun(ok)} ${done}.`);
  if (failed.length > 0) parts.push(`${failed.length} ${noun(failed.length)} could not be.`);
  if (parts.length === 0) parts.push("Nothing was selected.");
  return {
    message: parts.join(" "),
    failures: failed.map((r) => `${r.name}: ${r.error ?? "Something went wrong."}`),
  };
}

/**
 * The address of a code page after the branch it names was renamed: the
 * same page, with the branch segment that follows `tree` or `blob`
 * replaced by `to`. Null when the path is not such a page.
 */
export function renamedBranchPath(pathname: string, search: string, to: string): string | null {
  const segments = pathname.split("/");
  // ["", owner, repo, "tree" | "blob", ref, ...path]
  if (segments.length < 5 || (segments[3] !== "tree" && segments[3] !== "blob")) return null;
  segments[4] = encodeURIComponent(to);
  return segments.join("/") + search;
}

/** Whole days from `now` until `at`, never below zero. */
export function daysUntil(at: string, now: number = Date.now()): number {
  const ms = Date.parse(at) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86_400_000)) : 0;
}

/** A date as "12 November 2026", in UTC so server and browser agree. */
export function longDate(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** A repository name as typed: trimmed, spaces to hyphens. The service has the final word. */
export function tidyName(name: string): string {
  return name.trim().replace(/\s+/g, "-");
}
