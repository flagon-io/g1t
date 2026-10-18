import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { Space } from "../who.ts";
import { deleteSpaceRows, eraseFolios, landingFor } from "./trash.ts";

/** D1, as far as the trash uses it, over node's SQLite with the service's migrations. */
function fakeD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  db.exec("PRAGMA foreign_keys = OFF");
  type Statement = { sql: string; params: unknown[] };
  const statement = (sql: string, params: unknown[] = []): Statement & Record<string, unknown> => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    run: async () => db.prepare(sql).run(...(params as never[])),
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  return {
    raw: db,
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Statement[]) => statements.map((s) => db.prepare(s.sql).run(...(s.params as never[]))),
  } as unknown as D1Database & { raw: DatabaseSync };
}

const AT = "2026-10-11T12:00:00.000Z";

function space(db: DatabaseSync, id: string, over: Partial<{ slug: string; is_default: number; archived_at: string | null; deleted_at: string | null }> = {}) {
  db.prepare(
    "INSERT INTO spaces (id, workspace_id, slug, name, kind, default_role, is_default, created_by, created_at, archived_at, deleted_at) VALUES (?, 'wsp_1', ?, ?, 'workspace', 'edit', ?, 'user:ana', ?, ?, ?)",
  ).run(id, over.slug ?? id, id, over.is_default ?? 0, AT, over.archived_at ?? null, over.deleted_at ?? null);
}

function folio(
  db: DatabaseSync,
  id: string,
  over: Partial<{ space_id: string | null; parent_id: string | null; path: string; trashed_at: string | null }> = {},
) {
  const path = over.path ?? `/${id}/`;
  db.prepare(
    "INSERT INTO folios (id, workspace_id, kind, title, owner, space_id, parent_id, position, acl_root, path, created_by, created_at, updated_at, edited_at, trashed_at) VALUES (?, 'wsp_1', 'doc', ?, 'user:ana', ?, ?, 1, ?, ?, 'user:ana', ?, ?, ?, ?)",
  ).run(id, id, over.space_id ?? null, over.parent_id ?? null, path.split("/").filter(Boolean)[0]!, path, AT, AT, AT, over.trashed_at ?? null);
  db.prepare("INSERT INTO folios_fts (folio_id, kind, title, body) VALUES (?, 'doc', ?, '')").run(id, id);
}

const ids = (db: DatabaseSync, sql: string) => (db.prepare(sql).all() as { id: string }[]).map((r) => r.id).sort();

test("erasing folios takes their rows and search rows, deepest first, and leaves the rest", async () => {
  const d1 = fakeD1();
  const db = d1.raw;
  folio(db, "top", { trashed_at: AT });
  folio(db, "kid", { parent_id: "top", path: "/top/kid/", trashed_at: AT });
  folio(db, "grandkid", { parent_id: "kid", path: "/top/kid/grandkid/", trashed_at: AT });
  folio(db, "other");
  const gone = await eraseFolios({ DB: d1 }, [
    { id: "top", path: "/top/" },
    { id: "kid", path: "/top/kid/" },
    { id: "grandkid", path: "/top/kid/grandkid/" },
    // Asked twice: goes once.
    { id: "kid", path: "/top/kid/" },
  ]);
  assert.deepEqual(gone, ["grandkid", "kid", "top"]);
  assert.deepEqual(ids(db, "SELECT id FROM folios"), ["other"]);
  assert.deepEqual(ids(db, "SELECT folio_id AS id FROM folios_fts"), ["other"]);
});

test("a child still alive under an erased folio goes to the top of where it was", async () => {
  const d1 = fakeD1();
  const db = d1.raw;
  folio(db, "top", { trashed_at: AT });
  folio(db, "alive", { parent_id: "top", path: "/top/alive/" });
  await eraseFolios({ DB: d1 }, [{ id: "top", path: "/top/" }]);
  const alive = db.prepare("SELECT parent_id FROM folios WHERE id = 'alive'").get() as { parent_id: string | null };
  assert.equal(alive.parent_id, null);
});

test("erasing nothing does nothing", async () => {
  const d1 = fakeD1();
  folio(d1.raw, "a");
  assert.deepEqual(await eraseFolios({ DB: d1 }, []), []);
  assert.deepEqual(ids(d1.raw, "SELECT id FROM folios"), ["a"]);
});

