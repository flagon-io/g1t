import type { AccessClient, BasePermission, RepoGrant } from "./access";
import type { Permissions, ScopeLevel, ScopeResource } from "./scopes";
import type { MemberPrivileges, OrgRole, PolicyHold } from "./members";
import type { Acting, CreateRunCredentialInput, RunBinding } from "./audit";
import type { RepoPath } from "./repos";
import type { Result } from "./result";
import type { TeamCreation, TeamsClient } from "./teams";
import type { DeployKeysClient } from "./deploy-keys";
import type { EmailConfirmed } from "./accounts";

export type User = {
  id: string;
  /** Lowercased: what the person is found, linked and mentioned by. */
  username: string;
  /**
   * The username as its owner wrote it (`Ana`), when that differs from
   * `username`: what pages show (`shownUsername`). Set on the signed-in
   * person and on people looked up by name.
   */
  display_username?: string;
  /**
   * `workspace` when a workspace is acting through one of its own access
   * tokens: `id` is then the workspace's and `username` its slug. `system`
   * is g1t itself doing platform work, such as a security update
   * (`username` `g1t`). Absent means `user`.
   */
  kind?: "user" | "workspace" | "agent" | "system";
  /**
   * Whether the account's email address is confirmed. Only set on users
   * resolved from credentials. An account that has not confirmed it can
   * only confirm it: see `awaitsConfirmation`.
   */
  verified?: boolean;
  /**
   * The workspaces this user belongs to. Set on users resolved from
   * credentials, so any service can authorize from it.
   */
  workspaces?: Membership[];
  /**
   * The person's uploaded avatar: the SHA-256 of its bytes, served at
   * `/avatars/<avatar>`. Only set on the signed-in person; absent means
   * the generated letter avatar.
   */
  avatar?: string;
  /**
   * Set on an agent resolved from its token: who it acts for ("g1t
   * on behalf of syntaqx"), with which credential, and what it may do.
   */
  acting?: Acting;
  /**
   * The repositories this user has a role on directly, whether or not they
   * belong to its workspace. Set with `workspaces`; see `access.ts`.
   */
  grants?: RepoGrant[];
  /**
   * Set on a user resolved from an access token: its scopes (null for full
   * access) and the workspaces or repositories it reaches. See scopes.ts.
   */
  token?: {
    token_id: string;
    scopes?: string[] | null;
    legacy?: boolean;
    /** The token's name, as its owner gave it. */
    name?: string;
    /**
     * A token narrowed to one workspace (or none): its workspace and
     * repositories. The key is kept from before tokens were one kind.
     */
    fine_grained?: {
      workspace?: string | null;
      repositories?: "all" | "selected" | "public";
      repo_ids?: string[];
    };
    /** A workspace's own token with Repositories: admin. */
    admin?: boolean;
    /** Set on what a deploy key resolves to. */
    deploy_key?: string;
    /** The one repository a job's token or a deploy key reaches. */
    repo?: string;
    /** Set on a workflow job's token (`G1T_TOKEN`): the run and job it was made for. */
    job?: { run_id: string; job_id: string; pull_requests?: boolean };
    /**
     * A person's token whose owner let it use the website as them, sent as
     * `Authorization: Bearer` (apps/web, lib/website-token.ts). Not a scope.
     */
    website?: boolean;
  };
  /**
   * Workspaces the person belongs to but cannot use until they meet its
   * policy, such as turning on two-factor authentication. Left out of
   * `workspaces` and `grants` meanwhile.
   */
  held?: PolicyHold[];
};

/** What a member may do: an owner also manages the workspace's members. */
export type Role = "owner" | "member";

export type Membership = {
  /** The workspace's name in URLs: `g1t.sh/<slug>`. */
  slug: string;
  role: Role;
  /** Its display name. Set on users resolved from credentials. */
  name?: string;
  /** Its uploaded icon, as `Workspace.avatar`. */
  avatar?: string;
  /** The workspace's base permission: what members get on every repository. Absent means `write`. */
  base_permission?: BasePermission;
  /** Who may create its teams. Absent means any member. */
  team_creation?: TeamCreation;
  /** The roles held besides owner or member. */
  org_roles?: OrgRole[];
  /** What the workspace lets its members do. Absent means the defaults. */
  privileges?: MemberPrivileges;
  /**
   * Whether this member uses Code: repositories, issues, pull requests,
   * checks, deploys. False for people who only use Chat, Docs and agents
   * (support, sales, finance): they see no repository, whatever the base
   * permission, and agents treat them as unable to change code. Absent
   * means true.
   */
  code_access?: boolean;
};

/** Whether a member uses Code. See `Membership.code_access`. */
export function hasCodeAccess(membership: Pick<Membership, "code_access"> | null | undefined): boolean {
  return membership?.code_access !== false;
}

/** How long an old workspace slug redirects, and stays reserved for it, after a rename. */
export const SLUG_HOLD_DAYS = 90;

/** How long a workspace must wait between renames. */
export const RENAME_COOLDOWN_HOURS = 24;

/** The largest avatar that can be uploaded, in bytes. */
export const MAX_AVATAR_BYTES = 1024 * 1024;

/**
 * Where a workspace keeps its repositories' git data: anywhere g1t stores
 * it (the default), or in the EU only. It applies to repositories made
 * after it is set.
 */
export type DataResidency = "anywhere" | "eu";

/**
 * A workspace: the owner of repositories, and the first segment of their
 * URLs. A person's own space and a team's are the same thing.
 */
