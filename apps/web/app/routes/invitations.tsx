import { Link } from "react-router";

import type { Route } from "./+types/invitations";
import { InvitationList } from "../components/invitation-list";
import { answerInvitation, loadInvitations } from "../lib/invitations.server";
import { declinedLine } from "../lib/invitations";
import { page } from "../lib/meta";
import { assertSameOrigin, nextPath, requireUser } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Invitations · g1t" });
}

/**
 * The workspace invitations waiting for the signed-in person's answer.
 * Nobody joins a workspace without saying yes here (or on the invite's own
 * page). Linked from the inbox item and the invitation email.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const next = nextPath(request);
  return {
    invitations: await loadInvitations(user),
    hasWorkspace: (user.workspaces ?? []).length > 0,
    next: next === "/" ? null : next,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  return (await answerInvitation(user, await request.formData(), request)) ?? null;
}

export default function Invitations({ loaderData, actionData }: Route.ComponentProps) {
  const { invitations, hasWorkspace, next } = loaderData;
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-xl font-semibold">Invitations</h1>
      <p className="mt-2 text-sm text-muted">
        Workspaces you are invited to join. You join one only when you accept; declining tells whoever invited you.
      </p>
      {actionData?.declined !== undefined && (
        <p className="mt-4 text-sm text-muted" role="status">
          {declinedLine(actionData.declined)}
        </p>
      )}
      <div className="mt-6">
        {invitations.length > 0 ? (
          <InvitationList
            invitations={invitations}
            error={actionData?.invitationError}
            errorFor={actionData?.invitationId}
            next={next}
          />
        ) : (
          <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
            <p className="text-sm font-medium">No invitations waiting</p>
            <p className="mt-1 text-sm text-muted">
              {hasWorkspace ? (
                <>
                  When someone invites you to a workspace, it shows here and in your{" "}
                  <Link to="/notifications" className="underline underline-offset-4 hover:text-fg">
                    notifications
                  </Link>
                  .
                </>
              ) : (
                <>
                  <Link to="/workspaces/new" className="underline underline-offset-4 hover:text-fg">
                    Create your workspace
                  </Link>
                  , or ask a workspace's owners to invite you by your username.
                </>
              )}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
