/**
 * The other pull requests for the same issue, as a pull request shows them
 * beside itself: alternatives to compare, not collisions to avoid. Each
 * says how it stands, how its head commit's checks went, and where its
 * review is, so two agents' attempts at one issue can be weighed side by
 * side (routes/repo/pull.tsx).
 */
import type { ChangedFile, Comment, CommitChecks, Overlap, Pull, PullStatus } from "@g1t/contracts";

/** How many other attempts a pull request reads, newest first. */
export const MAX_ATTEMPTS = 4;

export type AttemptReview = {
  state: "approved" | "changes_requested" | "requested" | "none";
  text: string;
};

/** One pull request for the issue: this one, or another. */
export type Attempt = {
  number: number;
  title: string;
  status: PullStatus;
  /** The pull request merged instead of it, when one was. */
  supersededBy: number | null;
  /** Who opened it, or `g1t`. */
  author: string;
  headCommit: string | null;
  files: ChangedFile[];
  updatedAt: string;
  /** Whether it is the pull request being looked at. */
  current: boolean;
  /** The files it changes that the one being looked at changes too. */
  shared: string[];
  /** Its head commit's checks; null when nothing reported on it. */
  checks: CommitChecks | null;
  review: AttemptReview;
};

/**
 * A pull request's overlaps, split: those for other issues will collide
 * with it; those for the same issue are alternatives to it, and expected
 * to change the same files.
 */
export function splitOverlaps(overlaps: Overlap[], issue: number | null): { collisions: Overlap[]; alternatives: Overlap[] } {
  const same = (other: Overlap) => issue != null && other.issue === issue;
  return { collisions: overlaps.filter((other) => !same(other)), alternatives: overlaps.filter(same) };
}

/** The other pull requests of an issue worth showing beside `number`: newest first, at most a few. */
export function otherAttempts(pulls: Pick<Pull, "number">[], number: number): number[] {
  return pulls
    .map((pull) => pull.number)
    .filter((other) => other !== number)
    .sort((a, b) => b - a)
    .slice(0, MAX_ATTEMPTS);
}

/** The paths both lists of changed files name, in the order of the first. */
export function sharedPaths(mine: Pick<ChangedFile, "path">[], theirs: Pick<ChangedFile, "path">[]): string[] {
  const other = new Set(theirs.map((file) => file.path));
  return mine.map((file) => file.path).filter((path) => other.has(path));
}

/**
 * Where a pull request's review stands: each reviewer's latest verdict,
 * changes asked for first; otherwise whose review was asked for.
 */
export function attemptReview(comments: Pick<Comment, "author" | "verdict">[], reviewers: string[]): AttemptReview {
  const latest = new Map<string, NonNullable<Comment["verdict"]>>();
  for (const comment of comments) if (comment.verdict) latest.set(comment.author.username, comment.verdict);
  const by = (verdict: NonNullable<Comment["verdict"]>) =>
    [...latest].filter(([, given]) => given === verdict).map(([reviewer]) => reviewer);
  const blocking = by("request_changes");
  if (blocking.length > 0) return { state: "changes_requested", text: `Changes requested by ${blocking.join(", ")}` };
  const approving = by("approve");
  if (approving.length > 0) return { state: "approved", text: `Approved by ${approving.join(", ")}` };
  if (reviewers.length > 0) return { state: "requested", text: `Review requested from ${reviewers.join(", ")}` };
  return { state: "none", text: "No review yet" };
}

/** What became of an attempt, in a few words. */
export function attemptOutcome(attempt: Pick<Attempt, "status" | "supersededBy">): string {
  if (attempt.status === "merged") return "Merged";
  if (attempt.supersededBy != null) return `Closed · #${attempt.supersededBy} was merged instead`;
  if (attempt.status === "closed") return "Closed without merging";
  if (attempt.status === "draft") return "Draft · in progress";
  return "Open";
}
