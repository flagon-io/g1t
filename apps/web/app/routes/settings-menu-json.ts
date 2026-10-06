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

export type AccountMenuData = {
  name: string | null;
  email: string | null;
  /** Invites left, or null when there is no limit (or none can be made yet). */
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
    invites_left: invites?.allowance.limit != null ? (invites.allowance.remaining ?? 0) : null,
  };
  return Response.json(data, { headers: { "cache-control": "private, max-age=60" } });
}
