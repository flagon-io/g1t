/**
 * Folio access in D1: reading a folio's chain (itself and the ancestors
 * its access comes from) and grants, keeping each subtree's denormalized
 * `acl_root` and `path` right, and rebuilding the materialized
 * `folio_access` rows the lists and search filter by. The rules
 * themselves are pure, in src/access.ts.
 */
import type { DocRole, FolioGeneralAccess } from "@g1t/contracts";

import { aclChain, aclRootOf, effectiveRole, folioPathOf, folioReadableByWorkspace, folioScope, materialize, type FolioAclNode, type FolioGrant, type Person } from "../access.ts";

/** A folio row as stored. `text` is left out of lists (see FOLIO_COLUMNS). */
export type FolioRow = {
  id: string;
  workspace_id: string;
  kind: "doc" | "slides" | "design" | "dashboard";
  title: string;
  icon: string | null;
  cover: string | null;
  owner: string;
  space_id: string | null;
  parent_id: string | null;
  position: number;
  inherit: number;
  acl_root: string;
  path: string;
  general_access: FolioGeneralAccess;
  general_role: DocRole | null;
  agent_mode: "suggest" | "edit" | null;
  text: string;
  excerpt: string;
  preview: string | null;
  source: string | null;
  mentioned: string;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  edited_by: string | null;
  edited_at: string;
  trashed_at: string | null;
  trashed_by: string | null;
  /** The saved Yjs state (migration 0006), only when a read asks for it. */
  state?: ArrayBuffer | number[] | null;
};

/** Every column but the text, as lists read them. */
export const FOLIO_COLUMNS =
  "id, workspace_id, kind, title, icon, cover, owner, space_id, parent_id, position, inherit, acl_root, path, general_access, general_role, agent_mode, '' AS text, excerpt, preview, source, mentioned, created_by, created_at, updated_by, updated_at, edited_by, edited_at, trashed_at, trashed_by";

/** The same, prefixed by a table alias. */
export function folioColumns(alias: string): string {
  return FOLIO_COLUMNS.split(", ")
    .map((c) => (c.startsWith("'") ? c : `${alias}.${c}`))
    .join(", ");
}

/** D1 binds at most 100 parameters; lists go in as one JSON parameter instead. */
export const json = (values: readonly string[]) => JSON.stringify([...new Set(values)]);

/** How many statements one batch carries. */
const BATCH = 80;

export async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH) await db.batch(statements.slice(i, i + BATCH));
}

export function aclNode(row: Pick<FolioRow, "id" | "owner" | "parent_id" | "space_id" | "inherit" | "general_access" | "general_role" | "created_at">): FolioAclNode {
  return {
    id: row.id,
    owner: row.owner,
    parent_id: row.parent_id,
    space_id: row.space_id,
    inherit: !!row.inherit,
    general_access: row.general_access,
    general_role: row.general_role,
    created_at: row.created_at,
  };
}

/** The ids in a path, top first. */
export function pathIds(path: string): string[] {
  return String(path ?? "")
    .split("/")
    .filter(Boolean);
}

