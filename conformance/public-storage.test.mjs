import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const source = readFileSync(new URL("../services/repos/src/public_storage.rs", import.meta.url), "utf8");
const sql = name => source.match(new RegExp(`const ${name}: &str = "([\\s\\S]*?)";`))[1];
function database() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../services/repos/migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, dir), "utf8"));
  return db;
}
function repo(db, id, bytes, workspace = "team", privateRepo = 0) {
  db.prepare("INSERT INTO repos(id,namespace,name,owner_id,stored_bytes,is_private,created_at) VALUES (?,?,?,'owner',?,?,'2026-10-14T00:00:00Z')")
    .run(id, workspace, id, bytes, privateRepo);
}
const reserve = (db, id, bytes, cap = 5_000_000_000) => db.prepare(sql("RESERVE")).get({ 1: id, 2: bytes, 3: cap });

test("overlapping pushes cannot reserve the same final capacity", () => {
  const db = database();
  repo(db, "first", 4_900_000_000); repo(db, "second", 0);
  assert.ok(reserve(db, "first", 80_000_000));
  assert.equal(reserve(db, "second", 80_000_000), undefined);
  assert.ok(reserve(db, "second", 20_000_000));
  assert.equal(reserve(db, "first", 1), undefined);
  assert.equal(db.prepare("SELECT SUM(stored_bytes + storage_reserved_bytes) n FROM repos").get().n, 5_000_000_000);
  assert.equal(db.prepare("SELECT SUM(stored_bytes) n FROM repos").get().n, 4_900_000_000, "reservations are not measured storage billed to customers");
  db.close();
});

test("deleted retained data and interrupted write reservations still consume capacity", () => {
  const db = database();
  repo(db, "retained", 4_950_000_000); repo(db, "active", 0);
  db.exec("UPDATE repos SET deleted_at = '2026-10-14T00:00:00Z' WHERE id = 'retained'");
  assert.ok(reserve(db, "active", 50_000_000));
  assert.equal(reserve(db, "active", 1), undefined);
  db.exec("DELETE FROM repos WHERE id = 'retained'");
  assert.ok(reserve(db, "active", 1));
  db.close();
});

test("concurrent visibility changes cannot bypass public capacity", () => {
  const db = database();
  repo(db, "public", 4_000_000_000); repo(db, "private_a", 750_000_000, "team", 1); repo(db, "private_b", 750_000_000, "team", 1);
  assert.ok(db.prepare(sql("MAKE_PUBLIC")).get({ 1: "private_a", 2: 5_000_000_000 }));
  assert.equal(db.prepare(sql("MAKE_PUBLIC")).get({ 1: "private_b", 2: 5_000_000_000 }), undefined);
  assert.ok(reserve(db, "private_b", 100_000_000));
  assert.equal(db.prepare("SELECT is_private FROM repos WHERE id='private_b'").get().is_private, 1);
  db.close();
});

test("transfer admission uses destination capacity at the moment of mutation", () => {
  const db = database();
  repo(db, "existing", 4_500_000_000, "destination"); repo(db, "moving", 600_000_000);
  assert.equal(db.prepare(sql("TRANSFER")).get({ 1: "moving", 2: "destination", 3: "team", 4: 5_000_000_000 }), undefined);
  assert.equal(db.prepare("SELECT namespace FROM repos WHERE id='moving'").get().namespace, "team");
  db.exec("DELETE FROM repos WHERE id='existing'");
  assert.ok(db.prepare(sql("TRANSFER")).get({ 1: "moving", 2: "destination", 3: "team", 4: 5_000_000_000 }));
  db.close();
});

test("native copy freezes new source writes until its storage snapshot is taken", () => {
  const db = database();
  repo(db, "source", 100); repo(db, "fork", 0);
  db.exec("INSERT INTO storage_copy_locks VALUES ('source','fork','2026-10-14T00:00:00Z')");
  assert.equal(reserve(db, "source", 20), undefined);
  assert.ok(reserve(db, "fork", 100));
  db.exec("DELETE FROM storage_copy_locks WHERE repo_id='source'");
  assert.ok(reserve(db, "source", 20));
  db.close();
});
