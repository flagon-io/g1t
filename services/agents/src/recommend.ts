/**
 * Spend less, keep quality (docs.g1t.sh/guides/spend/#spend-less-keep-quality):
 * a weekly check, per workspace, of whether each agent could run at a
 * cheaper effort level without its work getting worse, judged only on the
 * agent's own finished sessions.
 *
 * - **What counts as good work.** A session is accepted when it finished
 *   (`done`) with nobody having to step in: no one steered it, and it was
 *   not stopped or failed. Only root sessions count (a helper's or
 *   subagent's work is part of its root's), and only those that recorded
 *   the level they ran at.
 * - **What is compared.** The level the agent runs at now (its setting, or
 *   for Auto the level most of its sessions ran at) against the level
 *   below, over the last `WINDOW_DAYS`.
 * - **When it recommends.** Both levels have at least `MIN_SESSIONS`
 *   sessions; the cheaper level's acceptance is no more than
 *   `ACCEPT_TOLERANCE` below the current one's, and even its pessimistic
 *   estimate (a Wilson lower bound) is within `ACCEPT_FLOOR`; and a typical
 *   (median) session at the cheaper level costs at most `COST_SHARE` of
 *   one at the current level.
 * - **When it can't tell.** Too few sessions on either side: a `thin`
 *   note that says how many it has and how many it needs, never a
 *   suggestion. When the cheaper level is measured and does worse, or
 *   saves too little, nothing is said.
 *
 * Every figure shown comes from those sessions' recorded charges, as
 * budgets count them: the model and the agent rate where it applies. Pure
 * functions first (tested in recommend.test.ts), then the database.
 */
import type { AgentEffort, AgentEffortCosts, AgentRecommendation, AgentRecommendations, EffortCost, EffortEvidence, EffortLevel } from "@g1t/contracts";

import { dollars } from "./money.ts";
import { effortOf, isLevel, lowerEffort } from "./routing.ts";
import { type Row, definitionOf } from "./store.ts";

export const WINDOW_DAYS = 28;
export const MIN_SESSIONS = 10;
export const ACCEPT_TOLERANCE = 0.05;
export const ACCEPT_FLOOR = 0.15;
export const COST_SHARE = 0.85;
/** How often a workspace is checked. */
export const CHECK_EVERY_DAYS = 7;
/** Workspaces checked per run, so one run stays short. */
const PER_RUN = 25;

const LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];
const DAY_MS = 86_400_000;

