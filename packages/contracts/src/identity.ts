import type { Result } from "./result";

export type User = {
  id: string;
  username: string;
  /**
   * Whether the account's email address is confirmed. Only set on users
   * resolved from credentials; unverified accounts cannot change anything.
   */
  verified?: boolean;
};

/** Who is asking. Every read and write in every service takes one. */
export type Viewer = User | null;

export type SshKey = {
  id: string;
  title: string;
  fingerprint: string;
  createdAt: number;
};

export type AccessToken = { id: string; name: string; createdAt: number };

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
  /** The plaintext token is returned once and never stored. */
  /**
   * With `ttlSeconds` the token expires and is left out of the user's list;
   * that form is used for hosted attempts.
   */
  createAccessToken(user: User, name: string, ttlSeconds?: number): Promise<{ token: string; info: AccessToken }>;
  removeAccessToken(user: User, id: string): Promise<void>;
}
