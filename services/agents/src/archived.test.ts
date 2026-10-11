import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { User } from "@g1t/contracts";

import { DESTROYED, destroyRefusal, destroyStatements, listArchived, restoreHandle, restoreRefusal } from "./archived.ts";

/** D1, as far as archived agents use it, over node's SQLite with the service's migrations: statements, `first`, `all`, `run` and `batch`. */
function fakeD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  return { prepare: (sql: string) => statement(sql), batch: async (statements: { run: () => Promise<unknown> }[]) => Promise.all(statements.map((s) => s.run())), raw: db } as unknown as D1Database & { raw: DatabaseSync };
}

const WS = "wsp_acme";
const owner = { id: "u_owner", kind: "user", username: "ana", verified: true, workspaces: [{ slug: "acme", role: "owner" }] } as unknown as User;
const member = { id: "u_mem", kind: "user", username: "mike", verified: true, workspaces: [{ slug: "acme", role: "member" }] } as unknown as User;
const other = { id: "u_other", kind: "user", username: "sam", verified: true, workspaces: [{ slug: "acme", role: "member" }] } as unknown as User;

type Seed = { id: string; handle: string; archived_at?: string | null; archived_by?: string | null; scope?: string; owner_id?: string | null; owner_username?: string | null; builtin?: number };

/** An agent row with what the queries read; everything else is the default. */
function seed(db: { raw: DatabaseSync }, a: Seed): void {
  db.raw
    .prepare(
      `INSERT INTO agents (id, workspace_id, handle, display_name, avatar, role, instructions, routing, budget, autonomy, title, created_by, created_at, updated_at, archived_at, archived_by, scope, owner_id, owner_username, builtin)
       VALUES (?, ?, ?, ?, NULL, 'Helps', 'Help.', '{}', '{}', '{}', 'Helper', 'ana', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', ?, ?, ?, ?, ?, ?)`,
    )
    .run(a.id, WS, a.handle, a.handle[0]!.toUpperCase() + a.handle.slice(1), a.archived_at ?? null, a.archived_by ?? null, a.scope ?? "workspace", a.owner_id ?? null, a.owner_username ?? null, a.builtin ?? 0);
}

/** Rows about one agent across the tables a delete reaches, so the test sees them go. */
function seedHistory(db: { raw: DatabaseSync }, agentId: string, n: number): void {
  const r = db.raw;
  r.prepare("INSERT INTO agent_versions (agent_id, version, definition, changed_by, created_at) VALUES (?, 1, '{}', 'ana', '2026-10-01T00:00:00Z')").run(agentId);
  for (let i = 0; i < n; i++) {
    r.prepare(
      `INSERT INTO agent_sessions (id, workspace_id, agent_id, kind, root_id, payer_agent_id, title, goal, status, workspace, channel_id, channel_kind, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'chat', ?1, ?3, 'Did a thing', 'Do the thing', 'done', 'acme', 'chn_1', 'dm', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')`,
    ).run(`ses_${agentId}_${i}`, WS, agentId);
    r.prepare("INSERT INTO agent_session_events (session_id, seq, kind, body, created_at) VALUES (?, 1, 'asked', 'do it', '2026-10-02T00:00:00Z')").run(`ses_${agentId}_${i}`);
    r.prepare(
      `INSERT INTO agent_replies (id, agent_id, workspace_id, channel_id, message_id, status, created_at)
       VALUES (?, ?, ?, 'chn_1', ?, 'done', '2026-10-02T00:00:00Z')`,
    ).run(`rep_${agentId}_${i}`, agentId, WS, `msg_${agentId}_${i}`);
  }
  r.prepare(
    `INSERT INTO agent_memories (id, agent_id, workspace_id, scope, scope_ref, body, source_kind, created_by, created_by_kind, created_at, updated_at)
     VALUES (?, ?, ?, 'workspace', '', 'Deploys are on Tuesdays', 'chat', 'ana', 'user', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')`,
  ).run(`mem_${agentId}`, agentId, WS);
  r.prepare(
    `INSERT INTO agent_routines (id, agent_id, workspace_id, workspace, name, instructions, channel_id, sponsor, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'acme', 'Standup', 'Post the standup', 'chn_1', 'u_owner', 1, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')`,
  ).run(`rtn_${agentId}`, agentId, WS);
  r.prepare("INSERT INTO agent_routine_runs (routine_id, run_key, created_at) VALUES (?, 'day:2026-10-03', '2026-10-03T00:00:00Z')").run(`rtn_${agentId}`);
  r.prepare("INSERT INTO agent_spend (agent_id, period, micros, replies) VALUES (?, '2026-10', 1200000, 3)").run(agentId);
  r.prepare("INSERT OR IGNORE INTO workspace_agent_spend (workspace_id, period, micros) VALUES (?, '2026-10', 1200000)").run(WS);
  r.prepare("INSERT INTO skill_attachments (id, workspace_id, skill_id, scope, target, version, attached_by, attached_at) VALUES (?, ?, 'skl_1', 'agent', ?, 1, 'ana', '2026-10-02T00:00:00Z')").run(`att_${agentId}`, WS, agentId);
}

