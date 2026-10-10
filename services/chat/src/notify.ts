/**
 * What the notify service is told about a new message, or a read: every
 * person in the conversation has its counts moved, and those it is for are
 * notified (docs.g1t.sh/guides/chat/, "Notifications").
 *
 * - A direct message notifies everyone else in it, muted or not.
 * - An @mention notifies the person named, muted or not.
 * - A reply notifies the people already in its thread (who started it or
 *   replied), unless they muted the conversation.
 * - Everyone else in it only has their counts moved.
 * - The author is never told of their own message; their own count for
 *   the conversation goes to nothing (what you wrote, you have read).
 * - Agents have no feed: only people are told.
 * - An agent's card that asks someone to act (a draft issue to file, a
 *   session's Approve more: a primary action) notifies whoever asked the
 *   agent, as waiting on them, if they are in the conversation.
 * - A notification about a card someone can act on carries the card's
 *   place and actions (`card`), so its toast offers them.
 *
 * `recipients` is pure, so the rules are tested apart from the service.
 */
import type { CardAction, FeedDelivery, FeedNotification, MemberProfile, NotificationCard, NotificationKind } from "@g1t/contracts";

import { plainText } from "@g1t/contracts/chat-markdown";

import { tally, type UnreadRow } from "./unread.ts";

export type Person = { key: string; user_id: string; username: string; muted: boolean };

export type Recipient = { user_id: string; kind: NotificationKind | null; mentioned: boolean; muted: boolean };

export function recipients(input: {
  /** `user:<id>` or `agent:<id>`. */
  author: string;
  channelKind: "channel" | "dm";
  /** The people in the conversation (agents left out). */
  people: Person[];
  /** Handles the message mentions, lowercased. */
  mentioned: string[];
  /** For a reply: the people in its thread, by key; null for a top-level message. */
  thread: ReadonlySet<string> | null;
  /** Who an agent's card asks to act (`user:<id>`, whoever asked the agent), or null. */
  waitingOn?: string | null;
}): Recipient[] {
  const named = new Set(input.mentioned.map((h) => h.toLowerCase()));
  const out: Recipient[] = [];
  for (const person of input.people) {
    if (person.key === input.author) continue;
    const mentioned = named.has(person.username.toLowerCase());
    let kind: NotificationKind | null = null;
    if (input.channelKind === "dm") kind = "dm";
    else if (mentioned) kind = "mention";
    else if (input.waitingOn === person.key) kind = "agent_waiting";
    else if (input.thread?.has(person.key) && !person.muted) kind = "thread_reply";
    out.push({ user_id: person.user_id, kind, mentioned, muted: person.muted });
  }
  return out;
}

/** A message's text as a notification shows it: one line, the Markdown's marks gone, short. */
export function preview(body: string, max = 140): string {
  return plainText(String(body ?? ""), max);
}

/** At most this many of a card's actions ride on a notification. */
const NOTIFIED_ACTIONS = 4;

/**
 * A card's place and actions for a notification about it, from the card as
 * stored: only when it has an owner to answer and something to press that
 * is not just a link; null otherwise.
 */
export function notificationCard(channelId: string, messageId: string, card: unknown): NotificationCard | null {
  if (!card || typeof card !== "object") return null;
  const c = card as { owner?: unknown; actions?: unknown };
  if (!c.owner || !Array.isArray(c.actions)) return null;
  const actions = (c.actions as CardAction[]).filter((a) => a && typeof a.id === "string" && typeof a.label === "string").slice(0, NOTIFIED_ACTIONS);
  if (!actions.some((a) => !a.href)) return null;
  return { channel_id: channelId, message_id: messageId, actions };
}

/** Whether a card asks someone to act: it has a primary action that runs (File issue, Approve more). */
export function asksToAct(card: NotificationCard | null): boolean {
  return !!card?.actions.some((a) => a.style === "primary" && !a.href);
}

/** Where a conversation, or a thread in it, is on the site. */
export function conversationHref(slug: string, channel: { id: string; kind: "channel" | "dm"; name: string | null }, threadRoot: string | null): string {
  const base = channel.kind === "dm" || !channel.name ? `/${slug}/-/chat/dm/${channel.id}` : `/${slug}/-/chat/${channel.name}`;
  return threadRoot ? `${base}?thread=${encodeURIComponent(threadRoot)}` : base;
}

/** The deliveries for one new message. */
export function messageDeliveries(input: {
  slug: string;
  channel: { id: string; kind: "channel" | "dm"; name: string | null };
  message: { id: string; author: string; body: string; card_title: string | null; thread_root: string | null; created_at: string };
  author: MemberProfile;
  recipients: Recipient[];
  /** The card's place and actions, when it has something to press. */
  card?: NotificationCard | null;
}): FeedDelivery[] {
  const { slug, channel, message, author } = input;
  const where = channel.kind === "dm" ? "" : ` in #${channel.name}`;
  // The service sets `display_name` by `memberName`'s rule (display name,
  // else the username in its chosen case), so pushes match the chat.
  const shown = author.display_name.trim() || author.display_username || author.name;
  const deliveries: FeedDelivery[] = input.recipients.map((r) => {
    const notification: FeedNotification | null = r.kind
      ? {
          id: message.id,
          kind: r.kind,
          workspace: slug,
          title: r.kind === "thread_reply" ? `${shown} replied${where}` : `${shown}${where}`,
          body: preview(message.card_title ?? message.body),
          href: conversationHref(slug, channel, message.thread_root),
          actor: {
            kind: author.kind,
            id: author.id,
            name: shown,
            avatar: author.avatar,
            avatar_seed: author.avatar_seed ?? null,
          },
          channel_id: channel.id,
          thread_root: message.thread_root,
          ...(input.card ? { card: input.card } : {}),
          created_at: message.created_at,
        }
      : null;
    return {
      user_id: r.user_id,
      workspace: slug,
      counts: { channel_id: channel.id, unread: 1, mentions: r.mentioned ? 1 : 0, muted: r.muted },
      notification,
    };
  });
  // The author has read the conversation by writing in it.
  if (message.author.startsWith("user:")) {
    deliveries.push({
      user_id: message.author.slice("user:".length),
      workspace: slug,
      counts: { channel_id: channel.id, unread: 0, mentions: 0, set: true },
      notification: null,
    });
  }
  return deliveries;
}

