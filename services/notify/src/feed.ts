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
 * unread counts per conversation, push subscriptions and preferences, and
 * the person's status, Do Not Disturb and whether they set themselves away,
 * and when they were last on each workspace's Home page (src/visits.ts).
 *
 * Presence is worked out here from the tabs (src/presence.ts) and told to
 * the room of every workspace the person belongs to (src/room.ts), which
 * passes it to everyone there who is online. A status or Do Not Disturb
 * that runs out is cleared by an alarm and told the same way.
 *
 * The feed authorizes nothing: the Worker reaches it only for the person
 * the site checked (src/index.ts).
 */
import { DurableObject } from "cloudflare:workers";

import {
  NOTIFY_SEED_HEADER,
  type ChannelCounts,
  type OwnPresence,
  type PresenceChange,
  type PresenceEntry,
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
import {
  OFFLINE_GRACE_MS,
  applyChange,
  cleanWorkspaces,
  current,
  dndOn,
  entryOf,
  nextExpiry,
  ownOf,
  presenceOf,
  readKept,
  sameEntry,
  type Kept,
} from "./presence.ts";
import type { Room } from "./room.ts";
import { type Visit, lastVisit, markVisit } from "./visits.ts";
import { sendPush, type Vapid } from "./webpush.ts";

export type FeedEnv = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** One presence room per workspace (src/room.ts); without it, presence stays in the person's own tabs. */
  ROOMS?: DurableObjectNamespace<Room>;
};

/** The headers the Worker passes the person's id and username in, with a socket (src/index.ts). */
export const FEED_USERNAME_HEADER = "x-g1t-notify-username";
export const FEED_USER_ID_HEADER = "x-g1t-notify-user-id";