/** One finished session, as the check reads it. */
export type SessionOutcome = { effort: EffortLevel; charged_micros: number; accepted: boolean };

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** The lower end of a Wilson score interval at about 90%: how low a share could plausibly be. */
export function wilsonLower(successes: number, trials: number, z = 1.2816): number {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

export function evidenceAt(outcomes: SessionOutcome[], effort: EffortLevel): EffortEvidence | null {
  const at = outcomes.filter((o) => o.effort === effort);
  if (!at.length) return null;
  const costs = at.map((o) => Math.max(0, o.charged_micros));
  return {
    effort,
    sessions: at.length,
    accepted: at.filter((o) => o.accepted).length,
    typical_micros: median(costs),
    mean_micros: Math.round(costs.reduce((n, c) => n + c, 0) / costs.length),
  };
}

/** The level an agent runs at now: its setting, or for Auto the level most of its sessions ran at (the higher on a tie). */
export function currentLevel(setting: AgentEffort, outcomes: SessionOutcome[]): EffortLevel | null {
  if (setting !== "auto") return setting;
  let best: EffortLevel | null = null;
  let most = 0;
  for (const level of LEVELS) {
    const n = outcomes.filter((o) => o.effort === level).length;
    if (n > 0 && n >= most) {
      best = level;
      most = n;
    }
  }
  return best;
}

export type Judgement =
  | { kind: "none" }
  | { kind: "thin"; from: AgentEffort; to: EffortLevel; current: EffortEvidence | null; cheaper: EffortEvidence | null }
  | { kind: "recommend"; from: AgentEffort; to: EffortLevel; current: EffortEvidence; cheaper: EffortEvidence; saving_month_micros: number };

/** Whether to suggest a cheaper level for one agent, from its sessions in the window. */
export function judge(setting: AgentEffort, outcomes: SessionOutcome[], windowDays = WINDOW_DAYS): Judgement {
  if (!outcomes.length) return { kind: "none" };
  const level = currentLevel(setting, outcomes);
  if (!level) return { kind: "none" };
  const to = lowerEffort(level);
  if (!to) return { kind: "none" };
  const current = evidenceAt(outcomes, level);
  const cheaper = evidenceAt(outcomes, to);
  if (!current || !cheaper || current.sessions < MIN_SESSIONS || cheaper.sessions < MIN_SESSIONS) {
    return { kind: "thin", from: setting, to, current, cheaper };
  }
  const rateNow = current.accepted / current.sessions;
  const rateCheaper = cheaper.accepted / cheaper.sessions;
  if (rateCheaper < rateNow - ACCEPT_TOLERANCE) return { kind: "none" };
  if (wilsonLower(cheaper.accepted, cheaper.sessions) < rateNow - ACCEPT_FLOOR) return { kind: "none" };
  if (current.typical_micros <= 0 || cheaper.typical_micros > current.typical_micros * COST_SHARE) return { kind: "none" };
  // At the pace it ran at the current level, what the difference comes to in 30 days.
  const perDay = current.sessions / Math.max(1, windowDays);
  const saving = Math.max(0, Math.round((current.mean_micros - cheaper.mean_micros) * perDay * 30));
  if (saving <= 0) return { kind: "none" };
  return { kind: "recommend", from: setting, to, current, cheaper, saving_month_micros: saving };
}

export const EFFORT_NAMES: Record<AgentEffort, string> = { auto: "Auto", low: "Low", medium: "Medium", high: "High", max: "Max" };

/** What a judgement says, in words built only from its numbers. */
export function wording(judgement: Exclude<Judgement, { kind: "none" }>, agentName: string, windowDays = WINDOW_DAYS): { title: string; reason: string } {
  const to = EFFORT_NAMES[judgement.to];
  const current = judgement.current;
  const cheaper = judgement.cheaper;
  const levelNow = current ? EFFORT_NAMES[current.effort] : judgement.from === "auto" ? "its usual level" : EFFORT_NAMES[judgement.from];
  if (judgement.kind === "thin") {
    const have = `${current?.sessions ?? 0} at ${levelNow} and ${cheaper?.sessions ?? 0} at ${to}`;
    return {
      title: `Not enough history to say whether ${agentName} can run at ${to}`,
      reason: `Its finished sessions in the last ${windowDays} days: ${have}. A suggestion needs at least ${MIN_SESSIONS} at each.`,
    };
  }
  const c = judgement.current;
  const k = judgement.cheaper;
  return {
    title: `Run ${agentName} at ${to} effort`,
    reason:
      `At ${to}, ${k.accepted} of its ${k.sessions} sessions finished with nobody stepping in, against ${c.accepted} of ${c.sessions} at ${EFFORT_NAMES[c.effort]}; ` +
      `a typical one cost ${dollars(k.typical_micros)} instead of ${dollars(c.typical_micros)}.`,
  };
}

// --- The database ----------------------------------------------------------

type OutcomeRow = { agent_id: string; effort: string | null; charged_micros: number; status: string; steered: number };

/** Finished root sessions with a recorded level since `since`, by agent: the check's input. */
export async function outcomesSince(db: D1Database, workspaceId: string, since: string, agentId?: string): Promise<Map<string, SessionOutcome[]>> {
  const rows = await db
    .prepare(
      `SELECT s.agent_id, s.effort, s.charged_micros, s.status,
         EXISTS (SELECT 1 FROM agent_session_events e WHERE e.session_id = s.id AND e.kind = 'steer') AS steered
       FROM agent_sessions s
       WHERE s.workspace_id = ?1 AND s.parent_id IS NULL AND s.effort IS NOT NULL AND s.finished_at >= ?2
         AND s.status IN ('done', 'failed', 'stopped') AND (?3 IS NULL OR s.agent_id = ?3)`,
    )
    .bind(workspaceId, since, agentId ?? null)
    .all<OutcomeRow>();
  const by = new Map<string, SessionOutcome[]>();
  for (const row of rows.results) {
    if (!isLevel(row.effort)) continue;
    const list = by.get(row.agent_id) ?? [];
    list.push({ effort: row.effort, charged_micros: row.charged_micros, accepted: row.status === "done" && !row.steered });
    by.set(row.agent_id, list);
  }
  return by;
}

/** What each level has cost one agent, from its own sessions. */
export function effortCostsOf(handle: string, setting: AgentEffort, outcomes: SessionOutcome[], windowDays = WINDOW_DAYS): AgentEffortCosts {
  const levels: EffortCost[] = LEVELS.map((effort) => {
    const at = evidenceAt(outcomes, effort);
    return {
      effort,
      sessions: at?.sessions ?? 0,
      typical_micros: at ? at.typical_micros : null,
      accepted_share: at ? at.accepted / at.sessions : null,
    };
  });
  return { handle, effort: setting, window_days: windowDays, levels };
}

type RecommendationRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  kind: string;
  status: string;
  from_effort: string;
  to_effort: string;
  title: string;
  reason: string;
  evidence: string;
  saving_month_micros: number | null;
  checked_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  handle?: string;
  display_name?: string;
  avatar_seed?: string;
};

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toRecommendation(row: RecommendationRow): AgentRecommendation {
  const evidence = parse<AgentRecommendation["evidence"]>(row.evidence, { window_days: WINDOW_DAYS, current: null, cheaper: null, needed: MIN_SESSIONS });
  return {
    id: row.id,
    agent_id: row.agent_id,
    agent_handle: row.handle ?? "agent",
    agent_name: row.display_name ?? "An agent",
    agent_avatar_seed: row.avatar_seed || row.handle || row.agent_id,
    kind: "effort",
    status: (["open", "applied", "dismissed", "thin"].includes(row.status) ? row.status : "open") as AgentRecommendation["status"],
    from_effort: (row.from_effort as AgentEffort) ?? "auto",
    to_effort: isLevel(row.to_effort) ? row.to_effort : "medium",
    title: row.title,
    reason: row.reason,
    evidence,
    saving_month_micros: row.saving_month_micros,
    checked_at: row.checked_at,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Checks one workspace: judges every agent that has finished sessions in
 * the window, and writes what it found. Open and thin suggestions are
 * refreshed in place; one that was applied or dismissed is left alone;
 * open or thin ones that no longer hold (the setting changed, or the
 * evidence moved) become `stale` and are no longer shown.
 */
export async function checkWorkspace(db: D1Database, workspaceId: string, now = Date.now()): Promise<{ open: number; thin: number }> {
  const since = iso(now - WINDOW_DAYS * DAY_MS);
  const checkedAt = iso(now);
  const [outcomes, agents] = await Promise.all([
    outcomesSince(db, workspaceId, since),
    db.prepare("SELECT * FROM agents WHERE workspace_id = ? AND archived_at IS NULL").bind(workspaceId).all<Row>(),
  ]);
  const statements: D1PreparedStatement[] = [];
  const keep: string[] = [];
  let open = 0;
  let thin = 0;
  for (const agent of agents.results) {
    const setting = effortOf(definitionOf(agent).routing);
    const judgement = judge(setting, outcomes.get(agent.id) ?? []);
    if (judgement.kind === "none") continue;
    const words = wording(judgement, agent.display_name);
    const status = judgement.kind === "recommend" ? "open" : "thin";
    if (status === "open") open++;
    else thin++;
    const evidence = JSON.stringify({ window_days: WINDOW_DAYS, current: judgement.current, cheaper: judgement.cheaper, needed: MIN_SESSIONS });
    const saving = judgement.kind === "recommend" ? judgement.saving_month_micros : null;
    const id = `rec_${agent.id}_${judgement.from}_${judgement.to}`;
    keep.push(id);
    statements.push(
      db
        .prepare(
          `INSERT INTO agent_recommendations (id, workspace_id, agent_id, kind, status, from_effort, to_effort, title, reason, evidence, saving_month_micros, checked_at, created_at)
           VALUES (?1, ?2, ?3, 'effort', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
           ON CONFLICT (agent_id, kind, from_effort, to_effort) DO UPDATE SET
             status = CASE WHEN agent_recommendations.status IN ('applied', 'dismissed') THEN agent_recommendations.status ELSE excluded.status END,
             title = CASE WHEN agent_recommendations.status IN ('applied', 'dismissed') THEN agent_recommendations.title ELSE excluded.title END,
             reason = CASE WHEN agent_recommendations.status IN ('applied', 'dismissed') THEN agent_recommendations.reason ELSE excluded.reason END,
             evidence = CASE WHEN agent_recommendations.status IN ('applied', 'dismissed') THEN agent_recommendations.evidence ELSE excluded.evidence END,
             saving_month_micros = CASE WHEN agent_recommendations.status IN ('applied', 'dismissed') THEN agent_recommendations.saving_month_micros ELSE excluded.saving_month_micros END,
             checked_at = excluded.checked_at`,
        )
        .bind(id, workspaceId, agent.id, status, judgement.from, judgement.to, words.title, words.reason, evidence, saving, checkedAt),
    );
  }
  // What no longer holds is put away; the record stays.
  statements.push(
    db
      .prepare(
        `UPDATE agent_recommendations SET status = 'stale', checked_at = ?2
         WHERE workspace_id = ?1 AND status IN ('open', 'thin') AND id NOT IN (SELECT value FROM json_each(?3))`,
      )
      .bind(workspaceId, checkedAt, JSON.stringify(keep)),
  );
  statements.push(
    db
      .prepare("INSERT INTO agent_recommendation_checks (workspace_id, checked_at) VALUES (?, ?) ON CONFLICT (workspace_id) DO UPDATE SET checked_at = excluded.checked_at")
      .bind(workspaceId, checkedAt),
  );
  await db.batch(statements);
  return { open, thin };
}

/**
 * The scheduled run: the workspaces with sessions finished in the window
 * whose last check is a week old or more (or never), a few at a time.
 * Called from the cron; does its work only in the first five minutes of an
 * hour, so the query runs hourly, and each workspace weekly.
 */
export async function checkDue(db: D1Database, now = Date.now()): Promise<number> {
  if (new Date(now).getUTCMinutes() >= 5) return 0;
  const due = await db
    .prepare(
      `SELECT DISTINCT s.workspace_id FROM agent_sessions s
       LEFT JOIN agent_recommendation_checks c ON c.workspace_id = s.workspace_id
       WHERE s.finished_at >= ?1 AND s.effort IS NOT NULL AND (c.checked_at IS NULL OR c.checked_at < ?2)
       LIMIT ?3`,
    )
    .bind(iso(now - WINDOW_DAYS * DAY_MS), iso(now - CHECK_EVERY_DAYS * DAY_MS), PER_RUN)
    .all<{ workspace_id: string }>();
  let checked = 0;
  for (const { workspace_id } of due.results) {
    try {
      await checkWorkspace(db, workspace_id, now);
      checked++;
    } catch (error) {
      console.error("agents: the spend check failed for a workspace", workspace_id, String(error));
    }
  }
  return checked;
}

/** What the Spend page shows: open suggestions, thin notes, and what was decided lately. */
export async function readRecommendations(db: D1Database, workspaceId: string, agentId: string | null, now = Date.now()): Promise<AgentRecommendations> {
  const [rows, check] = await Promise.all([
    db
      .prepare(
        `SELECT r.*, a.handle, a.display_name, a.avatar_seed FROM agent_recommendations r JOIN agents a ON a.id = r.agent_id
         WHERE r.workspace_id = ?1 AND a.archived_at IS NULL AND (?2 IS NULL OR r.agent_id = ?2)
           AND (r.status IN ('open', 'thin') OR (r.status IN ('applied', 'dismissed') AND r.resolved_at >= ?3))
         ORDER BY r.saving_month_micros DESC, a.handle`,
      )
      .bind(workspaceId, agentId, iso(now - 30 * DAY_MS))
      .all<RecommendationRow>(),
    db.prepare("SELECT checked_at FROM agent_recommendation_checks WHERE workspace_id = ?").bind(workspaceId).first<{ checked_at: string }>(),
  ]);
  const all = rows.results.map(toRecommendation);
  return {
    checked_at: check?.checked_at ?? null,
    window_days: WINDOW_DAYS,
    open: all.filter((r) => r.status === "open"),
    thin: all.filter((r) => r.status === "thin"),
    resolved: all.filter((r) => r.status === "applied" || r.status === "dismissed").sort((a, b) => (b.resolved_at ?? "").localeCompare(a.resolved_at ?? "")),
  };
}

export async function recommendationRow(db: D1Database, workspaceId: string, id: string): Promise<RecommendationRow | null> {
  return db
    .prepare(
      `SELECT r.*, a.handle, a.display_name, a.avatar_seed FROM agent_recommendations r JOIN agents a ON a.id = r.agent_id
       WHERE r.workspace_id = ? AND r.id = ?`,
    )
    .bind(workspaceId, id)
    .first<RecommendationRow>();
}

/** Marks one decided, only from open: two owners pressing at once decide it once. */
export async function markResolved(db: D1Database, id: string, status: "applied" | "dismissed", by: string, now = Date.now()): Promise<boolean> {
  const result = await db
    .prepare("UPDATE agent_recommendations SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'")
    .bind(status, by, iso(now), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export function sinceWindow(now = Date.now()): string {
  return iso(now - WINDOW_DAYS * DAY_MS);
}
