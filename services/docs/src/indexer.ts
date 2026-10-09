/**
 * The semantic index: pages and projects' docs files as passages
 * (src/chunks.ts) in D1 (`doc_chunks`, with full text in
 * `doc_chunks_fts`) and as vectors in the vector store (src/vectors.ts).
 *
 * A page is indexed a little after its Markdown is saved (the room,
 * src/room.ts, in the background, so editing never waits on it); a
 * project's docs files after they are read (src/repo-spaces.ts). Only
 * passages whose text changed are embedded; one that only moved keeps its
 * vector. Embedding is capped per workspace and hour (EMBED_PER_HOUR):
 * past the cap passages are kept for words, and a catch-up run on the
 * queue embeds them later. A failure leaves them for the next save or run.
 * Nothing here throws to its caller.
 *
 * The backfill indexes a workspace's existing pages and files in batches
 * on the queue (`docs.index` jobs, on the docs service's own events queue).
 */
import { chunkId, chunkMarkdown, embedText, repoFileId, textHash } from "./chunks.ts";
import { cloudflareEmbedder, cloudflareVectors, type Embedder, type VectorMetadata, type VectorStore } from "./vectors.ts";

/** Passages embedded per workspace per hour at most. Logged when reached. */
export const EMBED_PER_HOUR = 200;
/** Documents one backfill job indexes before handing on to the next. */
const BACKFILL_BATCH = 20;
/** A backfill not finished after this long is taken to have died and may start again. */
const BACKFILL_STALE_MS = 2 * 60 * 60 * 1000;
/** How long a run waits when the hour's cap is reached. */
const CAP_DELAY_SECONDS = 3600;

/** A job on the queue: index more of a workspace's docs. */
export type DocsJob = { type: "docs.index"; workspace_id: string };

export type IndexEnv = { DB: D1Database; AI?: Ai; VECTORS?: Vectorize; JOBS?: Queue<DocsJob> };

/** The embedder and store this deployment has; null without them (words only). */
export function adapters(env: IndexEnv): { embedder: Embedder | null; store: VectorStore | null } {
  return env.AI && env.VECTORS ? { embedder: cloudflareEmbedder(env.AI), store: cloudflareVectors(env.VECTORS) } : { embedder: null, store: null };
}

/** One document to index: a page, or a project's docs file. */
export type IndexDoc = {
  kind: "page" | "repo_file";
  /** The page's id, or the file's `rf_` id. */
  doc_id: string;
  workspace_id: string;
  space_id: string;
  title: string;
  markdown: string;
  repo_id?: string | null;
  path?: string | null;
};

type ChunkRow = { id: string; seq: number; space_id: string; hash: string; vector_hash: string | null };

const hourOf = (now: Date) => now.toISOString().slice(0, 13);

function metadataOf(doc: IndexDoc): VectorMetadata {
  return doc.kind === "page"
    ? { workspace_id: doc.workspace_id, space_id: doc.space_id, kind: "page", page_id: doc.doc_id }
    : { workspace_id: doc.workspace_id, space_id: doc.space_id, kind: "repo_file", repo_file_id: doc.doc_id, repo_id: doc.repo_id ?? "" };
}

/** Passages the workspace may still embed this hour. */
async function allowance(db: D1Database, workspaceId: string, now: Date): Promise<number> {
  const used = await db.prepare("SELECT chunks FROM doc_embed_usage WHERE workspace_id = ? AND hour = ?").bind(workspaceId, hourOf(now)).first<{ chunks: number }>();
  return Math.max(0, EMBED_PER_HOUR - (used?.chunks ?? 0));
}

async function meter(db: D1Database, workspaceId: string, chunks: number, chars: number, now: Date): Promise<void> {
  if (!chunks) return;
  await db
    .prepare(
      "INSERT INTO doc_embed_usage (workspace_id, hour, chunks, tokens) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (workspace_id, hour) DO UPDATE SET chunks = chunks + ?3, tokens = tokens + ?4",
    )
    .bind(workspaceId, hourOf(now), chunks, Math.ceil(chars / 4))
    .run();
}

/**
 * Brings one document's passages up to date: rows and full text in D1,
 * vectors for those that changed (within the hour's cap). `capped` when
 * some were left for later.
 */
