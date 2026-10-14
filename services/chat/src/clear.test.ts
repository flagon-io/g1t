import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { G1T_KEY } from "@g1t/contracts/chat";

import { clearConversation, mayClear } from "./clear.ts";
import { conversation, latestQuestion, type SaidRow } from "./g1t.ts";

/** D1, as far as a clear uses it, over node's SQLite with chat's migrations. */
function fakeD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  type Statement = { sql: string; params: unknown[] };
  const run = (s: Statement) => {
    const done = db.prepare(s.sql).run(...(s.params as never[]));
    return { success: true, meta: { changes: Number(done.changes) }, results: [] };
  };
  const statement = (sql: string, params: unknown[] = []): Statement & Record<string, unknown> => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    run: async () => run({ sql, params }),
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  return {
    raw: db,
    prepare: (sql: string) => statement(sql),
    // One transaction, as D1's batch is.
    batch: async (statements: Statement[]) => {
      db.exec("BEGIN");
      try {
        const results = statements.map(run);
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database & { raw: DatabaseSync };
}

const AT = "2026-10-14T12:00:00.000Z";
const ANA = "user:u_ana";
const BEN = "user:u_ben";

function channel(db: DatabaseSync, id: string, kind: "channel" | "dm", members: string[]) {
  db.prepare("INSERT INTO channels (id, workspace_id, kind, name, created_by, created_at, last_message_at) VALUES (?, 'wsp_1', ?, ?, ?, ?, ?)").run(
    id,
    kind,
    kind === "channel" ? id : null,
    members[0]!,
    AT,
    AT,
  );
  for (const principal of members) {
    db.prepare("INSERT INTO channel_members (channel_id, principal, last_read_id, joined_at) VALUES (?, ?, 'msg_9', ?)").run(id, principal, AT);
  }
}

function say(db: DatabaseSync, channelId: string, id: string, author: string, body: string, extra: { meta?: string; thread_root?: string; deleted?: boolean } = {}) {
  db.prepare("INSERT INTO messages (id, channel_id, author, body, thread_root, created_at, deleted_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    channelId,
    author,
    body,
    extra.thread_root ?? null,
    AT,
    extra.deleted ? AT : null,
    extra.meta ?? null,
  );
}

const answer = (text: string) => JSON.stringify({ answer: { state: "done", steps: [{ type: "tool", id: "t1", label: "Read pull request #7", status: "done", summary: text }] } });

/** Ana's direct message with g1t, Ben's, and a channel they share. */
function workspace() {
  const d1 = fakeD1();
  const db = d1.raw;
  channel(db, "chn_ana_g1t", "dm", [ANA, G1T_KEY]);
  channel(db, "chn_ben_g1t", "dm", [BEN, G1T_KEY]);
  channel(db, "chn_general", "channel", [ANA, BEN]);
  say(db, "chn_ana_g1t", "msg_01", ANA, "What is the launch code word?", { meta: JSON.stringify({ page: { path: "/acme/web/pull/7" } }) });
  say(db, "chn_ana_g1t", "msg_02", G1T_KEY, "It is swordfish.", { meta: answer("swordfish") });
  say(db, "chn_ana_g1t", "msg_03", ANA, "a reply in a thread", { thread_root: "msg_02" });
  say(db, "chn_ana_g1t", "msg_04", G1T_KEY, "New conversation", { meta: JSON.stringify({ reset: true }) });
  say(db, "chn_ana_g1t", "msg_05", ANA, "", { deleted: true });
  db.prepare("INSERT INTO reactions (message_id, principal, emoji, created_at) VALUES ('msg_02', ?, 'thumbsup', ?)").run(ANA, AT);
  say(db, "chn_ben_g1t", "msg_11", BEN, "Ben's own question");
  say(db, "chn_ben_g1t", "msg_12", G1T_KEY, "Ben's answer", { meta: answer("ben") });
  say(db, "chn_general", "msg_21", ANA, "hello team");
  db.prepare("INSERT INTO reactions (message_id, principal, emoji, created_at) VALUES ('msg_21', ?, 'wave', ?)").run(BEN, AT);
  db.prepare("INSERT INTO chat_meter (workspace_id, day, messages, bytes) VALUES ('wsp_1', '2026-10-14', 8, 120)").run();
  return d1;
}

const count = (db: DatabaseSync, sql: string, ...params: string[]) => Number((db.prepare(sql).get(...params) as { n: number }).n);

test("only the one person in a direct message with g1t may clear it, and only their own", () => {
  assert.ok(mayClear({ channelKind: "dm", members: [ANA, G1T_KEY], viewer: ANA }));
  // Someone else's direct message with g1t, whoever asks.
  assert.ok(!mayClear({ channelKind: "dm", members: [BEN, G1T_KEY], viewer: ANA }));
  // A channel, a direct message between people, a group with g1t in it.
  assert.ok(!mayClear({ channelKind: "channel", members: [ANA, G1T_KEY], viewer: ANA }));
  assert.ok(!mayClear({ channelKind: "dm", members: [ANA, BEN], viewer: ANA }));
  assert.ok(!mayClear({ channelKind: "dm", members: [ANA, BEN, G1T_KEY], viewer: ANA }));
  // g1t itself is not a person who clears.
  assert.ok(!mayClear({ channelKind: "dm", members: [ANA, G1T_KEY], viewer: G1T_KEY }));
});

test("clearing deletes everything in that conversation and nothing anywhere else", async () => {
  const d1 = workspace();
  const db = d1.raw;
  const done = await clearConversation(d1, "chn_ana_g1t");
  // Every row, before and after the mark, thread replies and deleted ones too.
  assert.equal(done.messages, 5);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?", "chn_ana_g1t"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM reactions WHERE message_id = 'msg_02'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%swordfish%' OR meta LIKE '%swordfish%'"), 0);
  // The direct message stays, empty, with its two members and nothing read or said last.
  const kept = db.prepare("SELECT last_message_at FROM channels WHERE id = 'chn_ana_g1t'").get() as { last_message_at: string | null };
  assert.equal(kept.last_message_at, null);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = 'chn_ana_g1t' AND last_read_id IS NULL"), 2);
  // Ben's conversation with g1t, the shared channel and its reactions, and the meter are untouched.
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?", "chn_ben_g1t"), 2);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?", "chn_general"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM reactions WHERE message_id = 'msg_21'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = 'chn_ben_g1t' AND last_read_id = 'msg_9'"), 2);
  assert.equal(count(db, "SELECT messages AS n FROM chat_meter WHERE workspace_id = 'wsp_1'"), 8);
});

