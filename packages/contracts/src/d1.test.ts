import assert from "node:assert/strict";
import { test } from "node:test";

import { openD1, sessionConstraint, timedD1, type D1Timing } from "./d1.ts";

/** A binding that answers every query after a tick, and remembers what batch was given. */
function fakeDb() {
  const given: object[][] = [];
  const statement = (query: string, binds: unknown[] = []) => ({
    query,
    binds,
    bind: (...args: unknown[]) => statement(query, args),
    all: async () => ({ results: [{ query, binds }] }),
    first: async () => ({ query, binds }),
    run: async () => ({ success: true }),
    raw: async () => [[query]],
  });
  const db = {
    prepare: (query: string) => statement(query),
    batch: async (statements: object[]) => {
      given.push(statements);
      return statements.map(() => ({ success: true }));
    },
    withSession: (constraint?: string) => ({ ...db, constraint, getBookmark: () => "bm-1" }),
  };
  return { db, given };
}

test("timedD1 counts each statement's trip and each batch, and keeps bindings", async () => {
  const { db, given } = fakeDb();
  const timing: D1Timing = { trips: 0, ms: 0 };
  const timed = timedD1(db, timing);
  const first = await timed.prepare("SELECT ?").bind(1).first();
  assert.deepEqual(first, { query: "SELECT ?", binds: [1] });
  await timed.prepare("SELECT 2").all();
  await timed.prepare("UPDATE t").run();
  await timed.prepare("SELECT 3").raw();
  assert.equal(timing.trips, 4);
  const a = timed.prepare("A").bind("x");
  const b = timed.prepare("B");
  await timed.batch([a, b]);
  assert.equal(timing.trips, 5, "a batch is one trip however many statements it carries");
  // The binding got its own statements back, not the counting wrappers.
  assert.equal(given.length, 1);
  assert.deepEqual(
    given[0]!.map((s) => (s as { query: string; binds: unknown[] }).query),
    ["A", "B"],
  );
  assert.deepEqual((given[0]![0] as { binds: unknown[] }).binds, ["x"]);
  assert.ok(timing.ms >= 0);
});

test("openD1 reports the service time, the database time and the bookmark", async () => {
  const { db } = fakeDb();
  const opened = openD1(db, new Request("https://service/rpc/x", { headers: { "x-d1-bookmark": "first-unconstrained" } }));
  await opened.db.prepare("SELECT 1").all();
  await opened.db.prepare("SELECT 2").all();
  const answered = opened.finish(Response.json({ ok: true }));
  const timing = answered.headers.get("server-timing") ?? "";
  assert.match(timing, /^svc;dur=\d+;desc="session", db;dur=\d+;desc="2 round trips"$/);
  assert.equal(answered.headers.get("x-d1-bookmark"), "bm-1");
  assert.deepEqual(await answered.json(), { ok: true });
});

test("openD1 without a session reads the primary and says so, with no db metric when nothing was read", async () => {
  const { db } = fakeDb();
  const opened = openD1(db, new Request("https://service/rpc/x"));
  const answered = opened.finish(new Response("ok"));
  assert.equal(answered.headers.get("server-timing"), `svc;dur=${/\d+/.exec(answered.headers.get("server-timing") ?? "")?.[0]};desc="primary"`);
  assert.equal(answered.headers.get("x-d1-bookmark"), null);
});

test("sessionConstraint takes the two first-* words and a bookmark, and starts anything else on the primary", () => {
  assert.equal(sessionConstraint(null), null);
  assert.equal(sessionConstraint("first-primary"), "first-primary");
  assert.equal(sessionConstraint("first-unconstrained"), "first-unconstrained");
  assert.equal(sessionConstraint("0000abc-DEF"), "0000abc-DEF");
  assert.equal(sessionConstraint("not a bookmark!"), "first-primary");
});
