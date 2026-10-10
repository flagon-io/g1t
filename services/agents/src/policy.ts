/**
 * The workspace's say over all its agents together
 * (docs.g1t.sh/guides/agent-budgets/): one monthly budget across every
 * agent, the budget a new agent starts with, the cap a session starts with,
 * and alerts at 75, 90 and 100% of the monthly budget. Owners set it. Pure
 * apart from the statements it builds, so the rules are tested on their
 * own.
 */
import type { AgentPolicy } from "@g1t/contracts";

import { dayKey, monthKey } from "./budget.ts";

/** A session's cap when nobody set one: $2. */
export const DEFAULT_SESSION_MICROS = 2_000_000;
/** The thresholds owners hear about, in % of the workspace's agent budget. */
export const ALERTS = [75, 90, 100] as const;

export type PolicyRow = AgentPolicy & {
  /** Every agent's spend this month. */
  spent: number;
  /** The highest alert already sent this month, or 0. */
  alerted: number;
};

export const DEFAULT_POLICY: AgentPolicy = { monthly_micros: null, default_agent_monthly_micros: null, default_session_micros: DEFAULT_SESSION_MICROS };

/** The workspace's policy and this month's spend across its agents. */
export async function readPolicy(db: D1Database, workspaceId: string, month: string): Promise<PolicyRow> {
  const [policy, spend] = await Promise.all([
    db
      .prepare("SELECT monthly_micros, default_agent_monthly_micros, default_session_micros FROM agent_policies WHERE workspace_id = ?")
      .bind(workspaceId)
      .first<AgentPolicy>(),
    db
      .prepare("SELECT micros, alerted FROM workspace_agent_spend WHERE workspace_id = ? AND period = ?")
      .bind(workspaceId, month)
      .first<{ micros: number; alerted: number }>(),
  ]);
  return {
    monthly_micros: positive(policy?.monthly_micros),
    default_agent_monthly_micros: positive(policy?.default_agent_monthly_micros),
    default_session_micros: positive(policy?.default_session_micros) ?? DEFAULT_SESSION_MICROS,
    spent: spend?.micros ?? 0,
    alerted: spend?.alerted ?? 0,
  };
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** Why no agent may start more work this month, as people are told, or null. */
export function policyBlock(policy: Pick<PolicyRow, "monthly_micros" | "spent">): string | null {
  if (policy.monthly_micros && policy.spent >= policy.monthly_micros) {
    return "This workspace's agents have used their budget for the month. An owner can raise it under Agents → Budget.";
  }
  return null;
}

/** The alert a workspace has newly crossed, or null: the highest threshold at or under its share, past what was sent. */
export function alertDue(policy: Pick<PolicyRow, "monthly_micros" | "spent" | "alerted">): number | null {
  if (!policy.monthly_micros) return null;
  const share = (policy.spent * 100) / policy.monthly_micros;
  const crossed = ALERTS.filter((level) => share >= level).at(-1) ?? null;
  return crossed && crossed > policy.alerted ? crossed : null;
}

/** Adds a charge to the workspace's agent spend, this month and today. */
export function workspaceSpendStatements(db: D1Database, workspaceId: string, micros: number, now: Date): D1PreparedStatement[] {
  return [monthKey(now), dayKey(now)].map((period) =>
    db
      .prepare(
        `INSERT INTO workspace_agent_spend (workspace_id, period, micros) VALUES (?1, ?2, ?3)
         ON CONFLICT (workspace_id, period) DO UPDATE SET micros = micros + ?3`,
      )
      .bind(workspaceId, period, Math.max(0, Math.ceil(micros))),
  );
}

/** Marks an alert as sent, once: true when this call is the one that sent it. */
export async function markAlerted(db: D1Database, workspaceId: string, month: string, level: number): Promise<boolean> {
  const changed = await db
    .prepare("UPDATE workspace_agent_spend SET alerted = ? WHERE workspace_id = ? AND period = ? AND alerted < ?")
    .bind(level, workspaceId, month, level)
    .run();
  return changed.meta.changes > 0;
}

/**
 * A policy as owners change it, checked: budgets are whole micro-dollars
 * or null (none); a session's default cap is between 10 cents and $500.
 */
export function checkPolicy(current: AgentPolicy, changes: Partial<AgentPolicy>): { ok: true; value: AgentPolicy } | { ok: false; message: string } {
  const next = { ...current };
  for (const key of ["monthly_micros", "default_agent_monthly_micros"] as const) {
    if (!(key in changes)) continue;
    const value = changes[key];
    if (value === null || value === 0) next[key] = null;
    else if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000_000_000_000) next[key] = Math.floor(value);
    else return { ok: false, message: "A budget is a positive amount, or none." };
  }
  if ("default_session_micros" in changes) {
    const value = changes.default_session_micros;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 100_000 || value > 500_000_000) {
      return { ok: false, message: "A session's cap is between $0.10 and $500." };
    }
    next.default_session_micros = Math.floor(value);
  }
  return { ok: true, value: next };
}
