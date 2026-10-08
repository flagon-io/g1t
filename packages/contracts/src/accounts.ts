/**
 * A person's email addresses and the security of their account, on the
 * identity service. Mirrors `crates/contracts/src/accounts.rs`.
 */
import type { AccountDeletion, DeletedAccount } from "./account-deletion";
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";
import type { Result } from "./result";

/** The most addresses one account may have, confirmed or not. */
export const MAX_EMAILS = 10;
/** How long after signing in sensitive changes need no password, in seconds. */
export const RECENT_AUTH_SECONDS = 10 * 60;
/** The domain of each person's private commit address. */
export const NOREPLY_DOMAIN = "users.noreply.g1t.sh";
/** How many digits the code in a confirmation email has. */
export const CONFIRM_CODE_DIGITS = 6;
/** How long a confirmation email's code and link work, in seconds. */
export const CONFIRM_TTL_SECONDS = 60 * 60;

/**
 * A confirmation code as typed or pasted, with spaces and hyphens taken
 * out; null unless that leaves exactly six digits.
 */
export function tidyConfirmCode(code: string): string | null {
  const digits = code.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** What confirming an address did: by its link (`verifyEmail`) or its code (`confirmEmailCode`). */
export type EmailConfirmed = {
  username: string;
  /** The address confirmed, as typed when it was added. */
  email: string;
  /** Whether the account is confirmed now: whether its primary is. */
  verified: boolean;
  /** The workspace the account's invite joined it to, by slug. */
  joined?: string | null;
  /** Why the invite the account signed up with no longer applies; the address is confirmed all the same. */
  inviteLapsed?: string | null;
};

/**
 * Proof that the person making a sensitive change is the account's owner:
 * the session they signed in to within `RECENT_AUTH_SECONDS`, or their
 * password. Without it the answer is `reauth_required`.
 */
export type Reauth = { sessionToken?: string | null; password?: string | null; client?: string | null };

/** One of a person's addresses. */
export type AccountEmail = {
  /** As typed when it was added. */
  email: string;
  verified: boolean;
  primary: boolean;
  /** Gets security notices as well as the primary. */
  backup: boolean;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  verifiedAt: string | null;
};

export type AccountEmails = {
  /** The primary first, then confirmed addresses, then the rest. */
  emails: AccountEmail[];
  /** Commits g1t makes for the person use `noreply`. */
  privateEmail: boolean;
  /** Refuse pushes whose commits carry one of the person's addresses. */
  blockPrivatePushes: boolean;
  /** `<id suffix>+<username>@users.noreply.g1t.sh`. */
  noreply: string;
  /** The address commits g1t makes for the person carry now. */
  commitEmail: string;
  limit: number;
};

/** What `updateEmailSettings` can change; each field given is changed. */
export type EmailSettings = {
  /** A confirmed address to make primary. */
  primary?: string;
  /** A confirmed address for security notices too, or "" for the primary only. */
  backup?: string;
  privateEmail?: boolean;
  blockPrivatePushes?: boolean;
};

export type SecurityEvent = {
  kind:
    | "email_added"
    | "email_verified"
    | "email_removed"
    | "primary_email_changed"
    | "backup_email_changed"
    | "email_privacy_changed"
    | "password_changed"
    | "password_locked"
    | "ssh_key_added"
    | "ssh_key_removed"
    | (string & {});
  detail: string | null;
  byStaff: boolean;
  reason: string | null;
  /** The staff member; only in staff views. */
  staff?: string | null;
  /** RFC 3339. */
  createdAt: string;
};

/** The account a commit's author address belongs to. */
export type EmailOwner = { id: string; username: string; avatar: string | null };

/** One account's addresses and security log, as staff see them. */
export type AdminUser = {
  id: string;
  username: string;
  /** RFC 3339. */
  createdAt: string;
  emails: AccountEmail[];
  privateEmail: boolean;
  log: SecurityEvent[];
  /** What deleting it would take, and what stands in the way (billing is not asked for staff). */
  deletion: AccountDeletion;
  /** Set while it is deleted and not yet purged. */
  deleted: DeletedAccount | null;
};

/** Where an account's two-factor authentication stands. */
export type TwoFactorStatus = {
  enabled: boolean;
  /** RFC 3339. */
  enabled_at: string | null;
  /** Recovery codes not used yet. */
  recovery_codes_left: number;
  /** The workspaces the person belongs to that require it. */
  required_by: string[];
};

/** What an authenticator app needs: the secret in base32, and the same as an `otpauth://` address for a QR code. */
export type TwoFactorSetup = { secret: string; uri: string };

/** How many recovery codes an account gets. */
export const RECOVERY_CODES = 10;

export interface AccountsApi {
  /** The person's own addresses. People only, never an agent's or a workspace's token. */
  listEmails(user: User): Promise<Result<AccountEmails>>;
  /** Adds an address and emails it a confirmation link. Needs `reauth`. */
  addEmail(user: User, email: string, reauth: Reauth): Promise<Result<AccountEmails>>;
  /** Removes an address; never the primary nor the last confirmed one. Needs `reauth`. */
  removeEmail(user: User, email: string, reauth: Reauth): Promise<Result<AccountEmails>>;
  /** Sends a new confirmation code and link, at most once a minute; the ones before stop working. */
  resendEmailVerification(user: User, email: string): Promise<Result<boolean>>;
  /**
   * The code from a confirmation email, typed by the signed-in person it was
   * sent to. Wrong codes are counted against the account and `client`.
   */
  confirmEmailCode(user: User, code: string, client?: string | null): Promise<Result<EmailConfirmed>>;
  /**
   * For an account with no confirmed address: replaces the address it signed
   * up with, and sends a new code and link there.
   */
  changePendingEmail(user: User, email: string): Promise<Result<AccountEmails>>;
  /** Primary and backup need `reauth`; the privacy switches do not. */
  updateEmailSettings(user: User, settings: EmailSettings, reauth: Reauth): Promise<Result<AccountEmails>>;
  /** The person typed their password again for this session. */
  reauthenticate(sessionToken: string, password: string, client?: string | null): Promise<Result<boolean>>;
  /** The newest entries of the person's security log. */
  securityLog(user: User): Promise<Result<SecurityEvent[]>>;
  /** Whose commits these are, by author address: confirmed and noreply addresses only. */
  emailOwners(emails: string[]): Promise<Record<string, EmailOwner>>;
  /** Whether two-factor authentication is on, and which workspaces require it. */
  twoFactorStatus(user: User): Promise<Result<TwoFactorStatus>>;
  /** Begins turning it on: a new secret for the app. Needs `reauth`. */
  twoFactorStart(user: User, reauth: Reauth): Promise<Result<TwoFactorSetup>>;
  /** A code from the app confirms it; returns the recovery codes, shown once. Needs `reauth`. */
  twoFactorEnable(user: User, code: string, reauth: Reauth): Promise<Result<{ codes: string[] }>>;
  /** Turns it off with a code (or a recovery code). Needs `reauth`. */
  twoFactorDisable(user: User, code: string, reauth: Reauth): Promise<Result<boolean>>;
  /** New recovery codes, replacing the old ones. Needs `reauth`. */
  twoFactorRecoveryCodes(user: User, reauth: Reauth): Promise<Result<{ codes: string[] }>>;
  /** What deleting the person's own account would take, and what stands in the way, changing nothing. People only. */
  checkAccountDeletion(user: User): Promise<Result<AccountDeletion>>;
  /**
   * Deletes the person's own account. `confirm` is their username, typed
   * out; needs `reauth`. Refused for a protected account and while they are
   * the only owner of a live workspace. Kept `ACCOUNT_RESTORE_DAYS` for
   * staff to restore. Publishes `user.deleting`. Not offered by the API.
   */
  deleteAccount(user: User, confirm: string, reauth: Reauth): Promise<Result<boolean>>;
}

/** Staff only, for sudo.g1t.sh. */
export interface AccountsAdminApi {
  user(username: string): Promise<AdminUser | null>;
  /** Removes an address with a reason the person sees; never the last confirmed one. */
  removeEmail(username: string, email: string, reason: string, staff: string): Promise<Result<AdminUser>>;
  /**
   * Deletes an account, with the reason and the username typed out. Refused
   * for a protected account and while it is the only owner of a live
   * workspace. Recorded in sudo's audit log (`account_deleted`).
   */
  deleteAccount(username: string, reason: string, confirm: string, staff: string): Promise<Result<boolean>>;
  /** Deleted accounts not purged yet, newest first. */
  deletedAccounts(): Promise<DeletedAccount[]>;
  /** Brings a deleted account back within its window, with the memberships it left. Publishes `user.restored`. */
  restoreAccount(userId: string, staff: string): Promise<Result<boolean>>;
  /** Purges a deleted account now; `confirm` is its username. Publishes `user.deleted`. */
  purgeAccount(userId: string, staff: string, confirm: string): Promise<Result<boolean>>;
}

async function call<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
  return (await response.json()) as T;
}

