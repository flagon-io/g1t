/**
 * The checks on a page's commits, read in one call for all of them (the
 * work service's `commit_checks`): statuses, check runs reported through
 * the API, and g1t Actions jobs. Loaders return the promise without
 * waiting, so the page goes out at once and each commit's badge streams in
 * (components/commit-checks.tsx).
 */
import type { CommitChecks, RepoPath, Viewer } from "@g1t/contracts";

import { work } from "./services.server";

/** A page's commits' checks, by full SHA. A commit nothing reported on is absent. */
export type ChecksBySha = Record<string, CommitChecks>;

/** The most commits one call reads. */
const MAX_COMMITS = 100;

/** Every check on each of `shas`; null when they could not be read. */
export function commitChecksFor(path: RepoPath, viewer: Viewer, shas: (string | null | undefined)[]): Promise<ChecksBySha | null> {
  const unique = [...new Set(shas.filter((sha): sha is string => Boolean(sha)))].slice(0, MAX_COMMITS);
  if (unique.length === 0) return Promise.resolve({});
  return work
    .commitChecks(path, viewer, unique)
    .then((found) => (found.ok ? found.value : null))
    .catch(() => null);
}