export type Workspace = {
  id: string;
  slug: string;
  name: string;
  /** One line saying what the workspace is for. */
  description: string | null;
  /** RFC 3339. */
  createdAt: string;
  memberCount: number;
  /**
   * The workspace's uploaded icon: the SHA-256 of its bytes, served at
   * `/avatars/<avatar>`. Null means the generated letter avatar.
   */
  avatar: string | null;
  /** What every member gets on each repository; owners have Admin. */
  basePermission?: BasePermission;
  /** Who may create its teams. Absent means any member. */
  teamCreation?: TeamCreation;
  /** Whether members and outside collaborators need two-factor authentication. */
  twoFactorRequirementEnabled?: boolean;
} & Partial<MemberPrivileges>;

export type Member = {
  username: string;
  /** The username as its owner wrote it (`Ana`), when that differs from `username`. */
  display_username?: string;
  role: Role;
  /** The roles they hold besides `role`. */
  org_roles?: OrgRole[];
  /** Whether two-factor authentication is on; owners only, null for anyone else. */
  two_factor?: boolean | null;
  /** Their display name, when they set one. */
  name?: string | null;
  /** Their uploaded avatar's hash, served at `/avatars/<avatar>`; null for the generated letter avatar. */
  avatar?: string | null;
};

/** An owner of a workspace, as staff see them. */
export type AdminOwner = { username: string; email: string | null };

/** A workspace as staff see it. Mirrors `AdminWorkspace` in `crates/contracts/src/identity.rs`. */
export type AdminWorkspace = {
  slug: string;
  name: string;
  /** RFC 3339. */
  createdAt: string;
  owners: AdminOwner[];
  memberCount: number;
};

/** A member of a workspace, as staff see them. */
export type AdminMember = { username: string; email: string | null; role: Role; /** RFC 3339. */ joined: string };

export type AdminWorkspaceDetail = {
  slug: string;
  name: string;
  description: string | null;
  /** RFC 3339. */
  createdAt: string;
  /** Owners first, then by username. */
  members: AdminMember[];
  /** It can never be deleted, by anyone (identity's `PROTECTED_WORKSPACES`). */
  protected: boolean;
};

/** The most workspaces one `workspaces` call returns. */
export const ADMIN_WORKSPACES_LIMIT = 500;

/**
 * Whether anyone may make an account, or only someone with an invite.
 * Identity's `REGISTRATION_MODE`; unset means `invite`.
 */
export type RegistrationMode = "invite" | "open";

/** How many invites a person may have out at once, unless identity's `INVITES_PER_USER` says otherwise. */
export const INVITES_PER_USER = 5;
/** How long an invite works, unless identity's `INVITE_TTL_DAYS` says otherwise. */
export const INVITE_TTL_DAYS = 30;

/** Only a pending invite can be used or revoked. Revoked and expired ones never used give the invite back. */
/**
 * `awaiting_confirmation`: used to make an account that has not confirmed its
 * email address yet; what it gives is joined when the address is confirmed,
 * unless it is revoked first.
 */
/**
 * `awaiting_answer`: the account it made is confirmed, and the workspace it
 * names waits for the person to accept or decline. `declined`: they said no.
 */
export type InviteStatus =
  | "pending"
  | "awaiting_confirmation"
  | "awaiting_answer"
  | "redeemed"
  | "declined"
  | "expired"
  | "revoked";

/** One invite. Mirrors `Invite` in `crates/contracts/src/identity.rs`. */
export type Invite = {
  id: string;
  /** `g1t-k7m2-…`: returned when it is made, and to its maker while pending. */
  code: string | null;
  /** The code's first group, such as `g1t-k7m2`. */
  hint: string;
  /** Only this address can use it. */
  email: string | null;
  /** `account` makes an account; `workspace` joins an existing one to `workspace`. */
  kind: "account" | "workspace";
  /** The workspace using it joins. */
  workspace: string | null;
  status: InviteStatus;
  /** Whose allowance it used. */
  chargedTo: "user" | "workspace" | "none";
  /** Its maker's username; null when g1t staff made it. */
  invitedBy: string | null;
  /** The account that used it. */
  redeemedBy: string | null;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  /** The account a workspace invitation is for, by username: someone invited by username, or the account the invite made. */
  invitee?: string | null;
  /** The role `workspace` is joined with; null when it names none. */
  role?: Role | null;
  /** The staff member who minted it; only in staff views. */
  staff?: string | null;
};

/**
 * A workspace invitation waiting for its person's answer, as they see it.
 * Mirrors `WorkspaceInvitation` in `crates/contracts/src/identity.rs`.
 */
export type WorkspaceInvitation = {
  id: string;
  workspace: ProfileWorkspace;
  /** The role accepting joins with. */
  role: Role;
  /** Null when g1t staff sent it. */
  invitedBy: { username: string; name: string | null; avatar: string | null } | null;
  createdAt: string;
  expiresAt: string;
};

/** Someone to invite, as `findPeople` finds them: never an email address. */
export type PersonMatch = { username: string; name: string | null; avatar: string | null };

/** How many invites someone may have out. `limit` and `remaining` are null for no limit. */
export type Allowance = { limit: number | null; used: number; remaining: number | null };

export type InvitesOverview = {
  mode: RegistrationMode;
  allowance: Allowance;
  /** Workspaces the person owns that were granted invites to share. */
  workspaces: { slug: string; allowance: Allowance }[];
  invites: Invite[];
};

