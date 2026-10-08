/**
 * Deleting accounts, as a person's page and the Deleted accounts page show
 * it: what went with an account, what stands in the way of deleting one,
 * and what staff type to confirm. Identity checks all of it again. No
 * Workers imports, so it can be tested under Node.
 */
import type { AccountDeletion, AccountWent, DeletedWorkspace, SoleOwnedWorkspace, WorkspaceDeletedWith } from "@g1t/contracts";

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

/**
 * Why staff cannot delete the account at all, in a sentence about it, or
 * null. Owning workspaces alone is not one: staff delete them with it.
 */
export function staffDeletionRefusal(deletion: AccountDeletion): string | null {
  if (deletion.protected) return `${deletion.username} is protected and can never be deleted.`;
  return null;
}

/** What the workspaces the account owns alone mean for deleting it, in a sentence, or null when it owns none. */
export function soleOwnerNote(deletion: AccountDeletion): string | null {
  const count = deletion.sole_owner_of.length;
  if (count === 0) return null;
  return `${deletion.username} is the only owner of ${count === 1 ? "1 workspace" : `${count} workspaces`}. Deleting the account deletes ${count === 1 ? "it" : "them"} first, each as its owner would: billing closes it, and it is kept for a restore like any deleted workspace.`;
}

/** Why staff cannot delete this workspace with the account, or null. */
export function soleWorkspaceRefusal(workspace: SoleOwnedWorkspace): string | null {
  if (workspace.protected) return `${workspace.slug} is protected and can never be deleted.`;
  return workspace.billing;
}

/**
 * Why staff cannot delete the account together with the workspaces it owns
 * alone, naming each that stands in the way, or null when every one can go.
 * Identity says the same, and deletes nothing, when asked anyway.
 */
export function soleWorkspacesRefusal(deletion: AccountDeletion): string | null {
  const reasons = deletion.sole_owner_of.map(soleWorkspaceRefusal).filter((reason): reason is string => reason !== null);
  if (reasons.length === 0) return null;
  return `${deletion.username} cannot be deleted with its workspaces yet. ${reasons.join(" ")}`;
}

/** Whether what staff typed is the username. Identity checks it again. */
export function confirmsUsername(username: string, typed: string): boolean {
  const value = typed.trim();
  return value !== "" && value.toLowerCase() === username.toLowerCase();
}

/** What staff sent to delete an account. */
export type StaffDeleteForm = {
  username: string;
  reason: string;
  confirm: string;
  /** The form that deletes the workspaces it owns alone too. */
  withWorkspaces: boolean;
  /** The box saying those workspaces go too, ticked. */
  acknowledged: boolean;
};

/** What is wrong with the form to delete an account, or null. Identity checks it all again. */
export function staffDeleteProblem(form: StaffDeleteForm): string | null {
  if (!form.reason) return "Say why the account is being deleted.";
  if (!confirmsUsername(form.username, form.confirm)) return `Type ${form.username} to confirm.`;
  if (form.withWorkspaces && !form.acknowledged) return "Tick the box to say the workspaces it alone owns are deleted too.";
  return null;
}

/** A workspace deleted with the account, as its page shows it: still waiting to be purged, or gone. */
export type DeletedWithAccount = WorkspaceDeletedWith & {
  /** Its deletion, while it waits to be purged; null once it is purged or restored. */
  deleted: DeletedWorkspace | null;
};

/** The workspaces deleted with an account, each matched to its deletion by id. */
export function deletedWithAccount(went: AccountWent, deleted: DeletedWorkspace[]): DeletedWithAccount[] {
  const byId = new Map(deleted.map((workspace) => [workspace.workspaceId, workspace]));
  return (went.deletedWorkspaces ?? []).map((workspace) => ({ ...workspace, deleted: byId.get(workspace.workspaceId) ?? null }));
}
