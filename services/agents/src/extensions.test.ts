import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { ExtensionManifest } from "@g1t/contracts";
import { FIRST_PARTY_EXTENSIONS } from "@g1t/contracts/marketplace";

import { type Catalog, extensionIdOf, install, listInstalls, setBudget, setEnabled, uninstall } from "./extensions.ts";
import { findListing } from "./installs.ts";

/** D1, as far as installs use it, over node's SQLite with the service's migrations. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    run: async () => db.prepare(sql).run(...(params as never[])),
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const standup: ExtensionManifest = { ...FIRST_PARTY_EXTENSIONS[0]!, id: "standup", name: "Standup", status: "available", source: { repo: "flagon-io/standup", tag: "v1.2.0" }, version: "1.2.0" };
const catalog: Catalog = (id) => (id === "standup" ? standup : FIRST_PARTY_EXTENSIONS.find((e) => e.id === id));
const ws = "wsp_acme";
const at = new Date("2026-10-10T12:00:00.000Z");

test("a published extension installs at its version, on the free plan, switched on", async () => {
  const db = fakeD1();
  const done = await install(db, catalog, ws, "ins_1", "standup", "chase", at);
  assert.ok(done.ok);
  assert.deepEqual(
    { listing: done.value.listing, version: done.value.version, plan: done.value.plan, enabled: done.value.enabled, by: done.value.installed_by },
    { listing: "extension:standup", version: "1.2.0", plan: "free", enabled: true, by: "chase" },
  );
  const again = await install(db, catalog, ws, "ins_2", "standup", "chase", at);
  assert.equal(!again.ok && again.error.code, "conflict");
  assert.deepEqual((await listInstalls(db, ws)).map((i) => i.listing), ["extension:standup"]);
  assert.deepEqual(await listInstalls(db, "wsp_other"), []);
});

test("nothing unpublished installs", async () => {
  const db = fakeD1();
  const support = await install(db, catalog, ws, "ins_1", "support", "chase", at);
  assert.equal(!support.ok && support.error.code, "invalid");
  assert.match(!support.ok ? support.error.message : "", /isn't published yet/);
  const missing = await install(db, catalog, ws, "ins_2", "nope", "chase", at);
  assert.equal(!missing.ok && missing.error.code, "not_found");
  // Nor can members ask for what can't be installed.
  assert.equal(findListing("extension:support"), null);
});

test("the kill switch turns an install off at once, and back on", async () => {
  const db = fakeD1();
  await install(db, catalog, ws, "ins_1", "standup", "chase", at);
  const off = await setEnabled(db, ws, "extension:standup", false, "dee", at);
  assert.ok(off.ok);
  assert.equal(off.value.enabled, false);
  assert.equal(off.value.disabled_by, "dee");
  const on = await setEnabled(db, ws, "extension:standup", true, "chase", at);
  assert.ok(on.ok);
  assert.equal(on.value.enabled, true);
  assert.equal(on.value.disabled_by, null);
  const missing = await setEnabled(db, ws, "extension:other", false, "dee", at);
  assert.equal(!missing.ok && missing.error.code, "not_found");
});

test("an install has a budget, and uninstalling keeps the record", async () => {
  const db = fakeD1();
  await install(db, catalog, ws, "ins_1", "standup", "chase", at);
  const capped = await setBudget(db, ws, "extension:standup", 25_000_000);
  assert.ok(capped.ok);
  assert.equal(capped.value.budget_monthly_micros, 25_000_000);
  assert.equal((await setBudget(db, ws, "extension:standup", -1)).ok, false);
  assert.ok((await uninstall(db, ws, "extension:standup", "chase", at)).ok);
  assert.deepEqual(await listInstalls(db, ws), []);
  assert.equal((await uninstall(db, ws, "extension:standup", "chase", at)).ok, false);
  // Installed again, it is a new install.
  assert.ok((await install(db, catalog, ws, "ins_2", "standup", "chase", at)).ok);
});

test("extension references", () => {
  assert.equal(extensionIdOf("extension:standup"), "standup");
  assert.equal(extensionIdOf("integration:sentry"), null);
});
