/**
 * Moving workspaces off Stripe's test mode before the live key: what a
 * detach's result says, as plain lines. No Workers imports, so it is tested.
 */
import type { WorkspaceDetach } from "@g1t/contracts";

import { usd } from "./money.ts";

/** The slugs left alone by "Detach every workspace" unless staff change them. */
export const DEFAULT_EXCLUDED = ["syntaqx", "flagon-io"];

/** What staff type to detach every workspace (billing checks it too). */
export const CONFIRM_ALL = "detach";

/** "syntaqx, flagon-io" or "syntaqx flagon-io" as slugs; blank is none. */
export function parseExclude(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((slug) => slug.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Each change a detach makes to a workspace, in the order it makes them. */
export function detachChanges(row: WorkspaceDetach): string[] {
  const out: string[] = [];
  if (row.customer || row.card_cached) out.push(`Customer${row.card ? ` and card ${row.card}` : ""} forgotten`);
  if (row.subscriptions > 0) out.push(`${count(row.subscriptions, "plan", "plans")} canceled`);
  if (row.card_checks > 0) out.push(`${count(row.card_checks, "card check", "card checks")} removed (trial kept)`);
  if (row.checkouts > 0) out.push(`${count(row.checkouts, "open checkout", "open checkouts")} removed`);
  if (row.ai_reload) out.push("AI auto-reload off");
  if (row.autopay_cleared) out.push("Declined autopay cleared");
  if (row.invoices_voided > 0) out.push(`${count(row.invoices_voided, "invoice", "invoices")} void`);
  if (row.months_skipped.length > 0) out.push(`${row.months_skipped.join(", ")} closed as skipped`);
  if (row.credit_grants_closed > 0) {
    out.push(`${count(row.credit_grants_closed, "AI credit grant", "AI credit grants")} closed (${usd(row.credit_closed_micros, { cents: true })} unused)`);
  }
  if (row.payments_reversed_micros > 0) out.push(`${usd(row.payments_reversed_micros, { cents: true })} of test payments reversed`);
  if (row.plan_payments_reversed_micros > 0) out.push(`${usd(row.plan_payments_reversed_micros, { cents: true })} of test plan payments reversed`);
  if (row.written_off_micros > 0) out.push(`${usd(row.written_off_micros, { cents: true })} owed written off as goodwill`);
  if (row.pending_months_marked > 0) {
    out.push(
      `${count(row.pending_months_marked, "metered figure", "metered figures")} of past months never charged (${usd(row.pending_marked_micros, { cents: true })})`,
    );
  }
  if (row.pending_baselined > 0) {
    out.push(
      `This month's ${count(row.pending_baselined, "metered figure", "metered figures")} so far never charged (${usd(row.pending_baselined_micros, { cents: true })})`,
    );
  }
  if (row.plan_credit_cleared_micros > 0) out.push(`${usd(row.plan_credit_cleared_micros, { cents: true })} of this month's included usage restored`);
  if (row.dispute_owed_cleared_micros > 0) out.push(`${usd(row.dispute_owed_cleared_micros, { cents: true })} owed for lost test disputes cleared`);
  if (row.disputes_closed > 0) out.push(`${count(row.disputes_closed, "open test dispute", "open test disputes")} closed`);
  if (row.stripe_canceled > 0) out.push(`${count(row.stripe_canceled, "subscription", "subscriptions")} canceled at Stripe`);
  for (const error of row.stripe_errors) out.push(`Stripe refused: ${error}`);
  return out;
}
