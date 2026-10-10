/**
 * Spend's reads: each part from the service that owns it, each on its own
 * so one that fails leaves only its part saying so. Billing has the
 * workspace's money (usage at price, the spend limit, caps, the price
 * book); the agents service has where agent work went (by agent, person,
 * channel, model, kind) and the budgets below the workspace's (its agents
 * together, each person, each agent, each session). The shaping is in
 * ./spend.ts.
 */
import type { AgentPolicy, AgentSpendBreakdown, Limit, PersonBudgets, SpendPeriod, UsageReport, User, WorkspaceAgent } from "@g1t/contracts";

import { type Pricing, type SpendScope, agentMicros, attributionSlices, pricingOf, spanFor } from "./spend";
import { billing, workspaceAgents } from "./services.server";

const warn = (what: string) => (error: unknown) => {
  console.warn(`spend: ${what} failed`, error);
  return null;
};

const value = <T>(result: { ok: true; value: T } | { ok: false } | null): T | null => (result && result.ok ? result.value : null);

/** Where agent work went for the scope and period: everyone's, or only what the viewer asked for. */
export function loadBreakdown(viewer: User, slug: string, scope: SpendScope, period: SpendPeriod): Promise<AgentSpendBreakdown | null> {
  return workspaceAgents
    .spend(slug, viewer, null, { period, person: scope === "me" ? viewer.username.toLowerCase() : null })
    .then(value)
    .catch(warn("agents spend"));
}

/** Everything the workspace used over the period, at price, by product and day. */
export function loadUsage(viewer: User, slug: string, period: SpendPeriod, now: Date): Promise<UsageReport | null> {
  const { from, until } = spanFor(period, now);
  return billing.usageReport(slug, viewer, { from, until }).then(value).catch(warn("usage report"));
}

/** One agent's budget and month, as the budgets list shows it. */
export type AgentBudgetRow = Pick<WorkspaceAgent, "id" | "handle" | "display_name" | "avatar_seed" | "budget" | "spent_month_micros" | "builtin">;

/** Every level of budget, widest first, with what is spent against each this month. */
export type Budgets = {
  /** The workspace's spend limit (billing); null when billing did not answer or is off. */
  limit: Limit | null;
  /** The plan's caps on one run and one issue (billing). */
  caps: { runMicros: number; issueMicros: number } | null;
  /** The workspace's agent policy: every agent together, the per-person default, a new agent's, a session's. */
  policy: AgentPolicy | null;
  /** Every agent's spend this month, against the policy's budget. */
  agentsMonthMicros: number | null;
  people: PersonBudgets | null;
  agents: AgentBudgetRow[] | null;
};

export async function loadBudgets(viewer: User, slug: string, monthBreakdown: Promise<AgentSpendBreakdown | null>): Promise<Budgets> {
  const [limit, entitlements, policy, people, agents, month] = await Promise.all([
    billing.limit(slug, viewer).then(value).catch(warn("limit")),
    billing.entitlements(slug).catch(warn("entitlements")),
    workspaceAgents.policy(slug, viewer).then(value).catch(warn("agent policy")),
    workspaceAgents.personBudgets(slug, viewer).then(value).catch(warn("person budgets")),
    workspaceAgents.list(slug, viewer).then(value).catch(warn("agents")),
    monthBreakdown,
  ]);
  return {
    limit,
    caps: entitlements ? { runMicros: entitlements.runCapMicros, issueMicros: entitlements.issueCapMicros } : null,
    policy,
    agentsMonthMicros: month?.total_micros ?? null,
    people,
    agents: agents
      ? agents
          .filter((a) => !a.archived_at)
          .map((a) => ({ id: a.id, handle: a.handle, display_name: a.display_name, avatar_seed: a.avatar_seed, budget: a.budget, spent_month_micros: a.spent_month_micros, builtin: a.builtin }))
          .sort((a, b) => Number(b.builtin) - Number(a.builtin) || b.spent_month_micros - a.spent_month_micros)
      : null,
  };
}

/** What the price book says about pricing. */
export function loadPricing(): Promise<Pricing | null> {
  return billing
    .prices()
    .then(pricingOf)
    .catch(warn("prices"));
}

/** The top bar's pill: the viewer's month, and the workspace's for someone who may see it. */
export type PillData = {
  month: string;
  me: { spentMicros: number; budgetMicros: number | null; byKind: AgentSpendBreakdown["by_kind"]; byAgent: AgentSpendBreakdown["by_agent"] } | null;
  /**
   * The workspace's month: everything it used at price (the figure Home and
   * Spend show), what it was charged after its plan and credit (the figure
   * its spend limit governs), its limit, and its agents' share.
   */
  workspace: { spentMicros: number | null; chargedMicros: number | null; limitMicros: number | null; agentsMicros: number | null; byAgent: AgentSpendBreakdown["by_agent"] } | null;
};

export async function loadPill(viewer: User, slug: string, mayWorkspace: boolean): Promise<PillData> {
  const me = viewer.username.toLowerCase();
  const [mine, people, everyone, limit, usage] = await Promise.all([
    loadBreakdown(viewer, slug, "me", "month"),
    workspaceAgents.personBudgets(slug, viewer).then(value).catch(warn("person budgets")),
    mayWorkspace ? loadBreakdown(viewer, slug, "workspace", "month") : Promise.resolve(null),
    mayWorkspace ? billing.limit(slug, viewer).then(value).catch(warn("limit")) : Promise.resolve(null),
    // The workspace's agents figure is the agent product on billing's
    // ledger, the same ledger "charged" is read from; the agents service's
    // own count stands in only while billing has not answered.
    mayWorkspace ? loadUsage(viewer, slug, "month", new Date()) : Promise.resolve(null),
  ]);
  const own = people?.people.find((p) => p.username === me);
  const budget = own ? own.monthly_micros : (people?.default_micros ?? null);
  const attributed = attributionSlices(usage);
  return {
    month: (mine ?? everyone)?.period ?? new Date().toISOString().slice(0, 7),
    me: mine ? { spentMicros: mine.total_micros, budgetMicros: budget, byKind: mine.by_kind, byAgent: mine.by_agent } : null,
    workspace: mayWorkspace
      ? {
          spentMicros: usage ? (usage.free ? usage.totals.costMicros : usage.totals.priceMicros) : null,
          chargedMicros: limit?.spentMicros ?? null,
          limitMicros: limit ? (limit.spendLimitMicros ?? limit.ceilingMicros) : null,
          agentsMicros: usage ? agentMicros(usage) : (everyone?.total_micros ?? null),
          byAgent: attributed?.agent ?? everyone?.by_agent ?? [],
        }
      : null,
  };
}
