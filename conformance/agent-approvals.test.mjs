import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// The integrations service's statements on calls of hosted sessions that wait
// for approval (services/integrations/src/agent_sessions.rs), run on SQLite
// against its migrations.
const source = readFileSync(new URL("../services/integrations/src/agent_sessions.rs", import.meta.url), "utf8");
const sql = (name) => source.match(new RegExp(`const ${name}: &str = "([\\s\\S]*?)";`))[1];

function database() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../services/integrations/migrations/", import.meta.url);
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(name, dir), "utf8"));
  return db;
}

/** A time on one morning, by minute past noon, in g1t's RFC 3339. */
const at = (minute) => `2026-10-21T12:${String(minute).padStart(2, "0")}:00.000Z`;
const keep = (db, session, call, minute, workspace = "acme") =>
  db.prepare(sql("KEEP_WAITING")).get(session, call, workspace, `${workspace}/web`, 4, "usr_a", "ada", "bash", "bash: npm install", at(minute));
/** An answer at `minute`; `cutoff` is ten minutes before then, as the service passes it. */
const answer = (db, session, call, status, minute, cutoff) => db.prepare(sql("TAKE_ANSWER")).get(status, "bea", at(minute), session, call, at(cutoff));
const status = (db, session, call) => db.prepare(sql("APPROVAL")).get(session, call)?.status;

test("a call is kept once, and seeing it again changes nothing, answered or not", () => {
  const db = database();
  // It names the call only when kept just now: its starter is told once.
  assert.deepEqual({ ...keep(db, "ses_1", "sevt_1", 5) }, { tool_use_id: "sevt_1" });
  assert.equal(keep(db, "ses_1", "sevt_1", 6), undefined, "seen again: nobody is told again");
  assert.equal(answer(db, "ses_1", "sevt_1", "allowed", 6, 0).status, "allowed");
  assert.equal(keep(db, "ses_1", "sevt_1", 9), undefined);
  const row = db.prepare(sql("APPROVAL")).get("ses_1", "sevt_1");
  assert.deepEqual([row.status, row.answered_by, row.asked_at], ["allowed", "bea", at(5)]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_approvals").get().n, 1);
  db.close();
});

test("of two answers at once only one is taken, and none once its time is up", () => {
  const db = database();
  keep(db, "ses_1", "sevt_1", 5);
  assert.equal(answer(db, "ses_1", "sevt_1", "allowed", 6, 0).status, "allowed");
  assert.equal(answer(db, "ses_1", "sevt_1", "denied", 6, 0), undefined, "someone answered first");
  assert.equal(status(db, "ses_1", "sevt_1"), "allowed");
  // Asked at :05 and answered at :15: the cutoff (:05) is not before it was asked.
  keep(db, "ses_1", "sevt_2", 5);
  assert.equal(answer(db, "ses_1", "sevt_2", "allowed", 15, 5), undefined);
  assert.equal(status(db, "ses_1", "sevt_2"), "waiting");
  db.close();
});

test("an unanswered call is declined once its time is up, and then cannot be answered or put back", () => {
  const db = database();
  keep(db, "ses_1", "sevt_old", 0);
  keep(db, "ses_1", "sevt_new", 8);
  keep(db, "ses_1", "sevt_done", 1);
  answer(db, "ses_1", "sevt_done", "denied", 2, 0);
  // At :11, the cutoff is :01: what was asked at or before it is due.
  const taken = db.prepare(sql("TAKE_UNANSWERED")).all(at(11), "ses_1", at(1));
  assert.deepEqual(
    taken.map((row) => row.tool_use_id),
    ["sevt_old"],
  );
  assert.equal(status(db, "ses_1", "sevt_old"), "expired");
  assert.equal(status(db, "ses_1", "sevt_done"), "denied", "an answered call is left as it was");
  assert.equal(status(db, "ses_1", "sevt_new"), "waiting");
  assert.equal(answer(db, "ses_1", "sevt_old", "allowed", 9, 0), undefined, "a declined call cannot be answered");
  db.prepare(sql("UNTAKE_ANSWER")).run("ses_1", "sevt_old");
  assert.equal(status(db, "ses_1", "sevt_old"), "expired", "putting an answer back never brings a declined call back");
  assert.deepEqual(db.prepare(sql("TAKE_UNANSWERED")).all(at(11), "ses_1", at(1)), [], "a call is declined once");
  db.close();
});

test("an answer that did not reach the session is put back to wait again", () => {
  const db = database();
  keep(db, "ses_1", "sevt_1", 5);
  answer(db, "ses_1", "sevt_1", "allowed", 6, 0);
  db.prepare(sql("UNTAKE_ANSWER")).run("ses_1", "sevt_1");
  const row = db.prepare(sql("APPROVAL")).get("ses_1", "sevt_1");
  assert.deepEqual([row.status, row.answered_by, row.answered_at], ["waiting", null, null]);
  db.close();
});

test("a session that ends leaves nothing waiting", () => {
  const db = database();
  keep(db, "ses_1", "sevt_1", 5);
  keep(db, "ses_2", "sevt_2", 5);
  keep(db, "ses_1", "sevt_3", 5);
  answer(db, "ses_1", "sevt_3", "allowed", 5, 0);
  // It names what it ended, so whoever started the session is told it no longer waits.
  assert.deepEqual(
    db
      .prepare(sql("END_WAITING"))
      .all(at(6), "ses_1")
      .map((row) => row.tool_use_id),
    ["sevt_1"],
  );
  assert.equal(status(db, "ses_1", "sevt_1"), "ended");
  assert.equal(status(db, "ses_1", "sevt_3"), "allowed");
  assert.deepEqual(db.prepare(sql("END_WAITING")).all(at(7), "ses_1"), [], "nothing is ended twice");
  assert.equal(status(db, "ses_2", "sevt_2"), "waiting");
  assert.equal(answer(db, "ses_1", "sevt_1", "allowed", 7, 0), undefined);
  db.close();
});

test("the waiting calls are listed by workspace or session, newest first, only those still in time", () => {
  const db = database();
  keep(db, "ses_1", "sevt_a", 1);
  keep(db, "ses_1", "sevt_b", 7);
  keep(db, "ses_2", "sevt_c", 5);
  keep(db, "ses_3", "sevt_d", 6, "other");
  keep(db, "ses_1", "sevt_e", 8);
  answer(db, "ses_1", "sevt_e", "allowed", 9, 0);
  const ids = (rows) => rows.map((row) => row.tool_use_id);
  assert.deepEqual(ids(db.prepare(sql("WAITING_IN_WORKSPACE")).all("acme", at(2), 100)), ["sevt_b", "sevt_c"]);
  assert.deepEqual(ids(db.prepare(sql("WAITING_IN_SESSION")).all("acme", "ses_1", at(0), 100)), ["sevt_b", "sevt_a"]);
  assert.deepEqual(ids(db.prepare(sql("WAITING_IN_SESSION")).all("acme", "ses_3", at(0), 100)), [], "another workspace's session is not listed");
  db.close();
});
