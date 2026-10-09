// node --test "scripts/deploy/*.test.mjs"   (npm run test:deploy)
//
// The queries that run on a timer or on every page load, planned by SQLite
// against each service's migrations as they apply in order: each must be a
// search of an index, never a scan of the table. D1 is SQLite, so its
// planner chooses the same way.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { ROOT } from "./stack.mjs";

/** A database with every one of `service`'s migrations applied, in order. */
function migrated(service) {
  const db = new DatabaseSync(":memory:");
  const dir = join(ROOT, "services", service, "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf8"));
  }
  return db;
}

/** How SQLite would run `sql`, one line per step. */
function plan(db, sql, ...params) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail);
}

function assertSearches(steps, index) {
  assert.ok(
    steps.some((step) => step.includes(`INDEX ${index}`)),
    `expected a search of ${index}, planned:\n  ${steps.join("\n  ")}`,
  );
}

test("webhooks: the hourly purge deletes old deliveries by time", () => {
  const steps = plan(
    migrated("webhooks"),
    "DELETE FROM deliveries WHERE rowid IN (SELECT rowid FROM deliveries WHERE created_at < ? ORDER BY created_at LIMIT ?)",
    "2026-09-24T00:00:00.000Z",
    1000,
  );
  assertSearches(steps, "deliveries_by_time");
});

test("billing: this month's users are read from an index, not the ledger", () => {
  const steps = plan(
    migrated("billing"),
    "SELECT DISTINCT workspace FROM ledger WHERE kind = 'usage' AND created_at >= ?",
    "2026-10-01",
  );
  assertSearches(steps, "ledger_usage_by_time");
  assert.ok(steps.some((step) => step.includes("COVERING INDEX")), steps.join("\n"));
});

test("events: a repository's events of one type, newest first, page by page", () => {
  const db = migrated("events");
  const first = plan(db, "SELECT * FROM events WHERE repo_id = ? AND type IN (?) ORDER BY id DESC LIMIT ?", "rep_1", "git.push", 50);
  assertSearches(first, "events_repo_type");
  const next = plan(db, "SELECT * FROM events WHERE repo_id = ? AND type IN (?) AND id < ? ORDER BY id DESC LIMIT ?", "rep_1", "git.push", "evt_9", 200);
  assertSearches(next, "events_repo_type");
  // Read in order: no sort of every match.
  assert.ok(!next.some((step) => step.includes("TEMP B-TREE")), next.join("\n"));
});

test("actions: a self-hosted runner's poll finds queued jobs by namespace, whatever its case", () => {
  const steps = plan(
    migrated("actions"),
    `SELECT jobs.*, runs.repo AS run_repo FROM jobs JOIN runs ON runs.id = jobs.run_id
     WHERE jobs.status = 'queued' AND jobs.labels IS NOT NULL AND lower(jobs.namespace) = ?
     ORDER BY jobs.rowid LIMIT 50`,
    "acme",
  );
  assertSearches(steps, "jobs_self_hosted_lower");
});
