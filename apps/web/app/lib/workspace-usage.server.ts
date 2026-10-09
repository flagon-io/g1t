import type { User } from "@g1t/contracts";

import { planStatus, type UsageGlance, usageGlance } from "./billing";
import { billing } from "./services.server";

/** The trial as published, when the price book cannot be read. */
const DEFAULT_TRIAL_MICROS = 5_000_000;

/**
 * The month for the Usage card, for members only: what was spent, what
 * pays first and what it went on. Fetched here, not with the sidebar, so
 * only this page pays for it; a billing service that cannot answer leaves
 * the card out rather than the page.
 */
export async function usageFor(slug: string, viewer: User | null): Promise<UsageGlance | null> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [account, usage, features, entitlements, limit, book] = await Promise.all([
    billing.account(slug, viewer).catch(() => null),
    billing.usage(slug, viewer, monthStart).catch(() => null),
    billing.features(slug, viewer).catch(() => null),
    billing.entitlements(slug).catch(() => null),
    billing.limit(slug, viewer).catch(() => null),
    billing.prices().catch(() => null),
  ]);
  if (!account?.ok || !usage?.ok) return null;
  // Without payments set up (a g1t run without billing), there is no plan to show.
  if (!account.value.status.enabled && !usage.value.free) return null;
  const plan = features?.ok ? (features.value.find((state) => state.plan.feature === "plan") ?? null) : null;
  return usageGlance({
    usage: usage.value,
    status: planStatus(plan, entitlements),
    entitlements,
    limit: limit?.ok ? limit.value : null,
    trialMicros: book?.free?.trialWorkspaceMicros ?? DEFAULT_TRIAL_MICROS,
  });
}

