/**
 * Workspace invitations, as the person invited sees them on /invitations
 * and on the page for someone without a workspace. No Workers or React
 * imports, so it can be tested under Node.
 */

type Shown = { role: "owner" | "member"; expiresAt: string };

/** What follows the inviter's name: the role it joins with, and until when it works. */
export function invitationLine(invitation: Shown, now = Date.now()): string {
  const role = invitation.role === "owner" ? "an owner" : "a member";
  const days = Math.ceil((new Date(invitation.expiresAt).getTime() - now) / (24 * 60 * 60 * 1000));
  const until =
    days <= 1 ? "It expires within a day." : `It works for ${days} more days.`;
  return `invited you to join as ${role}. ${until}`;
}

/** What the page says once an invitation was declined. */
export function declinedLine(workspace: string | null | undefined): string {
  const name = workspace?.trim();
  return name
    ? `You declined the invitation to ${name}. Whoever sent it has been told.`
    : "You declined the invitation. Whoever sent it has been told.";
}
