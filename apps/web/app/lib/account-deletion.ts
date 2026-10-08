/**
 * What Settings → Account says about deleting your account: what goes with
 * it, why it cannot go yet, and what you type to confirm. Identity decides
 * all of it again (`account_deletion.rs`); these say the same words first.
 * No Workers or React imports, so it can be tested under Node.
 */
import type { AccountDeletion } from "@g1t/contracts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `a`, `a and b`, `a, b and c`. */
function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Why the account cannot be deleted, as one sentence, or null. */
export function accountDeletionRefusal(deletion: AccountDeletion | null): string | null {
  if (!deletion) return null;
  if (deletion.protected) return `${deletion.username} is protected and can never be deleted.`;
  const slugs = deletion.sole_owner_of.map((workspace) => workspace.slug);
  if (slugs.length === 1) {
    return `You are the only owner of ${slugs[0]}. Make someone else an owner of it, or delete it, first.`;
  }
  if (slugs.length > 1) {
    return `You are the only owner of ${list(slugs)}. Make someone else an owner of each, or delete them, first.`;
  }
  return null;
}

/** What deleting the account takes with it, one line each. Nothing it does not have is listed. */
export function whatAccountDeletionTakes(deletion: AccountDeletion): string[] {
  const lines: string[] = [];
  if (deletion.workspaces > 0) lines.push(`Your membership of ${plural(deletion.workspaces, "workspace", "workspaces")}`);
  if (deletion.repositories > 0) {
    lines.push(`Your role on ${plural(deletion.repositories, "repository", "repositories")} you were added to`);
  }
  if (deletion.tokens > 0) lines.push(plural(deletion.tokens, "access token", "access tokens"));
  if (deletion.ssh_keys > 0) lines.push(plural(deletion.ssh_keys, "SSH key", "SSH keys"));
  if (deletion.applications > 0) {
    lines.push(plural(deletion.applications, "connected application", "connected applications"));
  }
  return lines;
}

/** Whether what was typed confirms the username: the username itself, in any case. */
export function confirmsUsername(username: string, typed: string): boolean {
  const value = typed.trim();
  return value !== "" && value.toLowerCase() === username.trim().toLowerCase();
}
