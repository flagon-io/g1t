import type { RepoPath } from "./repos";
import type { Result } from "./result";

export type User = {
  id: string;
  username: string;
  /**
   * `workspace` when a workspace is acting through one of its own access
   * tokens: `id` is then the workspace's and `username` its slug. Absent
   * means `user`.
   */
  kind?: "user" | "workspace" | "agent";
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
};

/** What a member may do: an owner also manages the workspace's members. */
export type Role = "owner" | "member";

export type Membership = { slug: string; role: Role };

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
};

export type Member = { username: string; role: Role };

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
};

export type OAuthTokens = {
  accessToken: string;
  /** Works once; using it returns the next one. */
  refreshToken: string;
  /** Seconds until the access token stops working. */
  expiresIn: number;
};

/** An application a person has signed in to. */
export type OAuthGrant = {
  id: string;
  clientName: string;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  lastUsedAt: string;
};

/** Accounts, credentials and sessions. */
export interface IdentityApi {
  /** Creates an account and signs it in. */
  register(username: string, email: string, password: string): Promise<Result<{ user: User; sessionToken: string }>>;
  /** Verifies a username and password for website sign-in. */
  signIn(username: string, password: string): Promise<Result<{ user: User; sessionToken: string }>>;
  signOut(sessionToken: string): Promise<void>;

  /** Sends the confirmation email again. */
  resendVerification(user: User): Promise<Result<boolean>>;
  /** Confirms the address the emailed token was sent to. */
  verifyEmail(token: string): Promise<Result<User>>;
  /** Emails a reset link if the address has an account. Always resolves. */
  requestPasswordReset(email: string): Promise<boolean>;
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
   * A workspace's own access tokens. They belong to the workspace, act as
   * it, and keep working when the member who made one leaves. Members only.
   */
  listWorkspaceTokens(slug: string, viewer: Viewer): Promise<Result<AccessToken[]>>;
  /** Owners only. The plaintext token is returned once and never stored. */
  createWorkspaceToken(actor: User, slug: string, name: string): Promise<Result<{ token: string; info: AccessToken }>>;
  /** Owners only. */
  removeWorkspaceToken(actor: User, slug: string, id: string): Promise<Result<boolean>>;

  userForSession(sessionToken: string): Promise<Viewer>;

  /** Verifies git credentials: the account password or an access token. */
  userForGitCredentials(username: string, secret: string): Promise<Viewer>;
  /** Resolves a `g1t_…` access token, as sent to the API and MCP server. */
  userForAccessToken(token: string): Promise<Viewer>;
  userForSshKey(fingerprint: string): Promise<Viewer>;
  userByUsername(username: string): Promise<Viewer>;

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
  createAccessToken(user: User, name: string, ttlSeconds?: number): Promise<{ token: string; info: AccessToken }>;
  /**
   * A token for a g1t agent working for `onBehalfOf`: it acts as
   * `g1t-agent`, in `scope.repo` only, and only for `scope.operations`.
   */
  createAgentToken(
    onBehalfOf: User,
    scope: AgentScope,
    ttlSeconds: number,
  ): Promise<{ token: string; info: AccessToken }>;
  removeAccessToken(user: User, id: string): Promise<void>;
}


/** What an agent's token may do: these operations, in this repository. */
export type AgentScope = { repo: RepoPath; operations: string[] };
