import { WorkerEntrypoint } from "cloudflare:workers";

import {
  type AccessToken,
  type IdentityApi,
  type Result,
  type SshKey,
  type User,
  type Viewer,
  fail,
  newId,
  ok,
} from "@g1t/contracts";

import {
  parseSshKey,
  randomHex,
  sha256Hex,
  verifyPassword,
} from "./crypto";

export interface IdentityEnv {
  DB: D1Database;
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_PREFIX = "g1t_";

type SshKeyRow = { id: string; title: string; fingerprint: string; created_at: number };
type TokenRow = { id: string; name: string; created_at: number };

function toSshKey(row: SshKeyRow): SshKey {
  return {
    id: row.id,
    title: row.title,
    fingerprint: row.fingerprint,
    createdAt: row.created_at * 1000,
  };
}

function toAccessToken(row: TokenRow): AccessToken {
  return { id: row.id, name: row.name, createdAt: row.created_at * 1000 };
}

export default class IdentityService
  extends WorkerEntrypoint<IdentityEnv>
  implements IdentityApi
{
  private get db(): D1Database {
    return this.env.DB;
  }

  /** A Worker must have an event handler; this service is RPC-only. */
  fetch(): Response {
    return new Response("Not found\n", { status: 404 });
  }

  private async userForPassword(username: string, password: string): Promise<Viewer> {
    const row = await this.db
      .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
      .bind(username.toLowerCase())
      .first<User & { password_hash: string }>();
    if (!row || !(await verifyPassword(password, row.password_hash))) return null;
    return { id: row.id, username: row.username };
  }

  async signIn(
    username: string,
    password: string,
  ): Promise<Result<{ user: User; sessionToken: string }>> {
    const user = await this.userForPassword(username, password);
    if (!user) return fail("unauthenticated", "Incorrect username or password.");
    const sessionToken = randomHex(32);
    await this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, unixepoch() + ?)",
      )
      .bind(await sha256Hex(sessionToken), user.id, SESSION_TTL_SECONDS)
      .run();
    return ok({ user, sessionToken });
  }

  async signOut(sessionToken: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM sessions WHERE id = ?")
      .bind(await sha256Hex(sessionToken))
      .run();
  }

  async userForSession(sessionToken: string): Promise<Viewer> {
    return this.db
      .prepare(
        `SELECT users.id, users.username FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.id = ? AND sessions.expires_at > unixepoch()`,
      )
      .bind(await sha256Hex(sessionToken))
      .first<User>();
  }

  async userForGitCredentials(username: string, secret: string): Promise<Viewer> {
    if (!secret.startsWith(TOKEN_PREFIX)) {
      return this.userForPassword(username, secret);
    }
    // Like GitHub, a token alone identifies its user.
    return this.db
      .prepare(
        `SELECT users.id, users.username FROM access_tokens
         JOIN users ON users.id = access_tokens.user_id
         WHERE token_hash = ?`,
      )
      .bind(await sha256Hex(secret))
      .first<User>();
  }

  async userForSshKey(fingerprint: string): Promise<Viewer> {
    return this.db
      .prepare(
        `SELECT users.id, users.username FROM ssh_keys
         JOIN users ON users.id = ssh_keys.user_id
         WHERE fingerprint = ?`,
      )
      .bind(fingerprint)
      .first<User>();
  }

  async userByUsername(username: string): Promise<Viewer> {
    return this.db
      .prepare("SELECT id, username FROM users WHERE username = ?")
      .bind(username.toLowerCase())
      .first<User>();
  }

  async listSshKeys(user: User): Promise<SshKey[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, title, fingerprint, created_at FROM ssh_keys WHERE user_id = ? ORDER BY id",
      )
      .bind(user.id)
      .all<SshKeyRow>();
    return results.map(toSshKey);
  }

  async addSshKey(user: User, title: string, publicKey: string): Promise<Result<SshKey>> {
    const key = await parseSshKey(publicKey);
    if (!key) return fail("invalid", "That is not a valid OpenSSH public key.");
    const taken = await this.db
      .prepare("SELECT 1 FROM ssh_keys WHERE fingerprint = ?")
      .bind(key.fingerprint)
      .first();
    if (taken) return fail("conflict", "That key is already registered.");
    const row: SshKeyRow = {
      id: newId("key"),
      title: title.trim() || key.comment || "SSH key",
      fingerprint: key.fingerprint,
      created_at: Math.floor(Date.now() / 1000),
    };
    await this.db
      .prepare(
        "INSERT INTO ssh_keys (id, user_id, title, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(row.id, user.id, row.title, key.publicKey, row.fingerprint, row.created_at)
      .run();
    return ok(toSshKey(row));
  }

  async removeSshKey(user: User, id: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM ssh_keys WHERE id = ? AND user_id = ?")
      .bind(id, user.id)
      .run();
  }

  async listAccessTokens(user: User): Promise<AccessToken[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, name, created_at FROM access_tokens WHERE user_id = ? ORDER BY id",
      )
      .bind(user.id)
      .all<TokenRow>();
    return results.map(toAccessToken);
  }

  async createAccessToken(
    user: User,
    name: string,
  ): Promise<{ token: string; info: AccessToken }> {
    const token = TOKEN_PREFIX + randomHex(20);
    const row: TokenRow = {
      id: newId("tok"),
      name: name.trim() || "Access token",
      created_at: Math.floor(Date.now() / 1000),
    };
    await this.db
      .prepare(
        "INSERT INTO access_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(row.id, user.id, row.name, await sha256Hex(token), row.created_at)
      .run();
    return { token, info: toAccessToken(row) };
  }

  async removeAccessToken(user: User, id: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM access_tokens WHERE id = ? AND user_id = ?")
      .bind(id, user.id)
      .run();
  }
}
