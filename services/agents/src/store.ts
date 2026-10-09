/**
 * Agents as stored in D1, and their spend. Shared by the RPC methods and
 * the desk.
 */
import type { WorkspaceAgent } from "@g1t/contracts";

import { agentStatus, budgetBlock, dayKey, monthKey } from "./budget.ts";
import { type Definition, DEFAULT_AUTONOMY, DEFAULT_BUDGET, DEFAULT_ROUTING, PRESETS, readJson } from "./definition.ts";

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
  version: number;
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
  return {
    handle: row.handle,
    display_name: row.display_name,
    role: row.role,
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
    version: row.version,
    status: row.archived_at ? "paused" : agentStatus({ busyUntil: row.busy_until, now, blocked: budgetBlock(definition.budget, spent, now) !== null }),
    spent_month_micros: spent.month,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

/** Adds a reply's charge to the agent's month and day. */
export function spendStatements(db: D1Database, agentId: string, micros: number, now: Date): D1PreparedStatement[] {
  return periods(now).map((period) =>
    db
      .prepare(
        `INSERT INTO agent_spend (agent_id, period, micros, replies) VALUES (?1, ?2, ?3, 1)
         ON CONFLICT (agent_id, period) DO UPDATE SET micros = micros + ?3, replies = replies + 1`,
      )
      .bind(agentId, period, Math.max(0, Math.ceil(micros))),
  );
}
