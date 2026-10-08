/**
 * When a build that keeps failing is tried again, and when it stops being
 * tried. The sweep builds an app again under its new name after a move
 * (see `followMoves`); a build that failed the same way a few times will
 * fail that way again, and one whose commit is gone (force-pushed over,
 * or its branch deleted) never builds, so neither is tried again until
 * something changes: a push, which builds on its own, or a redeploy.
 *
 * Kept free of imports so its tests run on Node as they are.
 */

/** The same failure, this many times in a row, and a rebuild is not tried again. */
export const MAX_IDENTICAL_FAILURES = 3;

/** What git says when the commit asked for is not in the repository. */
const MISSING_COMMIT = /reference is not a tree|not our ref|bad object|unknown revision|no such commit|commit no longer exists/i;

/** Whether a build failed because its commit is no longer in the repository. */
export function commitMissing(error: string | null | undefined): boolean {
  return !!error && MISSING_COMMIT.test(error);
}

/**
 * What a build whose commit is gone says, in place of git's own words:
 * the pull request's head was force-pushed over or its branch deleted.
 */
export function missingCommitMessage(build: { kind: string; number: number | null }): string {
  if (build.kind === "preview" && build.number != null) {
    return `This pull request's commit no longer exists. Push again, or close pull request #${build.number}.`;
  }
  if (build.kind === "preview") return "This branch's commit no longer exists. Push to the branch again.";
  return "This commit no longer exists in the repository. Push to the default branch again.";
}

/** One earlier build of an app, newest first, as far as retrying needs it. */
export type PastBuild = { status: string; error: string | null; commit_sha: string; created_at: string };

export type RetryDecision =
  /** Build it now. */
  | { kind: "build" }
  /** Tried too recently: wait for a later sweep. */
  | { kind: "wait"; until: number }
  /** Not tried again: its commit is gone, or it failed the same way too often. */
  | { kind: "stop"; reason: "missing_commit" | "failing" };

/**
 * Whether to build an app again, from its builds newest first. A build
 * under way is left to finish (the caller checks that first). The run of
 * identical failures at the head of `history` (same commit, same error)
 * decides: a missing commit stops at once; `MAX_IDENTICAL_FAILURES` of
 * them stop; fewer wait `afterMs`, doubled for each failure after the
 * first. With `backoff` off (an event's delivery) only stopping applies.
 */
export function retryDecision(
  history: PastBuild[],
  now: number,
  afterMs: number,
  options: { backoff?: boolean; max?: number } = {},
): RetryDecision {
  const last = history[0];
  if (!last) return { kind: "build" };
  const max = options.max ?? MAX_IDENTICAL_FAILURES;
  if (last.status === "failed") {
    if (commitMissing(last.error)) return { kind: "stop", reason: "missing_commit" };
    let run = 0;
    for (const build of history) {
      if (build.status !== "failed" || build.error !== last.error || build.commit_sha !== last.commit_sha) break;
      run++;
    }
    if (run >= max) return { kind: "stop", reason: "failing" };
    if (!options.backoff) return { kind: "build" };
    const until = Date.parse(last.created_at) + afterMs * 2 ** (run - 1);
    return until <= now ? { kind: "build" } : { kind: "wait", until };
  }
  if (!options.backoff) return { kind: "build" };
  // Refused or skipped: tried again after `afterMs`, as before.
  const until = Date.parse(last.created_at) + afterMs;
  return until <= now ? { kind: "build" } : { kind: "wait", until };
}
