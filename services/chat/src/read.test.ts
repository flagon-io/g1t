import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { G1T_KEY } from "@g1t/contracts/chat";

import { markReadUpTo } from "./read.ts";
import { tally } from "./unread.ts";

/** D1, as far as the read mark uses it, over node's SQLite with chat's migrations. */
function fakeD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, params: unknown[] = []): Record<string, unknown> => ({
    bind: (...values: unknown[]) => statement(sql, values),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) }, results: [] }),
  });
  return { raw: db, prepare: (sql: string) => statement(sql) } as unknown as D1Database & { raw: DatabaseSync };
}

const AT = "2026-10-20T12:00:00.000Z";
const ANA = "user:u_ana";

/** Ana's direct message with g1t: her question (msg_01) and g1t's answer (msg_02), unread from msg_00 on. */
function dm() {
  const d1 = fakeD1();
  d1.raw
    .prepare("INSERT INTO channels (id, workspace_id, kind, name, created_by, created_at, last_message_at) VALUES ('chn_dm', 'wsp_1', 'dm', NULL, ?, ?, ?)")
    .run(ANA, AT, AT);
  for (const principal of [ANA, G1T_KEY])
    d1.raw.prepare("INSERT INTO channel_members (channel_id, principal, last_read_id, joined_at) VALUES ('chn_dm', ?, 'msg_00', ?)").run(principal, AT);
  for (const [id, author] of [
    ["msg_01", ANA],
    ["msg_02", G1T_KEY],
  ])
    d1.raw.prepare("INSERT INTO messages (id, channel_id, author, body, created_at) VALUES (?, 'chn_dm', ?, 'text', ?)").run(id, author, AT);
  return d1;
}

const mark = (d1: ReturnType<typeof dm>) =>
  (d1.raw.prepare("SELECT last_read_id FROM channel_members WHERE channel_id = 'chn_dm' AND principal = ?").get(ANA) as { last_read_id: string }).last_read_id;

const unread = (d1: ReturnType<typeof dm>) => {
  const rows = d1.raw.prepare("SELECT channel_id, id, author, NULL AS mentions FROM messages WHERE id > ?").all(mark(d1)) as never[];
  return tally(rows, ANA, "ana", new Map([["chn_dm", mark(d1)]])).get("chn_dm")?.unread ?? 0;
};

test("a read from any surface (Home's Summarize, the Ask panel, Chat) moves the read mark, and the answer is no longer unread", async () => {
  const d1 = dm();
  assert.equal(unread(d1), 1, "g1t's answer is unread; Ana's own question is not");
  assert.equal(await markReadUpTo(d1, "chn_dm", ANA, "msg_02"), true);
  assert.equal(mark(d1), "msg_02");
  assert.equal(unread(d1), 0);
});

test("the read mark only moves forward, and says when it did not move", async () => {
  const d1 = dm();
  await markReadUpTo(d1, "chn_dm", ANA, "msg_02");
  assert.equal(await markReadUpTo(d1, "chn_dm", ANA, "msg_01"), false, "an older surface reading late does not mark the answer unread");
  assert.equal(await markReadUpTo(d1, "chn_dm", ANA, "msg_02"), false, "the same read twice is told once");
  assert.equal(mark(d1), "msg_02");
});

test("a read marks only the reader's own place", async () => {
  const d1 = dm();
  assert.equal(await markReadUpTo(d1, "chn_dm", "user:u_ben", "msg_02"), false, "not a member: nothing moves");
  await markReadUpTo(d1, "chn_dm", ANA, "msg_02");
  const g1t = d1.raw.prepare("SELECT last_read_id FROM channel_members WHERE principal = ?").get(G1T_KEY) as { last_read_id: string };
  assert.equal(g1t.last_read_id, "msg_00");
});
