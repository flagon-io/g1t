/**
 * What the danger zone of a workspace's settings says about deleting it:
 * what goes with it, and why it cannot go. No Workers or React imports, so
 * it can be tested under Node.
 */
import type { WorkspaceDeletion } from "@g1t/contracts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What deleting the workspace takes with it, one line each, from what
 * identity counted and the apps deployments has up (null when unknown).
 * Nothing it does not hold is listed.
 */
export function whatGoes(deletion: WorkspaceDeletion, apps: number | null): string[] {
  const lines: string[] = [];
  if (deletion.repositories > 0) {
    const their = deletion.repositories === 1 ? "its" : "their";
    lines.push(`${plural(deletion.repositories, "repository", "repositories")}, with ${their} issues, pull requests and workflow runs`);
  }
  if (deletion.projects > 0) lines.push(plural(deletion.projects, "project", "projects"));
  if (apps && apps > 0) lines.push(`${plural(apps, "live app", "live apps")}, taken offline`);
  if (deletion.members > 0) {
    lines.push(`Access for ${plural(deletion.members, "member", "members")}; their own accounts stay`);
  }
  return lines;
}

/** Why the workspace cannot be deleted, as a sentence, or null. */
export function deletionRefusal(slug: string, deletion: WorkspaceDeletion | null): string | null {
  if (!deletion) return null;
  if (deletion.protected) return `${slug} is protected and can never be deleted.`;
  return deletion.billing;
}

/** Whether what was typed confirms the slug: the slug itself, in any case. */
export function confirmsSlug(slug: string, typed: string): boolean {
  return typed.trim().toLowerCase() === slug.toLowerCase();
}
