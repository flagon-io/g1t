/**
 * What a billing form posts back: an error for one section, a change to
 * confirm, or a Stripe billing link to hand on. Shared by the workspace and
 * enterprise pages.
 */
import type { BillingLink, Terms } from "@g1t/contracts";

export type Review =
  | { intent: "terms"; before: Terms; after: Terms; fields: Record<string, string> }
  | { intent: "attach"; workspace: string; targetName: string; fields: Record<string, string> }
  | { intent: "detach"; workspace: string; from: string; fields: Record<string, string> }
  | { intent: "billing-link"; workspace: string; fields: Record<string, string> };

export type ActionData =
  | { error: string; section: string; values?: Record<string, string> }
  | { review: Review }
  | { link: BillingLink; workspace: string };

export type SectionError = { error: string; values?: Record<string, string> } | null;

/** The flash messages a change redirects back with (`?done=`). */
export const DONE: Record<string, string> = {
  terms: "Terms saved. They apply to charges from now on.",
  attach: "Workspace moved onto the enterprise.",
  detach: "Workspace moved off the enterprise. It pays for itself again.",
  credit: "Credit issued.",
  created: "Enterprise created.",
};

export function doneMessage(url: string): string | null {
  const done = new URL(url).searchParams.get("done");
  return done && DONE[done] ? DONE[done] : null;
}
