/**
 * Which model a reply runs on. Pure, so it is tested on its own.
 *
 * Nobody picks a model: g1t routes each step to the tier it needs (chat
 * replies start on `small`), and the agent's definition only limits that
 * (docs.g1t.sh/guides/agents/, "Model routing"). The model behind each tier
 * is the runner's routing policy (`AGENT_ROUTING`, with staff's defaults on
 * top), read through the runner's own module so the two never disagree.
 */
import type { AgentEffort, AgentRouting as AgentLimits, EffortLevel, ModelTier } from "@g1t/contracts";

import type { AgentRouting as Policy, TokenPrice } from "../../runner/src/model-env.ts";

const ORDER: ModelTier[] = ["small", "large", "frontier"];

/** Where a chat reply starts before the agent's limits apply. */
export const REPLY_TIER: ModelTier = "small";

export function isTier(value: unknown): value is ModelTier {
  return value === "small" || value === "large" || value === "frontier";
}

/**
 * `tier` held between the agent's floor and ceiling. When a definition
 * has the floor above the ceiling (saved before validation said no, or
 * edited by hand), the ceiling wins: it is the spending rail, and a rail
 * is never crossed to honour a preference.
 */
export function clampTier(tier: ModelTier, floor: ModelTier | null, ceiling: ModelTier | null): ModelTier {
  let at = ORDER.indexOf(tier);
  if (floor && ORDER.indexOf(floor) > at) at = ORDER.indexOf(floor);
  if (ceiling && ORDER.indexOf(ceiling) < at) at = ORDER.indexOf(ceiling);
  return ORDER[at];
}

/** Whether a floor and a ceiling can both hold. */
export function limitsAgree(floor: ModelTier | null, ceiling: ModelTier | null): boolean {
  return !floor || !ceiling || ORDER.indexOf(floor) <= ORDER.indexOf(ceiling);
}

/** The word the agent's `providers` list uses for g1t's hosted models. */
export const HOSTED = "g1t";
/** The word the agent's `providers` list uses for the workspace's own providers, whichever they are. */
export const OWN = "workspace";

/**
 * Where an agent's model calls may go: g1t's hosted models, the
 * workspace's own provider, or both. `providers` empty means whatever the
 * workspace allows; `g1t` is g1t's hosted models, `workspace` any of the
 * workspace's own providers, and anything else one of them by integration
 * id. `ownId` is the workspace's own model connection, if it has one.
 */
export function allowedProviders(limits: Pick<AgentLimits, "providers">, ownId: string | null): { hosted: boolean; own: boolean } {
  const list = (limits.providers ?? []).map((p) => p.trim()).filter(Boolean);
  if (!list.length) return { hosted: true, own: ownId != null };
  return { hosted: list.includes(HOSTED), own: ownId != null && (list.includes(OWN) || list.includes(ownId)) };
}

/** The model a pinned `provider/model` names, or null. */
export function pinnedModel(pinned: string | null | undefined): string | null {
  if (!pinned) return null;
  const at = pinned.indexOf("/");
  const model = (at >= 0 ? pinned.slice(at + 1) : pinned).trim();
  return model || null;
}

export type ReplyModel = {
  tier: ModelTier;
  /** Sent to the provider. */
  model: string;
  /** Shown to people and on the bill. */
  modelName: string;
  /** The provider's list price, when g1t knows it. */
  price: TokenPrice | null;
};

/**
 * The model a reply runs on: the reply tier (or `start`, where the work
 * calls for another, or the tier the workspace chose for replies), held to
 * the agent's limits, and the model the policy
 * puts behind it. A pinned model, or a workspace route that names its own
 * model, replaces the tier's model; it is not priced here, since it runs on
 * the workspace's provider.
 */
export function replyModel(
  policy: Pick<Policy, "tiers">,
  limits: Pick<AgentLimits, "floor" | "ceiling" | "pinned">,
  options: { chosen?: ModelTier | null; named?: string | null; start?: ModelTier } = {},
): ReplyModel {
  const start = options.chosen && isTier(options.chosen) ? options.chosen : (options.start ?? REPLY_TIER);
  const tier = clampTier(start, limits.floor, limits.ceiling);
  const named = options.named || pinnedModel(limits.pinned);
  if (named) return { tier, model: named, modelName: named, price: null };
  const route = policy.tiers[tier];
  return { tier, model: route.model, modelName: route.modelName, price: route.price ?? null };
}

/**
 * How hard an agent works (docs.g1t.sh/guides/agents/#effort): one setting
 * that moves three things together, so nobody tunes them apart.
 *
 * | Setting | Starts on | Reasoning | A session's steps |
 * | --- | --- | --- | --- |
 * | low | small | low | 5 |
 * | medium | where the work starts | medium | 8 |
 * | high | large or above | high | 10 |
 * | max | frontier | max | 12 |
 *
 * `auto` runs replies and sessions at medium, and a session at high once a
 * person has had to steer it. The agent's floor and ceiling hold over all
 * of it: the ceiling is the spending rail.
 */
export type EffortPlan = {
  /** The level the work runs at, as recorded. */
  level: EffortLevel;
  /** The tier it starts on, before the floor and ceiling. */
  start: ModelTier;
  /** A session's step limit at this level. */
  steps: number;
};

export const SESSION_STEPS: Record<EffortLevel, number> = { low: 5, medium: 8, high: 10, max: 12 };

const LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

export function isEffort(value: unknown): value is AgentEffort {
  return value === "auto" || isLevel(value);
}

export function isLevel(value: unknown): value is EffortLevel {
  return LEVELS.includes(value as EffortLevel);
}

/** The setting an agent's routing names; anything else, or none, is `auto`. */
export function effortOf(routing: Pick<AgentLimits, "effort"> | null | undefined): AgentEffort {
  const value = routing?.effort;
  return isEffort(value) ? value : "auto";
}

/**
 * What a setting means for one piece of work. `base` is where the work
 * would start on its own (`REPLY_TIER` for a reply, `large` for a session
 * step, higher for @g1t in a long thread); `raised` is a session someone
 * had to steer, which Auto works harder on.
 */
export function effortPlan(setting: AgentEffort | null | undefined, base: ModelTier, options: { raised?: boolean } = {}): EffortPlan {
  const level: EffortLevel = !setting || setting === "auto" ? (options.raised ? "high" : "medium") : setting;
  let start = base;
  if (level === "low") start = "small";
  else if (level === "max") start = "frontier";
  else if (level === "high" && ORDER.indexOf(base) < ORDER.indexOf("large")) start = "large";
  return { level, start, steps: SESSION_STEPS[level] };
}

/**
 * The reasoning effort sent with a request (`output_config.effort`): only
 * on g1t's tiers whose model takes it (the catalogue's `effort`
 * capability; a route from configuration says nothing, so it is sent, as
 * the runner does), never to a model a workspace's own route names.
 */
export function reasoningEffort(level: EffortLevel, route: { capabilities?: string[] } | null, named: boolean): EffortLevel | null {
  if (named || !route) return null;
  if (route.capabilities && !route.capabilities.includes("effort")) return null;
  return level;
}

/** The higher of two levels, for a session Auto raised partway. */
export function higherEffort(a: EffortLevel | null, b: EffortLevel): EffortLevel {
  return a && LEVELS.indexOf(a) > LEVELS.indexOf(b) ? a : b;
}

/** The level below, or null at the bottom. */
export function lowerEffort(level: EffortLevel): EffortLevel | null {
  const at = LEVELS.indexOf(level);
  return at > 0 ? LEVELS[at - 1] : null;
}