/** What a valid code is for, before it is used. */
export type InvitePreview = {
  kind: "account" | "workspace";
  /** Pending, unless `anyStatus` asked about a code that is spent. */
  status: InviteStatus;
  /** Null when g1t staff sent it. */
  invitedBy: { username: string; name: string | null; avatar: string | null } | null;
  workspace: ProfileWorkspace | null;
  /** The repository it accepts an invitation to, such as `{ name: "flagon-io/g1t", role: "write" }`. */
  repository: { name: string; role: string } | null;
  /** Partly hidden, such as `a•••@example.com`. */
  email: string | null;
  /** The bound address in full, while the invite is pending: it fills in and locks the sign-up form. */
  address: string | null;
  /** Whether the bound address has a g1t account already: sign in to accept. */
  hasAccount: boolean;
  /** With a viewer: whether it is theirs (for one of their confirmed addresses, or used by them). */
  forViewer: boolean | null;
  expiresAt: string;
  /** A shared invite link's group, such as `Cloudflare judges`; null for a one-person invite. Not secret. */
  sharedLabel: string | null;
  /** The email domains a shared invite link is limited to; empty for any address. */
  sharedDomains: string[];
  /**
   * Whether the page was opened from this pending invite's own email (its
   * `proof` checked out): the account made with it starts with `address`
   * confirmed. False without a proof, with a wrong one, or for an invite
   * bound to no address.
   */
  emailProven: boolean;
};

export type WaitlistStatus = "waiting" | "invited" | "dismissed";

export type WaitlistEntry = {
  id: string;
  email: string;
  about: string | null;
  status: WaitlistStatus;
  inviteId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** What staff wrote when approving; it went in the invite email. */
  note: string | null;
  /** The account made with the invite, once it was used. */
  joinedAs: string | null;
  /** When they first asked. */
  createdAt: string;
  /** When they last asked. */
  updatedAt: string;
};

export type InviteGrant = { amount: number; note: string | null; grantedBy: string; createdAt: string };
export type InviteTreeNode = { username: string; joinedAt: string; invited: InviteTreeNode[] };

/** Where a person came from and whom they brought. For a workspace, `username` is its slug. */
export type InviteTree = {
  username: string;
  /** Who invited them, then who invited that person, and so on. */
  invitedBy: string[];
  /** The staff member who minted their invite, when staff did. */
  staff: string | null;
  allowance: Allowance;
  grants: InviteGrant[];
  invites: Invite[];
  /** Whom they invited, three levels down. */
  invited: InviteTreeNode[];
  /** The shared invite link the account was made with, if it was. */
  shared: SharedInviteSource | null;
};

// --- Shared invite links, staff only ---------------------------------------------------
//
// One link for a group (a conference's judges, a post, a community): up to
// `maxUses` new accounts, until it expires or staff revoke it, optionally only
// for addresses at some domains. Each use makes a new account, which makes its
// own workspace; it never joins an existing one and uses nobody's allowance.
// The link is `https://g1t.sh/register?invite=<code>`. Mirrors the shared
// invite types in `crates/contracts/src/identity.rs`.

/** How long a shared invite link works when staff give no date. */
export const SHARED_INVITE_TTL_DAYS = 14;
/** The furthest ahead a shared invite link's last day may be set. */
export const SHARED_INVITE_MAX_DAYS = 365;
/** The most accounts one shared invite link makes. */
export const MAX_SHARED_INVITE_USES = 1000;
/** The most characters a shared invite link's label keeps. */
export const MAX_SHARED_INVITE_LABEL = 80;
/** The most email domains one shared invite link may be limited to. */
export const MAX_SHARED_INVITE_DOMAINS = 10;

/** Only a live link makes accounts; `used_up`: every use is taken. */
export type SharedInviteStatus = "live" | "used_up" | "expired" | "revoked";

/** The shared invite link an account was made with. */
export type SharedInviteSource = { id: string; label: string };

/** One shared invite link, as staff see it. */
export type SharedInvite = {
  /** `sinv_…`. */
  id: string;
  /** Whom it is for, such as `Cloudflare judges`. */
  label: string;
  /** The code, while it is live. */
  code: string | null;
  /** The code's first group, such as `g1t-k7m2`. */
  hint: string;
  maxUses: number;
  /** Accounts made with it so far. */
  uses: number;
  /** Only addresses at these domains may use it; empty for any. */
  domains: string[];
  status: SharedInviteStatus;
  /** The staff member who made it, by email. */
  staff: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  /** The accounts made with it, oldest first; `username` is null once one is purged. */
  accounts: { username: string | null; joinedAt: string }[];
};

/** What staff make a shared invite link from. */
export type NewSharedInvite = {
  label: string;
  /** 1 to 1000. */
  maxUses: number;
  /** The last day it works, `YYYY-MM-DD` (UTC); null for 14 days from now. */
  expiresOn: string | null;
  /** Email domains it is limited to, such as `cloudflare.com`; empty for any address. */
  domains: string[];
};

/** The most rows one staff listing of invites or the waitlist returns. */
export const ADMIN_INVITES_LIMIT = 500;

/**
 * Staff-only identity, for sudo.g1t.sh. It takes no viewer and checks no
 * membership: only sudo calls it, over its service binding, once Cloudflare
 * Access and its staff list have let someone in. Never call it on behalf of
 * a customer.
 */
export interface IdentityAdminApi {
  /** Every workspace, newest first, at most 500; `query` matches slug, name, or an owner's username or email. */
  workspaces(query?: string): Promise<AdminWorkspace[]>;
  /** One workspace with all its members, or null. */
  workspace(slug: string): Promise<AdminWorkspaceDetail | null>;

