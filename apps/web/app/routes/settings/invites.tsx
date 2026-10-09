import type { Route } from "./+types/invites";
import { page } from "../../lib/meta";
import { assertSameOrigin, requireUser } from "../../lib/session.server";
import { InvitesSection } from "../../components/invites-section";
import { inviteAction, loadBringInto, loadInvites } from "../../lib/invites.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Invites · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const [invites, bringInto] = await Promise.all([loadInvites(user), loadBringInto(user, request)]);
  return { invites, bringInto, origin: new URL(request.url).origin };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  // Making and revoking invites (lib/invites.server.ts).
  const done = await inviteAction(user, form);
  return { inviteCreated: done?.inviteCreated, inviteError: done?.inviteError };
}

export default function InviteSettings({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <InvitesSection
      overview={loaderData.invites}
      origin={loaderData.origin}
      bringInto={loaderData.bringInto}
      created={actionData?.inviteCreated}
      error={actionData?.inviteError}
    />
  );
}