const count = (db: { raw: DatabaseSync }, table: string, where: string, ...params: unknown[]) => Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...(params as never[])) as { n: number }).n);

test("the archived list has archived agents only, newest archived first, with what deleting each would take", async () => {
  const db = fakeD1();
  seed(db, { id: "agt_live", handle: "live" });
  seed(db, { id: "agt_old", handle: "old", archived_at: "2026-09-01T00:00:00Z", archived_by: "ana" });
  seed(db, { id: "agt_new", handle: "new", archived_at: "2026-10-05T00:00:00Z", archived_by: "mike" });
  seed(db, { id: "agt_g1t", handle: "g1t", builtin: 1 });
  seedHistory(db, "agt_new", 2);
  const listed = await listArchived(db, WS, { id: owner.id, owner: true });
  assert.deepEqual(
    listed.map((a) => [a.handle, a.archived_by, a.counts]),
    [
      ["new", "mike", { sessions: 2, replies: 2, memories: 1, routines: 1 }],
      ["old", "ana", { sessions: 0, replies: 0, memories: 0, routines: 0 }],
    ],
  );
  assert.equal(listed[0]!.display_name, "New");
  assert.equal(listed[0]!.avatar_seed, "new");
  assert.deepEqual(await listArchived(db, "wsp_other", { id: owner.id, owner: true }), []);
});

test("a member sees only their own archived personal agents", async () => {
  const db = fakeD1();
  seed(db, { id: "agt_ws", handle: "ws", archived_at: "2026-10-01T00:00:00Z" });
  seed(db, { id: "agt_mine", handle: "mine", archived_at: "2026-10-02T00:00:00Z", scope: "personal", owner_id: member.id, owner_username: "mike" });
  seed(db, { id: "agt_theirs", handle: "theirs", archived_at: "2026-10-03T00:00:00Z", scope: "personal", owner_id: other.id, owner_username: "sam" });
  const mine = await listArchived(db, WS, { id: member.id, owner: false });
  assert.deepEqual(
    mine.map((a) => [a.handle, a.scope, a.personal_owner]),
    [["mine", "personal", "mike"]],
  );
  // Owners see every member's, and the workspace's.
  assert.deepEqual((await listArchived(db, WS, { id: owner.id, owner: true })).map((a) => a.handle), ["theirs", "mine", "ws"]);
});

test("restoring: owners any agent, a member their own personal one, and only an archived one", () => {
  const archived = { handle: "sam", archived_at: "2026-10-01T00:00:00Z", scope: "workspace" };
  assert.equal(restoreRefusal(owner, "acme", archived), null);
  assert.equal(restoreRefusal(member, "acme", archived)?.code, "forbidden");
  const personal = { handle: "me", archived_at: "2026-10-01T00:00:00Z", scope: "personal", owner_id: member.id };
  assert.equal(restoreRefusal(member, "acme", personal), null);
  assert.equal(restoreRefusal(other, "acme", personal)?.code, "forbidden");
  assert.equal(restoreRefusal(owner, "acme", { ...archived, archived_at: null })?.code, "invalid");
});

test("restoring under a handle a live agent holds is a conflict that says what to do; a new handle is checked", () => {
  const agent = { handle: "sam", archived_at: "2026-10-01T00:00:00Z" };
  const taken = (h: string) => h === "sam" || h === "ana";
  const conflict = restoreHandle(agent, null, taken);
  assert.equal(!conflict.ok && conflict.error.code, "conflict");
  assert.match(!conflict.ok ? conflict.error.message : "", /Rename that one first, or restore this one under a new handle/);
  const again = restoreHandle(agent, "ana", taken);
  assert.match(!again.ok ? again.error.message : "", /already called @ana. Pick another/);
  assert.deepEqual(restoreHandle(agent, "@Sam-2", taken), { ok: true, handle: "sam-2" });
  assert.deepEqual(restoreHandle(agent, "", () => false), { ok: true, handle: "sam" });
  const bad = restoreHandle(agent, "a", taken);
  assert.equal(!bad.ok && bad.error.code, "invalid");
});