  /** The waitlist, newest first; `query` matches the address or what they said. */
  waitlist(query?: string | null, status?: WaitlistStatus | null): Promise<WaitlistEntry[]>;
  /** How many requests are waiting, for the navigation's badge. */
  waitlistPending(): Promise<number>;
  /**
   * Approving mints an invite bound to the address and emails it, with
   * `note` (up to 500 characters) if given; dismissing only marks it.
   */
  decideWaitlist(id: string, approve: boolean, staff: string, note?: string | null): Promise<Result<WaitlistEntry>>;
  /** Invites, newest first; `query` is a code's start, or part of an email, inviter or redeemer. */
  invites(query?: string | null): Promise<Invite[]>;
  revokeInvite(id: string, staff: string): Promise<Result<Invite>>;
  /** An invite that uses nobody's allowance, optionally bound to (and emailed to) `email`. */
  mintInvite(email: string | null, staff: string): Promise<Result<Invite>>;
  /** More invites (or fewer, with a negative amount) for a person or a workspace. */
  grantInvites(
    target: "user" | "workspace",
    name: string,
    amount: number,
    note: string,
    staff: string,
  ): Promise<Result<Allowance>>;
  /** Where a person came from and whom they brought, or null. */
  inviteTree(username: string): Promise<InviteTree | null>;
  /** A workspace's granted invites and the invites made for it, or null. */
  workspaceInvites(slug: string): Promise<InviteTree | null>;
  /** Shared invite links, newest first, each with the accounts it made. */
  sharedInvites(): Promise<SharedInvite[]>;
  /** Makes a shared invite link; the result carries its code. Recorded in the audit log. */
  createSharedInvite(link: NewSharedInvite, staff: string): Promise<Result<SharedInvite>>;
  /** Stops a shared invite link making more accounts; those it made stay. Recorded in the audit log. */
  revokeSharedInvite(id: string, staff: string): Promise<Result<SharedInvite>>;

  /** Workspaces owners deleted that are not purged yet, newest first. */
  deletedWorkspaces(): Promise<DeletedWorkspace[]>;
  /**
   * Brings a deleted workspace back, with its members, tokens and what went
   * with it, while it is still restorable. Publishes `workspace.restored`.
   */
  restoreWorkspace(workspaceId: string, staff: string): Promise<Result<boolean>>;
  /**
   * Purges a deleted workspace now rather than at `purgeAfter`. `confirm` is
   * its slug, typed out. Refused for a protected workspace. Publishes
   * `workspace.deleted`.
   */
  purgeWorkspace(workspaceId: string, staff: string, confirm: string): Promise<Result<boolean>>;

  /** Every workspace alias, by name. */
  aliases(): Promise<WorkspaceAlias[]>;
  /**
   * Points `alias` at the workspace whose slug is `workspace`. Refused for
   * one of the site's routes, anyone's username, a workspace's slug (deleted
   * or held after a rename) and an existing alias. `note` says why.
   */
  setAlias(alias: string, workspace: string, note: string, staff: string): Promise<Result<WorkspaceAlias>>;
  /** Removes an alias; `reason` goes in sudo's audit log. */
  removeAlias(alias: string, reason: string, staff: string): Promise<Result<boolean>>;
}

/**
 * A name g1t's staff point at a workspace, so its addresses lead there under
 * the workspace's own name: `g1t`, the product, leads to `flagon-io`, Flagon,
 * Inc. Staff-managed only; it follows the workspace through renames.
 */
export type WorkspaceAlias = {
  alias: string;
  workspaceId: string;
  /** The workspace's slug and name now. */
  workspace: string;
  workspaceName: string;
  /** Why it exists. */
  note: string;
  /** The staff member who set it, or `migration`. */
  createdBy: string;
  /** RFC 3339. */
  createdAt: string;
};

/** Who is asking. Every read and write in every service takes one. */
export type Viewer = User | null;

/**
 * Whether this is a person whose account has not confirmed its email
 * address. Such an account can only confirm it, change it, or sign out.
 */
export function awaitsConfirmation(user: Pick<User, "kind" | "verified"> | null | undefined): boolean {
  return !!user && (user.kind ?? "user") === "user" && !user.verified;
}

export type SshKey = {
  id: string;
  title: string;
  fingerprint: string;
  /** RFC 3339. */
  createdAt: string;
  /** When it last signed in over SSH, RFC 3339, to within 5 minutes; null when it never has. */
  lastUsedAt: string | null;
};

export type AccessToken = {
  id: string;
  name: string;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339, to within a few minutes. Null until it is first used. */
  lastUsedAt: string | null;
  /**
   * For a workspace's token, the username of the member who made it. Null
   * once that account is gone, and on personal tokens.
   */
  createdBy: string | null;
  /** Its scopes, as `resource:level`, the highest of each resource. Null: full access. */
  scopes: string[] | null;
  /** Made before tokens had scopes: full access until someone narrows it. */
  legacy: boolean;
  /** RFC 3339. Null: it does not expire. */
  expiresAt: string | null;
  /** Its scopes as permissions: each resource it may use, at the highest level. */
  permissions?: Permissions;
  /** What it is for, as its owner wrote it. */
  description?: string | null;
  /**
   * A personal token's reach: the workspace it is made for; null for every
   * workspace you belong to (or, with `repositorySelection` public, none).
   * Null on a workspace's own token, which reaches its workspace.
   */
  workspace?: string | null;
  /** Which repositories of that workspace it reaches. */
  repositorySelection?: RepositorySelection;
  /** With `selected`: the repositories, as `owner/name`, that you can see. */
  repositories?: string[];
  /** Whether a token made for a workspace that approves tokens may be used there yet. */
  status?: TokenStatus;
  /** Why an owner denied or revoked it. */
  reviewReason?: string | null;
  /** A workspace's own token, acting as the workspace. */
  workspaceOwned?: boolean;
  /** A workspace's own token with Repositories: admin, an admin of its repositories. */
  admin?: boolean;
  /** A personal token its owner let use the website as them. */
  website?: boolean;
};

/** Which repositories a token reaches in its workspace: all, the selected ones, or public ones only. */
export type RepositorySelection = "all" | "selected" | "public";

/** Whether a token made for a workspace may be used there yet. */
export type TokenStatus = "active" | "pending" | "denied" | "revoked";

