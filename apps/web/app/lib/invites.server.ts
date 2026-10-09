import type { Invite, InvitesOverview, User } from "@g1t/contracts";

import { type BringInto, bringIntoChoices, inviteDraft, peoplePages } from "./invites";
import { readCookie } from "./mission";
import { billing, identity } from "./services.server";
import { WORKSPACE_COOKIE, chosenWorkspace } from "./workspace-choice";

/** What the Invites section's forms answer. */
export type InviteActionData = { inviteCreated?: Invite; inviteError?: string; inviteRevoked?: boolean } | null;

/**
 * The workspaces an invite to g1t can also invite its person to
 * (`bringIntoChoices`), and the People pages where a workspace invitation
 * is made instead (`peoplePages`).
 */
export type BringIntoChoices = {
  options: BringInto[];
  note: string | null;
  people: { slug: string; name: string; to: string }[];
};

/** A person's invites, or null when they cannot make any yet (email unconfirmed). */
export async function loadInvites(user: User): Promise<InvitesOverview | null> {
  if (!user.verified) return null;
  return identity.listInvites(user).catch(() => null);
}

/**
 * The workspaces an invite can also invite its person to, and the People
 * pages to invite someone to a workspace from, the one the person is in
 * (the shell's current workspace, from its cookie) first. A workspace
 * whose plan cannot be checked is not offered: identity would refuse it.
 */
export async function loadBringInto(user: User, request: Request): Promise<BringIntoChoices> {
  const memberships = user.workspaces ?? [];
  const owned = memberships.filter((m) => m.role === "owner").map((m) => m.slug);
  const free = owned.length > 0 ? await billing.freeWorkspaces(owned).catch(() => owned) : [];
  const current = chosenWorkspace(memberships, readCookie(request.headers.get("cookie"), WORKSPACE_COOKIE))?.slug ?? null;
  return { ...bringIntoChoices(memberships, free, current), people: peoplePages(memberships, current) };
}

/** Handles the Invites section's intents; null for any other intent. */
export async function inviteAction(user: User, form: FormData): Promise<InviteActionData | undefined> {
  switch (form.get("intent")) {
    case "create-invite": {
      // A workspace goes with it only when its box is ticked (`inviteDraft`).
      const result = await identity.createInvite(user, inviteDraft(form));
      return result.ok ? { inviteCreated: result.value } : { inviteError: result.error.message };
    }
    case "revoke-invite": {
      const result = await identity.revokeInvite(user, String(form.get("id") ?? ""));
      return result.ok ? { inviteRevoked: true } : { inviteError: result.error.message };
    }
  }
  return undefined;
}
