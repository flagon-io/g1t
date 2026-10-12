/**
 * How long the site waits on a service before it gives up. Nothing on
 * Workers ends a subrequest that stops answering: the page waits as long
 * as the visitor does, so a service stuck on one call holds the page on
 * its loading bar for good. With a deadline it fails instead, as an error
 * the page can draw and the next click can get past.
 */

/** A read: no page should wait longer than this on one service call. */
export const READ_DEADLINE_MS = 15_000;

/** A write: some do real work (a merge, a commit), so they get longer. */
export const WRITE_DEADLINE_MS = 60_000;

/** Reads that do real work inline the first time, or walk history. */
export const SLOW_READ_DEADLINE_MS = 60_000;

/** Jobs a person starts and waits on: an import, a model's draft, a computer waking. */
export const LONG_DEADLINE_MS = 600_000;

/**
 * Reads that can take longer than `READ_DEADLINE_MS` and still be right,
 * by service binding and method. Cut off, their work is lost and starts
 * again on the next visit, so they get the time to finish.
 */
const SLOW_READS = new Set([
  // A repository's first look runs its dependency scan inline (services/security/src/deps.rs).
  "security overview",
  "security dependency_graph",
  "security sbom",
  // Walks up to 400 commits, reading trees and blobs one after another (services/repos/src/blame.rs).
  "repos blame",
  // Up to 2,500 store reads per call (services/repos/src/last_commits.rs).
  "repos last_commits",
]);

/**
 * Writes that run for minutes and still finish: copying a repository in,
 * syncing a mirror, a model writing a draft, a computer's home moved in or
 * out of storage, a scan over many repositories.
 */
const LONG_CALLS = new Set([
  "repos create",
  "integrations github_import",
  "integrations mirror_add",
  "integrations mirror_sync",
  "integrations mirror_move_in",
  "integrations mirror_hand_back",
  "agents draft",
  "agents try_draft",
  "agents redraft",
  "agents draft_skill",
  "agents sync_skill_mirror",
  "agents computer_wake",
  "agents computer_sleep",
  "security dry_run_pattern",
  "security rescan",
  "security check_updates",
  "artifacts add_repo_space",
]);

/** How long a call to `service`'s `method` may take; `writes` as lib/perf.ts `mayWrite` says. */
export function deadlineFor(service: string, method: string, writes: boolean): number {
  const call = `${service} ${method}`;
  if (LONG_CALLS.has(call)) return LONG_DEADLINE_MS;
  if (SLOW_READS.has(call)) return SLOW_READ_DEADLINE_MS;
  return writes ? WRITE_DEADLINE_MS : READ_DEADLINE_MS;
}

/** What a call past its deadline throws. */
export class DeadlineExceeded extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${ms}ms`);
    this.name = "DeadlineExceeded";
  }
}

/**
 * `run`'s answer, or a `DeadlineExceeded` after `ms`. `run` is handed a
 * signal that aborts at the deadline, so the call it makes is cancelled
 * too; `outer`, when given, aborts it sooner. Whatever `run` reads must be
 * read inside it: the deadline ends when it returns.
 */
export async function withDeadline<T>(
  what: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal | null,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineExceeded(what, ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  const stop = () => controller.abort(outer?.reason);
  if (outer?.aborted) stop();
  else outer?.addEventListener("abort", stop, { once: true });
  try {
    // Raced as well as aborted: a binding that ignores the signal still lets go.
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
}