/** A new access token: a person's, or (with `owner`) a workspace's. */
export type TokenInput = {
  /** A workspace's slug to make that workspace's token; null for your own. */
  owner?: string | null;
  name: string;
  description?: string | null;
  /** 1 to 366 days; null for no expiry, where the workspaces it reaches allow that. */
  ttlSeconds: number | null;
  /**
   * A personal token's reach: a workspace's slug, or null for every
   * workspace you belong to (with `repositorySelection` public: none).
   */
  workspace: string | null;
  repositorySelection: RepositorySelection;
  /** With `selected`: `owner/name` or names in the workspace. */
  repositories: string[];
  /** Each resource's level; left out is no access. */
  permissions: Partial<Record<ScopeResource, ScopeLevel>>;
  /** A personal token: whether it may use the website as you. Off unless set. */
  website?: boolean;
};

/** A change to a token; what is left out stays. */
export type TokenChange = Partial<Pick<TokenInput, "name" | "description" | "repositorySelection" | "repositories" | "permissions" | "website">>;

/** A workspace's rules for personal access tokens. */
export type TokenPolicy = {
  /** A token made for every workspace of its owner reaches this one. */
  allowTokensForAllWorkspaces: boolean;
  /** A token may be made for this workspace alone. */
  allowTokensForThisWorkspace: boolean;
  /** A token made for this workspace waits for an owner's approval. */
  requireApproval: boolean;
  /** Null: no limit. */
  maxLifetimeDays: number | null;
  forbidNoExpiry: boolean;
  updatedBy?: string | null;
  updatedAt?: string | null;
};

/** A member's personal token that reaches a workspace, as its owners see it. */
export type MemberToken = {
  owner: string;
  token: AccessToken;
  /** Whether it reaches the workspace now. */
  reaches: boolean;
  /** Why not: pending approval, denied, revoked, tokens for all workspaces not allowed, tokens made for this workspace not allowed, lasts too long, never expires. */
  blockedBy?: string | null;
};

/** What a new or changed token may do. */
export type TokenGrant = {
  /** Null: full access. */
  scopes: string[] | null;
};

export type DeviceStart = {
  /** Secret held by the tool and exchanged for a token once approved. */
  deviceCode: string;
  /** Short code shown to the person, e.g. `WDJB-MJHT`. */
  userCode: string;
  /** Seconds until both codes stop working. */
  expiresIn: number;
  /** Seconds the tool should wait between polls. */
  interval: number;
};

export type DeviceRequest = { userCode: string; clientName: string };

export type DeviceClaim =
  | { status: "pending" | "denied" | "expired" }
  | { status: "approved"; token: string; user: User };

/** What the site passes on once a person has approved an application. */
export type OAuthApproval = {
  clientId: string;
  /** Shown wherever the application's access is listed. */
  clientName: string;
  redirectUri: string;
  /** PKCE challenge, method S256. */
  codeChallenge: string;
  /** What the person granted. Null: full access. */
  scopes: string[] | null;
};

export type OAuthTokens = {
  accessToken: string;
  /** Works once; using it returns the next one. */
  refreshToken: string;
  /** Seconds until the access token stops working. */
  expiresIn: number;
  /** The scopes granted, space-separated, or `*` for full access. */
  scope?: string | null;
};

/** An application a person has signed in to. */
export type OAuthGrant = {
  id: string;
  clientName: string;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  lastUsedAt: string;
  /** What the person granted. Null: full access. */
  scopes: string[] | null;
  /** Signed in before applications had scopes: full access until narrowed. */
  legacy: boolean;
};

/** Accounts, credentials and sessions. */
/**
 * What deleting a workspace takes with it, and what stands in the way:
 * nothing does while `billing` is null and it is not `protected`.
 */
export type WorkspaceDeletion = {
  /** Its live repositories, deleted with it. */
  repositories: number;
  /** Its projects, hidden with it. */
  projects: number;
  members: number;
  /** Why billing cannot close it yet, in words for its owner. */
  billing: string | null;
  /** It can never be deleted, by anyone. */
  protected: boolean;
};

/** How long a deleted workspace is kept, for g1t's staff to restore, before it is purged. */
export const WORKSPACE_RESTORE_DAYS = 30;

/**
 * Workspaces nobody can delete, whatever identity's `PROTECTED_WORKSPACES`
 * says: Flagon's, which runs g1t. Services that act on `workspace.deleting`
 * check it too, so one published for it by mistake changes nothing.
 */
export const ALWAYS_PROTECTED_WORKSPACES: readonly string[] = ["flagon-io"];

/** Whether `slug` is one of `ALWAYS_PROTECTED_WORKSPACES`, in any case. */
export function isProtectedWorkspace(slug: string): boolean {
  return ALWAYS_PROTECTED_WORKSPACES.includes(slug.trim().toLowerCase());
}

/** A workspace an owner deleted, kept until `purgeAfter` for staff to restore. */
export type DeletedWorkspace = {
  workspaceId: string;
  slug: string;
  name: string;
  /** RFC 3339. */
  deletedAt: string;
  /** The username of the owner who deleted it, or the staff member who deleted it with the account that alone owned it. */
  deletedBy: string;
  /** RFC 3339: when it is purged unless restored first. */
  purgeAfter: string;
  /** What went with it, counted when it was deleted. */
  went: WorkspaceDeletion;
  /** Whether staff can still restore it. */
  restorable: boolean;
};

