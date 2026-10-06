import { CircleAlert, Ticket } from "lucide-react";
import { Form, Link, data, redirect } from "react-router";

import type { InvitePreview } from "@g1t/contracts";

import type { Route } from "./+types/invite";
import { page } from "../lib/meta";
import { Mark } from "../components/logo";
import { Avatar, Button, ButtonLink, ErrorText } from "../components/ui";
import { identity } from "../lib/services.server";
import { cleanCode } from "../lib/invites";
import { clientKey } from "../lib/registration.server";
import { assertSameOrigin, getViewer, requireUser } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "You're invited · g1t",
    description: "An invite to g1t, where people and agents ship software together.",
  });
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const code = cleanCode(params.code);
  const viewer = getViewer(context);
  const checked = await identity.checkInvite(code, clientKey(request));
  return {
    code,
    viewer: viewer ? { username: viewer.username, avatar: viewer.avatar ?? null } : null,
    invite: checked.ok ? checked.value : null,
    error: checked.ok ? null : checked.error.message,
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const result = await identity.acceptInvite(user, cleanCode(params.code));
  if (!result.ok) return data({ error: result.error.message }, { status: 422 });
  throw redirect(`/${result.value}`);
}

function Sender({ invite }: { invite: InvitePreview }) {
  const from = invite.invitedBy;
  return (
    <div className="flex items-center gap-3">
      {from ? (
        <Avatar name={from.username} image={from.avatar} size={44} />
      ) : (
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Ticket size={20} />
        </span>
      )}
      {invite.workspace && (
        <>
          <span className="text-faint">→</span>
          <Avatar name={invite.workspace.slug} image={invite.workspace.avatar} size={44} square />
        </>
      )}
    </div>
  );
}

function headline(invite: InvitePreview): string {
  const from = invite.invitedBy ? (invite.invitedBy.name ?? invite.invitedBy.username) : "The g1t team";
  return invite.workspace ? `${from} invited you to ${invite.workspace.name}` : `${from} invited you to g1t`;
}

const LONG_DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export default function Invite({ loaderData, actionData }: Route.ComponentProps) {
  const { invite, viewer, code, error } = loaderData;
  const here = `/invite/${code}`;
  return (
    <main className="mx-auto flex max-w-md flex-col px-4 pt-20 pb-10">
      <Mark className="size-9" />
      {invite ? (
        <>
          <div className="mt-8">
            <Sender invite={invite} />
          </div>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight text-balance">{headline(invite)}</h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            {invite.workspace
              ? `g1t is where people and agents ship software together. Accepting ${
                  invite.kind === "account" ? "makes your account and " : ""
                }joins you to the ${invite.workspace.slug} workspace.`
              : "g1t is where people and agents ship software together: plan in issues, assign work to agents like teammates, and land it through checks that hold. It is invite-only for now; this invite gets you in."}
          </p>
          <dl className="mt-5 space-y-1 text-sm">
            {invite.invitedBy && (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-faint">From</dt>
                <dd className="font-mono text-fg-soft">@{invite.invitedBy.username}</dd>
              </div>
            )}
            {invite.email && (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-faint">For</dt>
                <dd className="font-mono text-fg-soft">{invite.email}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-faint">Works until</dt>
              <dd className="text-fg-soft">{LONG_DATE.format(new Date(invite.expiresAt))}</dd>
            </div>
          </dl>

          <div className="mt-8">
            {viewer ? (
              invite.workspace ? (
                <Form method="post" className="space-y-3">
                  <p className="flex items-center gap-2 text-sm text-muted">
                    <Avatar name={viewer.username} image={viewer.avatar} size={20} />
                    Signed in as <span className="font-mono text-fg">{viewer.username}</span>
                  </p>
                  <ErrorText>{actionData?.error}</ErrorText>
                  <div className="*:w-full">
                    <Button type="submit">Join {invite.workspace.slug}</Button>
                  </div>
                </Form>
              ) : (
                <div className="rounded-md border border-line bg-surface p-4 text-sm">
                  <p>
                    You already have a g1t account, <span className="font-mono">{viewer.username}</span>, so this
                    invite has nothing more to give you.
                  </p>
                  <p className="mt-2 text-muted">Pass it on to whoever it was meant for, or keep it for someone else.</p>
                </div>
              )
            ) : invite.kind === "workspace" ? (
              <div className="space-y-3">
                <ButtonLink to={`/login?next=${encodeURIComponent(here)}`}>Sign in to join</ButtonLink>
                <p className="text-sm text-muted">This invite is for an address that already has a g1t account.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <ButtonLink to={`/register?invite=${encodeURIComponent(code)}`}>Accept invite</ButtonLink>
                <p className="text-sm text-muted">
                  Already on g1t?{" "}
                  <Link to={`/login?next=${encodeURIComponent(here)}`} className="text-fg underline underline-offset-4">
                    Sign in
                  </Link>
                </p>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <h1 className="mt-6 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <CircleAlert size={22} className="text-warn" />
            This invite cannot be used
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted">{error}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink to="/register">Request access</ButtonLink>
            <ButtonLink to={viewer ? "/" : "/login"} variant="quiet">
              {viewer ? "Go to g1t" : "Sign in"}
            </ButtonLink>
          </div>
        </>
      )}
    </main>
  );
}
