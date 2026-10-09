import { redirect } from "react-router";

import type { User, WorkspaceInvitation } from "@g1t/contracts";

import { identity } from "./services.server";
import { rememberWorkspace } from "./workspace-choice";
import { safeNext } from "./next";

/** The workspace invitations waiting for `user`'s answer; empty when they cannot be read. */
export async function loadInvitations(user: User): Promise<WorkspaceInvitation[]> {
  if (!user.verified) return [];
  return identity.listInvitations(user).catch(() => []);
}

/** What answering an invitation says back, when it does not move on. */
export type InvitationAnswer = { invitationError?: string; invitationId?: string; declined?: string } | undefined;

/**
 * Answers an invitation from a posted form (`intent` accept or decline,
 * `id`). Accepting lands in the workspace joined, made the one the sidebar
 * is about, or in `next` when they were on their way somewhere. Undefined
 * for any other intent.
 */
export async function answerInvitation(user: User, form: FormData, request: Request): Promise<InvitationAnswer> {
  const intent = form.get("intent");
  const id = String(form.get("id") ?? "");
  if (intent === "accept-invitation") {
    const result = await identity.acceptInvitation(user, id);
    if (!result.ok) return { invitationError: result.error.message, invitationId: id };
    const secure = new URL(request.url).protocol === "https:";
    const next = safeNext(String(form.get("next") ?? ""));
    throw redirect(next !== "/" ? next : `/${result.value}`, {
      headers: { "set-cookie": rememberWorkspace(result.value, secure) },
    });
  }
  if (intent === "decline-invitation") {
    const result = await identity.declineInvitation(user, id);
    if (!result.ok) return { invitationError: result.error.message, invitationId: id };
    return { declined: String(form.get("workspace") ?? "") };
  }
  return undefined;
}
