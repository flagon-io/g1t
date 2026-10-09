import { CheckCircle2, Ticket } from "lucide-react";
import { Form, Link, data, redirect } from "react-router";

import type { InvitePreview } from "@g1t/contracts";
import { USERNAME_PATTERN } from "@g1t/contracts";

import type { Route } from "./+types/register";
import { page } from "../lib/meta";
import { AuthCard } from "../components/auth-card";
import { ContinueWithGithub, OrDivider } from "../components/github";
import { Honeypot } from "../components/honeypot";
import { githubSignInEnabled } from "../lib/github.server";
import { Avatar, Button, ErrorText, Field, Input, SubmitButton } from "../components/ui";
import { identity } from "../lib/services.server";
import { cleanCode, cleanProof, invitePath, looksAutomated, sharedDomainsHint, sharedInviteLine } from "../lib/invites";
import { clientKey, registrationMode } from "../lib/registration.server";
import {
  assertSameOrigin,
  getViewer,
  nextPath,
  startSession,
} from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Create an account · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (getViewer(context)) throw redirect(nextPath(request));
  const inviteOnly = (await registrationMode()) !== "open";
  const code = cleanCode(new URL(request.url).searchParams.get("invite"));
  // The invite is checked before anything else on the page: without a good
  // one, there is no form to fill in.
  const checked = code ? await identity.checkInvite(code, clientKey(request)) : null;
  const invite: InvitePreview | null = checked?.ok ? checked.value : null;
  // A good invite is used on its own page, which knows whom it is from and
  // where it leads; it signs up, joins and lands in one go. A shared link
  // for a group signs up here: it joins nothing, and the form says which
  // group it is for.
  // The invite email's proof goes with it, so the address it proves stays
  // confirmed there.
  if (invite && code && !invite.sharedLabel) {
    throw redirect(invitePath(code, cleanProof(new URL(request.url).searchParams.get("proof"))));
  }
  // Signing up with GitHub carries the invite code and `next` through it.
  const params = new URLSearchParams();
  if (code) params.set("invite", code);
  if (nextPath(request) !== "/") params.set("next", nextPath(request));
  const query = params.toString();
  return {
    inviteOnly,
    code,
    invite,
    inviteError: checked && !checked.ok ? checked.error.message : null,
    github: await githubSignInEnabled(),
    githubUrl: query ? `/auth/github?${query}` : "/auth/github",
    started: Date.now(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const client = clientKey(request);

  if (form.get("intent") === "request-access") {
    // A bot gets the same thanks as a person, and nothing is kept.
    if (looksAutomated(form)) return { requested: true };
    const result = await identity.requestAccess(
      String(form.get("email") ?? ""),
      String(form.get("about") ?? ""),
      client,
    );
    if (!result.ok) return data({ requestError: result.error.message }, { status: 422 });
    return { requested: true };
  }

  const code = cleanCode(String(form.get("invite") ?? ""));
  if (looksAutomated(form)) return data({ error: "Something went wrong. Try again." }, { status: 422 });
  // The invite first, so its problem is the one shown.
  let joins: string | null = null;
  if (code) {
    const checked = await identity.checkInvite(code, client);
    if (!checked.ok) return data({ error: checked.error.message }, { status: 422 });
    joins = checked.value.workspace?.slug ?? null;
  }
  const result = await identity.register(
    String(form.get("username") ?? ""),
    String(form.get("email") ?? ""),
    String(form.get("password") ?? ""),
    code || null,
    client,
  );
  if (!result.ok) return data({ error: result.error.message }, { status: 422 });
  // An invite to a workspace lands in it; anything else goes where it was going.
  const next = nextPath(request);
  throw redirect(joins && next === "/" ? `/${joins}` : next, {
    headers: { "set-cookie": startSession(result.value.sessionToken) },
  });
}

/** Who sent the invite and what it joins, above the form; for a shared link, the group it is for. */
function InvitedBy({ invite }: { invite: InvitePreview }) {
  const from = invite.invitedBy;
  const group = sharedInviteLine(invite.sharedLabel);
  if (group) {
    return (
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3" role="status">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Ticket size={18} />
        </span>
        <p className="min-w-0 text-sm leading-5 font-medium text-fg">{group}</p>
      </div>
    );
  }
  return (
    <div className="mb-6 flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3" role="status">
      {invite.workspace ? (
        <Avatar name={invite.workspace.slug} image={invite.workspace.avatar} size={36} square />
      ) : from ? (
        <Avatar name={from.username} image={from.avatar} size={36} />
      ) : (
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Ticket size={18} />
        </span>
      )}
      <p className="min-w-0 text-sm leading-5">
        {from ? (
          <>
            <span className="font-medium text-fg">{from.name ?? from.username}</span>
            {from.name && <span className="font-mono text-muted"> @{from.username}</span>}
          </>
        ) : (
          <span className="font-medium text-fg">The g1t team</span>
        )}{" "}
        <span className="text-muted">
          invited you
          {invite.workspace ? (
            <>
              {" "}to <span className="font-medium text-fg">{invite.workspace.name}</span>
            </>
          ) : (
            " to g1t"
          )}
          .
        </span>
      </p>
    </div>
  );
}

function SignUpForm({
  loaderData,
  error,
}: {
  loaderData: Route.ComponentProps["loaderData"];
  error: string | undefined;
}) {
  const { invite, code, inviteOnly } = loaderData;
  return (
    <>
      {invite && <InvitedBy invite={invite} />}
      {loaderData.github && (
        <>
          <ContinueWithGithub href={loaderData.githubUrl} />
          <OrDivider />
        </>
      )}
      <Form method="post" className="relative space-y-4">
        <Honeypot started={loaderData.started} />
        {inviteOnly || code ? (
          <Field label="Invite code" hint={invite ? undefined : "From your invite link or email."}>
            <span className="block font-mono">
              <Input name="invite" defaultValue={code} required={inviteOnly} spellCheck={false} autoCapitalize="none" />
            </span>
          </Field>
        ) : null}
        <Field
          label="Username"
          hint="Letters, digits and single hyphens. It is how you sign in, and how others see you, in the case you type it."
        >
          <Input
            name="username"
            autoComplete="username"
            required
            autoFocus
            maxLength={39}
            pattern={USERNAME_PATTERN}
          />
        </Field>
        <Field
          label="Email"
          hint={invite?.email ? `This invite is for ${invite.email}. Use that address.` : sharedDomainsHint(invite?.sharedDomains)}
        >
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="pt-2 *:w-full">
          <SubmitButton pending="Creating account…">
            {invite?.workspace ? `Create account and join ${invite.workspace.slug}` : "Create account"}
          </SubmitButton>
        </div>
      </Form>
    </>
  );
}

/** Invite-only and no good code: enter one, or ask for access. */
function InviteOnly({
  loaderData,
  actionData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
  actionData: Route.ComponentProps["actionData"];
}) {
  const requested = actionData && "requested" in actionData;
  return (
    <div className="space-y-8">
      <section id="invite" className="scroll-mt-24">
        <h2 className="text-sm font-medium">Have an invite?</h2>
        <p className="mt-1 text-sm text-muted">Paste the code or link from your invite.</p>
        <Form method="get" className="mt-3 flex gap-2">
          <div className="min-w-0 grow font-mono">
            <Input
              name="invite"
              aria-label="Invite code"
              placeholder="g1t-xxxx-xxxx-…"
              defaultValue={loaderData.code}
              required
              spellCheck={false}
              autoCapitalize="none"
            />
          </div>
          <Button type="submit" variant="quiet">
            Continue
          </Button>
        </Form>
        {loaderData.inviteError && (
          <div className="mt-2">
            <ErrorText>{loaderData.inviteError}</ErrorText>
          </div>
        )}
      </section>

      <section id="request" className="scroll-mt-24 border-t border-line pt-8">
        <h2 className="text-sm font-medium">Request access</h2>
        {requested ? (
          <p className="mt-3 flex items-start gap-2 rounded-md border border-success/40 bg-surface p-3 text-sm" role="status">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
            <span>
              You are on the list, and your invite comes to that address when a place opens. The first time an address
              asks, we email it to confirm.
            </span>
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted">
              Leave your email and we will send an invite as we open up. Someone already on g1t can also invite you.
            </p>
            <Form method="post" className="relative mt-3 space-y-3">
              <input type="hidden" name="intent" value="request-access" />
              <Honeypot started={loaderData.started} />
              <Field label="Email">
                <Input name="email" type="email" autoComplete="email" required maxLength={254} />
              </Field>
              <Field label="What will you build? (optional)">
                <textarea
                  name="about"
                  rows={3}
                  maxLength={1000}
                  className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
                />
              </Field>
              <ErrorText>{actionData && "requestError" in actionData ? actionData.requestError : undefined}</ErrorText>
              <div className="*:w-full">
                <SubmitButton pending="Sending…" match={{ intent: "request-access" }}>
                  Request access
                </SubmitButton>
              </div>
            </Form>
          </>
        )}
      </section>
    </div>
  );
}

export default function Register({ loaderData, actionData }: Route.ComponentProps) {
  const { inviteOnly, invite } = loaderData;
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  // Invite-only: the sign-up form only appears with a good code (or a
  // submitted one that failed, so the person can correct the rest).
  const showForm = !inviteOnly || invite !== null;
  return (
    <AuthCard
      title={showForm ? "Create your account" : "g1t is invite-only for now"}
      subtitle={showForm ? "Your team and its agents, working in one place" : "Enter your invite, or ask for one"}
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="text-fg underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      {showForm ? <SignUpForm loaderData={loaderData} error={error} /> : <InviteOnly loaderData={loaderData} actionData={actionData} />}
    </AuthCard>
  );
}