export interface IdentityApi extends AccessClient, TeamsClient, DeployKeysClient {
  /**
   * Creates an account and signs it in. While registration is invite-only,
   * `inviteCode` must be an unused, unexpired invite (and, when it names an
   * email, that address); it is ignored while registration is open.
   */
  register(
    username: string,
    email: string,
    password: string,
    inviteCode?: string | null,
    /** Who is asking, such as the visitor's IP address, for rate limits. */
    client?: string | null,
    /**
     * The `proof` from the invite email's link. When it is the invite's own
     * and `email` is the address it was sent to, the account starts with that
     * address confirmed; otherwise it is ignored.
     */
    emailProof?: string | null,
  ): Promise<Result<{ user: User; sessionToken: string }>>;
  /** Verifies a username and password for website sign-in. */
  /**
   * Verifies a username, or any confirmed address of the account, and its
   * password. Wrong passwords are counted against the account and `client`
   * (the visitor's IP address); past a limit nothing is checked for a while.
   */
  signIn(
    username: string,
    password: string,
    client?: string | null,
  ): Promise<Result<{ user: User; sessionToken: string; twoFactorChallenge?: string | null }>>;
  /**
   * The second step of signing in, for an account with two-factor
   * authentication: the challenge `signIn` returned, and a code from the
   * app or a recovery code.
   */
  twoFactorSignIn(challenge: string, code: string, client?: string | null): Promise<Result<{ user: User; sessionToken: string }>>;
  signOut(sessionToken: string): Promise<void>;

  /**
   * Sends a new confirmation code and link to the primary of an account
   * that has not confirmed it, at most once a minute.
   */
  resendVerification(user: User): Promise<Result<boolean>>;
  /** Confirms the address the emailed link was sent to, signed in or not; ends the code sent with it. */
  verifyEmail(token: string): Promise<Result<EmailConfirmed>>;
  /** Emails a reset link if the address has an account. Always resolves. */
  /**
   * Any confirmed address of an account works; the link goes to it, and the
   * primary and backup are told. A few an hour per address and per `client`.
   */
  requestPasswordReset(email: string, client?: string | null): Promise<boolean>;
  /** Sets a new password from an emailed token and ends every session. */
  resetPassword(token: string, password: string): Promise<Result<User>>;

  /**
   * Device sign-in (RFC 8628). A tool starts a request, a person approves
   * its short code in a browser, and the tool claims an access token.
   */
  deviceStart(clientName: string): Promise<DeviceStart>;
  /** What a user code is asking for, or null if it is not valid. */
  deviceLookup(userCode: string): Promise<DeviceRequest | null>;
  deviceResolve(userCode: string, user: User, approve: boolean): Promise<Result<boolean>>;
  deviceClaim(deviceCode: string): Promise<DeviceClaim>;

  /**
   * OAuth 2.1 for applications that sign a person in through the browser.
   * The caller has checked the client and its redirect address; this
   * returns the one-time code the application exchanges for tokens.
   */
  oauthAuthorize(user: User, approval: OAuthApproval): Promise<{ code: string }>;
  /** Redeems a code. It works once, for that client, with the PKCE verifier. */
  oauthExchange(code: string, codeVerifier: string, clientId: string, redirectUri: string): Promise<Result<OAuthTokens>>;
  /** Trades a refresh token for new tokens; the old ones stop working. */
  oauthRefresh(refreshToken: string, clientId: string): Promise<Result<OAuthTokens>>;
  /** Applications the user has signed in to, most recently used first. */
  listOAuthGrants(user: User): Promise<OAuthGrant[]>;
  /** Signs an application out. */
  revokeOAuthGrant(user: User, id: string): Promise<void>;
  /** Changes what an application may do, at once and when it refreshes. */
  updateOAuthGrant(user: User, id: string, grant: TokenGrant): Promise<Result<OAuthGrant>>;

  createWorkspace(user: User, slug: string, name: string): Promise<Result<Workspace>>;
  /** Public details of a workspace, or null. */
  getWorkspace(slug: string): Promise<Workspace | null>;
  /** Where a workspace keeps its repositories' git data; null when there is no such workspace. */
  workspaceResidency(slug: string): Promise<DataResidency | null>;
  /**
   * Owners only. Applies to repositories made from then on. Offer `eu`
   * only when the repos service's `storageOptions()` says it is available.
   */
  setWorkspaceResidency(actor: User, slug: string, residency: DataResidency): Promise<Result<DataResidency>>;
  /** Members only. */
  listMembers(slug: string, viewer: Viewer): Promise<Result<Member[]>>;
  /** Owners only. */
  addMember(actor: User, slug: string, username: string): Promise<Result<boolean>>;
  /** Owners only; your own username is leaving. Never the last owner. */
  removeMember(actor: User, slug: string, username: string): Promise<Result<boolean>>;
  /** Owners only: owner or member, and the roles held besides it. Never leaves no owner. */
  updateMember(actor: User, slug: string, username: string, change: { role?: Role; org_roles?: OrgRole[] }): Promise<Result<Member>>;
  /** Owners only: `username` becomes an owner, and you a member. */
  transferOwnership(actor: User, slug: string, username: string): Promise<Result<boolean>>;
  /** You leave the workspace. Never the last owner. */
  leaveWorkspace(user: User, slug: string): Promise<Result<boolean>>;
  /** Owners only: change some member privileges; returns all of them. */
  setMemberPrivileges(actor: User, slug: string, change: Partial<MemberPrivileges>): Promise<Result<MemberPrivileges>>;
  /** Owners only, with two-factor on themselves: require it of everyone. */
  setTwoFactorRequirement(actor: User, slug: string, required: boolean): Promise<Result<boolean>>;
  /** Owners only. An empty name falls back to the slug. */
  updateWorkspace(actor: User, slug: string, details: { name: string; description: string }): Promise<Result<Workspace>>;
  /**
   * Owners only. Changes the slug, the first segment of the workspace's
   * URLs; the display name is untouched. The old slug redirects to the new
   * one, and stays reserved for this workspace, for `SLUG_HOLD_DAYS`.
   * Publishes `workspace.renamed`.
   */
  renameWorkspace(actor: User, slug: string, newSlug: string): Promise<Result<Workspace>>;
  /** Whether `renameWorkspace` would be allowed, changing nothing. */
  checkWorkspaceRename(actor: User, slug: string, newSlug: string): Promise<Result<boolean>>;
  /**
   * The workspace's current slug when `slug` is one it was renamed from
   * within `SLUG_HOLD_DAYS`, or when `slug` is an alias staff set for it
   * (`WorkspaceAlias`); null otherwise, including for a slug in use.
   */
  resolveSlug(slug: string): Promise<string | null>;
  /**
   * Owners only, a person only. `confirm` is the slug, typed out. Refused
   * for a protected workspace, and while billing cannot settle it. Its
   * repositories, projects and apps go with it; it is kept for
   * `WORKSPACE_RESTORE_DAYS`, when g1t's staff can restore it, then purged.
   * Its slug is never given to anyone else; the person whose username it is
   * may make it again once it is purged. Publishes `workspace.deleting`.
   */
  deleteWorkspace(actor: User, slug: string, confirm: string): Promise<Result<boolean>>;
  /** What `deleteWorkspace` would take with it, and what stands in its way, changing nothing. */
  checkWorkspaceDeletion(actor: User, slug: string): Promise<Result<WorkspaceDeletion>>;
  /**
   * Owners only. `image` is the file in base64: PNG, JPEG, WebP or GIF, at
   * most `MAX_AVATAR_BYTES`, checked by its bytes. Null removes the icon.
   */
  setWorkspaceAvatar(actor: User, slug: string, image: string | null): Promise<Result<Workspace>>;
  /** A person's own avatar, as `setWorkspaceAvatar`: the new one, or null. */
  setUserAvatar(user: User, image: string | null): Promise<Result<string | null>>;

