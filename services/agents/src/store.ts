/**
 * Agents as stored in D1, and their spend. Shared by the RPC methods and
 * the desk.
 */
import type { SubagentDef, WorkspaceAgent } from "@g1t/contracts";

import { agentStatus, budgetBlock, dayKey, monthKey } from "./budget.ts";
import { type Definition, DEFAULT_AUTONOMY, DEFAULT_BUDGET, DEFAULT_ROUTING, legacyRoleOf, PRESETS, readJson } from "./definition.ts";

export type Row = {
  id: string;
  workspace_id: string;
  handle: string;
  display_name: string;
  avatar: string | null;
  role: string;
  instructions: string;
  personality_preset: string;
  personality: string;
  routing: string;
  budget: string;
  autonomy: string;
  capacity: number;
  template: string | null;
  avatar_seed: string | null;
  title: string | null;
  /**
   * Unused columns from when an agent carried its own team and department.
   * Teams are memberships in identity now; `team` is read once, by the move
   * to them (team-move.ts), and `role` made from them follows the title.
   */
  team?: string | null;
  department?: string | null;
  responsibilities: string | null;
  subagents: string | null;
  faces: string | null;
  reading?: string | null;
  skills_off?: string | null;
  version: number;
  /** 1 for the workspace's built-in @g1t. */
  builtin: number;
  /** `workspace`, or `personal` (a member's own); missing before personal agents. */
  scope?: string | null;
  /** A personal agent's member: user id and username. */
  owner_id?: string | null;
  owner_username?: string | null;
  busy_until: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  /** Joined from agent_spend: this month and today. */
  spent_month?: number | null;
  spent_day?: number | null;
};

/**
 * Agents with this month's and today's spend: `where` filters `agents`
 * (aliased `a`); its parameters follow the two periods.
 */
export function selectAgents(where: string): string {
  return `SELECT a.*, m.micros AS spent_month, d.micros AS spent_day FROM agents a
    LEFT JOIN agent_spend m ON m.agent_id = a.id AND m.period = ?1
    LEFT JOIN agent_spend d ON d.agent_id = a.id AND d.period = ?2
    WHERE ${where}`;
}

export function periods(now: Date): [string, string] {
  return [monthKey(now), dayKey(now)];
}

export function definitionOf(row: Row): Definition {
  const title = row.title ?? "";
  // A role made from the title and its old team or department is the title alone.
  const made = (row.team || row.department?.trim()) && row.role === legacyRoleOf(title, row.team ?? null, row.department ?? null);
  return {
    handle: row.handle,
    display_name: row.display_name,
    role: made && title.trim() ? title.trim() : row.role,
    instructions: row.instructions,
    personality_preset: PRESETS.includes(row.personality_preset as Definition["personality_preset"])
      ? (row.personality_preset as Definition["personality_preset"])
      : "crisp",
    personality: row.personality,
    routing: readJson(row.routing, DEFAULT_ROUTING),
    budget: readJson(row.budget, DEFAULT_BUDGET),
    autonomy: readJson(row.autonomy, DEFAULT_AUTONOMY),
    capacity: row.capacity,
    template: row.template,
    avatar_seed: row.avatar_seed || row.handle,
    title,
    responsibilities: readList<string>(row.responsibilities),
    subagents: readList<SubagentDef>(row.subagents),
    faces: "internal",
    reading: readList<string>(row.reading ?? null),
    skills_off: readList<string>(row.skills_off ?? null),
  };
}

export function toAgent(row: Row, now: Date): WorkspaceAgent {
  const definition = definitionOf(row);
  const spent = { month: row.spent_month ?? 0, day: row.spent_day ?? 0 };
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    avatar: row.avatar,
    ...definition,
    builtin: !!row.builtin,
    scope: isPersonal(row) ? "personal" : "workspace",
    personal_owner_id: isPersonal(row) ? (row.owner_id ?? null) : null,
    personal_owner: isPersonal(row) ? (row.owner_username ?? null) : null,
    version: row.version,
    status: row.archived_at ? "paused" : agentStatus({ busyUntil: row.busy_until, now, blocked: budgetBlock(definition.budget, spent, now) !== null }),
    spent_month_micros: spent.month,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

/** Whether a row is a member's personal agent. */
export function isPersonal(row: Pick<Row, "scope">): boolean {
  return row.scope === "personal";
}

/**
 * Adds a charge to the paying agent's month and day: a reply's, or a
 * session step's (`task`), counted as one of each.
 */
export function spendStatements(db: D1Database, agentId: string, micros: number, now: Date, task: "reply" | "session" = "reply"): D1PreparedStatement[] {
  const [replies, sessions] = task === "reply" ? [1, 0] : [0, 1];
  return periods(now).map((period) =>
    db
      .prepare(
        `INSERT INTO agent_spend (agent_id, period, micros, replies, sessions) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (agent_id, period) DO UPDATE SET micros = micros + ?3, replies = replies + ?4, sessions = sessions + ?5`,
      )
      .bind(agentId, period, Math.max(0, Math.ceil(micros)), replies, sessions),
  );
}

/** A stored JSON list, read defensively: anything else is empty. */
function readList<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * The agents table's definition columns, in the order `definitionColumns`
 * gives their values. Statements are built from this one list, so a new
 * field is added in one place.
 */
export const DEFINITION_COLUMNS = [
  "handle",
  "display_name",
  "role",
  "instructions",
  "personality_preset",
  "personality",
  "routing",
  "budget",
  "autonomy",
  "capacity",
  "template",
  "avatar_seed",
  "title",
  "responsibilities",
  "subagents",
  "faces",
  "reading",
  "skills_off",
] as const;

/** A definition's values, in `DEFINITION_COLUMNS` order. */
export function definitionColumns(d: Definition): (string | number | null)[] {
  return [
    d.handle,
    d.display_name,
    d.role,
    d.instructions,
    d.personality_preset,
    d.personality,
    JSON.stringify(d.routing),
    JSON.stringify(d.budget),
    JSON.stringify(d.autonomy),
    d.capacity,
    d.template,
    d.avatar_seed,
    d.title,
    JSON.stringify(d.responsibilities),
    JSON.stringify(d.subagents),
    d.faces,
    JSON.stringify(d.reading ?? []),
    JSON.stringify(d.skills_off ?? []),
  ];
}

/**
 * A new agent row: `id`, `workspace_id`, the definition, then `extra`
 * columns (version, builtin, who made it, when), all bound in order.
 */
export function insertAgent(db: D1Database, id: string, workspaceId: string, d: Definition, extra: Record<string, string | number>, orIgnore = false): D1PreparedStatement {
  const names = ["id", "workspace_id", ...DEFINITION_COLUMNS, ...Object.keys(extra)];
  const values = [id, workspaceId, ...definitionColumns(d), ...Object.values(extra)];
  return db
    .prepare(`INSERT ${orIgnore ? "OR IGNORE " : ""}INTO agents (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
    .bind(...values);
}

/** Sets a row's definition, from the version read only, with `extra` columns. */
export function updateAgent(db: D1Database, id: string, readVersion: number, d: Definition, extra: Record<string, string | number>): D1PreparedStatement {
  const names = [...DEFINITION_COLUMNS, ...Object.keys(extra)];
  return db
    .prepare(`UPDATE agents SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE id = ? AND version = ?`)
    .bind(...definitionColumns(d), ...Object.values(extra), id, readVersion);
}

/** A version of a definition, as saved. */
export function versionStatement(db: D1Database, agentId: string, version: number, d: Definition, by: string, at: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO agent_versions (agent_id, version, definition, changed_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(agentId, version, JSON.stringify(d), by, at);
}
