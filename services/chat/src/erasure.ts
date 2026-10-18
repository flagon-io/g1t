import { GHOST_ID } from "@g1t/contracts";

import { g1tDmPerson } from "./g1t.ts";
import type { ChannelRoom } from "./room.ts";
import { clearConversation } from "./clear.ts";

type Env = { DB: D1Database; ROOMS: DurableObjectNamespace<ChannelRoom>; AVATARS: KVNamespace };
export type Erasure = { kind: "user" | "workspace"; id: string; username?: string; slug?: string };

const GHOST = `user:${GHOST_ID}`;
/** Messages deleted per statement, and per call, so one huge channel never holds the database in one write. */
const CHUNK = 500;
const BUDGET = 5000;
/** Channels handled per call; the rest wait for identity's next retry. */
const CHANNELS = 25;

/**
 * Called only by identity's durable purge jobs, through a service binding.
 * Safe to repeat: every step is idempotent, and work left over answers
 * `pending` so identity calls again rather than recording success.
 */
export async function purgePersonalData(env: Env, args: Erasure): Promise<{ ok: boolean; pending?: boolean }> {
  if (!args?.id || !["user", "workspace"].includes(args.kind)) throw new Error("Invalid purge subject");
  const db = env.DB,
    key = `user:${args.id}`;
  // The channels to visit are listed once, in the transaction that writes
  // the tombstone: a retry works through the list instead of scanning
  // every message again, and the list can never be skipped.
  const unseeded = "NOT EXISTS (SELECT 1 FROM erased_subjects WHERE id = ?1)";
  await db.batch([
    args.kind === "workspace"
      ? db.prepare(`INSERT OR IGNORE INTO purge_channels SELECT ?1, id FROM channels WHERE workspace_id = ?1 AND ${unseeded}`).bind(args.id)
      : db
          .prepare(
            `INSERT OR IGNORE INTO purge_channels SELECT ?1, id FROM channels WHERE (created_by = ?2 OR id IN (SELECT channel_id FROM channel_members WHERE principal = ?2 UNION SELECT channel_id FROM messages WHERE author = ?2)) AND ${unseeded}`,
          )
          .bind(args.id, key),
    db.prepare("INSERT OR IGNORE INTO erased_subjects (id, kind) VALUES (?, ?)").bind(args.id, args.kind),
  ]);
  let budget = BUDGET;
  const channels = (
    await db.prepare("SELECT channel_id FROM purge_channels WHERE subject_id = ? LIMIT ?").bind(args.id, CHANNELS).all<{ channel_id: string }>()
  ).results;
  for (const { channel_id: id } of channels) {
    if (budget <= 0) break;
    const channel = await db.prepare("SELECT kind FROM channels WHERE id = ?").bind(id).first<{ kind: string }>();
    const members = (await db.prepare("SELECT principal FROM channel_members WHERE channel_id = ?").bind(id).all<{ principal: string }>()).results.map(
      (r) => r.principal,
    );
    const destroy = args.kind === "workspace" || (channel?.kind === "dm" && g1tDmPerson(members) === key);
    // References stay in purge_channels until both the room and database confirm cleanup.
    await env.ROOMS.get(env.ROOMS.idFromName(id)).erase(id, destroy ? null : key);
    if (destroy) {
      // In chunks, newest last, until the channel is empty or this call's budget is spent.
      let left = true;
      while (budget > 0) {
        const [, gone] = await db.batch([
          db.prepare(`DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ? ORDER BY id LIMIT ${CHUNK})`).bind(id),
          db.prepare(`DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE channel_id = ? ORDER BY id LIMIT ${CHUNK})`).bind(id),
        ]);
        const changes = Number(gone?.meta?.changes ?? 0);
        budget -= Math.max(changes, 1);
        if (changes < CHUNK) {
          left = false;
          break;
        }
      }
      if (left) break;
      await clearConversation(db, id);
      await db.batch([
        db.prepare("DELETE FROM channel_members WHERE channel_id = ?").bind(id),
        db.prepare("DELETE FROM channel_removals WHERE channel_id = ?").bind(id),
        db.prepare("DELETE FROM channels WHERE id = ?").bind(id),
      ]);
    } else {
      await db.batch([
        db.prepare("UPDATE messages SET author = ? WHERE channel_id = ? AND author = ?").bind(GHOST, id, key),
        db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND principal = ?").bind(id, key),
        db
          .prepare(
            "UPDATE channels SET created_by = CASE WHEN created_by = ?2 THEN ?3 ELSE created_by END, dm_key = CASE WHEN kind = 'dm' THEN NULL ELSE dm_key END WHERE id = ?1",
          )
          .bind(id, key, GHOST),
      ]);
      budget -= 1;
    }
    await db.prepare("DELETE FROM purge_channels WHERE subject_id = ? AND channel_id = ?").bind(args.id, id).run();
  }
  if (await db.prepare("SELECT 1 FROM purge_channels WHERE subject_id = ? LIMIT 1").bind(args.id).first()) return { ok: false, pending: true };
  if (args.kind === "user") {
    await db.batch([
      db.prepare("DELETE FROM reactions WHERE principal = ?").bind(key),
      db.prepare("DELETE FROM general_joined WHERE principal = ?").bind(key),
      db.prepare("UPDATE custom_emoji SET created_by = ? WHERE created_by = ?").bind(GHOST, key),
      // Invitations, requests and removals name them; what someone else sent goes with them too.
      db.prepare("DELETE FROM channel_invitations WHERE invitee = ?1 OR invited_by = ?1").bind(key),
      db.prepare("UPDATE channel_requests SET answered_by = ?2 WHERE answered_by = ?1").bind(key, GHOST),
      db.prepare("DELETE FROM channel_requests WHERE requester = ?").bind(key),
      db.prepare("DELETE FROM channel_removals WHERE principal = ?1 OR removed_by = ?1").bind(key),
    ]);
  } else {
    const files = (await db.prepare("SELECT DISTINCT file FROM custom_emoji WHERE workspace_id = ? AND file IS NOT NULL").bind(args.id).all<{ file: string }>())
      .results;
    for (const { file } of files) {
      const used = await db.prepare("SELECT 1 FROM custom_emoji WHERE workspace_id != ? AND file = ? LIMIT 1").bind(args.id, file).first();
      if (!used) await env.AVATARS.delete(`emoji/${file}`);
    }
    await db.batch(
      ["general_joined", "custom_emoji", "chat_settings", "former_agents", "chat_meter", "channel_invitations", "channel_requests"].map((table) =>
        db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).bind(args.id),
      ),
    );
  }
  return { ok: true };
}
