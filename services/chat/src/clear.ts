/**
 * Clearing a person's conversation with @g1t (docs.g1t.sh/guides/ask/,
 * "Clear the conversation"): everything said in their direct message with
 * g1t is deleted for good, so g1t remembers none of it and the history is
 * gone from Ask and from Chat.
 *
 * "New conversation" only leaves a mark (src/g1t.ts `conversation`); this
 * deletes. What goes, from chat's own database: every message in the
 * direct message (top-level and thread replies, g1t's answers with their
 * steps and sources, the pages questions were asked from, marks, and the
 * empty rows deleted messages left), their reactions, and the read mark
 * and last activity that pointed at them. The direct message itself and
 * its two members stay, empty, so the Ask panel and Chat open it as
 * before. `chat_meter` stays: it counts messages and bytes per workspace
 * per day for billing, with no text and no person in it.
 *
 * The rest of a clear is the service's (src/index.ts `g1tClear`): the
 * channel's room throws away an answer still being written
 * (src/room.ts `clear`), and notify forgets the person's notifications
 * from it.
 *
 * Who may clear is decided here too, purely, so it is tested on its own
 * (clear.test.ts): only the one person in a direct message with g1t, in
 * their own.
 */
import { g1tDmPerson } from "./g1t.ts";

/**
 * Whether `viewer` (a member key, `user:<id>`) may clear this
 * conversation: it is a direct message of exactly them and g1t. Never a
 * channel, a group message, or anyone else's direct message with g1t,
 * whatever their role.
 */
export function mayClear(input: { channelKind: "channel" | "dm"; members: readonly string[]; viewer: string }): boolean {
  return input.channelKind === "dm" && g1tDmPerson(input.members) === input.viewer;
}

/** The part of D1 a clear uses. */
type Db = Pick<D1Database, "prepare" | "batch">;

/**
 * Deletes everything said in one conversation, in one transaction (a D1
 * batch), and says how many messages went. Clearing again finds nothing
 * and deletes nothing: 0. The caller checks it is the viewer's own
 * direct message with g1t ([`mayClear`]); this touches only `channelId`.
 */
export async function clearConversation(db: Db, channelId: string): Promise<{ messages: number }> {
  const results = await db.batch([
    db.prepare("DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)").bind(channelId),
    db.prepare("DELETE FROM messages WHERE channel_id = ?").bind(channelId),
    // Nothing is left to have read, or to have been said last.
    db.prepare("UPDATE channel_members SET last_read_id = NULL WHERE channel_id = ?").bind(channelId),
    db.prepare("UPDATE channels SET last_message_at = NULL WHERE id = ?").bind(channelId),
  ]);
  return { messages: Number(results[1]?.meta?.changes ?? 0) };
}
