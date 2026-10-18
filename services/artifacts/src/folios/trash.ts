/**
 * The trash's two ends, over D1 alone so they are tested on SQLite
 * (trash.test.ts): what deleting folios for good does to the database
 * (`eraseFolios`: one artifact, the whole trash, the daily purge), what
 * deleting a space does to its rows (`deleteSpaceRows`), and where a folio
 * restored from the trash lands when its space is gone (`landingFor`).
 * Rooms, events and the index's vectors are the callers' (service.ts).
 */
import { atLeast } from "../access.ts";
import { forgetFolios, type IndexEnv } from "../indexer.ts";
import type { Space } from "../who.ts";
import { json, runBatches } from "./access-store.ts";

/**
 * Deletes folios for good: their passages leave the index, children still
 * alive under them go to the top of where they were, and their search rows
 * and rows go, deepest first, so no parent goes before its children. Returns
 * the ids that went, in that order. Callers destroy the rooms.
 */
export async function eraseFolios(env: IndexEnv, rows: readonly { id: string; path: string }[]): Promise<string[]> {
  if (!rows.length) return [];
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
  const ids = unique.sort((x, y) => y.path.length - x.path.length).map((r) => r.id);
  await env.DB.prepare("UPDATE folios SET parent_id = NULL WHERE parent_id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))")
    .bind(json(ids), json(ids))
    .run();
  await forgetFolios(env, ids);
  await runBatches(
    env.DB,
    ids.flatMap((id) => [env.DB.prepare("DELETE FROM folios_fts WHERE folio_id = ?").bind(id), env.DB.prepare("DELETE FROM folios WHERE id = ?").bind(id)]),
  );
  return ids;
}

/**
 * What deleting a space does to the database, at `at` by `by`: every folio
 * in it not already in the trash goes there together (so each top restores
 * as usual), the space's pages (Docs' older model) too, members' sidebars
 * drop it, and its row is marked deleted with its address freed for a new
 * space (`<slug>~<id>`, which no address can be; see migration 0007). The
 * row stays, so the trash keeps the space's name and rules and a deleted
 * General is never made again. Returns the ids of the folios trashed.
 */
export async function deleteSpaceRows(db: D1Database, space: { id: string; slug: string }, at: string, by: string): Promise<string[]> {
  const rows = (await db.prepare("SELECT id FROM folios WHERE space_id = ? AND trashed_at IS NULL").bind(space.id).all<{ id: string }>()).results;
  await db.batch([
    db.prepare("UPDATE folios SET trashed_at = ?, trashed_by = ? WHERE space_id = ? AND trashed_at IS NULL").bind(at, by, space.id),
    db.prepare("UPDATE pages SET archived_at = ?, archived_by = ? WHERE space_id = ? AND archived_at IS NULL").bind(at, by, space.id),
    db.prepare("DELETE FROM space_joins WHERE space_id = ?").bind(space.id),
    db
      .prepare("UPDATE spaces SET deleted_at = ?, deleted_by = ?, slug = ? WHERE id = ? AND deleted_at IS NULL")
      .bind(at, by, `${space.slug}~${space.id}`, space.id),
  ]);
  return rows.map((r) => r.id);
}

/**
 * Where a folio restored from the trash lands when the space it was in has
 * been deleted: the General space, when there is one that is live and the
 * restorer may add to; else null, its owner's Private.
 */
export function landingFor(spaces: readonly Space[]): Space | null {
  return spaces.find((s) => s.row.is_default && !s.row.deleted_at && !s.row.archived_at && atLeast(s.role, "edit")) ?? null;
}
