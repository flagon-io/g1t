/**
 * Chat as the site draws it: which messages sit together under one name,
 * where a day starts, what an `@…` being typed could become, and a
 * message's text as safe blocks and spans. Pure, so it is tested on its
 * own (chat.test.ts); the components are in components/chat.
 *
 * Message bodies are never HTML: they are parsed here into a small tree
 * that React renders as text, so nothing anyone writes can run.
 */
import type { ChatMessage, ChatSidebarEntry, MemberProfile, Principal } from "@g1t/contracts";

/** Two messages from the same author this close together share one header. */
export const GROUP_GAP_MS = 5 * 60 * 1000;

/** A message on its way: shown at once, then swapped for what the service saved. */
export type ShownMessage = ChatMessage & { pending?: boolean; failed?: boolean; client_id?: string };

export type TimelineRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: ShownMessage; head: boolean };

function sameAuthor(a: ChatMessage["author"], b: ChatMessage["author"]): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** The calendar day of an instant, in the reader's time zone (or `zone`). */
export function dayKey(at: string | Date, zone?: string): string {
  const date = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** "Today", "Yesterday", or the date, for the rule between days. */
export function dayLabel(at: string, now: Date = new Date(), zone?: string): string {
  const key = dayKey(at, zone);
  if (key === dayKey(now, zone)) return "Today";
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (key === dayKey(yesterday, zone)) return "Yesterday";
  const date = new Date(at);
  const sameYear = dayKey(date, zone).slice(0, 4) === dayKey(now, zone).slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(date);
}

/**
 * The channel's messages, oldest first, as rows: a rule where each day
 * starts, and each message marked with whether it starts a group (and so
 * shows its author's name and avatar). A card always starts one.
 */
export function timeline(messages: ShownMessage[], now: Date = new Date(), zone?: string): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let previous: ShownMessage | null = null;
  let day: string | null = null;
  for (const message of messages) {
    if (message.deleted_at) continue;
    const today = dayKey(message.created_at, zone);
    if (today !== day) {
      rows.push({ kind: "day", key: `day:${today}`, label: dayLabel(message.created_at, now, zone) });
      day = today;
      previous = null;
    }
    const head =
      previous == null ||
      message.kind === "card" ||
      previous.kind === "card" ||
      !sameAuthor(previous.author, message.author) ||
      new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() > GROUP_GAP_MS;
    rows.push({ kind: "message", key: message.client_id ?? message.id, message, head });
    previous = message;
  }
  return rows;
}

/**
 * Messages merged by id, oldest first: what the page had, what arrived
 * live and what a reload brought. A newer copy (an edit) wins; a pending
 * message is dropped once the saved one with its `client_id` is there.
 */
export function mergeMessages(current: ShownMessage[], incoming: ShownMessage[]): ShownMessage[] {
  const byId = new Map<string, ShownMessage>();
  for (const message of [...current, ...incoming]) {
    const key = message.id;
    const had = byId.get(key);
    if (!had || !message.pending || had.pending) byId.set(key, message);
  }
  const saved = new Set([...byId.values()].filter((m) => !m.pending).map((m) => m.client_id).filter(Boolean));
  return [...byId.values()]
    .filter((message) => !(message.pending && message.client_id && saved.has(message.client_id)))
    .sort((a, b) => (a.pending === b.pending ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.pending ? 1 : -1));
}

/** Someone who can be mentioned: a person by username, an agent by handle. */
export type Mentionable = {
  kind: "user" | "agent";
  /** What follows the `@`: lowercased, as it is kept. */
  name: string;
  /** A person's username as they wrote it, when that differs from `name`. */
  display_username?: string | null;
  display_name: string;
  avatar: string | null;
  /** An agent's role, shown beside it. */
  role?: string | null;
};

export type MentionQuery = { start: number; typed: string; options: Mentionable[] };

/** Most suggestions at once. */
export const MAX_MENTIONS = 6;

/**
 * The `@…` just before the caret and who it could be: names that start with
 * what is typed first, then display names with a word that does. Null when
 * the caret is not in a mention, or nothing fits.
 */
export function mentionQuery(text: string, caret: number, people: readonly Mentionable[]): MentionQuery | null {
  const match = /(?:^|[\s(])@([\w.-]{0,40})$/.exec(text.slice(0, caret));
  if (!match) return null;
  const typed = match[1]!.toLowerCase();
  const start = caret - match[1]!.length - 1;
  const first: Mentionable[] = [];
  const then: Mentionable[] = [];
  for (const person of people) {
    const name = person.name.toLowerCase();
    if (name === typed) continue;
    if (name.startsWith(typed)) first.push(person);
    else if (typed && person.display_name.toLowerCase().split(/\s+/).some((word) => word.startsWith(typed))) then.push(person);
  }
  const options = [...first, ...then].slice(0, MAX_MENTIONS);
  return options.length > 0 ? { start, typed, options } : null;
}

// ---------------------------------------------------------------------------
// A message's text: its Markdown, parsed by the rule every part of g1t reads it with.

export { type Block, type Span, blocks, inline, plainText, safeHref, spansText } from "@g1t/contracts/chat-markdown";

/** Whether a message is only emoji, a few of them: shown larger, as people expect. */
export function onlyEmoji(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 24) return false;
  return /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(trimmed) && /\p{Extended_Pictographic}/u.test(trimmed);
}