  /**
   * A workspace's own access tokens. They belong to the workspace, act as
   * it, and keep working when the member who made one leaves. Members only.
   */
  listWorkspaceTokens(slug: string, viewer: Viewer): Promise<Result<AccessToken[]>>;
  /** Owners only. */
  removeWorkspaceToken(actor: User, slug: string, id: string): Promise<Result<boolean>>;

  /**
   * An access token: yours, or (with `input.owner`, owners only) a
   * workspace's. People only, signed in. The plaintext token is returned
   * once and never stored. A personal token made for a workspace that asks
   * for approval starts pending unless you are an owner there.
   */
  createToken(actor: User, input: TokenInput): Promise<Result<{ token: string; info: AccessToken }>>;
  /**
   * Changes a token of yours, or (with `owner`, owners only) a
   * workspace's; what is left out stays. Widening a token made for a
   * workspace that approves tokens asks for approval again.
   */
  updateToken(actor: User, id: string, change: TokenChange, owner?: string | null): Promise<Result<AccessToken>>;
  /** A workspace's rules for personal access tokens. Members only. */
  getTokenPolicy(slug: string, viewer: Viewer): Promise<Result<TokenPolicy>>;
  /** Owners only, as people. `maxLifetimeDays` of 0 removes the limit. */
  setTokenPolicy(
    actor: User,
    slug: string,
    change: Partial<Omit<TokenPolicy, "updatedBy" | "updatedAt">>,
  ): Promise<Result<TokenPolicy>>;
  /** The members' tokens that can reach a workspace. Owners only. */
  listMemberTokens(
    actor: User,
    slug: string,
    filter?: { status?: TokenStatus },
  ): Promise<Result<MemberToken[]>>;
  /** Approve or deny a token waiting for approval. Owners only. */
  reviewTokenRequest(actor: User, slug: string, id: string, approve: boolean, reason?: string | null): Promise<Result<MemberToken>>;
  /** Take a member's token out of the workspace. Owners only. */
  revokeMemberToken(actor: User, slug: string, id: string, reason?: string | null): Promise<Result<boolean>>;

  userForSession(sessionToken: string): Promise<Viewer>;

  /** Whether registration is invite-only. */
  registration(): Promise<RegistrationMode>;
  /** A person's invites and what they have left. */
  listInvites(user: User): Promise<InvitesOverview>;
  /**
   * A person makes an invite, optionally for one address (emailed to it),
   * using one of theirs or, with `workspace`, one the workspace was granted.
   * People only: never an agent or a workspace's token.
   */
  createInvite(
    user: User,
    options?: { email?: string | null; workspace?: string | null; join?: string | null; joinRole?: "owner" | "member" | null },
  ): Promise<Result<Invite>>;
  /** Its maker, or an owner of its workspace, revokes a pending invite; the invite comes back. */
  revokeInvite(user: User, id: string): Promise<Result<Invite>>;
  /**
   * What a code is for. Unknown, used, revoked and expired codes all get the
   * same answer, unless `anyStatus`: then a real code that is spent is
   * described, with its `status`. `viewer` sets `forViewer`; `emailProof`,
   * the `proof` from the invite email's link, sets `emailProven`.
   */
  checkInvite(
    code: string,
    client?: string | null,
    options?: { viewer?: User | null; anyStatus?: boolean; emailProof?: string | null },
  ): Promise<Result<InvitePreview>>;
  /**
   * A signed-in person uses a workspace invite sent to their address, or one
   * sent with a repository invitation; returns the workspace's slug, or
   * `workspace/repo`.
   */
  acceptInvite(user: User, code: string): Promise<Result<string>>;
  /**
   * Owners only. Invites someone into a workspace by address (always with an
   * invite bound to it) or by `username`: a workspace invitation they accept
   * or decline. Nobody joins without saying yes. `role` is what they join as.
   */
  inviteMember(
    actor: User,
    slug: string,
    who: { email?: string | null; username?: string | null; role?: Role | null },
  ): Promise<Result<Invite>>;
  /** The workspace invitations waiting for the person's answer, newest first. */
  listInvitations(user: User): Promise<WorkspaceInvitation[]>;
  /** Joins the invitation's workspace with its role; returns the workspace's slug. */
  acceptInvitation(user: User, id: string): Promise<Result<string>>;
  /** Declines it; whoever sent it is told in their inbox. */
  declineInvitation(user: User, id: string): Promise<Result<boolean>>;
  /** People to invite, by username prefix or name: a username, a name and an avatar each. */
  findPeople(query: string, limit?: number): Promise<PersonMatch[]>;
  /** Owners only: the workspace's invites, newest first. */
  workspaceInvites(slug: string, viewer: Viewer): Promise<Result<Invite[]>>;
  /** Owners only. */
  revokeWorkspaceInvite(actor: User, slug: string, id: string): Promise<Result<Invite>>;
  /** Someone without an invite asks for one. Always the same answer for a valid address. */
  requestAccess(email: string, about: string, client?: string | null): Promise<Result<boolean>>;

