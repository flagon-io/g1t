/**
 * What the account menu shows under the avatar, fetched when it opens so
 * no page waits on it: the name people see, the primary address, and how
 * many invites are left when there is a limit. Each part is optional: a
 * service that cannot answer leaves its part out.
 */
import type { Route } from "./+types/settings-menu-json";
import { accounts, identity } from "../lib/services.server";
import { getViewer } from "../lib/session.server";
import { loadInvites } from "../lib/invites.server";
import { invitesPage } from "../lib/invites";

export type AccountMenuData = {
  name: string | null;
  email: string | null;
  /** Invites left, or null when there is no limit (or none can be made yet). */
  invites_left: number | null;
  /**
   * Whether the menus list Settings → Invites: while sign-up takes an
   * invite, or, once anyone can sign up, when there are invites already
   * made to look back on (`invitesPage`).
   */
  invites_page: boolean;
};

export async function loader({ context }: Route.LoaderArgs) {
  const user = getViewer(context);
  if (!user) return Response.json(null, { status: 401, headers: { "cache-control": "private, no-store" } });
  const [profile, emails, invites] = await Promise.all([
    identity.profile(user.username).catch(() => null),
    accounts.listEmails(user).catch(() => null),
    loadInvites(user),
  ]);
  const primary = emails?.ok ? (emails.value.emails.find((e) => e.primary)?.email ?? null) : null;
  const data: AccountMenuData = {
    name: profile?.name?.trim() || null,
    email: primary,
    // Nothing to make once anyone can sign up, so no count either.
    invites_left: invites?.mode !== "open" && invites?.allowance.limit != null ? (invites.allowance.remaining ?? 0) : null,
    // An account that cannot list its invites yet (unconfirmed) keeps the page: it says why.
    invites_page: invites ? invitesPage(invites.mode, invites.invites.length).listed : true,
  };
  // Not kept by the browser: the menu asks again after a name, address or
  // invite changes, and a kept copy would show the old one for a minute.
  return Response.json(data, { headers: { "cache-control": "private, no-store" } });
}
