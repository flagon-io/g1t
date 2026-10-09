/**
 * Notifications: the notify service (`services/notify`) keeps one feed per
 * person, a Durable Object holding their open tabs' sockets, their latest
 * notifications, live unread counts and their browser push subscriptions.
 *
 * Chat tells it about every message a person should count or hear of, the
 * events service about every inbox item, and the site forwards each tab's
 * `/-/live` socket to it. Wire shapes are snake_case end to end.
 */
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";

/** What a notification is about; the preferences decide which ones toast and push. */
export type NotificationKind = "dm" | "mention" | "thread_reply" | "inbox" | "agent_waiting" | "approval";

export const NOTIFICATION_KINDS: readonly NotificationKind[] = ["dm", "mention", "thread_reply", "inbox", "agent_waiting", "approval"];

/** Who it is from: a person, an agent, or g1t itself. */
export type NotificationActor = {
  kind: "user" | "agent" | "system";
  id: string;
  /** How they show: a display name. */
  name: string;
  /** A person's uploaded avatar hash, or null for the letter avatar. */
  avatar?: string | null;
  /** What an agent's pixel creature is drawn from. */
  avatar_seed?: string | null;
};

export type FeedNotification = {
  /** Unique per notification: the same id twice is told once. */
  id: string;
  kind: NotificationKind;
  /** The workspace's slug. */
  workspace: string;
  title: string;
  /** A short preview, a line or two. */
  body: string;
  /** Where clicking it goes, relative to the site. */
  href: string;
  actor: NotificationActor;
  /** The conversation it is in, for a chat notification: toasts for the open one are skipped, and pushes collapse by it. */
  channel_id?: string | null;
  /** The thread it is in, for a reply: quick replies go there. */
  thread_root?: string | null;
  created_at: string;
};

/** How much a person hears of. Counts always move; this governs toasts and pushes. */
export type NotifyLevel = "all" | "dms_mentions" | "none";

export const NOTIFY_LEVELS: readonly NotifyLevel[] = ["all", "dms_mentions", "none"];

export type NotifyPreferences = {
  level: NotifyLevel;
  /** A different level for a workspace, by slug. */
  workspaces: Record<string, NotifyLevel>;
};

/** A change to them: a workspace set to null goes back to the general level. */
export type NotifyPreferencesChange = { level?: NotifyLevel; workspaces?: Record<string, NotifyLevel | null> };

export const DEFAULT_NOTIFY_PREFERENCES: NotifyPreferences = { level: "dms_mentions", workspaces: {} };

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export type PushSubscriptionJson = {
  endpoint: string;
  expiration_time?: number | null;
  keys: { p256dh: string; auth: string };
};

/** A conversation's unread counts for one person. */
export type ChannelCounts = { channel_id: string; unread: number; mentions: number; muted: boolean };

/**
 * What a person has unread in a workspace. `chat_unread` leaves out muted
 * conversations, as the rail's badge does; mentions count everywhere.
 * `inbox_unread` is the person's whole inbox, which is not per workspace.
 * `complete` says `per_channel` was read from chat itself (on connect), so
 * a conversation left out of it has nothing unread.
 */
export type FeedCounts = {
  workspace: string;
  chat_unread: number;
  chat_mentions: number;
  inbox_unread: number;
  per_channel: Omit<ChannelCounts, "muted">[];
  complete: boolean;
};

/** What the feed socket sends a tab. */
export type FeedEvent =
  | { type: "hello"; notifications: FeedNotification[]; vapid_public_key: string | null; preferences: NotifyPreferences }
  | { type: "notification"; notification: FeedNotification; toast: boolean }
  | ({ type: "counts" } & FeedCounts)
  | { type: "preferences"; preferences: NotifyPreferences }
  /** The person's inbox count as it now is, after items arrive or are marked anywhere. */
  | { type: "inbox"; unread: number };

/**
 * What a tab sends over the feed socket: plain `ping` every 25 s (answered
 * without waking the feed), and a state frame whenever it gains or loses
 * focus or moves to another page, and the inbox count the page last read.
 */
export type FeedClientFrame =
  | { type: "state"; focused: boolean; path: string }
  | { type: "inbox"; unread: number };

/**
 * One delivery from chat: counts to move for one person in one
 * conversation, and maybe a notification. `set` replaces the counts (after
 * reading, or writing); otherwise they are added.
 */
export type FeedDelivery = {
  user_id: string;
  workspace: string;
  counts?: {
    channel_id: string;
    unread: number;
    mentions: number;
    muted?: boolean | null;
    set?: boolean;
  } | null;
  notification?: FeedNotification | null;
};

/** What the site hands the feed with a socket: who, and the counts read from chat and the inbox just now. */
export type FeedSeed = {
  workspace: string | null;
  per_channel: ChannelCounts[] | null;
  inbox_unread: number | null;
};

/** Headers the site sets on a forwarded feed socket. */
export const NOTIFY_VIEWER_HEADER = "x-g1t-notify-viewer";
export const NOTIFY_SEED_HEADER = "x-g1t-notify-seed";

export type NotifyStatus = {
  preferences: NotifyPreferences;
  /** How many browsers get pushes. */
  subscriptions: number;
  /** Whether this browser's endpoint is one of them, when it was asked about. */
  subscribed: boolean;
  /** The public key a browser subscribes with; null when push is not set up. */
  vapid_public_key: string | null;
};

export type NotifyApi = {
  /** Tells a person: their open tabs at once, and a push when none is in front of them. */
  notify(target: { user_id?: string; username?: string }, notification: FeedNotification): Promise<{ ok: boolean }>;
  /** Many at once, as chat sends them for a message. */
  deliver(items: FeedDelivery[]): Promise<{ ok: boolean }>;
  subscribe(user: User, subscription: PushSubscriptionJson, userAgent?: string | null): Promise<{ ok: boolean }>;
  unsubscribe(user: User, endpoint: string): Promise<{ ok: boolean }>;
  status(user: User, endpoint?: string | null): Promise<NotifyStatus>;
  setPreferences(user: User, preferences: NotifyPreferencesChange): Promise<NotifyPreferences>;
  /** Sends the person a test notification, toasted and pushed whatever their focus. */
  test(user: User): Promise<{ ok: boolean; pushed: number }>;
};

async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
  return (await response.json()) as T;
}

export function notifyClient(service: ServiceBinding): NotifyApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    notify: (target, notification) => call("notify", { user_id: target.user_id ?? null, username: target.username ?? null, notification }),
    deliver: (items) => call("deliver", { items }),
    subscribe: (user, subscription, userAgent) => call("subscribe", { user_id: user.id, subscription, user_agent: userAgent ?? null }),
    unsubscribe: (user, endpoint) => call("unsubscribe", { user_id: user.id, endpoint }),
    status: (user, endpoint) => call("status", { user_id: user.id, endpoint: endpoint ?? null }),
    setPreferences: (user, preferences) => call("set_preferences", { user_id: user.id, preferences }),
    test: (user) => call("test", { user_id: user.id, username: user.username }),
  };
}
