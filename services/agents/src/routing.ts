/**
 * Which model a reply runs on. Pure, so it is tested on its own.
 *
 * Nobody picks a model: g1t routes each step to the tier it needs (chat
 * replies start on `small`), and the agent's definition only limits that
 * (docs.g1t.sh/guides/agents/, "Model routing"). The model behind each tier
 * is the runner's routing policy (`AGENT_ROUTING`, with staff's defaults on
 * top), read through the runner's own module so the two never disagree.
 */
import type { AgentRouting as AgentLimits, ModelTier } from "@g1t/contracts";

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
