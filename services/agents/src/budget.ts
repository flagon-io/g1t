/**
 * An agent's budget: what it has spent, whether it may reply, and what a
 * reply cost. Pure, so it is tested on its own.
 *
 * Spend is limited at several levels (docs/WORKSPACE.md, "Budgets"). The
 * workspace's own limit and AI credit are billing's, checked by the
 * compute gate. The agent's monthly and daily caps are checked here, from
 * the spend this service rolls up per agent, before anything is reserved.
 * Spend counts what a reply costs at price: the model at the provider's
 * price with billing's model margin, plus g1t's agent rate on every token.
 * The ledger (with comped terms and discounts) is billing's; the agent's
 * cap is about how much work it does, so it counts the list price.
 */
import type { AgentBudget, AgentStatus } from "@g1t/contracts";

import type { TokenPrice } from "../../runner/src/model-env.ts";

/** `2026-10`: the month spend is rolled up under, in UTC. */
export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** `2026-10-08`: the day spend is rolled up under, in UTC. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type Spent = { month: number; day: number };

export type BudgetBlock = { cap: "month" | "day"; message: string };

const capSet = (cap: number | null | undefined): cap is number => typeof cap === "number" && Number.isFinite(cap) && cap > 0;

/**
 * Why the agent may not take another reply on its own budget, as it says
 * so in chat, or null when it may. A cap of zero or null is no cap.
 */
export function budgetBlock(budget: AgentBudget, spent: Spent, now: Date): BudgetBlock | null {
  if (capSet(budget.monthly_micros) && spent.month >= budget.monthly_micros) {
    return {
      cap: "month",
      message: `I'm out of budget for ${MONTHS[now.getUTCMonth()]}. An owner can raise my monthly limit on my profile.`,
    };
  }
  if (capSet(budget.daily_micros) && spent.day >= budget.daily_micros) {
    return {
      cap: "day",
      message: "I've used today's budget. I'll be back tomorrow (UTC), or an owner can raise my daily limit on my profile.",
    };
  }
  return null;
}

/**
 * The most one reply may spend on models, in millionths of a dollar: the
 * lowest of what is left of the agent's month and day, its per-task cap,
 * and the plan's per-run cap. Null when nothing caps it. Never below 1, so
 * a cap is never read as "none".
 */
export function replyCapMicros(budget: AgentBudget, spent: Spent, planRunCapMicros: number | null): number | null {
  const caps: number[] = [];
  if (capSet(budget.monthly_micros)) caps.push(budget.monthly_micros - spent.month);
  if (capSet(budget.daily_micros)) caps.push(budget.daily_micros - spent.day);
  if (capSet(budget.task_micros)) caps.push(budget.task_micros);
  if (capSet(planRunCapMicros)) caps.push(planRunCapMicros);
  return caps.length ? Math.max(1, Math.floor(Math.min(...caps))) : null;
}

/** The tokens one answer used, by kind. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function totalTokens(tokens: Tokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** What `tokens` cost at `price` (dollars per million tokens), in millionths of a dollar. */
export function costMicros(tokens: Tokens, price: TokenPrice | null): number {
  if (!price) return 0;
  const micros = tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * price.cacheWrite;
  return Math.ceil(Math.max(0, micros));
}

/**
 * What a reply counts against the agent's budget: on g1t's models, the
 * model's cost with the model margin; on the workspace's own provider,
 * nothing for the model (the provider bills the workspace). On both, the
 * agent rate (`agent_tokens` or `agent_tokens_own` in the price book, per
 * million tokens) on every token.
 */
export function chargedMicros(input: {
  costMicros: number;
  hosted: boolean;
  marginPercent: number;
  ratePerMillionMicros: number;
  tokens: number;
}): number {
  const model = input.hosted ? Math.ceil((input.costMicros * (100 + Math.max(0, input.marginPercent))) / 100) : 0;
  const rate = Math.ceil((Math.max(0, input.tokens) * Math.max(0, input.ratePerMillionMicros)) / 1_000_000);
  return model + rate;
}

/** The agent's presence, as the Agents page shows it. */
export function agentStatus(input: { busyUntil: string | null; now: Date; blocked: boolean }): AgentStatus {
  if (input.busyUntil && Date.parse(input.busyUntil) > input.now.getTime()) return "working";
  if (input.blocked) return "out_of_budget";
  return "idle";
}