/** What each socket carries: focus, page, whether it has gone idle, and the workspace it is open in. */
type Tab = { focused: boolean; path: string; at: number; idle?: boolean; workspace?: string | null };

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
    // When the person was last on each workspace's Home page (src/visits.ts).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS visits (workspace TEXT PRIMARY KEY, seen_at INTEGER NOT NULL, previous_at INTEGER)`);
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

  // ── Presence ────────────────────────────────────────────────────────────

  private kept(): Kept {
    return readKept(this.meta("presence"));
  }

  /** Who this feed is for, as the site last said. */
  private person(): { user_id: string; username: string } {
    return { user_id: this.meta("user_id") ?? "", username: this.meta("username") ?? "" };
  }

  /** The open tabs as presence sees them, leaving out one that is closing. */
  private presenceTabs(closing?: WebSocket): { idle: boolean }[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket !== closing && socket.readyState === WebSocket.OPEN)
      .map((socket) => ({ idle: (socket.deserializeAttachment() as Tab | null)?.idle === true }));
  }

  private entry(closing?: WebSocket): PresenceEntry {
    const kept = this.kept();
    return entryOf(this.person(), presenceOf(this.presenceTabs(closing), kept.away_manual), kept, Date.now());
  }

  private room(workspace: string) {
    const rooms = this.env.ROOMS;
    return rooms ? rooms.get(rooms.idFromName(workspace)) : null;
  }

  private memberOf(): string[] {
    try {
      return cleanWorkspaces(JSON.parse(this.meta("workspaces") ?? "[]"));
    } catch {
      return [];
    }
  }

  /**
   * Works presence out again and, when how the person shows has changed,
   * tells their own tabs and every workspace's room. `force` tells them
   * anyway (a tab just connected, so a room may have missed the last word).
   */
  private async refresh(options: { closing?: WebSocket; force?: boolean } = {}): Promise<PresenceEntry> {
    const now = Date.now();
    // What ran out goes, so nobody is told of it again.
    const kept = this.kept();
    const live = current(kept, now);
    if (JSON.stringify(live) !== JSON.stringify(kept)) this.setMeta("presence", JSON.stringify(live));
    const entry = this.entry(options.closing);
    let before: PresenceEntry | null = null;
    try {
      before = JSON.parse(this.meta("reported") ?? "null") as PresenceEntry | null;
    } catch {
      before = null;
    }
    const changed = !sameEntry(before, entry);
    if (changed || options.force) {
      this.setMeta("reported", JSON.stringify(entry));
      this.send({ type: "me", me: ownOf(entry, live) }, options.closing);
      // Without an id there is nobody to name: the site always sends one with a socket.
      if (entry.user_id) await Promise.allSettled(this.memberOf().map((workspace) => this.room(workspace)?.report(workspace, entry)));
    }
    await this.schedule();
    return entry;
  }

  /** The next alarm: when a status or Do Not Disturb runs out, or when a person whose last tab closed shows offline. */
  private async schedule(): Promise<void> {
    const now = Date.now();
    const times = [nextExpiry(this.kept(), now), Number(this.meta("offline_at") ?? 0) || null].filter((at): at is number => at != null && at > now);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  override async alarm(): Promise<void> {
    const offlineAt = Number(this.meta("offline_at") ?? 0);
    if (offlineAt && offlineAt <= Date.now()) this.setMeta("offline_at", "0");
    await this.refresh();
  }

  /** A tab just connected: everyone hears it is here, and it hears how everyone in its workspace shows. */
  private async connected(socket: WebSocket, workspace: string | null): Promise<void> {
    this.setMeta("offline_at", "0");
    const entry = await this.refresh({ force: true });
    if (!workspace || !entry.user_id) return;
    const people = await this.room(workspace)
      ?.report(workspace, entry, true)
      .catch((error: unknown) => {
        console.error("notify: reading a presence room failed", error);
        return null;
      });
    if (!people) return;
    try {
      socket.send(JSON.stringify({ type: "presence", workspace, people, full: true } satisfies FeedEvent));
    } catch {
      // Gone already.
    }
  }

  // ── Sockets ─────────────────────────────────────────────────────────────

  private tabs(): TabState[] {
    return this.ctx.getWebSockets().map((socket) => {
      const tab = (socket.deserializeAttachment() as Tab | null) ?? { focused: false, path: "", at: 0 };
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0;
      return { focused: tab.focused, seen_at: Math.max(tab.at, pinged) };
    });
  }

  private send(event: FeedEvent, except?: WebSocket): void {
    const text = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
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
    const username = request.headers.get(FEED_USERNAME_HEADER);
    const userId = request.headers.get(FEED_USER_ID_HEADER);
    this.remember({ user_id: userId ?? "", username: username ?? "" });
    if (Array.isArray(seed?.workspaces)) this.setMeta("workspaces", JSON.stringify(cleanWorkspaces(seed.workspaces)));
    const workspace = seed?.workspace?.toLowerCase() || null;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ focused: false, path: "", at: Date.now(), idle: false, workspace } satisfies Tab);
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
    // Presence after the socket is handed back: the rooms are not waited on.
    this.ctx.waitUntil(this.connected(server, workspace));
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
      const before = (socket.deserializeAttachment() as Tab | null) ?? { focused: false, path: "", at: 0 };
      const idle = frame.idle === true;
      socket.serializeAttachment({
        focused: frame.focused === true,
        path: String(frame.path ?? "").slice(0, 500),
        at: Date.now(),
        idle,
        workspace: before.workspace ?? null,
      } satisfies Tab);
      // Gone idle, or back: away or active.
      if (idle !== (before.idle === true)) await this.refresh();
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
    await this.left(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.left(socket);
  }

  /**
   * A tab went. The last one leaves the person showing as they were for a
   * moment, so a reload or a switch of workspace is not leaving; the alarm
   * then says offline if no tab came back.
   */
  private async left(socket: WebSocket): Promise<void> {
    if (this.presenceTabs(socket).length === 0) {
      this.setMeta("offline_at", String(Date.now() + OFFLINE_GRACE_MS));
      await this.schedule();
      return;
    }
    await this.refresh({ closing: socket });
  }

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
    const now = Date.now();
    // Do Not Disturb: kept and counted, neither toasted nor pushed.
    const quiet = dndOn(this.kept().dnd_until, now);
    const decision = decide({ prefs: this.preferences(), notification, tabs: this.tabs(), subscriptions, now, test, dnd: quiet });
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

  /** Tabs open in `workspace` hear how these people now show (from its room). */
  async presence(workspace: string, people: PresenceEntry[]): Promise<void> {
    const text = JSON.stringify({ type: "presence", workspace, people, full: false } satisfies FeedEvent);
    for (const socket of this.ctx.getWebSockets()) {
      const tab = socket.deserializeAttachment() as Tab | null;
      if (tab?.workspace !== workspace) continue;
      try {
        socket.send(text);
      } catch {
        // Closing already.
      }
    }
  }

  /** The person's own: presence, status, Do Not Disturb. */
  async own(person: { user_id: string; username: string }): Promise<OwnPresence> {
    this.remember(person);
    const kept = current(this.kept(), Date.now());
    return ownOf(this.entry(), kept);
  }

  /** A change to the person's own, told to their tabs and to every workspace they are in. */
  async setPresence(person: { user_id: string; username: string }, change: PresenceChange): Promise<OwnPresence> {
    this.remember(person);
    const kept = applyChange(this.kept(), change, Date.now());
    this.setMeta("presence", JSON.stringify(kept));
    const entry = await this.refresh();
    return ownOf(entry, current(this.kept(), Date.now()));
  }

  private remember(person: { user_id: string; username: string }): void {
    if (person.user_id) this.setMeta("user_id", person.user_id.slice(0, 100));
    if (person.username) this.setMeta("username", person.username.slice(0, 100));
  }

  private visit(workspace: string): Visit | null {
    return this.sql.exec<Visit>("SELECT seen_at, previous_at FROM visits WHERE workspace = ?", workspace).toArray()[0] ?? null;
  }

  /** When the person was last on `workspace`'s Home page, as it counts from (src/visits.ts); null when never. */
  async lastVisit(workspace: string): Promise<{ seen_at: string | null }> {
    const since = lastVisit(this.visit(workspace), Date.now());
    return { seen_at: since != null ? new Date(since).toISOString() : null };
  }

  /** Marks the person's visit to `workspace`'s Home page at `at`; it only moves forward. */
  async markVisit(workspace: string, at: unknown): Promise<{ seen_at: string | null }> {
    const now = Date.now();
    const next = markVisit(this.visit(workspace), at, now);
    if (next) {
      this.sql.exec(
        "INSERT INTO visits (workspace, seen_at, previous_at) VALUES (?, ?, ?) ON CONFLICT (workspace) DO UPDATE SET seen_at = excluded.seen_at, previous_at = excluded.previous_at",
        workspace,
        next.seen_at,
        next.previous_at,
      );
    }
    return this.lastVisit(workspace);
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
