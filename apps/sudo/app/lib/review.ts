/**
 * What a billing form posts back: an error for one section, a change to
 * confirm, or a result to show once (a Stripe billing link, an invoice).
 * Shared by the workspace and enterprise pages.
 */
import type { BillingLink, EnterpriseInvoice, Terms } from "@g1t/contracts";

export type Review =
  | { intent: "terms"; before: Terms; after: Terms; fields: Record<string, string> }
  | { intent: "attach"; workspace: string; targetName: string; fields: Record<string, string> }
  | { intent: "detach"; workspace: string; from: string; fields: Record<string, string> }
  | { intent: "billing-link"; workspace: string; fields: Record<string, string> }
  | { intent: "billing-email"; name: string; before: string | null; after: string; fields: Record<string, string> }
  | { intent: "invoice"; name: string; email: string | null; workspaces: number; fields: Record<string, string> };

export type ActionData =
  | { error: string; section: string; values?: Record<string, string> }
  | { review: Review }
  | { link: BillingLink; workspace: string }
  | { invoice: EnterpriseInvoice };

export type SectionError = { error: string; values?: Record<string, string> } | null;

/** The flash messages a change redirects back with (`?done=`). */
export const DONE: Record<string, string> = {
  terms: "Terms saved. They apply to charges from now on.",
  allowances: "Plan, pools and caps saved. They apply from now on.",
  attach: "Workspace moved onto the enterprise.",
  detach: "Workspace moved off the enterprise. It pays for itself again.",
  credit: "Credit given. It is on the balance and the statement, and the owners were emailed.",
  revoked: "What was left of the credit was taken back. It is on the statement and in the audit log.",
  reset: "Billing reset. The workspace starts again as a new customer, and the costs analysis ran again, so every figure is fresh.",
  "reset-stale": "Billing reset. The workspace starts again as a new customer; the costs analysis did not finish, so press Run the analysis now on Costs & margin.",
  created: "Enterprise created.",
  "billing-email": "Saved where the enterprise's invoices go.",
  "billing-address": "Billing address saved on its Stripe customer. Its invoices are taxed from it.",
  sales: "Sales record saved.",
  note: "Note added.",
  payment: "Payment recorded. It is on the workspace's statement and counts toward its limit.",
  approved: "Approved. The owner is told in the app and by email.",
  declined: "Declined. The owner is told why, in the app and by email.",
  goodwill: "Goodwill credit given. It is on the statement and in the audit log.",
};

/** The `?done=` key, if it is one sudo knows. */
export function doneKey(url: string): string | null {
  const done = new URL(url).searchParams.get("done");
  return done && DONE[done] ? done : null;
}

export function doneMessage(url: string): string | null {
  const done = new URL(url).searchParams.get("done");
  return done && DONE[done] ? DONE[done] : null;
}