// ---------------------------------------------------------------------------
// The sidebar.

export type ChatFilter = "all" | "unread" | "mentions";

/** The sidebar's rows that pass the filter and the "Jump to" text. */
export function filterEntries(entries: ChatSidebarEntry[], filter: ChatFilter, query: string): ChatSidebarEntry[] {
  const q = query.trim().toLowerCase().replace(/^[#@]/, "");
  return entries.filter((entry) => {
    if (filter === "unread" && entry.unread === 0 && entry.mentions === 0) return false;
    if (filter === "mentions" && entry.mentions === 0) return false;
    if (!q) return true;
    if (entry.title.toLowerCase().includes(q)) return true;
    return entry.others.some((member) => member.name.toLowerCase().includes(q) || member.display_name.toLowerCase().includes(q));
  });
}

/** The agent a conversation is a direct message with, when it is with one agent alone; else null. */
export function agentDmOf(entry: ChatSidebarEntry): string | null {
  const only = entry.others.length === 1 ? entry.others[0]! : null;
  return entry.channel.kind === "dm" && only?.kind === "agent" ? only.id : null;
}

/**
 * The sidebar's sections, in the order they show: what is pinned (the
 * `starred` preference), channels, and direct messages, the latest first,
 * with people and agents alike (an agent is a member you message like
 * anyone). `agentDms` finds the direct message with each agent, by agent
 * id, so the Agents section lists only the agents you have not talked to.
 */
export function sections(entries: ChatSidebarEntry[]): {
  pinned: ChatSidebarEntry[];
  channels: ChatSidebarEntry[];
  agentDms: Map<string, ChatSidebarEntry>;
  dms: ChatSidebarEntry[];
} {
  const byName = (a: ChatSidebarEntry, b: ChatSidebarEntry) => a.title.localeCompare(b.title);
  // Direct messages: the latest conversation first, as people scan them.
  const byRecent = (a: ChatSidebarEntry, b: ChatSidebarEntry) =>
    (b.channel.last_message_at ?? b.channel.created_at).localeCompare(a.channel.last_message_at ?? a.channel.created_at);
  const agentDms = new Map<string, ChatSidebarEntry>();
  for (const entry of entries) {
    const agent = agentDmOf(entry);
    if (agent) agentDms.set(agent, entry);
  }
  return {
    pinned: entries.filter((e) => e.starred).sort(byName),
    channels: entries.filter((e) => !e.starred && e.channel.kind === "channel").sort(byName),
    agentDms,
    dms: entries.filter((e) => !e.starred && e.channel.kind === "dm").sort(byRecent),
  };
}

/** Where a conversation is, under the workspace. */
export function channelPath(slug: string, channel: { id: string; kind: "channel" | "dm"; name: string | null }): string {
  return channel.kind === "dm" || !channel.name ? `/${slug}/-/chat/dm/${channel.id}` : `/${slug}/-/chat/${channel.name}`;
}

/** Unread across the sidebar, leaving out what is muted: the rail's badge. */
export function unreadTotals(entries: ChatSidebarEntry[]): { unread: number; mentions: number } {
  let unread = 0;
  let mentions = 0;
  for (const entry of entries) {
    mentions += entry.mentions;
    if (!entry.muted) unread += entry.unread;
  }
  return { unread, mentions };
}

/** Channel names: lowercase words and digits joined by dashes, as people type them. */
export function channelName(typed: string): string {
  return typed
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

/** Paths under `-/chat/` that are pages, not channels: never a channel's name. */
export const RESERVED_CHANNEL_NAMES = ["dm", "browse", "live", "api", "new"] as const;

/** A principal as a form field carries it: `user:<username>` or `agent:<id>`. */
export function principalField(kind: Principal["kind"], key: string): string {
  return `${kind}:${key}`;
}

/**
 * A member's handle as it shows after `@`: a person's username in its
 * chosen case, an agent's handle. The same rule as `memberHandle` in
 * @g1t/contracts, kept here so this file stays pure for its tests.
 */
export function shownHandle(member: { name: string; display_username?: string | null }): string {
  const display = member.display_username;
  return display && display.toLowerCase() === member.name.toLowerCase() ? display : member.name;
}

/**
 * The name shown for a member, everywhere in chat (messages, the sidebar,
 * typing, cards): their display name, else their handle in its chosen
 * case. The same rule as `memberName` in @g1t/contracts, which the chat
 * service and its notifications follow.
 */
export function shownName(member: Pick<MemberProfile, "display_name" | "name"> & { display_username?: string | null }): string {
  return member.display_name?.trim() || shownHandle(member);
}

/**
 * Who each lowercased handle is, for drawing `@name` as the name people
 * know: the workspace's people and agents.
 */
export function mentionNames(people: readonly Mentionable[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const person of people) names.set(person.name.toLowerCase(), shownName(person));
  return names;
}

/** Reconnect delays for the live socket: doubling from one second to thirty, with jitter. */
export function backoff(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + random() * 0.5));
}
