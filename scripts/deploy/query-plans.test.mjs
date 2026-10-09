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

test("chat: a channel's messages and a thread's replies, newest first, page by page", () => {
  const db = migrated("chat");
  // The first page passes `~` as the cursor, so both read as a range.
  const top = plan(
    db,
    `SELECT * FROM messages WHERE channel_id = ?1 AND thread_root IS NULL AND id < ?2
       AND (deleted_at IS NULL OR reply_count > 0) ORDER BY id DESC LIMIT ?3`,
    "chn_1",
    "~",
    51,
  );
  assertSearches(top, "messages_by_channel");
  assert.ok(!top.some((step) => step.includes("TEMP B-TREE")), top.join("\n"));
  const thread = plan(db, "SELECT * FROM messages WHERE thread_root = ?1 AND channel_id = ?2 AND id < ?3 ORDER BY id DESC LIMIT ?4", "msg_1", "chn_1", "~", 51);
  assertSearches(thread, "messages_by_thread");
});

test("chat: the sidebar's unread messages are read from each channel's index, after the last read", () => {
  const steps = plan(
    migrated("chat"),
    `SELECT msg.channel_id, msg.id, msg.author, msg.mentions
     FROM channel_members m
     JOIN channels c ON c.id = m.channel_id
     JOIN messages msg ON msg.channel_id = m.channel_id AND msg.id > COALESCE(m.last_read_id, '')
     WHERE m.principal = ?1 AND c.workspace_id = ?2 AND c.archived_at IS NULL
       AND msg.deleted_at IS NULL AND msg.author != ?1
     LIMIT 5000`,
    "user:usr_1",
    "wsp_1",
  );
  assertSearches(steps, "channel_members_by_principal");
  assert.ok(steps.some((step) => step.includes("messages_by_channel (channel_id=? AND id>?)")), steps.join("\n"));
});
