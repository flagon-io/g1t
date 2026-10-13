/**
 * The Invites page: every invite, to find and revoke one, with invites to
 * g1t from Invite a friend on their own tab, and more of those for a
 * person. Anyone may register, so there is no waitlist and no shared link
 * to manage; an invite is never needed to sign up. No Workers imports, so
 * it can be tested under Node. Identity checks everything again.
 */

/** The page's tabs: every invite, or only invites to g1t (Invite a friend). */
export type InvitesTab = "all" | "g1t";

export function invitesTab(raw: string | null | undefined): InvitesTab {
  return raw === "g1t" ? "g1t" : "all";
}

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
  granted: "Granted. It applies at once.",
};

/** The flash for `?done=`. */
export function doneMessage(done: string | null): string | null {
  return done ? (INVITES_DONE[done] ?? null) : null;
}

/** What an account made with a shared link, before registration opened, says about where it came from. */
export function joinedThrough(label: string): string {
  return `Joined through ${label}`;
}

/** The most invites one grant gives or takes back (`MAX_INVITE_GRANT` in the contracts). */
export const MAX_GRANT = 1000;

const USERNAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

export type Grant = { username: string; amount: number; note: string };

/** A grant of invites to g1t, as typed: who, how many (negative takes back), and why. */
export function parseGrant(form: { get(name: string): unknown }): { ok: true; value: Grant } | { ok: false; error: string } {
  const read = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const username = read("username").replace(/^@/, "").toLowerCase();
  if (!USERNAME.test(username)) return { ok: false, error: `“${read("username")}” is not a username.` };
  const raw = read("amount");
  if (!/^-?\d+$/.test(raw)) return { ok: false, error: "Give a whole number of invites, such as 10, or -5 to take some back." };
  const amount = Number(raw);
  if (amount === 0 || Math.abs(amount) > MAX_GRANT) return { ok: false, error: `Grant between 1 and ${MAX_GRANT} invites.` };
  const note = read("note");
  if (note.length < 3) return { ok: false, error: "Say why, for the record." };
  return { ok: true, value: { username, amount, note: note.slice(0, 500) } };
}
