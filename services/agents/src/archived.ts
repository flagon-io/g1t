/**
 * Archived agents (docs.g1t.sh/guides/agents/, "Archive, restore and
 * delete"): the Archived section's list, bringing one back, and deleting
 * one for good. Archiving itself is `archive` in index.ts.
 *
 * An archived agent is out of every list, every lookup by handle and every
 * conversation's wake, but its row and everything it did stay. Restoring
 * clears `archived_at`, under its old handle or a new one if a live agent
 * took the old. Deleting removes every row the service keeps about it, in
 * one batch (`destroyStatements`), and index.ts then tells the runner and
 * chat. What stays: its messages in chat (under the name it had), the
 * workspace's month totals (`workspace_agent_spend`), and the audit log.
 *
 * The decisions are pure and tested on their own (archived.test.ts); the
 * reads and the batch take the database.
 */
import type { ArchivedAgent, User } from "@g1t/contracts";

// Relative, with extensions, so Node runs the tests on this file as it is.
import { readLook } from "../../../packages/contracts/src/agent-look.ts";
import type { Failure, FailureCode } from "../../../packages/contracts/src/result.ts";
import { MANAGE_REFUSAL, type Owned, canArchive, canManage, isOwnerOf } from "./access.ts";
import { checkHandle } from "./handle.ts";

const refusal = (code: FailureCode, message: string): Failure => ({ code, message });

type Viewer = Pick<User, "kind" | "username" | "workspaces" | "verified"> & { id?: string };

/** What the decisions read of an agent's row. */
export type ArchivedLike = Owned & { handle: string; archived_at: string | null };

/** The refusal for restoring `agent`, or null when `viewer` may. */
export function restoreRefusal(viewer: Viewer | null | undefined, workspace: string, agent: ArchivedLike): Failure | null {
  if (!agent.archived_at) return refusal("invalid", `@${agent.handle} isn't archived.`);
  if (!canArchive(viewer, workspace, agent)) return refusal("forbidden", MANAGE_REFUSAL);
  return null;
}

/**
 * The refusal for deleting `agent` for good, or null when `viewer` may:
 * owners any agent, a member their own personal one; never the built-in
 * @g1t; only an archived agent, and only with its handle typed back.
 */
export function destroyRefusal(viewer: Viewer | null | undefined, workspace: string, agent: ArchivedLike, confirm: unknown): Failure | null {
  if (agent.builtin) return refusal("invalid", "@g1t is every workspace's orchestrator and can't be deleted.");
  if (!canManage(viewer, workspace) && !isOwnerOf(viewer, agent)) return refusal("forbidden", "Only the workspace's owners delete an agent, and a member their own personal agent.");
  if (!agent.archived_at) return refusal("invalid", `Archive @${agent.handle} first. Deleting is for archived agents, so nothing goes by accident.`);
  if (typeof confirm !== "string" || confirm.trim().replace(/^@/, "").toLowerCase() !== agent.handle) {
    return refusal("invalid", `Type @${agent.handle} to confirm.`);
  }
  return null;
}

/**
 * The handle an agent is restored under: its own, or `given` when the
 * person chose a new one. `conflict` when the handle is taken by a live
 * agent (`taken` says so), with what to do about it.
 */
export function restoreHandle(agent: ArchivedLike, given: unknown, taken: (handle: string) => boolean): { ok: true; handle: string } | { ok: false; error: Failure } {
  let handle = agent.handle;
  if (given !== undefined && given !== null && given !== "") {
    const checked = checkHandle(given);
    if (!checked.ok) return { ok: false, error: refusal("invalid", checked.message) };
    handle = checked.handle;
  }
  if (taken(handle)) {
    return {
      ok: false,
      error: refusal(
        "conflict",
        handle === agent.handle
          ? `A live agent is called @${handle} now. Rename that one first, or restore this one under a new handle.`
          : `A live agent is already called @${handle}. Pick another handle.`,
      ),
    };
  }
  return { ok: true, handle };
}

