/**
 * Invite a friend (Settings → Invites to g1t): loading a person's invites to
 * g1t and the workspaces one can also invite its person to, and answering
 * the page's forms. Identity checks everything again: people only, a
 * confirmed address, the allowance, and for a workspace, the owner and the
 * paid plan.
 */
import type { Invite, InvitesOverview, User } from "@g1t/contracts";

import { type BringInto, bringIntoChoices, inviteDraft } from "./invites";
import { billing, identity } from "./services.server";

/** What the page's forms answer. */
export type InviteActionData =
  | { done: "created"; invite: Invite }
  | { done: "revoked" | "resent"; id: string }
  | { error: string; intent: string; id?: string }
  | null;

/** A person's invites to g1t, or null when they cannot make any yet (address unconfirmed) or identity did not answer. */
export async function loadInvites(user: User): Promise<InvitesOverview | null> {
  if (!user.verified) return null;
  return identity.listInvites(user).catch(() => null);
}

/**
 * The workspaces an invite to g1t can also invite its person to: the ones
 * the person owns on a paid plan. A workspace whose plan cannot be checked
 * is not offered, since identity would refuse it.
 */
export async function loadBringInto(user: User): Promise<BringInto[]> {
  const memberships = user.workspaces ?? [];
  const owned = memberships.filter((m) => m.role === "owner").map((m) => m.slug);
  if (owned.length === 0) return [];
  const free = await billing.freeWorkspaces(owned).catch(() => owned);
  return bringIntoChoices(memberships, free);
}

/** Handles the page's intents: create, revoke and resend. Null for any other intent. */
export async function inviteAction(user: User, form: FormData): Promise<InviteActionData> {
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "").trim();
  switch (intent) {
    case "create-invite": {
      // A workspace goes with it only when its box is ticked and it is one offered.
      const draft = inviteDraft(form, await loadBringInto(user));
      if (!draft.email) return { error: "Enter your friend's email address.", intent };
      const result = await identity.createInvite(user, draft);
      return result.ok ? { done: "created", invite: result.value } : { error: result.error.message, intent };
    }
    case "revoke-invite":
    case "resend-invite": {
      if (!id) return { error: "Which invite?", intent };
      const result = intent === "revoke-invite" ? await identity.revokeInvite(user, id) : await identity.resendInvite(user, id);
      if (!result.ok) return { error: result.error.message, intent, id };
      return { done: intent === "revoke-invite" ? "revoked" : "resent", id };
    }
  }
  return null;
}
