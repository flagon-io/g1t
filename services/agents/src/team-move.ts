/**
 * The one-time move of agents' own teams to team memberships
 * (migrations/0010_agent_team_memberships.sql). An agent is on teams the
 * way a person is, through identity's team_agents; agents made before
 * that named a team themselves, in `agents.team`.
 *
 * Every cron run takes the agents not moved yet (none, once it is done:
 * a partial index makes that one cheap read) and asks identity to put
 * each on the team its old value names, by slug in any case, in its own
 * workspace. A value that names no team is dropped and logged. Archived
 * and personal agents are marked without joining anything: neither is on
 * a team. Each agent is marked `team_moved_at` once identity answered for
 * its workspace, so a second run does nothing, and identity's insert is
 * idempotent besides.
 */
import type { AdoptedAgentTeam } from "@g1t/contracts";

/** Agents read per run: the move finishes over a few runs in a large installation. */
export const MOVE_BATCH = 200;

export type MoveRow = { id: string; workspace_id: string; team: string; scope: string | null; archived_at: string | null };

/** What identity is asked, per workspace: the agents that may join, by the team each named. */
export function claimsByWorkspace(rows: readonly MoveRow[]): Map<string, { agent_id: string; team: string }[]> {
  const out = new Map<string, { agent_id: string; team: string }[]>();
  for (const row of rows) {
    if (row.archived_at || row.scope === "personal") continue;
    const team = row.team.trim();
    if (!team) continue;
    out.set(row.workspace_id, [...(out.get(row.workspace_id) ?? []), { agent_id: row.id, team }]);
  }
  return out;
}

export type MoveReport = { seen: number; added: number; already: number; dropped: { agent_id: string; team: string }[] };

/** `adopt` is identity's `adopt_agent_teams` (index.ts passes it). */
export async function moveAgentTeams(
  db: D1Database,
  adopt: (workspaceId: string, agents: { agent_id: string; team: string }[]) => Promise<AdoptedAgentTeam[]>,
  now: Date = new Date(),
): Promise<MoveReport> {
  const rows = await db.prepare(
    `SELECT id, workspace_id, team, scope, archived_at FROM agents
     WHERE team IS NOT NULL AND team <> '' AND team_moved_at IS NULL LIMIT ?`,
  )
    .bind(MOVE_BATCH)
    .all<MoveRow>();
  const report: MoveReport = { seen: 0, added: 0, already: 0, dropped: [] };
  if (!rows.results.length) return report;
  const claims = claimsByWorkspace(rows.results);
  // Agents identity is not asked about (archived, personal) are done as they are.
  const done = new Set(rows.results.filter((row) => !claims.get(row.workspace_id)?.some((c) => c.agent_id === row.id)).map((row) => row.id));
  for (const [workspaceId, agents] of claims) {
    try {
      const outcomes = await adopt(workspaceId, agents);
      for (const outcome of outcomes) {
        if (outcome.outcome === "added") report.added += 1;
        else if (outcome.outcome === "already") report.already += 1;
        else report.dropped.push({ agent_id: outcome.agent_id, team: outcome.team });
      }
      for (const agent of agents) done.add(agent.agent_id);
    } catch (error) {
      // Left unmarked: the next run asks again.
      console.error("agents: moving agents' teams to memberships failed for a workspace", workspaceId, String(error));
    }
  }
  if (done.size) {
    await db.prepare("UPDATE agents SET team_moved_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND team_moved_at IS NULL")
      .bind(now.toISOString(), JSON.stringify([...done]))
      .run();
  }
  report.seen = done.size;
  for (const drop of report.dropped) console.log("agents: an agent's old team names no team, so it joins none", drop.agent_id, drop.team);
  if (report.seen) console.log("agents: moved agents' teams to memberships", JSON.stringify({ seen: report.seen, added: report.added, already: report.already, dropped: report.dropped.length }));
  return report;
}