test("clearing again, or an empty conversation, deletes nothing and is no error", async () => {
  const d1 = workspace();
  assert.equal((await clearConversation(d1, "chn_ana_g1t")).messages, 5);
  assert.equal((await clearConversation(d1, "chn_ana_g1t")).messages, 0);
  assert.equal((await clearConversation(d1, "chn_nobody")).messages, 0);
  assert.equal(count(d1.raw, "SELECT COUNT(*) AS n FROM messages"), 3);
});

test("after a clear, what g1t reads holds none of the old conversation", async () => {
  const d1 = workspace();
  const db = d1.raw;
  const read = () => db.prepare("SELECT id, author, kind, body, meta, deleted_at FROM messages WHERE channel_id = 'chn_ana_g1t' AND thread_root IS NULL ORDER BY id").all() as SaidRow[];
  // Before: a question after the mark would still read nothing of before it, but the history is there.
  say(db, "chn_ana_g1t", "msg_06", ANA, "And before that?");
  assert.ok(read().some((row) => row.body.includes("swordfish")));
  await clearConversation(d1, "chn_ana_g1t");
  assert.deepEqual(conversation(read()), []);
  assert.equal(latestQuestion(read()), null);
  // The next question is read on its own.
  say(db, "chn_ana_g1t", "msg_31", ANA, "What did I ask you before?");
  const asked = conversation(read());
  assert.deepEqual(asked, [{ role: "user", content: "What did I ask you before?" }]);
  assert.ok(!JSON.stringify(asked).includes("swordfish"));
  assert.equal(latestQuestion(read()), "msg_31");
});
