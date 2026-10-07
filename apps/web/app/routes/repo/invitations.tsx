import { Box, CircleAlert, MailOpen } from "lucide-react";
import { Form, data, redirect } from "react-router";

import { REPO_ROLE_LABELS, REPO_ROLE_SUMMARIES } from "@g1t/contracts";

import type { Route } from "./+types/invitations";
import { Avatar, ButtonLink, ErrorText, SubmitButton, usePending } from "../../components/ui";
import { page } from "../../lib/meta";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Invitation · ${params.owner}/${params.repo} · g1t` });
}

/** The viewer's pending invitation to this repository, if they have one. */
async function invitationTo(user: Parameters<typeof identity.myRepoInvitations>[0], owner: string, repo: string) {
  const full = `${owner}/${repo}`.toLowerCase();
  const mine = await identity.myRepoInvitations(user);
  return mine.find((invitation) => invitation.repo.toLowerCase() === full && invitation.status === "pending") ?? null;
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Someone invited usually cannot see the repository yet, so this reads
  // their own invitations, not the repository.
  const user = requireUser(context, request);
  const invitation = await invitationTo(user, params.owner, params.repo);
  return { invitation, viewer: { username: user.username, avatar: user.avatar ?? null } };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const accept = form.get("intent") === "accept";
  const invitation = await invitationTo(user, params.owner, params.repo);
  // Refusals are said with a 200, so the page loads again and shows the
  // invitation as it now stands beside the reason: after a 4xx answer
  // React Router keeps the page's data as it was.
  if (!invitation) return { error: "This invitation is no longer open." };
  const answered = await identity.respondRepoInvitation(user, invitation.id, accept);
  if (!answered.ok) return { error: answered.error.message };
  // The role is theirs from the next request on: straight to the repository.
  throw redirect(accept ? `/${invitation.repo}` : "/");
}

const LONG_DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export default function RepoInvitation({ loaderData, actionData, params }: Route.ComponentProps) {
  const { invitation, viewer } = loaderData;
  // Either answer: the other button waits for it.
  const answering = usePending();
  const full = `${params.owner}/${params.repo}`;
  if (!invitation) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <CircleAlert size={22} className="text-warn" />
          No open invitation
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          There is no invitation to <span className="font-mono text-fg">{full}</span> waiting for{" "}
          <span className="font-mono text-fg">{viewer.username}</span>. It may have been accepted, declined, revoked, or
          it expired; an invitation lasts 7 days. Ask whoever invited you to send another.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink to={`/${full}`} variant="quiet">
            Go to {full}
          </ButtonLink>
          <ButtonLink to="/" variant="quiet">
            Mission control
          </ButtonLink>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <div className="flex items-center gap-3">
        {invitation.invited_by ? (
          <Avatar name={invitation.invited_by} image={invitation.inviter_avatar} size={44} />
        ) : (
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
            <MailOpen size={20} />
          </span>
        )}
        <span className="text-faint">→</span>
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-raised text-muted ring-1 ring-line">
          <Box size={18} />
        </span>
      </div>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-balance">
        {invitation.invited_by ?? "Someone"} invited you to <span className="font-mono break-all">{invitation.repo}</span>
      </h1>
      <p className="mt-2 text-sm leading-6 text-muted">
        Accepting gives you the <span className="text-fg">{REPO_ROLE_LABELS[invitation.role]}</span> role on this
        repository: {REPO_ROLE_SUMMARIES[invitation.role].replace(/^./, (c) => c.toLowerCase())} You see this repository
        only, not the rest of the {params.owner} workspace.
      </p>
      <dl className="mt-5 space-y-1 text-sm">
        {invitation.invited_by && (
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-faint">From</dt>
            <dd className="font-mono text-fg-soft">@{invitation.invited_by}</dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-faint">Role</dt>
          <dd className="text-fg-soft">{REPO_ROLE_LABELS[invitation.role]}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-faint">Works until</dt>
          <dd className="text-fg-soft">{LONG_DATE.format(new Date(invitation.expires_at))}</dd>
        </div>
      </dl>
      <Form method="post" className="mt-8 space-y-3">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Avatar name={viewer.username} image={viewer.avatar} size={20} />
          Signed in as <span className="font-mono text-fg">{viewer.username}</span>
        </p>
        <ErrorText>{actionData?.error}</ErrorText>
        <div className="flex flex-col gap-3 sm:flex-row">
          <SubmitButton name="intent" value="accept" disabled={answering} pending="Accepting…">
            Accept invitation
          </SubmitButton>
          <SubmitButton name="intent" value="decline" variant="quiet" disabled={answering} pending="Declining…">
            Decline
          </SubmitButton>
        </div>
      </Form>
    </div>
  );
}
