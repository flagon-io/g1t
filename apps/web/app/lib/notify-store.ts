/**
 * The rules behind live notifications in the browser, apart from the
 * browser: which toasts show, how counts merge, what the tab title says,
 * when to offer browser notifications, and how long to wait before
 * reconnecting. Pure, so they are tested apart from the socket
 * (lib/notify-client.ts) and the toasts (components/notifications/).
 */
import type { ChatSidebarEntry, FeedCounts, FeedNotification } from "@g1t/contracts";

/** The most toasts on screen; a fourth pushes the oldest out. */
export const MAX_TOASTS = 3;
/** How long a toast stays, unless the pointer or the keyboard is on it. */
export const TOAST_MS = 6_000;
/** Every so often the socket says it is still there, focus and all. */
export const HEARTBEAT_MS = 25_000;
/** While the socket is down, the Chat sidebar asks again this often. */
export const FALLBACK_REFRESH_MS = 60_000;

export type Toast = { notification: FeedNotification; at: number };

/** The path a link goes to, without its query or fragment. */
export function pathOf(href: string): string {
  return href.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
}

/**
 * Whether the person is looking at the conversation a notification is
 * about right now: its page is open, or the chat page open says it shows
 * that channel. A toast for it would only repeat what is on screen.
 */
export function isViewing(notification: FeedNotification, viewing: { path: string; channel_id?: string | null }): boolean {
  if (notification.channel_id && viewing.channel_id && notification.channel_id === viewing.channel_id) return true;
  if (!notification.channel_id) return false;
  return pathOf(notification.href) === pathOf(viewing.path);
}

/**
 * The toasts after one arrives: never twice, never for what is on screen,
 * newest last, at most `MAX_TOASTS`.
 */
export function addToast(
  toasts: Toast[],
  notification: FeedNotification,
  viewing: { path: string; channel_id?: string | null },
  now: number,
): Toast[] {
  if (toasts.some((t) => t.notification.id === notification.id)) return toasts;
  if (isViewing(notification, viewing)) return toasts;
  // A newer message in the same conversation replaces the older toast.
  const kept = notification.channel_id ? toasts.filter((t) => t.notification.channel_id !== notification.channel_id) : toasts;
  return [...kept, { notification, at: now }].slice(-MAX_TOASTS);
}

/** The space between stacked toasts. */
export const TOAST_GAP = 8;
/** The "+2 more" pill's height. */
export const PILL_HEIGHT = 30;
/** A toast's height before it was measured. */
export const TOAST_GUESS = 120;

/**
 * How many of the oldest toasts fold into "+N more" so the stack fits in
 * `available` pixels. `heights` are oldest first; `reserved` is what
 * always shows besides (the offer of browser notifications). The newest
 * toast always shows; nothing ever overlaps.
 */
export function hiddenToFit(heights: number[], available: number, reserved = 0): number {
  const height = (hidden: number) => {
    const shown = heights.slice(hidden);
    const parts = shown.length + (reserved > 0 ? 1 : 0) + (hidden > 0 ? 1 : 0);
    return reserved + shown.reduce((sum, h) => sum + h, 0) + (hidden > 0 ? PILL_HEIGHT : 0) + TOAST_GAP * Math.max(0, parts - 1);
  };
  let hidden = 0;
  while (hidden < heights.length - 1 && height(hidden) > available) hidden++;
  return hidden;
}

export function dismissToast(toasts: Toast[], id: string): Toast[] {
  return toasts.filter((t) => t.notification.id !== id);
}

/** Whether a notification gets a reply box: something said to you, in a conversation. */
export function canQuickReply(notification: FeedNotification): boolean {
  return (notification.kind === "dm" || notification.kind === "mention" || notification.kind === "thread_reply") && !!notification.channel_id && !!notification.workspace;
}

/** What a quick reply posts to the chat api route. */
export function quickReplyRequest(notification: FeedNotification, body: string): { url: string; body: { intent: "post"; channel_id: string; body: string; thread_root: string | null } } | null {
  const text = body.trim();
  if (!text || !canQuickReply(notification)) return null;
  return {
    url: `/${notification.workspace}/-/chat/api`,
    body: { intent: "post", channel_id: notification.channel_id!, body: text, thread_root: notification.thread_root ?? null },
  };
}