export async function indexDoc(
  db: D1Database,
  embedder: Embedder | null,
  store: VectorStore | null,
  doc: IndexDoc,
  now = new Date(),
): Promise<{ chunks: number; embedded: number; capped: boolean }> {
  const at = now.toISOString();
  const chunks = chunkMarkdown(doc.markdown, doc.title).map((c) => {
    const embed = embedText(doc.title, c);
    return { ...c, id: chunkId(doc.doc_id, c.seq), embed, hash: textHash(embed) };
  });
  const column = doc.kind === "page" ? "page_id" : "repo_file_id";
  const old = (await db.prepare(`SELECT id, seq, space_id, hash, vector_hash FROM doc_chunks WHERE ${column} = ?`).bind(doc.doc_id).all<ChunkRow>()).results;
  const byId = new Map(old.map((r) => [r.id, r]));
  const statements: D1PreparedStatement[] = [];
  for (const c of chunks) {
    const was = byId.get(c.id);
    if (was && was.hash === c.hash && was.space_id === doc.space_id) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO doc_chunks (id, workspace_id, space_id, page_id, repo_file_id, repo_id, path, seq, heading, text, hash, vector_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT (id) DO UPDATE SET space_id = excluded.space_id, repo_id = excluded.repo_id, path = excluded.path, heading = excluded.heading, text = excluded.text, hash = excluded.hash, updated_at = excluded.updated_at`,
        )
        .bind(
          c.id,
          doc.workspace_id,
          doc.space_id,
          doc.kind === "page" ? doc.doc_id : null,
          doc.kind === "repo_file" ? doc.doc_id : null,
          doc.repo_id ?? null,
          doc.path ?? null,
          c.seq,
          c.heading,
          c.text,
          c.hash,
          at,
        ),
      db.prepare("DELETE FROM doc_chunks_fts WHERE chunk_id = ?").bind(c.id),
      db.prepare("INSERT INTO doc_chunks_fts (chunk_id, space_id, doc_id, heading, text) VALUES (?, ?, ?, ?, ?)").bind(c.id, doc.space_id, doc.doc_id, c.heading ?? "", c.text),
    );
  }
  const keep = new Set(chunks.map((c) => c.id));
  const gone = old.filter((r) => !keep.has(r.id));
  for (const r of gone) {
    statements.push(db.prepare("DELETE FROM doc_chunks WHERE id = ?").bind(r.id), db.prepare("DELETE FROM doc_chunks_fts WHERE chunk_id = ?").bind(r.id));
  }
  for (let i = 0; i < statements.length; i += 60) await db.batch(statements.slice(i, i + 60));

  if (!store || !embedder) return { chunks: chunks.length, embedded: 0, capped: false };
  const result = await embedChanged(db, embedder, store, doc, chunks, old, byId, now);
  // Last, so a passage that moved from a place now gone could take its vector first.
  try {
    if (gone.some((r) => r.vector_hash)) await store.delete(gone.filter((r) => r.vector_hash).map((r) => r.id));
  } catch (error) {
    console.error("docs could not drop old passages from the index", doc.doc_id, String(error));
  }
  return result;
}

type IndexedChunk = { id: string; seq: number; heading: string | null; text: string; embed: string; hash: string };

/** Vectors for the passages that need one: reused when the index already holds their text, embedded otherwise (within the cap). */
async function embedChanged(
  db: D1Database,
  embedder: Embedder,
  store: VectorStore,
  doc: IndexDoc,
  chunks: IndexedChunk[],
  old: ChunkRow[],
  byId: Map<string, ChunkRow>,
  now: Date,
): Promise<{ chunks: number; embedded: number; capped: boolean }> {
  // What needs a vector: a passage whose text the index doesn't hold under its id, or one whose space changed.
  const stale = chunks.filter((c) => {
    const was = byId.get(c.id);
    return !was || was.vector_hash !== c.hash || was.space_id !== doc.space_id;
  });
  if (!stale.length) return { chunks: chunks.length, embedded: 0, capped: false };
  // A passage that only moved (or changed space) has its vector already, under another id or this one.
  const held = new Map<string, string>();
  for (const r of old) if (r.vector_hash) held.set(r.vector_hash, r.id);
  const reuse = stale.filter((c) => held.has(c.hash));
  const fresh = stale.filter((c) => !held.has(c.hash));
  const budget = fresh.length ? await allowance(db, doc.workspace_id, now) : 0;
  const embedNow = fresh.slice(0, budget);
  const capped = embedNow.length < fresh.length;
  if (capped) console.log("docs embedding cap reached", doc.workspace_id, `${fresh.length - embedNow.length} passages wait for the next hour`);
  const metadata = metadataOf(doc);
  const done: { id: string; hash: string }[] = [];
  try {
    const vectors: { id: string; values: number[]; metadata: VectorMetadata }[] = [];
    if (reuse.length) {
      const values = new Map((await store.get([...new Set(reuse.map((c) => held.get(c.hash)!))])).map((v) => [v.id, v.values]));
      for (const c of reuse) {
        const v = values.get(held.get(c.hash)!);
        if (v) vectors.push({ id: c.id, values: v, metadata });
      }
    }
    if (embedNow.length) {
      const embedded = await embedder.embed(embedNow.map((c) => c.embed));
      embedNow.forEach((c, i) => vectors.push({ id: c.id, values: embedded[i]!, metadata }));
      await meter(
        db,
        doc.workspace_id,
        embedNow.length,
        embedNow.reduce((n, c) => n + c.embed.length, 0),
        now,
      );
    }
    if (vectors.length) await store.upsert(vectors);
    const hashOf = new Map(chunks.map((c) => [c.id, c.hash]));
    for (const v of vectors) done.push({ id: v.id, hash: hashOf.get(v.id)! });
  } catch (error) {
    console.error("docs could not embed passages; the next save tries again", doc.doc_id, String(error));
  }
  if (done.length) {
    const updates = done.map((d) => db.prepare("UPDATE doc_chunks SET vector_hash = ? WHERE id = ?").bind(d.hash, d.id));
    for (let i = 0; i < updates.length; i += 60) await db.batch(updates.slice(i, i + 60));
  }
  return { chunks: chunks.length, embedded: embedNow.length, capped };
}

/** Takes passages out of D1 and the index: by page ids, file ids, or a whole space. */
export async function forgetDocs(env: IndexEnv, which: { page_ids?: string[]; repo_file_ids?: string[]; space_id?: string }): Promise<void> {
  const db = env.DB;
  const { store } = adapters(env);
  try {
    const found: string[] = [];
    const select = async (column: string, values: string[]) => {
      for (let i = 0; i < values.length; i += 90) {
        const part = values.slice(i, i + 90);
        const rows = await db.prepare(`SELECT id FROM doc_chunks WHERE ${column} IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ id: string }>();
        found.push(...rows.results.map((r) => r.id));
      }
    };
    if (which.page_ids?.length) await select("page_id", which.page_ids);
    if (which.repo_file_ids?.length) await select("repo_file_id", which.repo_file_ids);
    if (which.space_id) await select("space_id", [which.space_id]);
    if (!found.length) return;
    if (store) {
      try {
        await store.delete(found);
      } catch (error) {
        console.error("docs could not drop passages from the index", found.length, String(error));
      }
    }
    const statements = found.flatMap((id) => [db.prepare("DELETE FROM doc_chunks WHERE id = ?").bind(id), db.prepare("DELETE FROM doc_chunks_fts WHERE chunk_id = ?").bind(id)]);
    for (let i = 0; i < statements.length; i += 80) await db.batch(statements.slice(i, i + 80));
  } catch (error) {
    console.error("docs could not forget passages", String(error));
  }
}

