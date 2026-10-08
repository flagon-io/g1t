/**
 * Deleting accounts, as a person's page and the Deleted accounts page show
 * it: what went with an account, what stands in the way of deleting one,
 * and what staff type to confirm. Identity checks all of it again. No
 * Workers imports, so it can be tested under Node.
 */
import type { AccountDeletion, AccountWent } from "@g1t/contracts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What went with an account, in a line: "2 workspaces, 1 team, 3 repositories, 4 tokens, 1 SSH key". */
export function accountWentSummary(went: AccountWent): string {
  return [
    plural(went.workspaces, "workspace", "workspaces"),
    plural(went.teams, "team", "teams"),
    plural(went.repositories, "repository", "repositories"),
    plural(went.tokens, "token", "tokens"),
    plural(went.sshKeys, "SSH key", "SSH keys"),
  ].join(", ");
}

/** Why staff cannot delete the account, in a sentence about it, or null. */
export function staffDeletionRefusal(deletion: AccountDeletion): string | null {
  if (deletion.protected) return `${deletion.username} is protected and can never be deleted.`;
  const slugs = deletion.sole_owner_of.map((workspace) => workspace.slug);
  if (slugs.length === 0) return null;
  return `${deletion.username} is the only owner of ${slugs.length === 1 ? "1 workspace" : `${slugs.length} workspaces`}. Each needs another owner, or to be deleted by its owner, first.`;
}

/** Whether what staff typed is the username. Identity checks it again. */
export function confirmsUsername(username: string, typed: string): boolean {
  const value = typed.trim();
  return value !== "" && value.toLowerCase() === username.toLowerCase();
}
