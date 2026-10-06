/**
 * Where a pull request's catch-up stands once it has been handed to a
 * sandbox: still going, done, failed, or taking far longer than it should.
 * Pure, so it is tested on its own; it imports only types.
 */
import type { AgentRun, PullBranchUpdate } from "@g1t/contracts";

/** A sandbox catch-up usually takes about a minute; past this, say so. */
export const CATCH_UP_TIMEOUT_MS = 5 * 60_000;
/** Runs created this long before the request was made still count as its run. */
const CLOCK_SLACK_MS = 30_000;

export type CatchUpPhase = "working" | "done" | "failed" | "timed_out";

/**
 * The `update` run started for a request made at `startedAt`, newest
 * first, if it has shown up yet.
 */
export function catchUpRun(runs: AgentRun[], startedAt: number): AgentRun | null {
  return (
    runs
      .filter((run) => run.kind === "update" && Date.parse(run.createdAt) >= startedAt - CLOCK_SLACK_MS)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  );
}

/**
 * Where it stands. It is done as soon as the pull request is no longer
 * behind, whatever the run says; failed when its run ended without that;
 * timed out when nothing has settled it for too long.
 */
export function catchUpPhase({
  behind,
  run,
  startedAt,
  now,
}: {
  behind: boolean;
  run: AgentRun | null;
  startedAt: number;
  now: number;
}): CatchUpPhase {
  if (!behind) return "done";
  if (run && (run.status === "failed" || run.status === "stopped")) return "failed";
  // Succeeded, but the page has not seen the push yet: give it the same time.
  if (now - startedAt > CATCH_UP_TIMEOUT_MS) return "timed_out";
  return "working";
}

type NeedsAgent = Extract<PullBranchUpdate, { outcome: "needs_agent" }>;

/** What the box says while a sandbox brings the pull request up to date. */
export function catchUpTitle(reason: NeedsAgent["reason"], defaultBranch: string): string {
  return reason === "conflicting"
    ? `g1t is resolving conflicts with ${defaultBranch}`
    : `g1t is merging ${defaultBranch} into this pull request`;
}

/** Why it went to a sandbox, in a sentence. */
export function catchUpWhy(update: Pick<NeedsAgent, "reason" | "paths">, defaultBranch: string): string {
  const files = update.paths.length === 1 ? "one file" : `${update.paths.length} files`;
  switch (update.reason) {
    case "conflicting":
      return `Merging ${defaultBranch} conflicts in ${files}, so g1t resolves them in a sandbox and pushes the result.`;
    case "overlap":
      return update.paths.length > 0
        ? `This pull request and ${defaultBranch} both changed ${files}, so they are merged with git in a sandbox. g1t resolves any conflicts.`
        : `They are merged with git in a sandbox. g1t resolves any conflicts.`;
    default:
      return `They are merged with git in a sandbox. g1t resolves any conflicts.`;
  }
}
