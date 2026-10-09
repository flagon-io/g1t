/**
 * Unread counts as the feed keeps them: per conversation, summed per
 * workspace the way the rail's badge sums them (muted conversations leave
 * their unread out; mentions count everywhere). Pure, so it is tested
 * apart from the feed.
 */
import type { ChannelCounts, FeedCounts } from "@g1t/contracts";

/** The counts after a delivery: added, or (`set`) replaced. Never below zero. */
export function applyCounts(
  before: ChannelCounts | null,
  change: { channel_id: string; unread: number; mentions: number; muted?: boolean | null; set?: boolean },
): ChannelCounts {
  const n = (v: unknown) => (Number.isFinite(v) ? Math.max(0, Math.floor(Number(v))) : 0);
  const d = (v: unknown) => (Number.isFinite(v) ? Math.floor(Number(v)) : 0);
  const muted = typeof change.muted === "boolean" ? change.muted : (before?.muted ?? false);
  if (change.set || !before) {
    return {
      channel_id: change.channel_id,
      unread: change.set ? n(change.unread) : n(d(change.unread)),
      mentions: change.set ? n(change.mentions) : n(d(change.mentions)),
      muted,
    };
  }
  return {
    channel_id: change.channel_id,
    unread: Math.max(0, before.unread + d(change.unread)),
    mentions: Math.max(0, before.mentions + d(change.mentions)),
    muted,
  };
}

/** A workspace's counts as the socket sends them. */
export function totals(workspace: string, rows: ChannelCounts[], inboxUnread: number, complete: boolean): FeedCounts {
  let unread = 0;
  let mentions = 0;
  const perChannel: FeedCounts["per_channel"] = [];
  for (const row of rows) {
    mentions += row.mentions;
    if (!row.muted) unread += row.unread;
    if (row.unread > 0 || row.mentions > 0) perChannel.push({ channel_id: row.channel_id, unread: row.unread, mentions: row.mentions });
  }
  return { workspace, chat_unread: unread, chat_mentions: mentions, inbox_unread: Math.max(0, inboxUnread), per_channel: perChannel, complete };
}