export function accountsClient(identity: ServiceBinding): AccountsApi {
  return {
    listEmails: (user) => call(identity, "list_emails", { user }),
    addEmail: (user, email, reauth) => call(identity, "add_email", { user, email, reauth }),
    removeEmail: (user, email, reauth) => call(identity, "remove_email", { user, email, reauth }),
    resendEmailVerification: (user, email) => call(identity, "resend_email_verification", { user, email }),
    confirmEmailCode: (user, code, client) => call(identity, "confirm_email_code", { user, code, client: client ?? null }),
    changePendingEmail: (user, email) => call(identity, "change_pending_email", { user, email }),
    updateEmailSettings: (user, settings, reauth) => call(identity, "update_email_settings", { user, ...settings, reauth }),
    reauthenticate: (sessionToken, password, client) => call(identity, "reauthenticate", { sessionToken, password, client: client ?? null }),
    securityLog: (user) => call(identity, "security_log", { user }),
    emailOwners: (emails) => call(identity, "email_owners", { emails }),
    twoFactorStatus: (user) => call(identity, "two_factor_status", { user }),
    twoFactorStart: (user, reauth) => call(identity, "two_factor_start", { user, reauth }),
    twoFactorEnable: (user, code, reauth) => call(identity, "two_factor_enable", { user, code, reauth }),
    twoFactorDisable: (user, code, reauth) => call(identity, "two_factor_disable", { user, code, reauth }),
    twoFactorRecoveryCodes: (user, reauth) => call(identity, "two_factor_recovery_codes", { user, reauth }),
    checkAccountDeletion: (user) => call(identity, "check_account_deletion", { user }),
    deleteAccount: (user, confirm, reauth) => call(identity, "delete_account", { user, confirm, reauth }),
  };
}