test("deleting refuses a live agent, the built-in @g1t, the wrong person and a confirmation that is not the handle", () => {
  const archived = { handle: "sam", archived_at: "2026-10-01T00:00:00Z", scope: "workspace" };
  assert.equal(destroyRefusal(owner, "acme", archived, "sam"), null);
  assert.equal(destroyRefusal(owner, "acme", archived, "@Sam "), null);
  assert.match(destroyRefusal(owner, "acme", { ...archived, archived_at: null }, "sam")?.message ?? "", /Archive @sam first/);
  assert.equal(destroyRefusal(owner, "acme", { ...archived, archived_at: null }, "sam")?.code, "invalid");
  assert.match(destroyRefusal(owner, "acme", { ...archived, handle: "g1t", builtin: 1 }, "g1t")?.message ?? "", /can't be deleted/);
  assert.equal(destroyRefusal(member, "acme", archived, "sam")?.code, "forbidden");
  assert.equal(destroyRefusal(owner, "acme", archived, "same")?.code, "invalid");
  assert.equal(destroyRefusal(owner, "acme", archived, undefined)?.code, "invalid");
  const personal = { handle: "me", archived_at: "2026-10-01T00:00:00Z", scope: "personal", owner_id: member.id };
  assert.equal(destroyRefusal(member, "acme", personal, "me"), null);
  assert.equal(destroyRefusal(other, "acme", personal, "me")?.code, "forbidden");
});

test("deleting removes every row about the agent, and nothing of another's or of the workspace's totals", async () => {
  const db = fakeD1();
  seed(db, { id: "agt_gone", handle: "gone", archived_at: "2026-10-01T00:00:00Z" });
  seed(db, { id: "agt_kept", handle: "kept" });
  seedHistory(db, "agt_gone", 3);
  seedHistory(db, "agt_kept", 1);
  const results = (await db.batch(destroyStatements(db, "agt_gone"))) as { meta: { changes: number } }[];
  assert.equal(results.length, DESTROYED.length);
  assert.equal(results[results.length - 1]!.meta.changes, 1, "the agents row went last");
  for (const { table } of DESTROYED) {
    const column = table === "agents" ? "id" : table === "skill_attachments" ? "target" : table === "agent_session_events" ? "session_id" : table === "agent_routine_runs" ? "routine_id" : "agent_id";
    const pattern = table === "agent_session_events" ? "ses_agt_gone_%" : table === "agent_routine_runs" ? "rtn_agt_gone" : "agt_gone";
    assert.equal(count(db, table, `${column} LIKE ?`, pattern), 0, `${table} still has rows about the deleted agent`);
  }
  // The other agent is untouched, and the workspace's month total stays for the statement.
  assert.equal(count(db, "agents", "id = ?", "agt_kept"), 1);
  assert.equal(count(db, "agent_sessions", "agent_id = ?", "agt_kept"), 1);
  assert.equal(count(db, "agent_session_events", "session_id LIKE ?", "ses_agt_kept_%"), 1);
  assert.equal(count(db, "agent_replies", "agent_id = ?", "agt_kept"), 1);
  assert.equal(count(db, "agent_memories", "agent_id = ?", "agt_kept"), 1);
  assert.equal(count(db, "agent_routine_runs", "routine_id = ?", "rtn_agt_kept"), 1);
  assert.equal(count(db, "skill_attachments", "target = ?", "agt_kept"), 1);
  assert.equal(count(db, "workspace_agent_spend", "workspace_id = ?", WS), 1);
  // A second delete finds nothing: the agents row is gone.
  const again = (await db.batch(destroyStatements(db, "agt_gone"))) as { meta: { changes: number } }[];
  assert.equal(again[again.length - 1]!.meta.changes, 0);
});

test("deleting leaves a live agent's row alone even when asked by id", async () => {
  const db = fakeD1();
  seed(db, { id: "agt_live", handle: "live" });
  const results = (await db.batch(destroyStatements(db, "agt_live"))) as { meta: { changes: number } }[];
  assert.equal(results[results.length - 1]!.meta.changes, 0);
  assert.equal(count(db, "agents", "id = ?", "agt_live"), 1);
});