test("deleting a space trashes what is in it together, frees its address and keeps its row marked", async () => {
  const d1 = fakeD1();
  const db = d1.raw;
  space(db, "spc_eng", { slug: "engineering" });
  space(db, "spc_other", { slug: "other" });
  folio(db, "a", { space_id: "spc_eng" });
  folio(db, "b", { space_id: "spc_eng", parent_id: "a", path: "/a/b/" });
  folio(db, "old", { space_id: "spc_eng", trashed_at: "2026-10-01T00:00:00.000Z" });
  folio(db, "elsewhere", { space_id: "spc_other" });
  folio(db, "private");
  db.prepare("INSERT INTO space_joins (space_id, user_id, position, joined_at) VALUES ('spc_eng', 'bo', 1, ?), ('spc_other', 'bo', 2, ?)").run(AT, AT);
  const trashed = await deleteSpaceRows(d1, { id: "spc_eng", slug: "engineering" }, AT, "user:ana");
  assert.deepEqual(trashed.sort(), ["a", "b"]);
  // Together: one trashed_at, so each top restores the whole of what went with it.
  assert.deepEqual(ids(db, `SELECT id FROM folios WHERE trashed_at = '${AT}' AND trashed_by = 'user:ana'`), ["a", "b"]);
  // What was already in the trash keeps its own time; other spaces and Private are untouched.
  assert.equal((db.prepare("SELECT trashed_at FROM folios WHERE id = 'old'").get() as { trashed_at: string }).trashed_at, "2026-10-01T00:00:00.000Z");
  assert.deepEqual(ids(db, "SELECT id FROM folios WHERE trashed_at IS NULL"), ["elsewhere", "private"]);
  // The row stays, marked, its address freed; the other space's joins stay.
  const row = db.prepare("SELECT slug, deleted_at, deleted_by FROM spaces WHERE id = 'spc_eng'").get() as {
    slug: string;
    deleted_at: string;
    deleted_by: string;
  };
  assert.deepEqual({ ...row }, { slug: "engineering~spc_eng", deleted_at: AT, deleted_by: "user:ana" });
  assert.deepEqual(ids(db, "SELECT space_id AS id FROM space_joins"), ["spc_other"]);
  // A new space takes the address.
  space(db, "spc_new", { slug: "engineering" });
  assert.deepEqual(ids(db, "SELECT id FROM spaces WHERE slug = 'engineering'"), ["spc_new"]);
});

test("a deleted General is still the workspace's default row, so it is never made again", async () => {
  const d1 = fakeD1();
  const db = d1.raw;
  space(db, "spc_general", { slug: "general", is_default: 1 });
  await deleteSpaceRows(d1, { id: "spc_general", slug: "general" }, AT, "user:ana");
  // What ensureDefault asks (src/who.ts, src/index.ts).
  const found = db.prepare("SELECT id FROM spaces WHERE workspace_id = 'wsp_1' AND is_default = 1").get() as { id: string } | undefined;
  assert.equal(found?.id, "spc_general");
  // And no second default can be made: the one-default index holds.
  assert.throws(() => space(db, "spc_again", { slug: "general", is_default: 1 }));
  // Deleting it again changes nothing.
  assert.deepEqual(await deleteSpaceRows(d1, { id: "spc_general", slug: "general~spc_general" }, "2026-10-12T00:00:00.000Z", "user:bo"), []);
  assert.equal((db.prepare("SELECT deleted_at FROM spaces WHERE id = 'spc_general'").get() as { deleted_at: string }).deleted_at, AT);
});

function aSpace(over: Partial<Space["row"]> & { role?: Space["role"] }): Space {
  const { role = "edit", ...row } = over;
  return {
    row: {
      id: "spc",
      workspace_id: "wsp_1",
      slug: "spc",
      name: "Space",
      description: null,
      icon: null,
      kind: "workspace",
      team: null,
      default_role: "edit",
      agent_mode: "suggest",
      editors_can_share: 0,
      is_default: 0,
      created_by: "user:ana",
      created_at: AT,
      archived_at: null,
      deleted_at: null,
      deleted_by: null,
      ...row,
    },
    members: [],
    projects: [],
    role,
  };
}

test("a folio restored from a deleted space lands in General when it is live and the restorer may add to it", () => {
  const general = aSpace({ id: "spc_general", is_default: 1 });
  assert.equal(landingFor([aSpace({ id: "spc_gone", deleted_at: AT }), general])?.row.id, "spc_general");
  // No General, an archived or deleted one, or one they can only read: its owner's Private.
  assert.equal(landingFor([aSpace({ id: "spc_other" })]), null);
  assert.equal(landingFor([aSpace({ id: "spc_general", is_default: 1, archived_at: AT })]), null);
  assert.equal(landingFor([aSpace({ id: "spc_general", is_default: 1, deleted_at: AT })]), null);
  assert.equal(landingFor([aSpace({ id: "spc_general", is_default: 1, role: "view" })]), null);
  assert.equal(landingFor([]), null);
});
