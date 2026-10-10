/**
 * Effort and suggestions, as the pages say them (components/effort.tsx).
 * Pure, so it is tested on its own. Every cost
 * shown comes from the agents service's measured sessions; a level an
 * agent has not run at says so instead of a number.
 */
import type { AgentEffort, AgentEffortCosts, AgentRecommendation, AgentRecommendations, EffortCost, EffortLevel } from "@g1t/contracts";

import { money } from "./money.ts";

export const EFFORT_OPTIONS: { key: AgentEffort; label: string; about: string }[] = [
  { key: "auto", label: "Auto", about: "Picks per piece of work: medium, and high on a session someone has had to steer." },
  { key: "low", label: "Low", about: "The fast tier, light reasoning, up to 5 steps a session. For routine work." },
  { key: "medium", label: "Medium", about: "Starts where the work would, moderate reasoning, up to 8 steps a session." },
  { key: "high", label: "High", about: "The standard tier or above, deep reasoning, up to 10 steps a session." },
  { key: "max", label: "Max", about: "The most capable tier, the most reasoning, up to 12 steps a session." },
];

export function effortLabel(effort: AgentEffort | null | undefined): string {
  return EFFORT_OPTIONS.find((o) => o.key === effort)?.label ?? "Auto";
}

/** An agent's setting from its routing; none is Auto. */
export function effortSetting(routing: { effort?: AgentEffort } | null | undefined): AgentEffort {
  const value = routing?.effort;
  return EFFORT_OPTIONS.some((o) => o.key === value) ? (value as AgentEffort) : "auto";
}

/** One level's measured cost, or null when the agent has not run at it. */
export function costAt(costs: AgentEffortCosts | null, level: EffortLevel): EffortCost | null {
  const found = costs?.levels.find((l) => l.effort === level);
  return found && found.sessions > 0 && found.typical_micros != null ? found : null;
}

/** What a setting has cost per typical task: "$0.42 a typical task, from 14 sessions", or why there is no figure. */
export function costLine(costs: AgentEffortCosts | null, effort: AgentEffort): string {
  if (!costs) return "Costs couldn't be read right now.";
  // Auto runs as medium, and high once steered: its figure is medium's.
  const level: EffortLevel = effort === "auto" ? "medium" : effort;
  const at = costAt(costs, level);
  const days = `in the last ${costs.window_days} days`;
  if (!at) return effort === "auto" ? `No sessions at Medium ${days}, so no figure yet.` : `No sessions at ${effortLabel(effort)} ${days}, so no figure yet.`;
  const sessions = `${at.sessions.toLocaleString("en-US")} session${at.sessions === 1 ? "" : "s"}`;
  return `${money(at.typical_micros!, { precise: true })} a typical task${effort === "auto" ? " at Medium" : ""}, from ${sessions} ${days}`;
}

/** "92%" of sessions finished with nobody stepping in, or empty. */
export function acceptedLabel(cost: EffortCost | null): string {
  return cost?.accepted_share != null ? `${Math.round(cost.accepted_share * 100)}%` : "";
}

/** What the open suggestions together would save a month. */
export function totalSaving(recs: AgentRecommendations | null): number {
  return (recs?.open ?? []).reduce((n, r) => n + (r.saving_month_micros ?? 0), 0);
}

/** "About $31 a month" from a suggestion's measured saving. */
export function savingLabel(rec: Pick<AgentRecommendation, "saving_month_micros">): string {
  return rec.saving_month_micros != null && rec.saving_month_micros > 0 ? `About ${money(rec.saving_month_micros)} a month` : "";
}
