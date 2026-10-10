/**
 * What a page's room saves to D1 after a burst of edits: the Markdown
 * rendition, the search index, backlinks, history, and telling people
 * newly mentioned in the page. Run by the room (src/room.ts), which owns
 * the live document; nothing here reads the document itself.
 */
import { newId, notifyClient, type DocCitation, type DocVersionKind, type FeedNotification, type FolioKind, type FolioVersionKind, type ServiceBinding } from "@g1t/contracts";

import { publishDocEvent } from "./events.ts";
import { fileStore, type FileStoreEnv } from "./files.ts";
import { workspaceReadable } from "./folios/access-store.ts";
import { publishFolioEvent } from "./folios/events.ts";
import type { Rendition } from "./kinds/types.ts";
import { excerpt, searchText } from "./markdown.ts";
import { linkedPageIds, pageSlug } from "./slugs.ts";

/** How long edits gather into one version before the next starts. */
export const VERSION_EVERY_MS = 10 * 60 * 1000;
/** The largest Yjs state a version keeps; past it, only its Markdown. */
const MAX_VERSION_STATE = 1_500_000;

export type SaveEnv = { DB: D1Database; NOTIFY?: ServiceBinding; EVENTS?: ServiceBinding };

export type Save = {
  page_id: string;
  markdown: string;
  /** Code the document cites (src/citations.ts `bodyCitations`). */
  citations: DocCitation[];
  /** The editors since the last save, member keys, last one last. */
  editors: string[];
  /** People mentioned in the document now (usernames, lowercased). */
  mentioned: string[];
  /** The usernames of the people who made these edits, lowercased: nobody is told they mentioned themselves. */
  editor_names: string[];
  /** The whole document, for a version. */
  state: Uint8Array;
  /** A version to record now, whatever the time since the last. */
  version: { kind: DocVersionKind; note: string | null; authors: string[] } | null;
  /** Editors since the last version, for a timed one. */
  pending_authors: string[];
  /** When the last version was recorded (ms), or 0. */
  last_version_at: number;
  /** The workspace's slug as the room last heard it, for links in notifications. */
  workspace_slug: string | null;
};

type PageRow = { id: string; workspace_id: string; space_id: string; title: string; mentioned: string; markdown: string; slug: string; archived_at: string | null };

