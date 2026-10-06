import type { Invite, InvitesOverview, User } from "@g1t/contracts";

import { identity } from "./services.server";

/** What the Invites section's forms answer. */
export type InviteActionData = { inviteCreated?: Invite; inviteError?: string; inviteRevoked?: boolean } | null;

/** A person's invites, or null when they cannot make any yet (email unconfirmed). */
export async function loadInvites(user: User): Promise<InvitesOverview | null> {
  if (!user.verified) return null;
  return identity.listInvites(user).catch(() => null);
}

/** Handles the Invites section's intents; null for any other intent. */
export async function inviteAction(user: User, form: FormData): Promise<InviteActionData | undefined> {
  switch (form.get("intent")) {
    case "create-invite": {
      const email = String(form.get("email") ?? "").trim();
      const workspace = String(form.get("charge") ?? "").trim();
      const result = await identity.createInvite(user, {
        email: email || null,
        workspace: workspace && workspace !== "mine" ? workspace : null,
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