type PageForIndex = { id: string; workspace_id: string; space_id: string; title: string; markdown: string; archived_at: string | null };

/** Indexes one page as it is saved now; forgets it when it is gone or in the trash. Never throws. */
export async function indexPage(env: IndexEnv, pageId: string, now = new Date()): Promise<{ capped: boolean }> {
  try {
    const page = await env.DB.prepare("SELECT id, workspace_id, space_id, title, markdown, archived_at FROM pages WHERE id = ?").bind(pageId).first<PageForIndex>();
    if (!page || page.archived_at) {
      await forgetDocs(env, { page_ids: [pageId] });
      return { capped: false };
    }
    const { embedder, store } = adapters(env);
    const result = await indexDoc(env.DB, embedder, store, { kind: "page", doc_id: page.id, workspace_id: page.workspace_id, space_id: page.space_id, title: page.title, markdown: page.markdown }, now);
    if (result.capped) await startBackfill(env, page.workspace_id, { delaySeconds: CAP_DELAY_SECONDS });
    return { capped: result.capped };
  } catch (error) {
    console.error("docs could not index a page", pageId, String(error));
    return { capped: false };
  }
}

type RepoFileForIndex = { space_id: string; path: string; title: string; markdown: string; workspace_id: string; repo_id: string };

function repoDoc(row: RepoFileForIndex): IndexDoc {
  return { kind: "repo_file", doc_id: repoFileId(row.space_id, row.path), workspace_id: row.workspace_id, space_id: row.space_id, title: row.title, markdown: row.markdown, repo_id: row.repo_id, path: row.path };
}

