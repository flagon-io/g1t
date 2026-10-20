/**
 * The read mark: how far a member has read a conversation
 * (`channel_members.last_read_id`). Every surface that shows messages
 * marks them read through it, whichever it is: the conversation in Chat,
 * the Ask panel, Home's Summarize, the phone app.
 */

/**
 * Moves `principal`'s read mark in `channelId` up to `id`. Only forward:
 * reading an old thread does not mark newer messages unread. Says whether
 * it moved, so the read is told to their tabs and devices only then.
 */
export async function markReadUpTo(db: D1Database, channelId: string, principal: string, id: string): Promise<boolean> {
  const changed = await db
    .prepare("UPDATE channel_members SET last_read_id = ?1 WHERE channel_id = ?2 AND principal = ?3 AND (last_read_id IS NULL OR last_read_id < ?1)")
    .bind(id, channelId, principal)
    .run();
  return changed.meta.changes > 0;
}
