/**
 * How active a project is lately, for sorting a workspace's projects: each
 * push, issue or pull request opened or closed, review, comment and
 * deployment adds one, and what came before counts for half as much every
 * week. Kept as a score and the time it was last raised, so raising it is
 * one row's update. Pure, so it is tested apart from the service.
 */

import type { EventType } from "@g1t/contracts";

/** What happens to a project's code and work that counts as activity. */
export const ACTIVE: ReadonlySet<EventType> = new Set<EventType>([
  "git.push",
  "issue.opened",
  "issue.closed",
  "issue.reopened",
  "pull.opened",
  "pull.updated",
  "pull.merged",
  "pull.closed",
  "review.completed",
  "comment.created",
  "deployment.succeeded",
  "deployment.failed",
]);

/** How long until activity counts for half. */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** The score `score` raised at `lastAt` is worth at `at` (RFC 3339 times). */
export function decayed(score: number, lastAt: string | null, at: string): number {
  if (!lastAt || !(score > 0)) return 0;
  const elapsed = Date.parse(at) - Date.parse(lastAt);
  if (!Number.isFinite(elapsed)) return 0;
  // Events delivered out of order count in full: never worth more than they were.
  return score * Math.pow(0.5, Math.max(0, elapsed) / HALF_LIFE_MS);
}

/** The score and its time after one more piece of activity at `at`. */
export function raised(score: number, lastAt: string | null, at: string): { score: number; at: string } {
  const later = !lastAt || Date.parse(at) >= Date.parse(lastAt) ? at : lastAt;
  return { score: decayed(score, lastAt, later) + 1, at: later };
}