/** Saves; returns whether a version was recorded, and its id, and whether the Markdown changed (so the room indexes it again, src/indexer.ts). */
export async function save(env: SaveEnv, input: Save, now = new Date()): Promise<{ version_id: string | null; changed: boolean }> {
  const at = now.toISOString();
  const page = await env.DB.prepare(
    "SELECT p.id, p.workspace_id, p.space_id, p.title, p.mentioned, p.markdown, p.archived_at, s.slug AS slug FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = ?",
  )
    .bind(input.page_id)
    .first<PageRow>();
  if (!page) return { version_id: null, changed: false };
  const changed = page.markdown !== input.markdown;
  const last = input.editors[input.editors.length - 1] ?? null;
  const statements: D1PreparedStatement[] = [];
  if (changed || last) {
    statements.push(
      env.DB.prepare("UPDATE pages SET markdown = ?, updated_at = ?, updated_by = COALESCE(?, updated_by) WHERE id = ?").bind(input.markdown, at, last, page.id),
    );
  }
  if (changed) {
    statements.push(env.DB.prepare("DELETE FROM pages_fts WHERE page_id = ?").bind(page.id));
    statements.push(env.DB.prepare("INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)").bind(page.id, page.title, searchText(input.markdown)));
    statements.push(env.DB.prepare("DELETE FROM page_links WHERE from_page = ?").bind(page.id));
    for (const to of linkedPageIds(input.markdown).filter((id) => id !== page.id).slice(0, 200)) {
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO page_links (from_page, to_page) VALUES (?, ?)").bind(page.id, to));
    }
    // What it cites, from its text; the header's own stay.
    statements.push(env.DB.prepare("DELETE FROM citations WHERE page_id = ? AND source = 'body'").bind(page.id));
    for (const c of input.citations) {
      statements.push(
        env.DB.prepare("INSERT OR IGNORE INTO citations (page_id, repo, path, kind, label, ref, source) VALUES (?, ?, ?, ?, ?, ?, 'body')").bind(page.id, c.repo, c.path, c.kind, c.label ?? "", c.ref),
      );
    }
  }
  // A version: asked for (an agent's edit, a suggestion, a restore), or
  // the first save after enough time since the last one.
  let versionId: string | null = null;
  const timed = input.pending_authors.length > 0 && now.getTime() - input.last_version_at >= VERSION_EVERY_MS;
  if (input.version || (timed && changed)) {
    versionId = newId("ver", now.getTime());
    const authors = input.version?.authors.length ? input.version.authors : input.pending_authors;
    const state = input.state.byteLength <= MAX_VERSION_STATE ? input.state : null;
    statements.push(
      env.DB.prepare("INSERT INTO page_versions (id, page_id, created_at, kind, authors, note, markdown, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
        versionId,
        page.id,
        at,
        input.version?.kind ?? "edit",
        JSON.stringify([...new Set(authors)]),
        input.version?.note ?? null,
        input.markdown,
        state,
      ),
    );
  }
  // People mentioned for the first time.
  let told: string[] = [];
  try {
    told = JSON.parse(page.mentioned) as string[];
  } catch {
    told = [];
  }
  const editors = new Set(input.editor_names);
  const fresh = input.mentioned.filter((name) => !told.includes(name) && !editors.has(name));
  if (fresh.length || input.mentioned.length !== told.length) {
    statements.push(env.DB.prepare("UPDATE pages SET mentioned = ? WHERE id = ?").bind(JSON.stringify([...new Set([...told.filter((id) => input.mentioned.includes(id)), ...fresh])]), page.id));
  }
  if (statements.length) await env.DB.batch(statements);
  // A version is what the rest of g1t hears of: at most every ten minutes of editing, and each agent edit, suggestion and restore.
  const kind = input.version?.kind ?? "edit";
  if (versionId && kind !== "created" && input.workspace_slug && !page.archived_at) {
    await publishDocEvent(
      env.EVENTS,
      "doc.page.updated",
      {
        workspace: input.workspace_slug,
        workspaceId: page.workspace_id,
        pageId: page.id,
        spaceId: page.space_id,
        title: page.title,
        path: `/${input.workspace_slug}/-/docs/${page.slug}/${pageSlug(page.title, page.id)}`,
        versionId,
        kind,
        authors: [...new Set(input.version?.authors.length ? input.version.authors : input.pending_authors)],
      },
      last,
    );
  }
  if (fresh.length && env.NOTIFY && !page.archived_at) {
    const slug = input.workspace_slug;
    if (slug) {
      const href = `/${slug}/-/docs/${page.slug}/${pageSlug(page.title, page.id)}`;
      const notification = (username: string): FeedNotification => ({
        id: `doc-mention:${page.id}:${username}`,
        kind: "mention",
        workspace: slug,
        title: `You were mentioned in ${page.title || "Untitled"}`,
        body: excerpt(input.markdown, 140),
        href,
        actor: { kind: last?.startsWith("agent:") ? "agent" : "user", id: last?.slice(last.indexOf(":") + 1) ?? "", name: "Docs" },
        created_at: at,
      });
      const notify = notifyClient(env.NOTIFY);
      await Promise.all(fresh.map((name) => notify.notify({ username: name }, notification(name)).catch(() => undefined)));
    }
  }
  return { version_id: versionId, changed };
}

// ── Folios (Artifacts mode) ─────────────────────────────────────────────

export type SaveFolioEnv = SaveEnv & FileStoreEnv;

export type SaveFolio = {
  folio_id: string;
  /** What the kind rendered from the document (src/kinds/types.ts). */
  rendition: Rendition;
  /** The editors since the last save, member keys, last one last. */
  editors: string[];
  /** The usernames of the people who made these edits, lowercased. */
  editor_names: string[];
  state: Uint8Array;
  version: { kind: FolioVersionKind; note: string | null; authors: string[] } | null;
  pending_authors: string[];
  last_version_at: number;
  workspace_slug: string | null;
};

type FolioSaveRow = { id: string; workspace_id: string; kind: FolioKind; title: string; text: string; preview: string | null; mentioned: string; space_id: string | null; trashed_at: string | null };

/**
 * What a folio's room saves to D1 after a burst of edits: its text
 * rendition, card, search text, links, citations and history. Returns the
 * version recorded (if one was), whether the text changed (so the room
 * indexes it again), and the people newly mentioned, whom the room tells
 * only if they can read the folio (src/folios/notify.ts).
 */
