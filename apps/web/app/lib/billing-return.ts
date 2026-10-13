/**
 * What the billing page says on the way back from Stripe's payment pages.
 * A card payment usually clears on the way back; a bank transfer, or a
 * payment the bank holds for a check, has not yet. Pure, so it can be
 * tested.
 */
import type { FeatureState, LedgerEntry } from "@g1t/contracts";

/**
 * Back from a plan's payment page: done once the plan is on; otherwise
 * that the payment did not go through, or has not cleared yet.
 */
export function planReturnNotice(state: FeatureState | null, done: "subscribed" | "security_on"): string {
  const security = done === "security_on";
  if (state?.on)
    return security ? "Security and quality is on for every private repository in the workspace." : "The g1t plan is on.";
  const name = security ? "Security and quality" : "The g1t plan";
  if (state?.subscription?.status === "past_due")
    return `The payment did not go through. Choose Update payment method on the plan; ${name.charAt(0).toLowerCase()}${name.slice(1)} starts once a payment clears.`;
  return `Payment pending. ${name} starts once the payment clears, and this page shows it the next time it loads.`;
}

/**
 * Back from a prepayment's page: whether it was credited, from the balance
 * before and after, or a payment in advance entered in the last half hour
 * (Stripe's webhook may have got there first).
 */
export function prepaymentSettled(before: number | null, after: number, ledger: LedgerEntry[] | null, now = Date.now()): boolean {
  if (before != null && after > before) return true;
  return (ledger ?? []).some(
    (entry) => entry.kind === "top_up" && entry.amountMicros > 0 && now - Date.parse(entry.createdAt) < 30 * 60_000,
  );
}
