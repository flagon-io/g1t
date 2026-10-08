/**
 * Each entry's last commit for the file list, waited on only so long. An
 * answer not yet kept walks history, which can take seconds on a large or
 * busy repository; the page goes out without it then, the column empty,
 * while the walk finishes in the background (waitUntil) so the next view
 * has it from the cache. The page's stream never waits on it past its own
 * timeout.
 */
import { waitUntil } from "cloudflare:workers";

import type { RepoPath, Viewer } from "@g1t/contracts";

import type { FileCommits } from "./commit-people";
import { repos } from "./services.server";

/** How long the page waits for the column. */
const WAIT_MS = 3_000;

export function lastCommitsFor(path: RepoPath, viewer: Viewer, ref: string | null, treePath: string): Promise<FileCommits | null> {
  const walk = repos
    .lastCommits(path, viewer, ref, treePath)
    // The rows show a commit's subject and age, never who made it: their
    // addresses stay on the server.
    .then((found): FileCommits | null =>
      found.ok
        ? {
            complete: found.value.complete,
            entries: found.value.entries.map(({ name, commit }) => ({
              name,
              commit: { hash: commit.hash, message: commit.message, authoredAt: commit.authoredAt },
            })),
          }
        : null,
    )
    .catch(() => null);
  waitUntil(walk);
  return Promise.race([walk, new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_MS))]);
}