/** Folio rows by id (any workspace's; callers check), without their text. */
export async function foliosById(db: D1Database, ids: readonly string[]): Promise<Map<string, FolioRow>> {
  const out = new Map<string, FolioRow>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await db
      .prepare(`SELECT ${FOLIO_COLUMNS} FROM folios WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(json(unique.slice(i, i + 500)))
      .all<FolioRow>();
    for (const r of rows.results) out.set(r.id, r);
  }
  return out;
}

/** Grants on these folios, by folio. */
export async function grantsOf(db: D1Database, ids: readonly string[]): Promise<Map<string, FolioGrant[]>> {
  const out = new Map<string, FolioGrant[]>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await db
      .prepare("SELECT folio_id, principal, role, granted_at FROM folio_grants WHERE folio_id IN (SELECT value FROM json_each(?))")
      .bind(json(unique.slice(i, i + 500)))
      .all<{ folio_id: string; principal: string; role: DocRole; granted_at: string }>();
    for (const r of rows.results) out.set(r.folio_id, [...(out.get(r.folio_id) ?? []), { principal: r.principal, role: r.role, granted_at: r.granted_at }]);
  }
  return out;
}

/** Everything access needs for these folios: them and their ancestors as nodes, and every grant on them. */
export type Ancestry = { rows: Map<string, FolioRow>; nodes: Map<string, FolioAclNode>; grants: Map<string, FolioGrant[]> };

export async function ancestry(db: D1Database, rows: readonly FolioRow[]): Promise<Ancestry> {
  const all = new Map(rows.map((r) => [r.id, r]));
  const missing = [...new Set(rows.flatMap((r) => pathIds(r.path)))].filter((id) => !all.has(id));
  if (missing.length) for (const [id, row] of await foliosById(db, missing)) all.set(id, row);
  const grants = await grantsOf(db, [...all.keys()]);
  return { rows: all, nodes: new Map([...all.values()].map((r) => [r.id, aclNode(r)])), grants };
}

/** What a reader's role depends on beyond the folio: their space roles and the links they opened. */
export type ReaderContext = {
  person: Person;
  /** Their role in each space (null: none). */
  spaceRole: (spaceId: string) => DocRole | null;
  /** Folio ids they opened. */
  visits: ReadonlySet<string>;
};

/** Of these folios, the ones whose link the person opened (or whose access root's). */
export async function visitsOf(db: D1Database, userId: string, rows: readonly Pick<FolioRow, "id" | "acl_root">[]): Promise<Set<string>> {
  const ids = [...new Set(rows.flatMap((r) => [r.id, r.acl_root]))];
  if (!ids.length) return new Set();
  const found = await db
    .prepare("SELECT folio_id FROM folio_visits WHERE user_id = ? AND folio_id IN (SELECT value FROM json_each(?))")
    .bind(userId, json(ids))
    .all<{ folio_id: string }>();
  return new Set(found.results.map((r) => r.folio_id));
}

/** A reader's role on each folio, from the full chain (defence in depth behind the list SQL). */
export function rolesFrom(found: Ancestry, rows: readonly FolioRow[], reader: ReaderContext): Map<string, DocRole | null> {
  const out = new Map<string, DocRole | null>();
  for (const row of rows) {
    const chain = aclChain(row.id, found.nodes);
    const root = chain[chain.length - 1];
    const visited = reader.visits.has(row.id) || (!!root && reader.visits.has(root.id));
    out.set(row.id, effectiveRole(chain, found.grants, root?.space_id ? reader.spaceRole(root.space_id) : null, reader.person, { visited }));
  }
  return out;
}

/**
 * The list filter (plan section 2.3): a folio is readable when one of the
 * reader's keys has a `folio_access` row on it; or its access root is at
 * the top of a space they can read and inherits it; or its access root
 * is open to the workspace; or it is a link folio they opened. `f` is the
 * folio and `r` its access root (`JOIN folios r ON r.id = f.acl_root`).
 */
export function readableWhere(keys: readonly string[], spaceIds: readonly string[], userId: string): { sql: string; binds: unknown[] } {
  return {
    sql: `(f.id IN (SELECT folio_id FROM folio_access WHERE principal IN (SELECT value FROM json_each(?)))
      OR (r.parent_id IS NULL AND r.inherit = 1 AND r.space_id IN (SELECT value FROM json_each(?)))
      OR r.general_access = 'workspace'
      OR (r.general_access = 'link' AND EXISTS (SELECT 1 FROM folio_visits v WHERE v.user_id = ? AND (v.folio_id = f.id OR v.folio_id = f.acl_root))))`,
    binds: [json(keys), json(spaceIds), userId],
  };
}

/** Whether every member of the workspace can read a folio (events and the inbox carry its title only then). */
export async function workspaceReadable(db: D1Database, folioId: string): Promise<boolean> {
  const row = (await foliosById(db, [folioId])).get(folioId);
  if (!row) return false;
  const found = await ancestry(db, [row]);
  const chain = aclChain(row.id, found.nodes);
  const root = chain[chain.length - 1];
  let space = null;
  if (root?.space_id) {
    const s = await db.prepare("SELECT kind, team, default_role FROM spaces WHERE id = ?").bind(root.space_id).first<{ kind: "workspace" | "team" | "private"; team: string | null; default_role: DocRole | null }>();
    if (s) space = { ...s, members: [] };
  }
  return folioReadableByWorkspace(chain, space);
}

/** The index scope of each of these folios (src/access.ts `folioScope`). */
export async function scopesOf(db: D1Database, rows: readonly FolioRow[]): Promise<Map<string, string>> {
  const found = await ancestry(db, rows);
  return new Map(rows.map((r) => [r.id, folioScope(aclChain(r.id, found.nodes), found.grants)]));
}

/**
 * A subtree: the folio and everything under it, by its path. (A prefix
 * compare, not LIKE: D1 refuses LIKE patterns over 50 bytes, which a
 * path two deep already is.)
 */
export async function subtree(db: D1Database, root: Pick<FolioRow, "path" | "workspace_id">): Promise<FolioRow[]> {
  return (
    await db
      .prepare(`SELECT ${FOLIO_COLUMNS} FROM folios WHERE workspace_id = ? AND substr(path, 1, ?) = ? ORDER BY length(path)`)
      .bind(root.workspace_id, root.path.length, root.path)
      .all<FolioRow>()
  ).results;
}

/**
 * Brings a subtree up to date after a move, a restriction, a grant or an
 * ownership change: each folio's space (its top's), `acl_root` and `path`
 * from its parent down, then its `folio_access` rows. `rootId`'s own
 * parent (and space, when it has a parent) must already be set. Returns
 * the subtree's ids, top first.
 */
export async function rebuildSubtree(db: D1Database, rootId: string): Promise<string[]> {
  const root = (await foliosById(db, [rootId])).get(rootId);
  if (!root) return [];
  const below = await subtree(db, root);
  const parent = root.parent_id ? ((await foliosById(db, [root.parent_id])).get(root.parent_id) ?? null) : null;
  // Top down: each child's place follows its parent's new one.
  const next = new Map<string, { space_id: string | null; acl_root: string; path: string }>();
  const placeOf = (row: FolioRow, up: { space_id: string | null; acl_root: string; path: string } | null) => ({
    space_id: up ? up.space_id : row.space_id,
    acl_root: aclRootOf({ id: row.id, inherit: !!row.inherit, parent_id: row.parent_id }, up?.acl_root ?? null),
    path: folioPathOf(row.id, up?.path ?? null),
  });
  const byParent = new Map<string, FolioRow[]>();
  for (const r of below) if (r.id !== root.id && r.parent_id) byParent.set(r.parent_id, [...(byParent.get(r.parent_id) ?? []), r]);
  const queue: FolioRow[] = [root];
  next.set(root.id, placeOf(root, parent ? { space_id: parent.space_id, acl_root: parent.acl_root, path: parent.path } : null));
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!;
    for (const child of byParent.get(at.id) ?? []) {
      next.set(child.id, placeOf(child, next.get(at.id)!));
      queue.push(child);
    }
  }
  const ids = queue.map((r) => r.id);
  const statements: D1PreparedStatement[] = [];
  for (const row of queue) {
    const place = next.get(row.id)!;
    if (place.space_id !== row.space_id || place.acl_root !== row.acl_root || place.path !== row.path) {
      statements.push(db.prepare("UPDATE folios SET space_id = ?, acl_root = ?, path = ? WHERE id = ?").bind(place.space_id, place.acl_root, place.path, row.id));
      Object.assign(row, place);
    }
  }
  await runBatches(db, statements);
  await rematerialize(db, queue);
  return ids;
}

/** Rewrites `folio_access` for these folios (their places already right). */
export async function rematerialize(db: D1Database, rows: FolioRow[]): Promise<void> {
  if (!rows.length) return;
  const found = await ancestry(db, rows);
  // The rows given win over what was read: they hold the places just written.
  for (const r of rows) {
    found.rows.set(r.id, r);
    found.nodes.set(r.id, aclNode(r));
  }
  const access = materialize(
    rows.map((r) => r.id),
    found.nodes,
    found.grants,
  );
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    statements.push(db.prepare("DELETE FROM folio_access WHERE folio_id IN (SELECT value FROM json_each(?))").bind(json(rows.slice(i, i + 500).map((r) => r.id))));
  }
  for (const a of access) {
    statements.push(db.prepare("INSERT OR REPLACE INTO folio_access (folio_id, principal, role, via, since) VALUES (?, ?, ?, ?, ?)").bind(a.folio_id, a.principal, a.role, a.via, a.since));
  }
  await runBatches(db, statements);
}
