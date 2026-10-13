import type { Route } from "./+types/invites";
import { page } from "../../lib/meta";
import { assertSameOrigin, requireUser } from "../../lib/session.server";
import { InvitesSection } from "../../components/invites-section";
import { inviteAction, loadBringInto, loadInvites } from "../../lib/invites.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Invites to g1t · Settings · g1t" });
}

/** Invite a friend: your invites to g1t, how many are left, and who joined. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const url = new URL(request.url);
  const [invites, bringInto] = await Promise.all([loadInvites(user), loadBringInto(user).catch(() => [])]);
  // `?new` comes from the account menu's Invite a friend: the dialog opens at once.
  return { invites, bringInto, origin: url.origin, openOnLoad: url.searchParams.has("new") };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  // Making, revoking and resending invites (lib/invites.server.ts).
  return inviteAction(user, await request.formData());
}

export default function InviteSettings({ loaderData }: Route.ComponentProps) {
  return (
    <InvitesSection
      overview={loaderData.invites}
      bringInto={loaderData.bringInto}
      origin={loaderData.origin}
      openOnLoad={loaderData.openOnLoad}
    />
  );
}
