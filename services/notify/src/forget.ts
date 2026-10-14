/**
 * A conversation the person cleared (chat's `g1t_clear`, their direct
 * message with @g1t): the feed deletes the notifications it kept from it,
 * whose text previews messages that no longer exist, and remembers when,
 * so a notification of a message from before the clear that arrives late
 * (an answer that ended as the clear ran) is dropped rather than kept.
 *
 * Pure, so it is tested on its own (forget.test.ts); src/feed.ts keeps
 * the times in its `meta` table under `forgotKey`.
 */
import type { FeedNotification } from "@g1t/contracts";

/** The `meta` key a forgotten conversation's time is kept under. */
export function forgotKey(workspace: string, channelId: string): string {
  return `forgot:${workspace.toLowerCase()}:${channelId}`;
}

/** A channel id as chat makes them: what forgetting takes, and nothing else. */
export function cleanChannelId(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : null;
}

/**
 * Whether a notification is of a message said before its conversation
 * was cleared at `forgotAt` (RFC 3339): such a message is gone. One with
 * no time, or a bad one, counts as before: it is dropped.
 */
export function beforeForgetting(notification: Pick<FeedNotification, "created_at">, forgotAt: string | null): boolean {
  if (!forgotAt) return false;
  const at = Date.parse(notification.created_at);
  return !Number.isFinite(at) || at <= Date.parse(forgotAt);
}
