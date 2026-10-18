import { GHOST_ID } from "@g1t/contracts";

import { cloudflareVectors } from "./vectors.ts";
import { fileStore, type FileStoreEnv } from "./files.ts";
import type { IndexEnv } from "./indexer.ts";
import type { PageRoom } from "./room.ts";
import type { FolioRoom } from "./folios/room.ts";

type Env = IndexEnv & FileStoreEnv & { PAGES?: DurableObjectNamespace<PageRoom>; FOLIOS?: DurableObjectNamespace<FolioRoom> };
type Subject = { kind: "user" | "workspace"; id: string; username?: string };
const GHOST = `user:${GHOST_ID}`;
/** Rows (chunks or files) a workspace sweep takes per pass; each pass deletes what it read, so a retry resumes. */
const PAGE = 200;
/** Documents destroyed per call; the rest wait for identity's next retry. */
const DOCUMENTS = 25;
/** Sweep passes per call, so a large workspace stays within one invocation's subrequests. */
const PASSES = 10;

/**
 * Called only by identity's durable purge jobs. Failures leave the SQL
 * references in place, every removal is idempotent, and work left over
 * answers `pending`, so identity retries rather than recording success.
 */
export async function purgePersonalData(env: Env, args: Subject): Promise<{ ok: boolean; pending?: boolean }> {
  if (!args?.id || !["user", "workspace"].includes(args.kind)) throw new Error("Invalid purge subject");
  const db = env.DB,
    key = `user:${args.id}`;
  await db.prepare("INSERT OR IGNORE INTO erased_subjects VALUES (?, ?)").bind(args.id, args.kind).run();
  if (args.kind === "workspace") {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO purge_documents SELECT ?, 'page', id FROM pages WHERE workspace_id = ?").bind(args.id, args.id),
      db.prepare("INSERT OR IGNORE INTO purge_documents SELECT ?, 'folio', id FROM folios WHERE workspace_id = ?").bind(args.id, args.id),
    ]);
  } else {
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO purge_access (subject_id, kind, document_id) SELECT ?1, 'page', id FROM pages WHERE created_by = ?2 OR updated_by = ?2 OR id IN (SELECT page_id FROM page_views WHERE user_id = ?1)",
        )
        .bind(args.id, key),
      db
        .prepare(
          "INSERT OR IGNORE INTO purge_access (subject_id, kind, document_id) SELECT ?1, 'folio', id FROM folios WHERE owner = ?2 OR created_by = ?2 OR updated_by = ?2 OR id IN (SELECT folio_id FROM folio_visits WHERE user_id = ?1)",
        )
        .bind(args.id, key),
    ]);
    const access = (
      await db
        .prepare("SELECT kind, document_id FROM purge_access WHERE subject_id = ? AND done = 0 LIMIT 50")
        .bind(args.id)
        .all<{ kind: string; document_id: string }>()
    ).results;
    for (const doc of access) {
      const rooms = doc.kind === "folio" ? env.FOLIOS : env.PAGES;
      if (!rooms) throw new Error("Document access cleanup unavailable");
      await rooms.get(rooms.idFromName(doc.document_id)).forgetPerson(key, args.username ?? "");
      await db.prepare("UPDATE purge_access SET done = 1 WHERE subject_id = ? AND kind = ? AND document_id = ?").bind(args.id, doc.kind, doc.document_id).run();
    }
    if (await db.prepare("SELECT 1 FROM purge_access WHERE subject_id = ? AND done = 0 LIMIT 1").bind(args.id).first()) return { ok: false, pending: true };
    // Only private folios nobody else can open, in any workspace: the folio
    // and everything under it the person's own, with no other principal's
    // access or grant. Shared material needs a case-specific assessment.
    await db
      .prepare(
        `INSERT OR IGNORE INTO purge_documents SELECT ?1, 'folio', f.id FROM folios f
      WHERE f.owner = ?2 AND f.space_id IS NULL AND f.general_access = 'none'
      AND NOT EXISTS (SELECT 1 FROM folios child WHERE substr(child.path, 1, length(f.path)) = f.path AND (
        child.owner != ?2 OR child.general_access != 'none'
        OR EXISTS (SELECT 1 FROM folio_access a WHERE a.folio_id = child.id AND a.principal != ?2)
        OR EXISTS (SELECT 1 FROM folio_grants g WHERE g.folio_id = child.id AND g.principal != ?2)))`,
      )
      .bind(args.id, key)
      .run();
  }
  const docs = (
    await db
      .prepare("SELECT kind, document_id FROM purge_documents WHERE subject_id = ? LIMIT ?")
      .bind(args.id, DOCUMENTS)
      .all<{ kind: string; document_id: string }>()
  ).results;
  for (const doc of docs) {
    const folio = doc.kind === "folio",
      id = doc.document_id;
    // First, so an upload, an index run or a save racing this cannot write rows for it again (migration 0010, indexer.ts).
    await db.prepare("INSERT OR IGNORE INTO erased_documents (id, kind) VALUES (?, ?)").bind(id, doc.kind).run();
    const rooms = folio ? env.FOLIOS : env.PAGES;
    if (!rooms) throw new Error("Document room cleanup unavailable");
    await rooms.get(rooms.idFromName(id)).destroy();
    const chunks = (
      await db
        .prepare(`SELECT id FROM ${folio ? "folio_chunks" : "doc_chunks"} WHERE ${folio ? "folio_id" : "page_id"} = ?`)
        .bind(id)
        .all<{ id: string }>()
    ).results.map((r) => r.id);
    const vectors = folio ? env.FOLIO_VECTORS : env.VECTORS;
    if (vectors && chunks.length) await cloudflareVectors(vectors).delete(chunks);
    const files = (
      await db
        .prepare(`SELECT key FROM ${folio ? "folio_files" : "files"} WHERE ${folio ? "folio_id" : "page_id"} = ?`)
        .bind(id)
        .all<{ key: string }>()
    ).results;
    for (const { key: file } of files) await fileStore(env).delete(`docs/${file}`);
    if (folio) {
      const states = (
        await db
          .prepare(
            "SELECT state_key AS key FROM folio_versions WHERE folio_id = ?1 AND state_key IS NOT NULL UNION SELECT update_key AS key FROM folio_proposals WHERE folio_id = ?1 AND update_key IS NOT NULL",
          )
          .bind(id)
          .all<{ key: string }>()
      ).results;
      for (const { key: file } of states) await fileStore(env).delete(file);
    }
    const table = folio ? "folios" : "pages",
      column = folio ? "folio_id" : "page_id";
    await db.batch([
      // By document, so passages a late index run wrote without a chunk row go too.
      db.prepare(`DELETE FROM ${folio ? "folio_chunks_fts WHERE folio_id" : "doc_chunks_fts WHERE doc_id"} = ?`).bind(id),
      db.prepare(`DELETE FROM ${folio ? "folio_chunks" : "doc_chunks"} WHERE ${column} = ?`).bind(id),
      db.prepare(`DELETE FROM ${folio ? "folios_fts" : "pages_fts"} WHERE ${column} = ?`).bind(id),
      db.prepare(`DELETE FROM ${folio ? "folio_files" : "files"} WHERE ${column} = ?`).bind(id),
      db.prepare(`UPDATE ${table} SET parent_id = NULL WHERE parent_id = ?`).bind(id),
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id),
      db.prepare("DELETE FROM purge_documents WHERE subject_id = ? AND kind = ? AND document_id = ?").bind(args.id, doc.kind, id),
    ]);
  }
  if (await db.prepare("SELECT 1 FROM purge_documents WHERE subject_id = ? LIMIT 1").bind(args.id).first()) return { ok: false, pending: true };
  if (args.kind === "workspace") {
    // What no document holds any more: repository docs' passages, passages
    // and uploads of documents deleted earlier. A page at a time, each
    // deleted once its vectors or blobs are, until none is left.
    let passes = PASSES;
    for (const [table, store] of [
      ["doc_chunks", env.VECTORS],
      ["folio_chunks", env.FOLIO_VECTORS],
    ] as const) {
      const fts = table === "doc_chunks" ? "doc_chunks_fts" : "folio_chunks_fts";
      for (;;) {
        if (passes-- <= 0) return { ok: false, pending: true };
        const ids = (await db.prepare(`SELECT id FROM ${table} WHERE workspace_id = ? LIMIT ${PAGE}`).bind(args.id).all<{ id: string }>()).results.map(
          (r) => r.id,
        );
        if (!ids.length) break;
        if (store) await cloudflareVectors(store).delete(ids);
        await db.batch([
          db.prepare(`DELETE FROM ${fts} WHERE chunk_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)),
          db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)),
        ]);
      }
    }
    for (const table of ["files", "folio_files"]) {
      for (;;) {
        if (passes-- <= 0) return { ok: false, pending: true };
        const rows = (await db.prepare(`SELECT key FROM ${table} WHERE workspace_id = ? LIMIT ${PAGE}`).bind(args.id).all<{ key: string }>()).results;
        if (!rows.length) break;
        for (const row of rows) await fileStore(env).delete(`docs/${row.key}`);
        await db
          .prepare(`DELETE FROM ${table} WHERE key IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(rows.map((r) => r.key)))
          .run();
      }
    }
    await db.batch([
      db.prepare("DELETE FROM repo_files_fts WHERE space_id IN (SELECT id FROM repo_spaces WHERE workspace_id = ?)").bind(args.id),
      ...["repo_spaces", "templates", "folio_templates", "spaces", "doc_index_runs", "doc_embed_usage", "workspace_billing"].map((table) =>
        db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).bind(args.id),
      ),
    ]);
  } else {
    const statements: D1PreparedStatement[] = [];
    for (const table of ["page_views", "favorites", "folio_visits", "folio_favorites", "folio_access_requests", "space_joins"])
      statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(args.id));
    for (const table of ["space_members", "page_owners", "folio_grants", "folio_access"])
      statements.push(db.prepare(`DELETE FROM ${table} WHERE principal = ?`).bind(key));
    const authors: Record<string, string[]> = {
      spaces: ["created_by", "deleted_by"],
      pages: ["created_by", "updated_by", "archived_by"],
      folios: ["owner", "created_by", "updated_by", "edited_by", "trashed_by"],
      templates: ["created_by"],
      folio_templates: ["created_by"],
      files: ["created_by"],
      folio_files: ["created_by"],
      suggestions: ["author", "asked_by", "decided_by"],
      folio_suggestions: ["author", "asked_by", "decided_by"],
      folio_proposals: ["author", "asked_by", "decided_by"],
      space_members: ["added_by"],
      folio_grants: ["granted_by"],
      repo_spaces: ["added_by"],
      page_changes: ["cleared_by"],
      folio_changes: ["cleared_by"],
    };
    for (const [table, columns] of Object.entries(authors))
      for (const column of columns) statements.push(db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).bind(GHOST, key));
    // The cheap LIKE first, so json_each runs only on the versions that name them.
    for (const table of ["page_versions", "folio_versions"])
      statements.push(
        db
          .prepare(
            `UPDATE ${table} SET authors = (SELECT json_group_array(CASE WHEN value = ?1 THEN ?2 ELSE value END) FROM json_each(${table}.authors)) WHERE authors LIKE '%' || ?1 || '%' AND EXISTS (SELECT 1 FROM json_each(${table}.authors) WHERE value = ?1)`,
          )
          .bind(key, GHOST),
      );
    // Who was already told of a mention, by username.
    const username = (args.username ?? "").toLowerCase();
    if (username)
      for (const table of ["pages", "folios"])
        statements.push(
          db
            .prepare(
              `UPDATE ${table} SET mentioned = (SELECT json_group_array(value) FROM json_each(${table}.mentioned) WHERE value != ?1) WHERE mentioned LIKE '%' || ?1 || '%' AND EXISTS (SELECT 1 FROM json_each(${table}.mentioned) WHERE value = ?1)`,
            )
            .bind(username),
        );
    for (let i = 0; i < statements.length; i += 80) await db.batch(statements.slice(i, i + 80));
  }
  await db.prepare("DELETE FROM purge_access WHERE subject_id = ?").bind(args.id).run();
  return { ok: true };
}
