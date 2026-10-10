/**
 * What was said over a span, counted (`activity`, for Home). Pure, so the
 * counting is tested apart from the service: the service reads one row per
 * (conversation, author) with how many messages, over the conversations
 * the viewer can read, and this adds them up.
 */

import type { ChatActivity } from "@g1t/contracts";

/** One conversation's messages by one author in the span. */
export type ActivityRow = { channel_id: string; author: string; n: number };

/** Messages, conversations with any, and who said how much, most first. */
export function chatActivity(rows: ActivityRow[], span: { from: string; until: string }): ChatActivity {
  const channels = new Set<string>();
  const byAuthor = new Map<string, number>();
  let messages = 0;
  for (const row of rows) {
    const n = Math.max(0, Math.floor(Number(row.n) || 0));
    if (n === 0) continue;
    messages += n;
    channels.add(row.channel_id);
    byAuthor.set(row.author, (byAuthor.get(row.author) ?? 0) + n);
  }
  const authors = [...byAuthor]
    .map(([key, count]) => ({ key, messages: count }))
    .sort((a, b) => b.messages - a.messages || a.key.localeCompare(b.key));
  return { from: span.from, until: span.until, messages, channels: channels.size, authors };
}

/**
 * The span as a pair of RFC 3339 times, or null when either is not a time
 * or the span is empty.
 */
export function activitySpan(from: unknown, until: unknown): { from: string; until: string; fromMs: number; untilMs: number } | null {
  if (typeof from !== "string" || typeof until !== "string") return null;
  const fromMs = Date.parse(from);
  const untilMs = Date.parse(until);
  if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs) || untilMs <= fromMs) return null;
  return { from, until, fromMs, untilMs };
}
