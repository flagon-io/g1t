/**
 * What the account menu shows under the avatar, fetched when it opens so
 * no page waits on it: the name people see, the primary address, and how
 * many friends the person can still invite to g1t. Each part is optional:
 * a service that cannot answer leaves its part out.
 */
import type { Route } from "./+types/settings-menu-json";
import { accounts, identity } from "../lib/services.server";
import { getViewer } from "../lib/session.server";
import { loadInvites } from "../lib/invites.server";

export type AccountMenuData = {
  name: string | null;
  email: string | null;
  /** Invites to g1t left (Invite a friend), or null when not known (address unconfirmed, or identity did not answer). */
  invites_left: number | null;
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
    invites_left: invites?.allowance.remaining ?? null,
  };
  // Not kept by the browser: the menu asks again after a name, address or
  // invite changes, and a kept copy would show the old one for a minute.
  return Response.json(data, { headers: { "cache-control": "private, no-store" } });
}
