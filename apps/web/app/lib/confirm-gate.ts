/**
 * The confirmation gate: a signed-in person whose account has not confirmed
 * its email address is sent to /confirm-email from every page, except the
 * pages that page needs (confirming by link, signing out and in again,
 * resetting a password) and the public pages about g1t: its policies,
 * security, support, status and prices. No Workers or React imports, so it
 * can be tested under Node.
 */

/** Where an account confirms its address: the code, a new one, a new address. */
export const CONFIRM_PATH = "/confirm-email";

/** Where a person answers the workspace invitations waiting for them. */
export const INVITATIONS_PATH = "/invitations";

/** Pages a pending account can open as they are. */
const OPEN = new Set([
  CONFIRM_PATH,
  // The link in the email, which confirms whoever follows it.
  "/verify",
  "/logout",
  "/login",
  "/login/two-factor",
  "/register",
  "/forgot",
  "/reset",
  // Who makes g1t and the promises it keeps.
  "/policies",
  "/security",
  "/support",
  "/status",
  "/status.json",
  "/pricing",
]);

/** Prefixes of the same: each policy, signing in with GitHub, well-known files. */
const OPEN_UNDER = ["/policies/", "/auth/github", "/.well-known/"];

type Pending = { kind?: string; verified?: boolean } | null | undefined;

/** The page a data request (`/foo.data`, `/_root.data`) is for. */
export function pageOf(pathname: string): string {
  if (!pathname.endsWith(".data")) return pathname;
  const page = pathname.slice(0, -".data".length);
  return page === "/_root" || page === "" ? "/" : page;
}

/** Whether a pending account may open `pathname` as it is. */
export function openWhilePending(pathname: string): boolean {
  const page = pageOf(pathname);
  const path = page.length > 1 ? page.replace(/\/+$/, "") : page;
  return OPEN.has(path) || OPEN_UNDER.some((prefix) => path.startsWith(prefix));
}

/**
 * Where to send `viewer` instead of `pathname` + `search`: the confirmation
 * page, with where they were going as `next`; null when the page is theirs
 * to open (confirmed, signed out, an agent or a workspace, or a page in the
 * list above).
 */
export function confirmGate(pathname: string, search: string, viewer: Pending): string | null {
  if (!viewer || (viewer.kind ?? "user") !== "user" || viewer.verified) return null;
  if (openWhilePending(pathname)) return null;
  const page = pageOf(pathname);
  // A data request's own parameters are not where they were going.
  const params = new URLSearchParams(search);
  params.delete("_routes");
  const query = params.toString();
  const next = page === "/" && !query ? "" : `?next=${encodeURIComponent(page + (query ? `?${query}` : ""))}`;
  return `${CONFIRM_PATH}${next}`;
}

/** What the confirmation page says once a code or link has worked. */
export function confirmedLine(done: { joined?: string | null; invitedTo?: string | null; inviteLapsed?: string | null }): string {
  if (done.inviteLapsed) return done.inviteLapsed;
  if (done.joined) return `Your email address is confirmed, and you have joined ${done.joined}.`;
  if (done.invitedTo) return `Your email address is confirmed. You are invited to join ${done.invitedTo}: accept or decline the invitation next.`;
  return "Your email address is confirmed.";
}

/**
 * Where to go once confirmed: the invitation the invite brought, to accept or
 * decline; else back where they were going, else the workspace joined, else home.
 */
export function afterConfirming(next: string, joined?: string | null, invitedTo?: string | null): string {
  if (invitedTo) return INVITATIONS_PATH;
  if (next && next !== "/") return next;
  return joined ? `/${joined}` : "/";
}
