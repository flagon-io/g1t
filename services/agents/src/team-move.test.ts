import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { AdoptedAgentTeam } from "@g1t/contracts";

import { claimsByWorkspace, moveAgentTeams } from "./team-move.ts";

/** D1 over node's SQLite with the service's migrations. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, params: unknown[] = []): any => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const at = "2026-10-10T12:00:00Z";

async function addAgent(db: D1Database, id: string, workspace: string, team: string | null, extra: { scope?: string; archived?: boolean } = {}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agents (id, workspace_id, handle, display_name, role, instructions, routing, budget, autonomy, created_by, created_at, updated_at, team, scope, archived_at)
       VALUES (?, ?, ?, ?, 'r', 'i', '{}', '{}', '{}', 'ana', ?, ?, ?, ?, ?)`,
    )
    .bind(id, workspace, id, id, at, at, team, extra.scope ?? "workspace", extra.archived ? at : null)
    .run();
}

/** Identity's side: teams by workspace, and the memberships it holds. */
function identity(teams: Record<string, string[]>) {
  const on = new Set<string>();
  const calls: string[] = [];
  const adopt = async (workspaceId: string, agents: { agent_id: string; team: string }[]): Promise<AdoptedAgentTeam[]> => {
    calls.push(workspaceId);
    return agents.map(({ agent_id, team }) => {
      const slug = team.trim().toLowerCase();
      if (!(teams[workspaceId] ?? []).includes(slug)) return { agent_id, team, outcome: "no_team" };
      const key = `${workspaceId}/${slug}/${agent_id}`;
      if (on.has(key)) return { agent_id, team, outcome: "already" };
      on.add(key);
      return { agent_id, team, outcome: "added" };
    });
  };
  return { adopt, on, calls };
}

test("only workspace agents that aren't archived join a team", () => {
  const claims = claimsByWorkspace([
    { id: "agt_a", workspace_id: "w1", team: "qa", scope: "workspace", archived_at: null },
    { id: "agt_b", workspace_id: "w1", team: "qa", scope: "personal", archived_at: null },
    { id: "agt_c", workspace_id: "w2", team: "sales", scope: null, archived_at: null },
    { id: "agt_d", workspace_id: "w2", team: "sales", scope: "workspace", archived_at: at },
    { id: "agt_e", workspace_id: "w2", team: "  ", scope: "workspace", archived_at: null },
  ]);
  assert.deepEqual([...claims], [
    ["w1", [{ agent_id: "agt_a", team: "qa" }]],
    ["w2", [{ agent_id: "agt_c", team: "sales" }]],
  ]);
});

test("agents' old teams become memberships once: matched by slug, the rest dropped, a second run does nothing", async () => {
  const db = fakeD1();
  await addAgent(db, "agt_margo", "w1", "QA");
  await addAgent(db, "agt_david", "w1", "sales");
  await addAgent(db, "agt_pax", "w1", "billing");
  await addAgent(db, "agt_otto", "w2", "qa");
  await addAgent(db, "agt_mine", "w1", "qa", { scope: "personal" });
  await addAgent(db, "agt_none", "w1", null);
  const fake = identity({ w1: ["qa", "sales"], w2: [] });
  const first = await moveAgentTeams(db, fake.adopt, new Date(at));
  assert.equal(first.added, 2);
  assert.deepEqual(first.dropped.map((d) => d.agent_id).sort(), ["agt_otto", "agt_pax"]);
  assert.equal(first.seen, 5, "the personal agent is marked without joining");
  assert.deepEqual([...fake.on].sort(), ["w1/qa/agt_margo", "w1/sales/agt_david"]);
  const second = await moveAgentTeams(db, fake.adopt, new Date(at));
  assert.deepEqual(second, { seen: 0, added: 0, already: 0, dropped: [] });
  assert.equal(fake.calls.length, 2, "identity is asked once per workspace, and never again");
});

test("a workspace identity couldn't answer for is asked again next run", async () => {
  const db = fakeD1();
  await addAgent(db, "agt_margo", "w1", "qa");
  let fail = true;
  const fake = identity({ w1: ["qa"] });
  const adopt = async (id: string, agents: { agent_id: string; team: string }[]) => {
    if (fail) throw new Error("identity is down");
    return fake.adopt(id, agents);
  };
  assert.equal((await moveAgentTeams(db, adopt)).seen, 0);
  fail = false;
  assert.equal((await moveAgentTeams(db, adopt)).added, 1);
});