// ── Counts ────────────────────────────────────────────────────────────────

/** What the rail shows for a workspace. */
export type LiveBadges = { chat: number; mentions: number; inbox: number };

/**
 * The rail's numbers from the feed, or null while it cannot say: chat's
 * only once the feed read them from chat itself (`complete`).
 */
export function badgesOf(counts: FeedCounts | null | undefined, inbox: number | null): Partial<LiveBadges> | null {
  const out: Partial<LiveBadges> = {};
  if (counts?.complete) {
    out.chat = counts.chat_unread;
    out.mentions = counts.chat_mentions;
  }
  const inboxUnread = inbox ?? (counts ? counts.inbox_unread : null);
  if (inboxUnread != null) out.inbox = inboxUnread;
  return Object.keys(out).length ? out : null;
}

/** A conversation read here, zeroed until the feed says so itself. */
export function markReadLocally(counts: FeedCounts, channelId: string): FeedCounts {
  const row = counts.per_channel.find((c) => c.channel_id === channelId);
  if (!row) return counts;
  // Muted unread was never in chat_unread; it is not known here, so the feed's next word settles it.
  return {
    ...counts,
    chat_unread: Math.max(0, counts.chat_unread - row.unread),
    chat_mentions: Math.max(0, counts.chat_mentions - row.mentions),
    per_channel: counts.per_channel.filter((c) => c.channel_id !== channelId),
  };
}

/**
 * The Chat sidebar with the feed's counts: each conversation's unread and
 * mentions as the feed has them (none, when it does not list it). Only
 * once the feed's counts are complete; before, the sidebar as it was read.
 */
export function overlayEntries(entries: ChatSidebarEntry[], counts: FeedCounts | null | undefined): ChatSidebarEntry[] {
  if (!counts?.complete) return entries;
  const by = new Map(counts.per_channel.map((c) => [c.channel_id, c]));
  let changed = false;
  const out = entries.map((entry) => {
    const live = by.get(entry.channel.id);
    const unread = live?.unread ?? 0;
    const mentions = live?.mentions ?? 0;
    if (unread === entry.unread && mentions === entry.mentions) return entry;
    changed = true;
    return { ...entry, unread, mentions };
  });
  return changed ? out : entries;
}

/** Conversations the feed counts that the sidebar does not list: a new DM, a channel just joined. */
export function unlisted(entries: ChatSidebarEntry[], counts: FeedCounts | null | undefined): string[] {
  if (!counts) return [];
  const listed = new Set(entries.map((e) => e.channel.id));
  return counts.per_channel.filter((c) => c.unread > 0 && !listed.has(c.channel_id)).map((c) => c.channel_id);
}

// ── The tab ───────────────────────────────────────────────────────────────

const COUNTED = /^\(\d+\+?\) /;

/** The tab's title with `count` in front, or without one at zero. */
export function titleWith(title: string, count: number): string {
  const bare = title.replace(COUNTED, "");
  if (count <= 0) return bare;
  return `(${count > 99 ? "99+" : count}) ${bare}`;
}

/** What the tab and the app icon count: chat unread (mentions when there are none) and the inbox. */
export function attentionCount(badges: Partial<LiveBadges> | null): number {
  if (!badges) return 0;
  return Math.max(badges.chat ?? 0, badges.mentions ?? 0) + (badges.inbox ?? 0);
}

// ── Browser notifications ─────────────────────────────────────────────────

/** What the person said to the offer, kept in the browser. */
export type PushChoice = "declined" | "off" | "on" | null;

/**
 * Whether to offer browser notifications: after a DM or mention toast,
 * only where the browser can, only while it has not been asked, and never
 * again once the person said no or closed the offer.
 */
export function offerPush(input: {
  kind: FeedNotification["kind"];
  supported: boolean;
  permission: "default" | "granted" | "denied";
  choice: PushChoice;
  hasKey: boolean;
  desktop: boolean;
}): boolean {
  if (input.desktop || !input.supported || !input.hasKey) return false;
  if (input.kind !== "dm" && input.kind !== "mention") return false;
  if (input.permission !== "default") return false;
  return input.choice === null;
}

/** Full jitter: a wait anywhere up to the doubled step, from a second up to half a minute. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.max(0, Math.min(attempt, 10)));
  return Math.round(500 + random() * (ceiling - 500));
}
