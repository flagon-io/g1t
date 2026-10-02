import type { Result } from "./result";

export type User = { id: string; username: string };

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
  createAccessToken(user: User, name: string): Promise<{ token: string; info: AccessToken }>;
  removeAccessToken(user: User, id: string): Promise<void>;
}