/**
 * Indexes a project's docs files after they were read: `changed` paths
 * again, `gone` paths forgotten. Never throws.
 */
export async function indexRepoFiles(env: IndexEnv, spaceId: string, changed: string[], gone: string[], now = new Date()): Promise<void> {
  try {
    if (gone.length) await forgetDocs(env, { repo_file_ids: gone.map((p) => repoFileId(spaceId, p)) });
    if (!changed.length) return;
    const { embedder, store } = adapters(env);
    let capped = false;
    let workspaceId: string | null = null;
    for (let i = 0; i < changed.length; i += 50) {
      const part = changed.slice(i, i + 50);
      const rows = (
        await env.DB.prepare(
          `SELECT f.space_id, f.path, f.title, f.markdown, s.workspace_id, s.repo_id FROM repo_files f JOIN repo_spaces s ON s.id = f.space_id WHERE f.space_id = ? AND f.path IN (${part.map(() => "?").join(",")})`,
        )
          .bind(spaceId, ...part)
          .all<RepoFileForIndex>()
      ).results;
      for (const row of rows) {
        workspaceId = row.workspace_id;
        // Past the cap, the rest are only kept for words until the catch-up run.
        const result = await indexDoc(env.DB, capped ? null : embedder, capped ? null : store, repoDoc(row), now);
        capped ||= result.capped;
      }
    }
    if (capped && workspaceId) await startBackfill(env, workspaceId, { delaySeconds: CAP_DELAY_SECONDS });
  } catch (error) {
    console.error("docs could not index a project's docs", spaceId, String(error));
  }
}

/**
 * Starts (or, with `force`, restarts) indexing a workspace's existing
 * pages and projects' docs on the queue. Does nothing while a run is
 * going, unless it has been going so long it must have died. Without a
 * queue, runs one batch now. True when a run was started.
 */
export async function startBackfill(env: IndexEnv, workspaceId: string, options: { force?: boolean; delaySeconds?: number } = {}): Promise<boolean> {
  const at = new Date();
  const staleBefore = new Date(at.getTime() - BACKFILL_STALE_MS).toISOString();
  const started = await env.DB.prepare(
    `INSERT INTO doc_index_runs (workspace_id, started_at, finished_at, cursor, pages, files) VALUES (?1, ?2, NULL, NULL, 0, 0)
     ON CONFLICT (workspace_id) DO UPDATE SET started_at = ?2, finished_at = NULL, cursor = NULL, pages = 0, files = 0
     WHERE ?3 OR doc_index_runs.finished_at IS NOT NULL OR doc_index_runs.started_at < ?4
     RETURNING workspace_id`,
  )
    .bind(workspaceId, at.toISOString(), options.force ? 1 : 0, staleBefore)
    .first<{ workspace_id: string }>();
  if (!started) return false;
  await enqueue(env, workspaceId, options.delaySeconds ?? 0);
  return true;
}

async function enqueue(env: IndexEnv, workspaceId: string, delaySeconds: number): Promise<void> {
  if (env.JOBS) {
    await env.JOBS.send({ type: "docs.index", workspace_id: workspaceId }, delaySeconds ? { delaySeconds } : undefined);
    return;
  }
  // No queue (self-hosted without one): one batch now; saves and later recalls carry on from there.
  if (!delaySeconds) await runBackfill(env, workspaceId, false);
}

