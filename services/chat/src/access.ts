/**
 * Who may open a conversation, and who is a guest (docs.g1t.sh/guides/chat/,
 * "Who can see a channel"). Pure, so it is tested apart from the service.
 *
 * A channel is private (only the people in it), kept to its workspace
 * (anyone in it), or public (anyone signed in to g1t). Someone in a
 * workspace's chat who is not a member of the workspace is a guest: asked
 * into a channel, or talking in a public one. Guests never see the rest of
 * the workspace, are never in a direct message, and never talk to @g1t,
 * which works for the workspace's members alone.
 */

import type { ChannelVisibility, User } from "@g1t/contracts";

/** A channel row's say in who may open it. */
export type VisibilityRow = { kind: "channel" | "dm"; private: number; public: number };

export function visibilityOf(row: VisibilityRow): ChannelVisibility {
  if (row.kind === "dm" || row.private) return "private";
  return row.public ? "public" : "workspace";
}

/** The viewer's role in a workspace; null for someone outside it. */
export type Standing = "owner" | "member" | null;

/**
 * Whether someone may read a conversation: anyone in it; else anyone in
 * the workspace when it is kept to the workspace or public; else anyone
 * signed in when it is public. Nothing private without being in it.
 */
export function mayRead(visibility: ChannelVisibility, role: Standing, inIt: boolean): boolean {
  if (inIt) return true;
  if (visibility === "private") return false;
  return visibility === "public" || role !== null;
}

/**
 * Whether someone not yet in a channel may join it on their own: whoever
 * may read it, except someone outside the workspace whom its owners took
 * out of it, and anything archived.
 */
export function mayJoin(visibility: ChannelVisibility, role: Standing, removed: boolean, archived: boolean): boolean {
  if (archived || !mayRead(visibility, role, false)) return false;
  return role !== null || !removed;
}

/**
 * Whether someone may ask people outside the workspace into its channels:
 * owners; members while the workspace lets members invite outside
 * collaborators (Settings, Permissions), as for repositories.
 */
export function mayInviteGuests(viewer: User | null, slug: string): boolean {
  const membership = viewer?.workspaces?.find((m) => m.slug === slug.toLowerCase());
  if (!membership) return false;
  if (membership.role === "owner") return true;
  return membership.privileges?.members_can_invite_outside_collaborators !== false;
}

/**
 * Whether a signed-in viewer may come into a workspace's chat as a guest:
 * a person (not a token for a workspace) whose email address is confirmed,
 * so a public channel is not open to throwaway accounts.
 */
export function mayVisit(viewer: User | null): string | null {
  if (!viewer) return "Sign in to use chat.";
  if (viewer.kind && viewer.kind !== "user") return "Only people can talk in another workspace's channels.";
  if (!viewer.verified) return "Confirm your email address to talk in other workspaces' channels.";
  return null;
}

/**
 * Whether someone may be let in on a request, or asked in: anyone in the
 * channel may add a member of the workspace (as `invite` does); only those
 * who may invite guests may let in someone outside it.
 */
export function mayAdmit(requesterIsMember: boolean, approverInChannel: boolean, approverMayInviteGuests: boolean): boolean {
  if (!approverInChannel) return false;
  return requesterIsMember || approverMayInviteGuests;
}

/** The longest note on a request to join. */
export const MAX_REQUEST_NOTE = 300;

/** A request's note, trimmed and cut to length; null when empty. */
export function requestNote(note: unknown): string | null {
  const text = typeof note === "string" ? note.trim() : "";
  return text ? text.slice(0, MAX_REQUEST_NOTE) : null;
}
