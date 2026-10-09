/**
 * Deleting an account. Mirrors `crates/contracts/src/account_deletion.rs`;
 * identity's `account_deletion.rs` does it.
 *
 * A person deletes their own account from Settings, typing their username
 * and proving it is them; g1t's staff can delete one from sudo with a
 * reason. Neither works while the account is the only owner of a live
 * workspace, or for a protected account; staff may instead delete those
 * workspaces with it (`withSoleWorkspaces`), unless one is protected or its
 * billing cannot settle. It is soft first: everything it
 * could sign in with ends at once and it leaves every workspace, and it is
 * kept for `ACCOUNT_RESTORE_DAYS` for staff to restore. Then it is purged,
 * its username is never given to anyone again, and what it wrote shows as
 * `GHOST_USERNAME`. There is no API route for it: the site and sudo only.
 */

/** How long a deleted account is kept, for g1t's staff to restore, before it is purged. */
export const ACCOUNT_RESTORE_DAYS = 30;

/** Who wrote what a purged account wrote. Reserved: nobody may register it. */
export const GHOST_USERNAME = "ghost";

/** `ghost`'s account id. */
export const GHOST_ID = "usr_ghost";

/** A live workspace the account is the only owner of: in the way until it has another owner or is deleted. */
export type SoleOwnedWorkspace = {
  slug: string;
  name: string;
  /** Everyone in it, the account included. */
  members: number;
  /** What billing needs before the workspace itself can be deleted; null when nothing. */
  billing: string | null;
  /** It can never be deleted, by anyone, so staff cannot delete it with the account either. */
  protected: boolean;
};

/** A workspace staff deleted together with the account that alone owned it. */
export type WorkspaceDeletedWith = {
  workspaceId: string;
  slug: string;
};

/** What deleting an account takes with it, and what stands in the way. */
export type AccountDeletion = {
  username: string;
  /** Live workspaces it is in, which it leaves. */
  workspaces: number;
  /** Personal access tokens. */
  tokens: number;
  ssh_keys: number;
  /** Applications signed in as it. */
  applications: number;
  /** Repositories it has a role on directly. */
  repositories: number;
  sole_owner_of: SoleOwnedWorkspace[];
  /** It can never be deleted, by anyone. */
  protected: boolean;
};

/** What went with a deleted account, counted when it was deleted, and who deleted it when it was staff. */
export type AccountWent = {
  workspaces: number;
  teams: number;
  repositories: number;
  tokens: number;
  sshKeys: number;
  /** The staff member who deleted it; null when the person did. */
  staff: string | null;
  reason: string | null;
  /** The workspaces it alone owned that staff deleted with it; each is restored or purged on its own. */
  deletedWorkspaces: WorkspaceDeletedWith[];
};

/** An account deleted and kept until `purgeAfter` for staff to restore. */
export type DeletedAccount = {
  userId: string;
  username: string;
  /** RFC 3339. */
  deletedAt: string;
  /** RFC 3339: when it is purged unless restored first. */
  purgeAfter: string;
  went: AccountWent;
  /** Whether staff can still restore it. */
  restorable: boolean;
};
