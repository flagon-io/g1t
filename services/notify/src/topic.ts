/**
 * One repository's live topic, as a Durable Object named by its id: who
 * is watching its pages now. A workspace's Work pages have one too, named
 * `workspace:<slug>` (src/watch.ts `workspaceTopic`).
 *
 * A feed (src/feed.ts) adds its person when one of their tabs opens a page
 * of the repository, and again before the watch runs out (REPO_WATCH_MS);
 * the site checked first that they may read it. When something changes in
 * the repository, the topic hands it to each of those feeds, which pass it
 * to their tabs. A feed with no tab open any more, or no longer watching,
 * is dropped, and so is a watch that ran out: someone who loses access
 * stops hearing of the repository at the latest when theirs does.
 *
 * Like the room, the topic authorizes nothing: only the Worker and feeds
 * reach it.
 */
import { DurableObject } from "cloudflare:workers";

import type { RepoChange, WorkspaceChange } from "@g1t/contracts";

import type { Feed } from "./feed.ts";
import { MAX_WATCHERS, named } from "./watch.ts";

export type TopicEnv = { FEEDS?: DurableObjectNamespace<Feed> };

export class Topic extends DurableObject<TopicEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: TopicEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS erased (user_id TEXT PRIMARY KEY)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS watchers (user_id TEXT PRIMARY KEY, repo TEXT NOT NULL, until INTEGER NOT NULL)`);
  }

  /** `userId` watches the repository, as `repo` (`owner/name`), until `until` (ms). */
  async watch(userId: string, repo: string, until: number): Promise<void> {
    if (this.sql.exec("SELECT 1 FROM erased WHERE user_id = ?", userId).toArray().length) return;
    this.sql.exec("INSERT OR REPLACE INTO watchers (user_id, repo, until) VALUES (?, ?, ?)", userId, repo, until);
    this.sql.exec("DELETE FROM watchers WHERE user_id NOT IN (SELECT user_id FROM watchers ORDER BY until DESC LIMIT ?)", MAX_WATCHERS);
  }

  async forget(userId: string): Promise<void> {
    this.sql.exec("INSERT OR IGNORE INTO erased (user_id) VALUES (?)", userId);
    await this.unwatch(userId);
  }

  /** `userId` stopped watching it. */
  async unwatch(userId: string): Promise<void> {
    this.sql.exec("DELETE FROM watchers WHERE user_id = ?", userId);
  }

  /** Hands `changes` to everyone watching now; returns how many feeds passed them on. */
  async changed(repoId: string, changes: RepoChange[]): Promise<number> {
    return this.tell(changes.length, (feed, watcher) => feed.repoChanged(repoId, named(changes, watcher.repo)));
  }

  /** A workspace's topic (`key`): hands its work items' `changes` to everyone watching its Work pages. */
  async workspaceChanged(key: string, changes: WorkspaceChange[]): Promise<number> {
    return this.tell(changes.length, (feed) => feed.workspaceChanged(key, changes));
  }

  private async tell(
    count: number,
    send: (feed: DurableObjectStub<Feed>, watcher: { user_id: string; repo: string }) => Promise<boolean>,
  ): Promise<number> {
    const feeds = this.env.FEEDS;
    if (!feeds || !count) return 0;
    const now = Date.now();
    this.sql.exec("DELETE FROM watchers WHERE until <= ?", now);
    const watchers = this.sql.exec<{ user_id: string; repo: string }>("SELECT user_id, repo FROM watchers").toArray();
    if (!watchers.length) return 0;
    const results = await Promise.allSettled(watchers.map((watcher) => send(feeds.get(feeds.idFromName(watcher.user_id)), watcher)));
    let told = 0;
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error("notify: telling a feed of a repository failed", result.reason);
        return;
      }
      if (result.value) told++;
      // No tab open, or not watching any more: it asks again when it is.
      else this.sql.exec("DELETE FROM watchers WHERE user_id = ?", watchers[i]!.user_id);
    });
    return told;
  }
}
