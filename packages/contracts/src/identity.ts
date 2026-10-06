import type { AccessClient, BasePermission, RepoGrant } from "./access";
import type { Acting, CreateRunCredentialInput, RunBinding } from "./audit";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

export type User = {
  id: string;
  username: string;
  /**
   * `workspace` when a workspace is acting through one of its own access
   * tokens: `id` is then the workspace's and `username` its slug. `system`
   * is g1t itself doing platform work, such as a security update
   * (`username` `g1t`). Absent means `user`.
   */
  kind?: "user" | "workspace" | "agent" | "system";
  /**
   * Whether the account's email address is confirmed. Only set on users
   * resolved from credentials; unverified accounts cannot change anything.
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
  };
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
};

/** How long an old workspace slug redirects, and stays reserved for it, after a rename. */
export const SLUG_HOLD_DAYS = 90;

/** How long a workspace must wait between renames. */
export const RENAME_COOLDOWN_HOURS = 24;

/** The largest avatar that can be uploaded, in bytes. */
export const MAX_AVATAR_BYTES = 1024 * 1024;

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
};

export type Member = {
  username: string;
  role: Role;
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
export type InviteStatus = "pending" | "redeemed" | "expired" | "revoked";

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
  /** The staff member who minted it; only in staff views. */
  staff?: string | null;
};

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
}

/** Who is asking. Every read and write in every service takes one. */
export type Viewer = User | null;

export type SshKey = {
  id: string;
  title: string;
  fingerprint: string;
  /** RFC 3339. */
  createdAt: string;
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
  /** Its scopes, as `resource:level`. Null: full access. */
  scopes: string[] | null;
  /** Made before tokens had scopes: full access until someone narrows it. */
  legacy: boolean;
  /** RFC 3339. Null: it does not expire. */
  expiresAt: string | null;
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
  /** The username of the owner who deleted it. */
  deletedBy: string;
  /** RFC 3339: when it is purged unless restored first. */
  purgeAfter: string;
  /** What went with it, counted when it was deleted. */
  went: WorkspaceDeletion;
  /** Whether staff can still restore it. */
  restorable: boolean;
};

export interface IdentityApi extends AccessClient {
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
  ): Promise<Result<{ user: User; sessionToken: string }>>;
  /** Verifies a username and password for website sign-in. */
  /**
   * Verifies a username, or any confirmed address of the account, and its
   * password. Wrong passwords are counted against the account and `client`
   * (the visitor's IP address); past a limit nothing is checked for a while.
   */
  signIn(username: string, password: string, client?: string | null): Promise<Result<{ user: User; sessionToken: string }>>;
  signOut(sessionToken: string): Promise<void>;

  /** Sends the confirmation email again. */
  resendVerification(user: User): Promise<Result<boolean>>;
  /** Confirms the address the emailed token was sent to. */
  verifyEmail(token: string): Promise<Result<User>>;
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
  /** Members only. */
  listMembers(slug: string, viewer: Viewer): Promise<Result<Member[]>>;
  /** Owners only. */
  addMember(actor: User, slug: string, username: string): Promise<Result<boolean>>;
  /** Owners only. */
  removeMember(actor: User, slug: string, username: string): Promise<Result<boolean>>;
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
   * within `SLUG_HOLD_DAYS`; null otherwise, including for a slug in use.
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
  /** Owners only. The plaintext token is returned once and never stored. */
  createWorkspaceToken(
    actor: User,
    slug: string,
    name: string,
    grant?: TokenGrant & { ttlSeconds?: number },
  ): Promise<Result<{ token: string; info: AccessToken }>>;
  /** Owners only. */
  removeWorkspaceToken(actor: User, slug: string, id: string): Promise<Result<boolean>>;

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
  createInvite(user: User, options?: { email?: string | null; workspace?: string | null }): Promise<Result<Invite>>;
  /** Its maker, or an owner of its workspace, revokes a pending invite; the invite comes back. */
  revokeInvite(user: User, id: string): Promise<Result<Invite>>;
  /**
   * What a code is for. Unknown, used, revoked and expired codes all get the
   * same answer, unless `anyStatus`: then a real code that is spent is
   * described, with its `status`. `viewer` sets `forViewer`.
   */
  checkInvite(
    code: string,
    client?: string | null,
    options?: { viewer?: User | null; anyStatus?: boolean },
  ): Promise<Result<InvitePreview>>;
  /**
   * A signed-in person uses a workspace invite sent to their address, or one
   * sent with a repository invitation; returns the workspace's slug, or
   * `workspace/repo`.
   */
  acceptInvite(user: User, code: string): Promise<Result<string>>;
  /** Owners only. Invites an address into a workspace, always with an invite bound to it. */
  inviteMember(actor: User, slug: string, email: string): Promise<Result<Invite>>;
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
   * The plaintext token is returned once and never stored. With
   * `ttlSeconds` the token expires and is left out of token lists; that
   * form is used for hosted agents. A token made for a workspace acting
   * through a token of its own belongs to that workspace too.
   */
  createAccessToken(
    user: User,
    name: string,
    ttlSeconds?: number,
    grant?: TokenGrant & { listed?: boolean },
  ): Promise<{ token: string; info: AccessToken }>;
  /** Changes what one of a person's tokens may do; the token is unchanged. */
  updateAccessToken(user: User, id: string, grant: TokenGrant): Promise<Result<AccessToken>>;
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
export const PROFILE_LIMITS = { name: 80, bio: 160, location: 80, website: 200, pronouns: 40 } as const;

/** What anyone may see about a person, at `g1t.sh/u/<username>`. */
export type Profile = {
  username: string;
  /** The name they go by, if they gave one. */
  name: string | null;
  bio: string | null;
  location: string | null;
  /** Always an `https://` address. */
  website: string | null;
  pronouns: string | null;
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
};

/** A workspace on a person's profile. */
export type ProfileWorkspace = { slug: string; name: string; avatar: string | null };
