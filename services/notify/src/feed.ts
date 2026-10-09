/**
 * One person's feed, as a Durable Object named by their user id.
 *
 * It holds a socket per open tab with the WebSocket Hibernation API, so a
 * person with g1t open all day costs nothing between notifications. Plain
 * `ping` keepalives are answered at the edge without waking it, and the
 * time of the last one says whether a tab is still there
 * (`getWebSocketAutoResponseTimestamp`). Each socket carries the tab's
 * focus and page (`serializeAttachment`), which survive hibernation.
 *
 * Kept in the object's own SQLite storage: the latest notifications, the
 * unread counts per conversation, push subscriptions and preferences.
 *
 * The feed authorizes nothing: the Worker reaches it only for the person
 * the site checked (src/index.ts).
 */
import { DurableObject } from "cloudflare:workers";

import {
  NOTIFY_SEED_HEADER,
  type ChannelCounts,
  type FeedDelivery,
  type FeedEvent,
  type FeedNotification,
  type FeedSeed,
  type NotifyPreferences,
  type NotifyStatus,
  type PushSubscriptionJson,
} from "@g1t/contracts";

import { applyCounts, totals } from "./counts.ts";
import { cleanNotification, decide, mergePreferences, pushPayload, readPreferences, type TabState } from "./prefs.ts";
import { sendPush, type Vapid } from "./webpush.ts";

export type FeedEnv = { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };

/** What each socket carries. */
type Tab = { focused: boolean; path: string; at: number };

/** Notifications kept for a tab that opens later. */
const KEPT = 100;
/** Sent with `hello`: the latest few. */
const HELLO = 20;
/** The most browsers one person gets pushes on. */
const MAX_SUBSCRIPTIONS = 20;
/** The longest endpoint taken. */
const MAX_ENDPOINT = 2000;

