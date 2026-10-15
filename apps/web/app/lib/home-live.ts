/**
 * Home that updates live: which of its repositories' changes it shows,
 * and which rows are new since it last drew. Pure; the hook that uses
 * them is lib/use-home-live.ts.
 *
 * Home watches the workspace's projects (the first HOME_WATCH_MAX, as the
 * digest reads them) over the live socket, as a repository page
 * watches its own (lib/repo-live.ts), and refreshes when something it
 * lists moves: a push to a default branch, a pull request or review, an
 * issue or comment, a run starting or finishing, a deployment or release,
 * a session starting or ending. Not a branch's pushes or a commit's
 * checks: a busy workspace sends those all the time, and nothing on Home
 * shows them. Its loader reads many services, so it refreshes at most
 * every HOME_GAP_MS.
 */
import type { RepoChange } from "@g1t/contracts";

import { branchOf } from "./repo-live.ts";

/** The most projects Home watches (a person watches at most 50, other tabs' pages too). */
export const HOME_WATCH_MAX = 25;
/** However many changes arrive, Home refreshes at most this often. */
export const HOME_GAP_MS = 5000;

/** A project Home watches: its id, `owner/name` and default branch. */
export type HomeRepo = { id: string; path: string; defaultBranch: string | null };

const FAMILIES = ["pull", "review", "issue", "comment", "workflow", "run", "deployment", "deployment_status", "release", "package"];
const KINDS = ["session.started", "session.ended", "queue.changed"];

/** Whether a change moves something Home shows. */
export function homeShows(change: RepoChange, repos: readonly HomeRepo[]): boolean {
  if (change.kind === "git.push") {
    const repo = repos.find((one) => one.id === change.repo_id);
    const branch = branchOf(change.ref);
    // A default branch's push lands; a tag's is a release.
    return branch == null || !repo?.defaultBranch || branch === repo.defaultBranch;
  }
  return FAMILIES.includes(change.kind.split(".")[0] ?? "") || KINDS.includes(change.kind);
}

/** What a list on the page remembers between draws: the keys it has shown, under which scope. */
export type Seen = { scope: string; keys: ReadonlySet<string> };

/**
 * The rows of `keys` that were not on the list when it last drew, and
 * what to remember now. On a first draw, or once the scope changed (the
 * span switched), none are new: only what arrives while it is open is.
 */
export function arrivedOf(seen: Seen | null, scope: string, keys: readonly string[]): { arrived: ReadonlySet<string>; seen: Seen } {
  if (!seen || seen.scope !== scope) return { arrived: new Set(), seen: { scope, keys: new Set(keys) } };
  const arrived = new Set(keys.filter((key) => !seen.keys.has(key)));
  return { arrived, seen: { scope, keys: new Set([...seen.keys, ...keys]) } };
}