/** A person's counts for one conversation after they read up to `lastReadId`, from the rows after it. */
export function countsAfterRead(rows: UnreadRow[], channelId: string, member: string, username: string, lastReadId: string): { unread: number; mentions: number } {
  return tally(rows, member, username, new Map([[channelId, lastReadId]])).get(channelId) ?? { unread: 0, mentions: 0 };
}


// ── Wiring, used by src/index.ts ─────────────────────────────────────────

type Db = D1Database;
type Notify = { fetch(input: string, init?: RequestInit): Promise<Response> };

async function deliver(notify: Notify, items: FeedDelivery[]): Promise<void> {
  if (!items.length) return;
  const response = await notify.fetch("https://service/rpc/deliver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!response.ok) throw new Error(`deliver failed with status ${response.status}`);
}

/** Tells notify of a new message: one batched call for everyone in the conversation. */
export async function notifyMessage(
  db: Db,
  notify: Notify | undefined,
  profiles: (keys: string[]) => Promise<Map<string, MemberProfile>>,
  input: {
    slug: string;
    channel: { id: string; kind: "channel" | "dm"; name: string | null };
    row: { id: string; author: string; body: string; card: string | null; thread_root: string | null; created_at: string };
    handles: string[];
    /** Who the agent posting was asked by (a user id), for a card that waits on them. */
    asked_by?: string | null;
  },
): Promise<void> {
  if (!notify) return;
  const { channel, row } = input;
  const [members, thread] = await Promise.all([
    db
      .prepare("SELECT principal, muted FROM channel_members WHERE channel_id = ? AND principal LIKE 'user:%'")
      .bind(channel.id)
      .all<{ principal: string; muted: number }>(),
    row.thread_root
      ? db
          .prepare("SELECT DISTINCT author FROM messages WHERE channel_id = ?1 AND (id = ?2 OR thread_root = ?2) AND author LIKE 'user:%'")
          .bind(channel.id, row.thread_root)
          .all<{ author: string }>()
      : Promise.resolve(null),
  ]);
  const keys = members.results.map((m) => m.principal);
  const found = await profiles([...keys, row.author]);
  const people: Person[] = members.results.map((m) => ({
    key: m.principal,
    user_id: m.principal.slice("user:".length),
    username: found.get(m.principal)?.name ?? "",
    muted: !!m.muted,
  }));
  const author = found.get(row.author);
  if (!author) return;
  let cardTitle: string | null = null;
  let card: NotificationCard | null = null;
  if (row.card) {
    try {
      const parsed = JSON.parse(row.card) as { title?: string };
      cardTitle = parsed.title ?? null;
      card = notificationCard(channel.id, row.id, parsed);
    } catch {
      cardTitle = null;
    }
  }
  // An agent's card asking someone to act waits on whoever asked the agent.
  const waitingOn = row.author.startsWith("agent:") && input.asked_by && asksToAct(card) ? `user:${input.asked_by}` : null;
  await deliver(
    notify,
    messageDeliveries({
      slug: input.slug,
      channel,
      message: { id: row.id, author: row.author, body: row.body, card_title: cardTitle, thread_root: row.thread_root, created_at: row.created_at },
      author,
      card,
      recipients: recipients({
        author: row.author,
        channelKind: channel.kind,
        people,
        mentioned: input.handles,
        thread: thread ? new Set(thread.results.map((r) => r.author)) : null,
        waitingOn,
      }),
    }),
  );
}

/** After a read: the person's counts for the conversation, as they now are, in every tab. */
export async function notifyRead(
  db: Db,
  notify: Notify | undefined,
  input: { slug: string; channel_id: string; user_id: string; username: string; last_read_id: string },
): Promise<void> {
  if (!notify) return;
  const member = `user:${input.user_id}`;
  const rows = await db
    .prepare(
      "SELECT channel_id, id, author, mentions FROM messages WHERE channel_id = ? AND id > ? AND deleted_at IS NULL AND author != ? LIMIT 5000",
    )
    .bind(input.channel_id, input.last_read_id, member)
    .all<UnreadRow>();
  const counts = countsAfterRead(rows.results, input.channel_id, member, input.username, input.last_read_id);
  await deliver(notify, [
    { user_id: input.user_id, workspace: input.slug, counts: { channel_id: input.channel_id, ...counts, set: true }, notification: null },
  ]);
}

/** After muting or unmuting: the badge counts the conversation, or leaves it out, in every tab. */
export async function notifyMuted(notify: Notify | undefined, input: { slug: string; channel_id: string; user_id: string; muted: boolean }): Promise<void> {
  if (!notify) return;
  await deliver(notify, [
    { user_id: input.user_id, workspace: input.slug, counts: { channel_id: input.channel_id, unread: 0, mentions: 0, muted: input.muted }, notification: null },
  ]);
}