export class Feed extends DurableObject<FeedEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: FeedEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS notifications_at ON notifications (at)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS counts (workspace TEXT NOT NULL, channel_id TEXT NOT NULL, unread INTEGER NOT NULL, mentions INTEGER NOT NULL, muted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workspace, channel_id))`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL)`,
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  // ── Kept state ──────────────────────────────────────────────────────────

  private meta(key: string): string | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  private preferences(): NotifyPreferences {
    return readPreferences(this.meta("preferences"));
  }

  private inboxUnread(): number {
    return Number(this.meta("inbox_unread") ?? 0) || 0;
  }

  private channelRows(workspace: string): ChannelCounts[] {
    return this.sql
      .exec<{ channel_id: string; unread: number; mentions: number; muted: number }>(
        "SELECT channel_id, unread, mentions, muted FROM counts WHERE workspace = ?",
        workspace,
      )
      .toArray()
      .map((r) => ({ channel_id: r.channel_id, unread: r.unread, mentions: r.mentions, muted: !!r.muted }));
  }

  private counts(workspace: string): FeedEvent {
    return { type: "counts", ...totals(workspace, this.channelRows(workspace), this.inboxUnread(), this.meta(`complete:${workspace}`) === "1") };
  }

  private workspaces(): string[] {
    return this.sql.exec<{ workspace: string }>("SELECT DISTINCT workspace FROM counts").toArray().map((r) => r.workspace);
  }

  private vapid(): Vapid | null {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = this.env;
    return VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY ? { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT || "https://g1t.sh" } : null;
  }

  private subscriptionCount(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM subscriptions").one().n;
  }

  // ── Sockets ─────────────────────────────────────────────────────────────

  private tabs(): TabState[] {
    return this.ctx.getWebSockets().map((socket) => {
      const tab = (socket.deserializeAttachment() as Tab | null) ?? { focused: false, path: "", at: 0 };
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0;
      return { focused: tab.focused, seen_at: Math.max(tab.at, pinged) };
    });
  }

  private send(event: FeedEvent): void {
    const text = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text);
      } catch {
        // Closing already.
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade\n", { status: 426 });
    }
    let seed: FeedSeed | null = null;
    try {
      seed = JSON.parse(request.headers.get(NOTIFY_SEED_HEADER) ?? "null") as FeedSeed | null;
    } catch {
      seed = null;
    }
    if (seed) this.applySeed(seed);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ focused: false, path: "", at: Date.now() } satisfies Tab);
    const hello: FeedEvent = {
      type: "hello",
      notifications: this.latest(HELLO),
      vapid_public_key: this.env.VAPID_PUBLIC_KEY || null,
      preferences: this.preferences(),
    };
    server.send(JSON.stringify(hello));
    const shown = new Set(this.workspaces());
    if (seed?.workspace) shown.add(seed.workspace);
    for (const workspace of shown) server.send(JSON.stringify(this.counts(workspace)));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Counts read from chat and the inbox just now replace what was kept for that workspace. */
  private applySeed(seed: FeedSeed): void {
    if (typeof seed.inbox_unread === "number") this.setMeta("inbox_unread", String(Math.max(0, Math.floor(seed.inbox_unread))));
    const workspace = seed.workspace?.toLowerCase();
    if (!workspace || !Array.isArray(seed.per_channel)) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM counts WHERE workspace = ?", workspace);
      for (const row of seed.per_channel!.slice(0, 2000)) {
        if (typeof row?.channel_id !== "string") continue;
        const kept = applyCounts(null, { ...row, set: true });
        this.sql.exec(
          "INSERT OR REPLACE INTO counts (workspace, channel_id, unread, mentions, muted) VALUES (?, ?, ?, ?, ?)",
          workspace,
          kept.channel_id,
          kept.unread,
          kept.mentions,
          kept.muted ? 1 : 0,
        );
      }
      this.setMeta(`complete:${workspace}`, "1");
    });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 4096) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    if (frame.type === "state") {
      socket.serializeAttachment({ focused: frame.focused === true, path: String(frame.path ?? "").slice(0, 500), at: Date.now() } satisfies Tab);
    } else if (frame.type === "inbox" && Number.isFinite(frame.unread)) {
      // The inbox count a page just read: every tab shows it at once.
      await this.setInbox(Number(frame.unread));
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(): Promise<void> {}

  // ── Notifications ───────────────────────────────────────────────────────

  private latest(limit: number): FeedNotification[] {
    return this.sql
      .exec<{ json: string }>("SELECT json FROM notifications ORDER BY at DESC LIMIT ?", limit)
      .toArray()
      .map((r) => JSON.parse(r.json) as FeedNotification);
  }

  /** Keeps it, unless it was told before. True when it is news. */
  private keep(notification: FeedNotification): boolean {
    const had = this.sql.exec("SELECT 1 FROM notifications WHERE id = ?", notification.id).toArray().length > 0;
    if (had) return false;
    this.sql.exec("INSERT INTO notifications (id, at, json) VALUES (?, ?, ?)", notification.id, Date.now(), JSON.stringify(notification));
    this.sql.exec("DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY at DESC LIMIT ?)", KEPT);
    return true;
  }

  /** Tells the person: open tabs at once, then browsers when none is in front of them. */
  private async tell(notification: FeedNotification, test = false): Promise<number> {
    if (!test && !this.keep(notification)) return 0;
    const subscriptions = this.subscriptionCount();
    const decision = decide({ prefs: this.preferences(), notification, tabs: this.tabs(), subscriptions, now: Date.now(), test });
    this.send({ type: "notification", notification, toast: decision.toast });
    return decision.push ? this.push(notification) : 0;
  }

  /** Pushes to every browser subscribed; drops the ones the push service says are gone. */
  private async push(notification: FeedNotification): Promise<number> {
    const vapid = this.vapid();
    if (!vapid) return 0;
    const subscriptions = this.sql.exec<{ endpoint: string; p256dh: string; auth: string }>("SELECT endpoint, p256dh, auth FROM subscriptions").toArray();
    const payload = pushPayload(notification);
    const results = await Promise.allSettled(
      subscriptions.map((s) => sendPush(s, payload, { vapid, urgency: payload.urgent ? "high" : "normal", topic: payload.tag, ttl: 12 * 3600 })),
    );
    let sent = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("notify: a push failed", result.reason);
        continue;
      }
      if (result.value.gone) this.sql.exec("DELETE FROM subscriptions WHERE endpoint = ?", result.value.endpoint);
      else if (result.value.status < 300) sent++;
      else console.error("notify: a push service answered", result.value.status);
    }
    return sent;
  }

  // ── RPC (called by the Worker, src/index.ts) ────────────────────────────

  async notify(value: unknown): Promise<{ ok: boolean }> {
    const notification = cleanNotification(value);
    if (!notification) return { ok: false };
    await this.tell(notification);
    return { ok: true };
  }

  /** A batch for this person from chat: counts moved, notifications told. */
  async deliver(items: FeedDelivery[]): Promise<{ ok: boolean }> {
    const changed = new Set<string>();
    const told: FeedNotification[] = [];
    for (const item of items) {
      const workspace = String(item.workspace ?? "").toLowerCase();
      if (item.counts?.channel_id && workspace) {
        const before = this.sql
          .exec<{ unread: number; mentions: number; muted: number }>(
            "SELECT unread, mentions, muted FROM counts WHERE workspace = ? AND channel_id = ?",
            workspace,
            item.counts.channel_id,
          )
          .toArray()[0];
        const after = applyCounts(
          before ? { channel_id: item.counts.channel_id, unread: before.unread, mentions: before.mentions, muted: !!before.muted } : null,
          item.counts,
        );
        this.sql.exec(
          "INSERT OR REPLACE INTO counts (workspace, channel_id, unread, mentions, muted) VALUES (?, ?, ?, ?, ?)",
          workspace,
          after.channel_id,
          after.unread,
          after.mentions,
          after.muted ? 1 : 0,
        );
        changed.add(workspace);
      }
      const notification = item.notification ? cleanNotification(item.notification) : null;
      if (notification) told.push(notification);
    }
    for (const workspace of changed) this.send(this.counts(workspace));
    await Promise.all(told.map((n) => this.tell(n)));
    return { ok: true };
  }

  /** The inbox count as it now is (events, after items arrive or are marked): every tab shows it at once. */
  async setInbox(value: number): Promise<{ ok: boolean }> {
    const unread = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    if (unread === this.inboxUnread()) return { ok: true };
    this.setMeta("inbox_unread", String(unread));
    this.send({ type: "inbox", unread });
    return { ok: true };
  }

  async subscribe(subscription: PushSubscriptionJson, userAgent: string | null): Promise<{ ok: boolean }> {
    const endpoint = String(subscription?.endpoint ?? "");
    const { p256dh, auth } = subscription?.keys ?? ({} as PushSubscriptionJson["keys"]);
    if (!/^https:\/\//.test(endpoint) || endpoint.length > MAX_ENDPOINT || typeof p256dh !== "string" || typeof auth !== "string") return { ok: false };
    this.sql.exec(
      "INSERT OR REPLACE INTO subscriptions (endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?)",
      endpoint,
      p256dh.slice(0, 200),
      auth.slice(0, 100),
      userAgent ? userAgent.slice(0, 300) : null,
      Date.now(),
    );
    // The oldest go first past the limit.
    this.sql.exec("DELETE FROM subscriptions WHERE endpoint NOT IN (SELECT endpoint FROM subscriptions ORDER BY created_at DESC LIMIT ?)", MAX_SUBSCRIPTIONS);
    return { ok: true };
  }

  async unsubscribe(endpoint: string): Promise<{ ok: boolean }> {
    this.sql.exec("DELETE FROM subscriptions WHERE endpoint = ?", String(endpoint ?? ""));
    return { ok: true };
  }

  async status(endpoint: string | null): Promise<NotifyStatus> {
    const subscribed = !!endpoint && this.sql.exec("SELECT 1 FROM subscriptions WHERE endpoint = ?", endpoint).toArray().length > 0;
    return { preferences: this.preferences(), subscriptions: this.subscriptionCount(), subscribed, vapid_public_key: this.env.VAPID_PUBLIC_KEY || null };
  }

  async setPreferences(change: unknown): Promise<NotifyPreferences> {
    const preferences = mergePreferences(this.preferences(), change);
    this.setMeta("preferences", JSON.stringify(preferences));
    this.send({ type: "preferences", preferences });
    return preferences;
  }

  async test(username: string): Promise<{ ok: boolean; pushed: number }> {
    const pushed = await this.tell(
      {
        id: `test:${crypto.randomUUID()}`,
        kind: "dm",
        workspace: "",
        title: "g1t",
        body: `Notifications are on, ${username || "there"}. This is what a message looks like.`,
        href: "/settings/notifications",
        actor: { kind: "system", id: "g1t", name: "g1t", avatar: null, avatar_seed: null },
        channel_id: null,
        thread_root: null,
        created_at: new Date().toISOString(),
      },
      true,
    );
    return { ok: true, pushed };
  }
}
