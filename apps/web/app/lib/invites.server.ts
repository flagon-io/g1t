import type { Invite, InvitesOverview, User } from "@g1t/contracts";

import { type BringInto, bringIntoChoices } from "./invites";
import { readCookie } from "./mission";
import { billing, identity } from "./services.server";
import { WORKSPACE_COOKIE, chosenWorkspace } from "./workspace-choice";

/** What the Invites section's forms answer. */
export type InviteActionData = { inviteCreated?: Invite; inviteError?: string; inviteRevoked?: boolean } | null;

/** The Invites section's "Bring them into" choices (`bringIntoChoices`). */
export type BringIntoChoices = { options: BringInto[]; chosen: string; note: string | null };

/** A person's invites, or null when they cannot make any yet (email unconfirmed). */
export async function loadInvites(user: User): Promise<InvitesOverview | null> {
  if (!user.verified) return null;
  return identity.listInvites(user).catch(() => null);
}

/**
 * The workspaces an invite can bring its person into, with the one the
 * person is in (the shell's current workspace, from its cookie) chosen
 * when it is one of them. A workspace whose plan cannot be checked is not
 * offered: identity would refuse it.
 */
export async function loadBringInto(user: User, request: Request): Promise<BringIntoChoices> {
  const memberships = user.workspaces ?? [];
  const owned = memberships.filter((m) => m.role === "owner").map((m) => m.slug);
  const free = owned.length > 0 ? await billing.freeWorkspaces(owned).catch(() => owned) : [];
  const current = chosenWorkspace(memberships, readCookie(request.headers.get("cookie"), WORKSPACE_COOKIE))?.slug ?? null;
  return bringIntoChoices(memberships, free, current);
}

/** Handles the Invites section's intents; null for any other intent. */
export async function inviteAction(user: User, form: FormData): Promise<InviteActionData | undefined> {
  switch (form.get("intent")) {
    case "create-invite": {
      const email = String(form.get("email") ?? "").trim();
      const workspace = String(form.get("charge") ?? "").trim();
      const join = String(form.get("join") ?? "").trim();
      const result = await identity.createInvite(user, {
        email: email || null,
        workspace: workspace && workspace !== "mine" ? workspace : null,
        join: join || null,
      });
      return result.ok ? { inviteCreated: result.value } : { inviteError: result.error.message };
    }
    case "revoke-invite": {
      const result = await identity.revokeInvite(user, String(form.get("id") ?? ""));
      return result.ok ? { inviteRevoked: true } : { inviteError: result.error.message };
    }
  }
  return undefined;
}
