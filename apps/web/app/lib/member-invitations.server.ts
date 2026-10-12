/**
 * What the Invite dialog and the Invitations page post, answered the same
 * way from whichever page they are on (Members, Invitations): inviting
 * someone, sending an invitation again, and revoking one. Identity checks
 * the owner, the plan and the invite allowance again. Answering an
 * invitation of your own is lib/invitations.server.ts.
 */
import type { User } from "@g1t/contracts";

import type { InvitationResult, InviteResult } from "./invites";
import { inviteTarget } from "./people-search";
import { identity } from "./services.server";

/**
 * Invites whoever the form names (`member`: a username or an address) with
 * `role` and an optional `message`. Nobody joins without saying yes: a
 * username or an address gets an invitation to accept or decline.
 */
export async function inviteFromForm(user: User, slug: string, form: FormData): Promise<InviteResult> {
  const member = String(form.get("member") ?? "").trim();
  const who = inviteTarget(member);
  if (!who) return { error: "Enter a g1t username or an email address." };
  const role = form.get("role") === "owner" ? "owner" : "member";
  const message = String(form.get("message") ?? "").trim() || null;
  const result = await identity.inviteMember(user, slug, { ...who, role, message });
  if (!result.ok) return { error: result.error.message };
  return { invited: "email" in who ? who.email : `@${who.username}` };
}

/** `action=revoke-invite` or `action=resend-invite`, with the invitation's `id`; null for anything else. */
export async function invitationFromForm(user: User, slug: string, form: FormData): Promise<InvitationResult | null> {
  const action = form.get("action");
  const id = String(form.get("id") ?? "").trim();
  if (action !== "revoke-invite" && action !== "resend-invite") return null;
  if (!id) return { error: "Which invitation?", id };
  const result =
    action === "revoke-invite" ? await identity.revokeWorkspaceInvite(user, slug, id) : await identity.resendWorkspaceInvite(user, slug, id);
  if (!result.ok) return { error: result.error.message, id };
  return { done: action === "revoke-invite" ? "revoked" : "resent", id };
}
