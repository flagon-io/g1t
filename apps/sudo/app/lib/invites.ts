/**
 * The Invites page: every invitation sent to an address, to find and
 * revoke one. Anyone may register, so there is no waitlist, no allowance
 * and no shared link to manage. No Workers imports, so it can be tested
 * under Node. Identity checks everything again.
 */

/** The page's address, with its search. */
export function invitesHref(params: Record<string, string | null | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `/invites?${query}` : "/invites";
}

/** The flash messages the page redirects back with (`?done=`). */
export const INVITES_DONE: Record<string, string> = {
  revoked: "Invite revoked. It stops working at once.",
};

/** The flash for `?done=`. */
export function doneMessage(done: string | null): string | null {
  return done ? (INVITES_DONE[done] ?? null) : null;
}

/** What an account made with a shared link, before registration opened, says about where it came from. */
export function joinedThrough(label: string): string {
  return `Joined through ${label}`;
}
