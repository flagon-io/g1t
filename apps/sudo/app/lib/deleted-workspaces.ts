/**
 * Deleted workspaces, as the Deleted workspaces page shows them: what went
 * with each, how long is left to restore it, and what staff must type to
 * purge one now. No Workers imports, so it can be tested under Node.
 */
import type { WorkspaceDeletion } from "@g1t/contracts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What went with a workspace, in a line: "3 repositories, 1 project, 2 members". */
export function wentSummary(went: WorkspaceDeletion): string {
  const parts = [
    plural(went.repositories, "repository", "repositories"),
    plural(went.projects, "project", "projects"),
    plural(went.members, "member", "members"),
  ];
  return parts.join(", ");
}

/** Whole days left before `purgeAfter` (RFC 3339), from `now`; 0 once it is due. */
export function daysLeft(purgeAfter: string, now: number): number {
  const left = Date.parse(purgeAfter) - now;
  if (!Number.isFinite(left) || left <= 0) return 0;
  return Math.ceil(left / 86_400_000);
}

/** Whether what staff typed to purge a workspace now is its slug. Identity checks it again. */
export function confirmsPurge(slug: string, typed: string): boolean {
  return typed.trim().toLowerCase() === slug.toLowerCase();
}