export async function saveFolio(env: SaveFolioEnv, input: SaveFolio, now = new Date()): Promise<{ version_id: string | null; changed: boolean; mentioned: string[]; last: string | null }> {
  const at = now.toISOString();
  const db = env.DB;
  const folio = await db.prepare("SELECT id, workspace_id, kind, title, text, preview, mentioned, space_id, trashed_at FROM folios WHERE id = ?").bind(input.folio_id).first<FolioSaveRow>();
  if (!folio) return { version_id: null, changed: false, mentioned: [], last: null };
  const r = input.rendition;
  const changed = folio.text !== r.text;
  const last = input.editors[input.editors.length - 1] ?? null;
  const statements: D1PreparedStatement[] = [];
  const preview = r.preview ? JSON.stringify(r.preview) : null;
  // The document itself, so a page opens from it before its room answers
  // (folios/service.ts `page`), and an emptied room is refilled with the
  // very same document (`ready`). Too large for a row: none is kept, and
  // the page waits for the room as before.
  statements.push(db.prepare("UPDATE folios SET state = ? WHERE id = ?").bind(input.state.byteLength <= MAX_VERSION_STATE ? input.state : null, folio.id));
  // A folio made from text that already reads as the kind renders it still needs its card.
  if (!changed && preview !== folio.preview) statements.push(db.prepare("UPDATE folios SET preview = ? WHERE id = ?").bind(preview, folio.id));
  if (changed) {
    statements.push(
      db
        .prepare("UPDATE folios SET text = ?, excerpt = ?, preview = ?, edited_at = ?, edited_by = COALESCE(?, edited_by), updated_at = ? WHERE id = ?")
        .bind(r.text, excerpt(r.text), preview, at, last, at, folio.id),
      db.prepare("DELETE FROM folios_fts WHERE folio_id = ?").bind(folio.id),
      db.prepare("INSERT INTO folios_fts (folio_id, kind, title, body) VALUES (?, ?, ?, ?)").bind(folio.id, folio.kind, folio.title, searchText(r.text)),
      db.prepare("DELETE FROM folio_links WHERE from_folio = ?").bind(folio.id),
      db.prepare("DELETE FROM folio_citations WHERE folio_id = ? AND source = 'body'").bind(folio.id),
    );
    for (const to of r.links.filter((id) => id !== folio.id).slice(0, 200)) {
      statements.push(db.prepare("INSERT OR IGNORE INTO folio_links (from_folio, to_folio) VALUES (?, ?)").bind(folio.id, to));
    }
    for (const c of r.citations) {
      statements.push(
        db.prepare("INSERT OR IGNORE INTO folio_citations (folio_id, repo, path, kind, label, ref, source) VALUES (?, ?, ?, ?, ?, ?, 'body')").bind(folio.id, c.repo, c.path, c.kind, c.label ?? "", c.ref),
      );
    }
  }
  // A version: asked for, or the first save with changes after enough time.
  let versionId: string | null = null;
  const timed = input.pending_authors.length > 0 && now.getTime() - input.last_version_at >= VERSION_EVERY_MS;
  if (input.version || (timed && changed)) {
    versionId = newId("ver", now.getTime());
    const authors = input.version?.authors.length ? input.version.authors : input.pending_authors;
    let state: Uint8Array | null = input.state.byteLength <= MAX_VERSION_STATE ? input.state : null;
    let stateKey: string | null = null;
    if (!state) {
      // Too large for a row: the file store keeps it.
      try {
        stateKey = `docs/versions/${folio.id}/${versionId}`;
        await fileStore(env).put(stateKey, input.state, "application/octet-stream");
      } catch (error) {
        console.error("folios could not keep a large version's state; its text is kept", folio.id, String(error));
        stateKey = null;
        state = null;
      }
    }
    statements.push(
      db
        .prepare("INSERT INTO folio_versions (id, folio_id, created_at, kind, authors, note, text, state, state_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(versionId, folio.id, at, input.version?.kind ?? "edit", JSON.stringify([...new Set(authors)]), input.version?.note ?? null, r.text, state, stateKey),
    );
  }
  let told: string[] = [];
  try {
    told = JSON.parse(folio.mentioned) as string[];
  } catch {
    told = [];
  }
  const editors = new Set(input.editor_names);
  const fresh = r.mentions.filter((name) => !told.includes(name) && !editors.has(name));
  if (fresh.length || r.mentions.length !== told.length) {
    statements.push(db.prepare("UPDATE folios SET mentioned = ? WHERE id = ?").bind(JSON.stringify([...new Set([...told.filter((n) => r.mentions.includes(n)), ...fresh])]), folio.id));
  }
  if (statements.length) await db.batch(statements);
  const kind = input.version?.kind ?? "edit";
  if (versionId && kind !== "created" && input.workspace_slug && !folio.trashed_at) {
    const open = await workspaceReadable(db, folio.id).catch(() => false);
    await publishFolioEvent(
      env.EVENTS,
      "folio.updated",
      {
        workspace: input.workspace_slug,
        workspaceId: folio.workspace_id,
        folioId: folio.id,
        kind: folio.kind,
        spaceId: folio.space_id,
        title: open ? folio.title : null,
        versionId,
        versionKind: kind,
        authors: [...new Set(input.version?.authors.length ? input.version.authors : input.pending_authors)],
      },
      last,
    );
  }
  return { version_id: versionId, changed, mentioned: folio.trashed_at ? [] : fresh, last };
}
