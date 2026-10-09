/**
 * Unread and mention counts for the sidebar, and its order. Pure, so they
 * are tested apart from the service.
 */

import { mentions } from "./mentions.ts";

/** A message the counts are made from: one after the member's last read. */
export type UnreadRow = { channel_id: string; id: string; author: string; mentions: string | null };

export type Counts = { unread: number; mentions: number };

/**
 * Whether a message is unread for a member: newer than the last one they
 * read, and not their own (what you wrote, you have read). Top-level
 * messages and thread replies count alike.
 */
export function isUnread(row: { id: string; author: string }, member: string, lastReadId: string | null): boolean {
  return row.author !== member && (lastReadId == null || row.id > lastReadId);
}

/**
 * Each channel's counts for `member` (`user:<id>`), whose username is
 * `username`, from the rows after their last read in each channel.
 */
export function tally(
  rows: UnreadRow[],
  member: string,
  username: string,
  lastRead: Map<string, string | null>,
): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  for (const row of rows) {
    if (!isUnread(row, member, lastRead.get(row.channel_id) ?? null)) continue;
    const count = counts.get(row.channel_id) ?? { unread: 0, mentions: 0 };
    count.unread += 1;
    if (mentions(row.mentions, username)) count.mentions += 1;
    counts.set(row.channel_id, count);
  }
  return counts;
}

/** Starred first, then the most recently active, then by title. */
export function sidebarOrder<T extends { starred: boolean; title: string; channel: { last_message_at: string | null; created_at: string } }>(
  entries: T[],
): T[] {
  const active = (entry: T) => entry.channel.last_message_at ?? entry.channel.created_at;
  return [...entries].sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    const at = active(b).localeCompare(active(a));
    return at || a.title.localeCompare(b.title);
  });
}

/** A direct message's title: the others' names, or yours for notes to yourself. */
export function dmTitle(others: { display_name: string }[], self: { display_name: string } | null): string {
  if (!others.length) return self ? `${self.display_name} (you)` : "Notes";
  const names = others.map((o) => o.display_name);
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}
