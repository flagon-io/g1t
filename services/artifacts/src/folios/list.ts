/**
 * Folio lists' small rules, apart from where rows come from: cleaning
 * input, the paging cursor, sidebar trees and the "Shared" section's
 * tops, and a tree's depth. Pure.
 */
import type { DocEditTarget, FolioTreeNode } from "@g1t/contracts";

import { pageSlug } from "../slugs.ts";

/** The longest title, in characters (FOLIO_MAX_TITLE). */
export const MAX_TITLE = 200;
/** The deepest a folio tree goes (FOLIO_MAX_DEPTH). */
export const MAX_DEPTH = 10;
/** A page of a list, unless asked for fewer (at most FOLIO_LIST_MAX). */
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;
/** A note on an edit, a template's description: at most this long. */
export const MAX_NOTE = 500;
/**
 * The largest saved document a page carries to the browser (base64, in
 * the page's data). Past it the editor waits for the room, as it did for
 * every doc before the state was kept.
 */
export const MAX_PAGE_STATE = 512 * 1024;

/** A folio's saved Yjs state as the page carries it: base64, or null when none is kept or it is too large. */
export function pageState(state: ArrayBuffer | ArrayLike<number> | null | undefined): string | null {
  if (!state) return null;
  const bytes = new Uint8Array(state as ArrayBuffer);
  if (!bytes.byteLength || bytes.byteLength > MAX_PAGE_STATE) return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function cleanTitle(title: unknown, max = MAX_TITLE): string {
  return [...String(title ?? "").replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

/** One emoji (or a few characters), or null. */
export function cleanIcon(icon: unknown): string | null {
  const s = String(icon ?? "").trim();
  return s ? [...s].slice(0, 4).join("") : null;
}

export function cleanCover(cover: unknown): string | null {
  const s = String(cover ?? "").trim();
  if (!s) return null;
  if (/^gradient:\d{1,2}$/.test(s)) return s;
  if (/^https:\/\/[^\s"'<>]{1,500}$/.test(s)) return s;
  return null;
}

export function cleanNote(note: unknown): string | null {
  const s = String(note ?? "").trim();
  return s ? s.slice(0, MAX_NOTE) : null;
}

/** Where it was written up from: a link on this site only. */
export function cleanSource(source: unknown): { title: string; href: string } | null {
  const s = source as { title?: unknown; href?: unknown } | null;
  if (!s || typeof s !== "object" || typeof s.href !== "string") return null;
  const href = s.href.trim();
  if (!href.startsWith("/") || href.startsWith("//") || href.length > 500 || /[\s"'<>]/.test(href)) return null;
  return { title: cleanTitle(s.title || "A conversation", 120) || "A conversation", href };
}

export function cleanTarget(target: unknown): DocEditTarget | null {
  const t = target as DocEditTarget | null;
  if (!t || typeof t !== "object") return null;
  switch (t.kind) {
    case "append":
    case "document":
      return { kind: t.kind };
    case "section":
      return typeof t.heading === "string" && t.heading.trim() ? { kind: "section", heading: t.heading.trim().slice(0, 300) } : null;
    case "blocks":
      return typeof t.from_block === "string" && typeof t.to_block === "string" ? { kind: "blocks", from_block: t.from_block, to_block: t.to_block } : null;
    default:
      return null;
  }
}

export function listLimit(limit: unknown): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** Where the next page of a list starts: after this sort key and id. */
export type Cursor = { k: string; id: string };

export function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify([cursor.k, cursor.id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== "string" || !value || value.length > 400) return null;
  try {
    const parsed = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") return { k: parsed[0], id: parsed[1] };
  } catch {
    // Not one of ours.
  }
  return null;
}

/** A folio's last address segment (`<title-slug>-<id>`), as `folioSlug` in contracts. */
export function slugOf(title: string, id: string): string {
  return pageSlug(title, id);
}

type TreeRow = { id: string; kind: FolioTreeNode["kind"]; parent_id: string | null; position: number; title: string; icon: string | null; inherit: number | boolean };

/**
 * A sidebar tree: the rows a reader may see, each under its parent when
 * they may see the parent too, otherwise at the top. Ordered by position.
 */
export function treeNodes(rows: readonly TreeRow[], stale: ReadonlySet<string> = new Set()): FolioTreeNode[] {
  const shown = new Set(rows.map((r) => r.id));
  return [...rows]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      parent_id: r.parent_id && shown.has(r.parent_id) ? r.parent_id : null,
      position: r.position,
      title: r.title,
      icon: r.icon,
      slug: slugOf(r.title, r.id),
      restricted: !r.inherit && !!r.parent_id,
      ...(stale.has(r.id) ? { stale: true } : {}),
    }));
}

/**
 * The tops of what is shared with someone: of the folios they can read
 * that aren't theirs, those whose parent they can't read (or that have
 * none), leaving out anything already in their other sections.
 */
export function sharedTops<T extends { id: string; parent_id: string | null }>(readable: readonly T[], elsewhere: ReadonlySet<string>): T[] {
  const ids = new Set(readable.map((r) => r.id));
  return readable.filter((r) => !elsewhere.has(r.id) && (!r.parent_id || (!ids.has(r.parent_id) && !elsewhere.has(r.parent_id))));
}

/** How deep a folio is: 1 at the top. */
export function depthOf(path: string): number {
  return String(path ?? "")
    .split("/")
    .filter(Boolean).length;
}

/** How many levels a subtree spans below its top (0 for a leaf), from its rows' paths. */
export function subtreeHeight(top: { path: string }, rows: readonly { path: string }[]): number {
  const base = depthOf(top.path);
  return rows.reduce((h, r) => Math.max(h, depthOf(r.path) - base), 0);
}