  /** Verifies git credentials: the account password or an access token. */
  userForGitCredentials(username: string, secret: string): Promise<Viewer>;
  /** Resolves a `g1t_…` access token, as sent to the API and MCP server. */
  userForAccessToken(token: string): Promise<Viewer>;
  userForSshKey(fingerprint: string): Promise<Viewer>;
  userByUsername(username: string): Promise<Viewer>;
  /** The names behind account and workspace ids; unknown ids are left out. */
  usernames(ids: string[]): Promise<Record<string, string>>;
  /**
   * Internal: the people behind these ids (at most 50) with their
   * workspaces, roles and repository grants, as a signed-in viewer has
   * them. For the agents service's audience checks only. Ids of no live
   * account are left out.
   */
  usersForAudience(ids: string[]): Promise<User[]>;

  /** A person's public profile, or null if there is no such account. Never an email address. */
  profile(username: string): Promise<Profile | null>;
  /** A person changes their own profile. Every field is replaced; an empty one is cleared. */
  updateProfile(actor: User, fields: ProfileFields): Promise<Result<Profile>>;
  /**
   * The workspaces a profile shows `viewer`: those the viewer belongs to
   * as well, and those of `publicIn` (where the person made a public
   * project) that the person really belongs to. Nothing else.
   */
  profileWorkspaces(username: string, viewer: Viewer, publicIn: string[]): Promise<ProfileWorkspace[]>;

  listSshKeys(user: User): Promise<SshKey[]>;
  /** Takes one line in OpenSSH public key format. */
  addSshKey(user: User, title: string, publicKey: string): Promise<Result<SshKey>>;
  removeSshKey(user: User, id: string): Promise<void>;

  listAccessTokens(user: User): Promise<AccessToken[]>;
  /**
   * A credential minted for a person or workspace by another service. The
   * plaintext token is returned once and never stored. With `ttlSeconds`
   * the token expires and is left out of token lists; that form is used
   * for hosted agents. Tokens people make use `createToken`.
   */
  createAccessToken(
    user: User,
    name: string,
    ttlSeconds?: number,
    grant?: TokenGrant & { listed?: boolean },
  ): Promise<{ token: string; info: AccessToken }>;
  /**
   * A token for a g1t agent working for `onBehalfOf`: it acts as
   * `g1t`, in `scope.repo` only, and only for `scope.operations`.
   */
  createAgentToken(
    onBehalfOf: User,
    scope: AgentScope,
    ttlSeconds: number,
  ): Promise<{ token: string; info: AccessToken }>;
  removeAccessToken(user: User, id: string): Promise<void>;
  /**
   * A token for one sandbox run: it acts as the agent on behalf of
   * `onBehalfOf`, can do only what the run's kind needs in `repo`, and
   * expires after `ttlSeconds`. See `audit.ts`.
   */
  createRunCredential(input: CreateRunCredentialInput): Promise<{ token: string; info: AccessToken }>;
  /** Ties tokens, by the SHA-256 of their text in hex, to the agent run their sandbox recorded. */
  bindRunCredentials(tokenHashes: string[], runId: string): Promise<boolean>;
  /** Ends a sandbox's run credentials, by hash or by run. Never touches another token. */
  revokeRunCredentials(target: { tokenHashes?: string[]; runId?: string | null }): Promise<boolean>;
}


/** What an agent's token may do: these operations, in this repository. */
export type AgentScope = { repo: RepoPath; operations: string[]; run?: RunBinding };

/** The most characters each profile field takes. Mirrors `crates/contracts/src/identity.rs`. */
export const PROFILE_LIMITS = { name: 80, bio: 160, location: 80, website: 200, pronouns: 40, timezone: 64 } as const;

/** What anyone may see about a person, at `g1t.sh/u/<username>`. */
export type Profile = {
  /** Lowercased: what the profile is found and linked by. */
  username: string;
  /** The username as its owner wrote it (`Ana`), when that differs: what the page shows. */
  displayUsername?: string | null;
  /** The name they go by, if they gave one. */
  name: string | null;
  bio: string | null;
  location: string | null;
  /** Always an `https://` address. */
  website: string | null;
  pronouns: string | null;
  /** The time zone they are in, an IANA name such as `America/Denver`. */
  timezone: string | null;
  /** The uploaded avatar's hash, served at `/avatars/<avatar>`. */
  avatar: string | null;
  /** When the account was made. RFC 3339. */
  createdAt: string;
};

/** What a person may change on their profile. Empty clears a field. */
export type ProfileFields = {
  name: string;
  bio: string;
  location: string;
  /** `https://…`; a bare `example.com` is taken as `https://example.com`. */
  website: string;
  pronouns: string;
  /** An IANA time zone name, such as `America/Denver`; empty clears it. */
  timezone: string;
};

/** A workspace on a person's profile. */
export type ProfileWorkspace = { slug: string; name: string; avatar: string | null };
