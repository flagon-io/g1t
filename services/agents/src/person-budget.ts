/**
 * Budgets per person (docs.g1t.sh/guides/agent-budgets/): what the agents
 * working for one person, the replies and sessions that person asked for,
 * may spend together in a month. The default is the workspace policy's
 * `person_monthly_micros`; an owner can give anyone their own
 * (`person_budgets`, 0 for none at all). What a person's agents spent is
 * summed from the replies and the root sessions they asked for, the same
 * rows the spend breakdown reads, so the two always agree.
 */
import type { PersonBudget, PersonBudgets } from "@g1t/contracts";

import { monthKey, personLimit } from "./budget.ts";

/** The first instant of `now`'s month (UTC), as rows' `created_at` compare. */
export function monthStart(now: Date): string {
  return `${monthKey(now)}-01T00:00:00.000Z`;
}

/** What agents spent for `username` since `from`: their replies, and their sessions with everything each brought in. */
export async function personSpent(db: D1Database, workspaceId: string, username: string, from: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(charged_micros), 0) FROM agent_replies WHERE workspace_id = ?1 AND asked_by_username = ?2 AND created_at >= ?3)
       + (SELECT COALESCE(SUM(charged_micros), 0) FROM agent_sessions WHERE workspace_id = ?1 AND asked_by_username = ?2 AND created_at >= ?3 AND parent_id IS NULL)
       AS micros`,
    )
    .bind(workspaceId, username, from)
    .first<{ micros: number | null }>();
  return row?.micros ?? 0;
}

/** A person's own budget, if an owner set one (0: none at all). */
export async function ownBudget(db: D1Database, workspaceId: string, username: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT monthly_micros FROM person_budgets WHERE workspace_id = ? AND username = ?")
    .bind(workspaceId, username)
    .first<{ monthly_micros: number }>();
  return row ? row.monthly_micros : null;
}

/**
 * Everyone's budget this month: each person with one of their own, and
 * each person agents spent for. `only` narrows it to one person.
 */
export async function personBudgets(db: D1Database, workspaceId: string, defaultMicros: number | null, now: Date, only: string | null): Promise<PersonBudgets> {
  const from = monthStart(now);
  const narrow = only ? " AND asked_by_username = ?3" : "";
  const binds = only ? [workspaceId, from, only] : [workspaceId, from];
  const [own, spent] = await Promise.all([
    db
      .prepare(`SELECT username, monthly_micros FROM person_budgets WHERE workspace_id = ?1${only ? " AND username = ?2" : ""}`)
      .bind(...(only ? [workspaceId, only] : [workspaceId]))
      .all<{ username: string; monthly_micros: number }>(),
    db
      .prepare(
        `SELECT asked_by_username AS username, SUM(micros) AS micros FROM (
           SELECT asked_by_username, charged_micros AS micros FROM agent_replies WHERE workspace_id = ?1 AND created_at >= ?2 AND asked_by_username IS NOT NULL${narrow}
           UNION ALL SELECT asked_by_username, charged_micros AS micros FROM agent_sessions WHERE workspace_id = ?1 AND created_at >= ?2 AND parent_id IS NULL AND asked_by_username IS NOT NULL${narrow}
         ) GROUP BY asked_by_username`,
      )
      .bind(...binds)
      .all<{ username: string; micros: number }>(),
  ]);
  const people = new Map<string, PersonBudget>();
  const entry = (username: string) => {
    const found = people.get(username);
    if (found) return found;
    const fresh: PersonBudget = { username, monthly_micros: personLimit(defaultMicros, null), own: false, spent_micros: 0 };
    people.set(username, fresh);
    return fresh;
  };
  for (const row of own.results) {
    const person = entry(row.username);
    person.own = true;
    person.monthly_micros = personLimit(defaultMicros, row.monthly_micros);
  }
  for (const row of spent.results) entry(row.username).spent_micros = row.micros ?? 0;
  if (only) entry(only);
  return {
    period: monthKey(now),
    default_micros: personLimit(defaultMicros, null),
    people: [...people.values()].sort((a, b) => b.spent_micros - a.spent_micros || a.username.localeCompare(b.username)),
  };
}

/** A username as people type it: `@Ana` is `ana`. Null when it can't be one. */
export function cleanUsername(raw: unknown): string | null {
  const name = String(raw ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,38}$/.test(name) ? name : null;
}
