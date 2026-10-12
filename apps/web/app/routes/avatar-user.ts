/**
 * A person's uploaded avatar by username, for the places that know who
 * someone is only by name (components/ui/avatar.tsx): a redirect to the
 * picture on the usercontent origin, or not found when they have none.
 * People only: identity's profiles are accounts, never workspaces, so a
 * workspace's icon is never drawn as a person's face. Public, as the
 * profile is, and kept five minutes.
 */
import type { Route } from "./+types/avatar-user";
import { avatarUrl } from "../components/ui/avatar";
import { addresses } from "../lib/addresses.server";
import { identity } from "../lib/services.server";

const CACHE = "public, max-age=300";

export async function loader({ params }: Route.LoaderArgs) {
  const username = params.username;
  const profile = /^[a-z0-9-]{1,39}$/i.test(username) ? await identity.profile(username).catch(() => null) : null;
  if (!profile?.avatar) return new Response(null, { status: 404, headers: { "cache-control": CACHE } });
  return new Response(null, {
    status: 302,
    headers: { location: avatarUrl(profile.avatar, addresses().usercontent), "cache-control": CACHE },
  });
}