/** The table and the column each delete runs on, so the docs and the tests say the same. */
export const DESTROYED: readonly { table: string; where: string }[] = [
  { table: "agent_session_events", where: "session_id IN (SELECT id FROM agent_sessions WHERE agent_id = ?)" },
  { table: "agent_sessions", where: "agent_id = ?" },
  { table: "agent_routine_runs", where: "routine_id IN (SELECT id FROM agent_routines WHERE agent_id = ?)" },
  { table: "agent_routines", where: "agent_id = ?" },
  { table: "agent_replies", where: "agent_id = ?" },
  { table: "agent_tool_calls", where: "agent_id = ?" },
  { table: "agent_memories", where: "agent_id = ?" },
  { table: "agent_drafts", where: "agent_id = ?" },
  { table: "agent_recommendations", where: "agent_id = ?" },
  { table: "agent_ability_requests", where: "agent_id = ?" },
  { table: "skill_attachments", where: "scope = 'agent' AND target = ?" },
  { table: "agent_spend", where: "agent_id = ?" },
  { table: "agent_versions", where: "agent_id = ?" },
  // Last, and only while still archived: a restore that raced the delete keeps the agent and all of the above is already gone for it.
  { table: "agents", where: "id = ? AND archived_at IS NOT NULL" },
];

/** Every row the service keeps about one agent, deleted in one batch. The `agents` row goes last. */
export function destroyStatements(db: D1Database, agentId: string): D1PreparedStatement[] {
  return DESTROYED.map(({ table, where }) => db.prepare(`DELETE FROM ${table} WHERE ${where}`).bind(agentId));
}

type ArchivedRow = {
  id: string;
  handle: string;
  display_name: string;
  title: string | null;
  role: string;
  avatar: string | null;
  avatar_seed: string | null;
  look: string | null;
  scope: string | null;
  owner_id: string | null;
  owner_username: string | null;
  archived_at: string;
  archived_by: string | null;
  sessions: number;
  replies: number;
  memories: number;
  routines: number;
};

/**
 * The workspace's archived agents, newest archived first: every one for an
 * owner, the viewer's own archived personal agents for anyone else. Each
 * with what deleting it would take: its sessions, replies, memories and
 * routines, counted in the same read.
 */
export async function listArchived(db: D1Database, workspaceId: string, viewer: { id: string; owner: boolean }): Promise<ArchivedAgent[]> {
  const rows = await db
    .prepare(
      `SELECT a.id, a.handle, a.display_name, a.title, a.role, a.avatar, a.avatar_seed, a.look, a.scope, a.owner_id, a.owner_username, a.archived_at, a.archived_by,
         (SELECT COUNT(*) FROM agent_sessions s WHERE s.agent_id = a.id) AS sessions,
         (SELECT COUNT(*) FROM agent_replies r WHERE r.agent_id = a.id) AS replies,
         (SELECT COUNT(*) FROM agent_memories m WHERE m.agent_id = a.id) AS memories,
         (SELECT COUNT(*) FROM agent_routines t WHERE t.agent_id = a.id) AS routines
       FROM agents a
       WHERE a.workspace_id = ?1 AND a.archived_at IS NOT NULL AND a.builtin = 0
         AND (?2 = 1 OR (a.scope = 'personal' AND a.owner_id = ?3))
       ORDER BY a.archived_at DESC, a.handle`,
    )
    .bind(workspaceId, viewer.owner ? 1 : 0, viewer.id)
    .all<ArchivedRow>();
  return rows.results.map((row) => ({
    id: row.id,
    handle: row.handle,
    display_name: row.display_name,
    title: row.title ?? "",
    role: row.role,
    avatar: row.avatar,
    avatar_seed: row.avatar_seed || row.handle,
    look: readLook(row.look),
    scope: row.scope === "personal" ? "personal" : "workspace",
    personal_owner: row.scope === "personal" ? (row.owner_username ?? null) : null,
    archived_at: row.archived_at,
    archived_by: row.archived_by ?? null,
    counts: { sessions: row.sessions ?? 0, replies: row.replies ?? 0, memories: row.memories ?? 0, routines: row.routines ?? 0 },
  }));
}