/**
 * The first time anyone recalls from a workspace's docs: when it has
 * pages or projects' docs and has never been indexed, start the backfill.
 */
export async function ensureIndexed(env: IndexEnv, workspaceId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT (SELECT 1 FROM doc_index_runs WHERE workspace_id = ?1) AS ran, (SELECT 1 FROM pages WHERE workspace_id = ?1 AND archived_at IS NULL LIMIT 1) AS page, (SELECT 1 FROM repo_spaces WHERE workspace_id = ?1 LIMIT 1) AS repo",
  )
    .bind(workspaceId)
    .first<{ ran: number | null; page: number | null; repo: number | null }>();
  if (!row || row.ran || (!row.page && !row.repo)) return;
  await startBackfill(env, workspaceId);
}

/**
 * One batch of a workspace's backfill: pages by id, then projects' docs
 * files by space and path, from the run's cursor. Hands on to the next
 * batch (or waits out the hour's cap) through the queue.
 */
export async function runBackfill(env: IndexEnv, workspaceId: string, chain = true): Promise<{ done: boolean }> {
  const run = await env.DB.prepare("SELECT cursor, finished_at, pages, files FROM doc_index_runs WHERE workspace_id = ?").bind(workspaceId).first<{ cursor: string | null; finished_at: string | null; pages: number; files: number }>();
  if (!run || run.finished_at) return { done: true };
  const { embedder, store } = adapters(env);
  const cursor = run.cursor ?? "p:";
  let next: string | null = cursor;
  let pages = 0;
  let files = 0;
  let capped = false;
  if (cursor.startsWith("p:")) {
    const rows = (
      await env.DB.prepare("SELECT id, workspace_id, space_id, title, markdown, archived_at FROM pages WHERE workspace_id = ? AND archived_at IS NULL AND id > ? ORDER BY id LIMIT ?")
        .bind(workspaceId, cursor.slice(2), BACKFILL_BATCH)
        .all<PageForIndex>()
    ).results;
    for (const page of rows) {
      const result = await indexDoc(env.DB, embedder, store, { kind: "page", doc_id: page.id, workspace_id: page.workspace_id, space_id: page.space_id, title: page.title, markdown: page.markdown });
      pages++;
      if (result.capped) {
        // This page again next time, after the hour: the cursor stays before it.
        capped = true;
        break;
      }
      next = `p:${page.id}`;
    }
    if (!capped && rows.length < BACKFILL_BATCH) next = "f:";
  } else {
    const [space, path] = splitFileCursor(cursor.slice(2));
    const rows = (
      await env.DB.prepare(
        `SELECT f.space_id, f.path, f.title, f.markdown, s.workspace_id, s.repo_id FROM repo_files f JOIN repo_spaces s ON s.id = f.space_id
         WHERE s.workspace_id = ? AND (f.space_id > ? OR (f.space_id = ? AND f.path > ?)) ORDER BY f.space_id, f.path LIMIT ?`,
      )
        .bind(workspaceId, space, space, path, BACKFILL_BATCH)
        .all<RepoFileForIndex>()
    ).results;
    for (const row of rows) {
      const result = await indexDoc(env.DB, embedder, store, repoDoc(row));
      files++;
      if (result.capped) {
        capped = true;
        break;
      }
      next = `f:${row.space_id}\n${row.path}`;
    }
    if (!capped && rows.length < BACKFILL_BATCH) next = null;
  }
  await env.DB.prepare("UPDATE doc_index_runs SET cursor = ?, pages = pages + ?, files = files + ?, finished_at = ? WHERE workspace_id = ?")
    .bind(next, pages, files, next === null ? new Date().toISOString() : null, workspaceId)
    .run();
  if (next === null) return { done: true };
  if (chain && env.JOBS) await enqueue(env, workspaceId, capped ? CAP_DELAY_SECONDS : 0);
  return { done: false };
}

function splitFileCursor(cursor: string): [string, string] {
  const at = cursor.indexOf("\n");
  // Empty: from the start.
  return at < 0 ? ["", ""] : [cursor.slice(0, at), cursor.slice(at + 1)];
}
