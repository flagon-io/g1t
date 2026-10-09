import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { REQUEST_EVERY_MS, claimAccessRequest } from "./requests.ts";

/** D1, as far as requests use it, over node's SQLite with the service's migrations. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  db.exec("PRAGMA foreign_keys = OFF");
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    run: async () => db.prepare(sql).run(...(params as never[])),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const at = new Date("2026-10-09T12:00:00.000Z");
const later = (ms: number) => new Date(at.getTime() + ms);

test("a person's first request for a folio goes", async () => {
  const db = fakeD1();
  assert.equal(await claimAccessRequest(db, "fol_a", "ana", at), true);
});

test("asking again within a day is refused, for that folio only", async () => {
  const db = fakeD1();
  await claimAccessRequest(db, "fol_a", "ana", at);
  assert.equal(await claimAccessRequest(db, "fol_a", "ana", later(60_000)), false);
  assert.equal(await claimAccessRequest(db, "fol_a", "ana", later(REQUEST_EVERY_MS - 1)), false);
  // Someone else, or another folio, is a request of its own.
  assert.equal(await claimAccessRequest(db, "fol_a", "bo", later(60_000)), true);
  assert.equal(await claimAccessRequest(db, "fol_b", "ana", later(60_000)), true);
});

test("a day later they may ask again, and the day starts over", async () => {
  const db = fakeD1();
  await claimAccessRequest(db, "fol_a", "ana", at);
  assert.equal(await claimAccessRequest(db, "fol_a", "ana", later(REQUEST_EVERY_MS)), true);
  assert.equal(await claimAccessRequest(db, "fol_a", "ana", later(REQUEST_EVERY_MS + 60_000)), false);
  assert.equal(await claimAccessRequest(db, "fol_a", "ana", later(2 * REQUEST_EVERY_MS)), true);
});

test("a refused press doesn't push the next allowed time back", async () => {
  const db = fakeD1();
  await claimAccessRequest(db, "fol_a", "ana", at);
  await claimAccessRequest(db, "fol_a", "ana", later(REQUEST_EVERY_MS - 1));
  assert.equal(await claimAccessRequest(db, "fol_a", "ana", later(REQUEST_EVERY_MS)), true);
});
