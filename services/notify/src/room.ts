/**
 * One workspace's presence room, as a Durable Object named by its slug.
 *
 * Each member's feed (src/feed.ts) tells the room how they show whenever
 * that changes: presence, status, Do Not Disturb. The room keeps the
 * latest word from each, in its own SQLite storage, and passes every
 * change on to the feeds of the members who are online now, which send it
 * down their tabs open in this workspace. Members who are offline hear
 * nothing; they read everyone afresh when a tab connects (`report` with
 * `snapshot`).
 *
 * The room authorizes nothing: only feeds reach it, and a feed reports to
 * the workspaces the site said its person belongs to.
 */
import { DurableObject } from "cloudflare:workers";

import type { PresenceEntry } from "@g1t/contracts";

import type { Feed } from "./feed.ts";
import { liveEntry, sameEntry } from "./presence.ts";

export type RoomEnv = { FEEDS?: DurableObjectNamespace<Feed> };

/** The most members a room keeps. */
const MAX_PEOPLE = 5000;

export class Room extends DurableObject<RoomEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS people (user_id TEXT PRIMARY KEY, at INTEGER NOT NULL, presence TEXT NOT NULL, json TEXT NOT NULL)`);
  }

  private all(): PresenceEntry[] {
    const now = Date.now();
    return this.sql
      .exec<{ json: string }>("SELECT json FROM people ORDER BY at DESC LIMIT ?", MAX_PEOPLE)
      .toArray()
      .map((row) => liveEntry(JSON.parse(row.json) as PresenceEntry, now));
  }

  private find(userId: string): PresenceEntry | null {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM people WHERE user_id = ?", userId).toArray()[0];
    return row ? (JSON.parse(row.json) as PresenceEntry) : null;
  }

  /**
   * A member's latest word: kept, and passed to everyone online when it
   * changes how they show. With `snapshot`, everyone known comes back, for
   * a tab that just connected.
   */
  async report(workspace: string, entry: PresenceEntry, snapshot = false): Promise<PresenceEntry[] | null> {
    const before = this.find(entry.user_id);
    // An older word, arriving late, changes nothing.
    if (!before || before.at <= entry.at) {
      this.sql.exec(
        "INSERT OR REPLACE INTO people (user_id, at, presence, json) VALUES (?, ?, ?, ?)",
        entry.user_id,
        entry.at,
        entry.presence,
        JSON.stringify(entry),
      );
      if (!sameEntry(before, entry)) this.ctx.waitUntil(this.tell(workspace, entry));
    }
    return snapshot ? this.all() : null;
  }

  /** Everyone known, as they show now. */
  async people(): Promise<PresenceEntry[]> {
    return this.all();
  }

  /** Passes a change to every member online now, the one it is about included (their other tabs). */
  private async tell(workspace: string, entry: PresenceEntry): Promise<void> {
    const feeds = this.env.FEEDS;
    if (!feeds) return;
    const online = this.sql
      .exec<{ user_id: string }>("SELECT user_id FROM people WHERE presence != 'offline' OR user_id = ?", entry.user_id)
      .toArray()
      .map((row) => row.user_id);
    const results = await Promise.allSettled(online.map((id) => feeds.get(feeds.idFromName(id)).presence(workspace, [entry])));
    for (const result of results) if (result.status === "rejected") console.error("notify: telling a feed of presence failed", result.reason);
  }
}