export function accountsAdminClient(identity: ServiceBinding): AccountsAdminApi {
  return {
    user: (username) => call(identity, "admin_user", { username }),
    removeEmail: (username, email, reason, staff) => call(identity, "admin_remove_email", { username, email, reason, staff }),
    deleteAccount: (username, reason, confirm, staff) => call(identity, "admin_delete_account", { username, reason, confirm, staff }),
    deletedAccounts: () => call(identity, "admin_deleted_accounts", {}),
    restoreAccount: (userId, staff) => call(identity, "admin_restore_account", { userId, staff }),
    purgeAccount: (userId, staff, confirm) => call(identity, "admin_purge_account", { userId, staff, confirm }),
  };
}

/** Words for a security log entry, as the person reads it. */
export function securityEventLabel(event: Pick<SecurityEvent, "kind" | "detail">): string {
  const detail = event.detail ?? "";
  switch (event.kind) {
    case "email_added":
      return `Added ${detail}`;
    case "email_verified":
      return `Confirmed ${detail}`;
    case "email_changed_before_confirming":
      return `Changed the address to confirm to ${detail}`;
    case "email_removed":
      return `Removed ${detail}`;
    case "primary_email_changed":
      return `Made ${detail} primary`;
    case "backup_email_changed":
      return detail === "primary only" ? "Security notices go to the primary only" : `Made ${detail} the backup`;
    case "email_privacy_changed":
      return `Email privacy: ${detail}`;
    case "password_changed":
      return "Changed the password";
    case "password_locked":
      return `Password sign-in paused after ${detail}`;
    case "two_factor_enabled":
      return "Turned on two-factor authentication";
    case "two_factor_disabled":
      return "Turned off two-factor authentication";
    case "recovery_codes_regenerated":
      return "Made new recovery codes";
    case "recovery_code_used":
      return "Signed in with a recovery code";
    case "token_created":
      return `Created access token ${detail}`;
    case "token_deleted":
      return `Deleted access token ${detail}`;
    case "token_rescoped":
      return `Changed the scopes of access token ${detail}`;
    case "ssh_key_added":
      return `Added SSH key ${detail}`;
    case "ssh_key_removed":
      return `Removed SSH key ${detail}`;
    case "oauth_grant_created":
      return `Authorized ${detail}`;
    case "oauth_grant_revoked":
      return `Revoked ${detail}`;
    case "oauth_grant_rescoped":
      return `Changed what ${detail} may do`;
    case "account_deleted":
      return "Deleted the account";
    case "account_restored":
      return "Restored the account";
    default:
      return detail ? `${event.kind}: ${detail}` : event.kind;
  }
}
