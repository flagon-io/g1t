import { CircleAlert, Lock, MailCheck, Ticket } from "lucide-react";
import { Form, Link, data, redirect } from "react-router";

import type { InvitePreview, User } from "@g1t/contracts";
import { USERNAME_PATTERN } from "@g1t/contracts";

import type { Route } from "./+types/invite";
import { page } from "../lib/meta";
import { Mark } from "../components/logo";
import { ContinueWithGithub, OrDivider } from "../components/github";
import { Honeypot } from "../components/honeypot";
import { Avatar, ButtonLink, ErrorText, Field, Input, SubmitButton } from "../components/ui";
import { githubSignInEnabled } from "../lib/github.server";
import { identity } from "../lib/services.server";
import { cleanCode, cleanProof, invitePageCopy, inviteSignUpCopy, landingFor, looksAutomated, suggestUsername, welcomeCookie } from "../lib/invites";
import { clientKey } from "../lib/registration.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, startSession } from "../lib/session.server";
import { rememberWorkspace } from "../lib/workspace-choice";

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "You're invited · g1t",
    description: "An invite to g1t, one workspace where a team and its agents talk, work and ship.",
  });
}

/**
 * Where an invite is used, from first click to landing inside: who sent
 * it and what it is for, then signing up on this page (or signing in, for
 * an address that has an account), and the workspace or repository it
 * gives. Signing in or up elsewhere (GitHub, /login) comes back here with
 * `?accept=1`, which finishes the job.
 *
 * The link in the invite's own email also carries `?proof=`, which only
 * that email has: signing up from it makes the account with the address
 * confirmed already. The code alone (typed in, or a link passed on) does
 * not, and the address is confirmed after sign-up as usual.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const code = cleanCode(params.code);
  const viewer = getViewer(context);
  const search = new URL(request.url).searchParams;
  const accepting = search.get("accept") === "1";
  const emailProof = cleanProof(search.get("proof"));
  const checked = await identity.checkInvite(code, clientKey(request), { viewer, anyStatus: true, emailProof });
  const invite = checked.ok ? checked.value : null;
  // A shared link for a group signs up on /register, which names the group.
  if (invite?.sharedLabel) throw redirect(`/register?invite=${encodeURIComponent(code)}`);
  const lands = invite ? landingFor(invite) : null;

  if (viewer && invite) {
    // Used by this person already: just made the account with it (through
    // GitHub), or an old link opened again.
    if (invite.status === "redeemed" && invite.forViewer) throw landIn(request, invite, [], accepting);
    // Back from signing in to accept an invite sent to their address.
    if (accepting && invite.status === "pending" && invite.forViewer === true && lands && !alreadyIn(viewer, invite)) {
      const accepted = await identity.acceptInvite(viewer, code);
      if (accepted.ok) throw landIn(request, invite, [], true);
      return { ...base(), acceptError: accepted.error.message };
    }
  }

  function base() {
    return {
      code,
      invite,
      error: checked.ok ? null : checked.error.message,
      viewer: viewer ? { username: viewer.username, avatar: viewer.avatar ?? null } : null,
      alreadyIn: viewer && invite ? alreadyIn(viewer, invite) : false,
      github: false,
      suggestion: suggestUsername(invite?.address),
      // Only a proof identity accepted goes back into the form.
      proof: invite?.emailProven ? emailProof : null,
      started: Date.now(),
      acceptError: null as string | null,
    };
  }
  const signingUp = !viewer && invite?.status === "pending" && invite.kind === "account" && !invite.hasAccount;
  return { ...base(), github: signingUp ? await githubSignInEnabled() : false };
}

/** Whether the viewer is in what the invite gives already. */
function alreadyIn(viewer: User, invite: InvitePreview): boolean {
  if (invite.workspace) return roleIn(viewer, invite.workspace.slug) !== null;
  return false;
}

/**
 * The redirect into what the invite gave, with the session (when one was
 * just made), the welcome for that first view, and the workspace made the
 * one the sidebar is about.
 */
function landIn(request: Request, invite: InvitePreview, cookies: string[], welcome: boolean): Response {
  const secure = new URL(request.url).protocol === "https:";
  const target = landingFor(invite);
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  if (target && welcome) headers.append("set-cookie", welcomeCookie(target, secure));
  if (invite.workspace) headers.append("set-cookie", rememberWorkspace(invite.workspace.slug, secure));
  return redirect(target ? `/${target}` : "/", { headers });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const code = cleanCode(params.code);
  const form = await request.formData();
  const client = clientKey(request);
  const emailProof = cleanProof(String(form.get("proof") ?? ""));
  const checked = await identity.checkInvite(code, client, { viewer: getViewer(context), emailProof });
  if (!checked.ok) return data({ error: checked.error.message }, { status: 422 });
  const invite = checked.value;

  if (form.get("intent") === "register") {
    if (looksAutomated(form)) return data({ error: "Something went wrong. Try again." }, { status: 422 });
    // An invite for one address makes the account with that address,
    // whatever the form sent.
    const email = invite.address ?? String(form.get("email") ?? "");
    const result = await identity.register(
      String(form.get("username") ?? ""),
      email,
      String(form.get("password") ?? ""),
      code,
      client,
      // Identity checks it again, against this invite and this address.
      emailProof,
    );
    if (!result.ok) return data({ error: result.error.message }, { status: 422 });
    throw landIn(request, invite, [startSession(result.value.sessionToken)], true);
  }

  const user = requireUser(context, request);
  const result = await identity.acceptInvite(user, code);
  // Said with a 200, so the page loads again and shows the invite as it
  // now stands (used up, revoked) beside the reason: after a 4xx answer
  // React Router keeps the page's data as it was.
  if (!result.ok) return { error: result.error.message };
  throw landIn(request, invite, [], true);
}

/** Who sent it, and the workspace it joins, as faces. */
function Faces({ invite }: { invite: InvitePreview }) {
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

/**
 * Which invite it is, in the headline (`invitePageCopy`): "@syntaqx
 * invited you to join Flagon, Inc. on g1t" (a workspace invitation, with
 * the place in bold), "… to collaborate on acme/web", or "@syntaqx invited
 * you to g1t" (an account, and no workspace).
 */
function Headline({ invite }: { invite: InvitePreview }) {
  const copy = invitePageCopy(invite, false);
  return (
    <>
      {copy.before}
      {copy.place && (
        <strong className={`font-semibold text-fg ${invite.repository && !invite.workspace ? "font-mono" : ""}`}>{copy.place}</strong>
      )}
      {copy.after}
    </>
  );
}

/** What accepting is called on its button. */
function joinLabel(invite: InvitePreview): string {
  if (invite.workspace) return `Join ${invite.workspace.name}`;
  if (invite.repository) return `Accept access to ${invite.repository.name}`;
  return "Accept invite";
}

const LONG_DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

type Loaded = Route.ComponentProps["loaderData"];

/** Signing up, on this page: the address the invite was sent to, a username, a password. */
function SignUp({ loaded, error }: { loaded: Loaded; error: string | null }) {
  const invite = loaded.invite!;
  const here = `/invite/${loaded.code}`;
  const back = `${here}?accept=1`;
  const github = `/auth/github?${new URLSearchParams({ invite: loaded.code, next: back })}`;
  const copy = inviteSignUpCopy(invite);
  return (
    <section aria-labelledby="sign-up" className="rounded-xl border border-line bg-surface/60 p-5 sm:p-6">
      <h2 id="sign-up" className="text-base font-semibold">
        Create your account
      </h2>
      <p className="mt-1 text-sm text-muted">{copy.intro}</p>
      {copy.confirmed && (
        <p className="mt-4 flex items-start gap-2 rounded-md border border-success/40 bg-success/5 p-3 text-sm" role="status">
          <MailCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
          <span>{copy.confirmed}</span>
        </p>
      )}
      {loaded.github && (
        <div className="mt-5">
          <ContinueWithGithub href={github} />
          <OrDivider />
        </div>
      )}
      <Form method="post" className={`relative space-y-4 ${loaded.github ? "" : "mt-5"}`}>
        <input type="hidden" name="intent" value="register" />
        <Honeypot started={loaded.started} />
        {loaded.proof && <input type="hidden" name="proof" value={loaded.proof} />}
        {invite.address ? (
          <Field label="Email" hint={copy.hint}>
            <span className="relative block">
              <Input name="email" type="email" value={invite.address} readOnly aria-readonly="true" autoComplete="email" />
              {copy.confirmed ? (
                <MailCheck size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-success" />
              ) : (
                <Lock size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-faint" />
              )}
            </span>
          </Field>
        ) : (
          <Field label="Email" hint={copy.hint}>
            <Input name="email" type="email" autoComplete="email" required maxLength={254} />
          </Field>
        )}
        <Field label="Username" hint="Letters, digits and single hyphens. It is how you sign in, and how others see you, in the case you type it.">
          <Input
            name="username"
            autoComplete="username"
            required
            autoFocus
            maxLength={39}
            defaultValue={loaded.suggestion}
            pattern={USERNAME_PATTERN}
          />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input name="password" type="password" autoComplete="new-password" required minLength={10} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="pt-1 *:w-full">
          <SubmitButton pending="Creating account…" match={{ intent: "register" }}>
            {invite.workspace
              ? `Create account and join ${invite.workspace.name}`
              : invite.repository
                ? "Create account and accept"
                : "Create account"}
          </SubmitButton>
        </div>
      </Form>
      <p className="mt-5 text-center text-sm text-muted">
        Already on g1t?{" "}
        <Link to={`/login?next=${encodeURIComponent(back)}`} className="text-fg underline underline-offset-4">
          Sign in to accept
        </Link>
      </p>
    </section>
  );
}

/** What to do next: join, sign in, sign out, or sign up. */
function Next({ loaded, error }: { loaded: Loaded; error: string | null }) {
  const invite = loaded.invite!;
  const viewer = loaded.viewer;
  const here = `/invite/${loaded.code}`;
  const back = `${here}?accept=1`;
  const joinable = invite.workspace !== null || invite.repository !== null;

  if (viewer) {
    const signedInAs = (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Avatar name={viewer.username} image={viewer.avatar} size={20} />
        Signed in as <span className="font-mono text-fg">{viewer.username}</span>
      </p>
    );
    // Its own intent, which /logout ignores, so only its button says it is working.
    const signOut = (label: string, variant: "primary" | "quiet") => (
      <Form method="post" action={`/logout?next=${encodeURIComponent(here)}`}>
        <input type="hidden" name="intent" value="sign-out" />
        <SubmitButton variant={variant} pending="Signing out…" match={{ intent: "sign-out" }}>
          {label}
        </SubmitButton>
      </Form>
    );
    if (invite.forViewer === false) {
      return (
        <div className="space-y-4">
          {signedInAs}
          <div className="rounded-md border border-warn/40 bg-warn/5 p-4 text-sm" role="status">
            <p className="font-medium text-fg">This invite is for {invite.address ?? invite.email}, not this account.</p>
            <p className="mt-1 text-muted">
              Only an account with that address confirmed can use it. Sign out, then sign in or sign up with it.
            </p>
          </div>
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap gap-3">{signOut("Sign out and continue", "primary")}</div>
        </div>
      );
    }
    if (loaded.alreadyIn && invite.workspace) {
      return (
        <div className="space-y-4">
          {signedInAs}
          <p className="text-sm text-muted">You are in {invite.workspace.name} already.</p>
          <ButtonLink to={`/${invite.workspace.slug}`}>Go to {invite.workspace.name}</ButtonLink>
        </div>
      );
    }
    if (!joinable) {
      return (
        <div className="space-y-4">
          {signedInAs}
          <div className="rounded-md border border-line bg-surface p-4 text-sm">
            <p>
              You already have a g1t account, <span className="font-mono">{viewer.username}</span>, so this invite has
              nothing more to give you.
            </p>
            <p className="mt-2 text-muted">Pass it on to whoever it was meant for, or keep it for someone else.</p>
          </div>
          <div className="flex flex-wrap gap-3">{signOut("Sign out to use it", "quiet")}</div>
        </div>
      );
    }
    return (
      <>
        {/* "Not you?" posts this form, so it does not carry the accept form's intent. */}
        <Form id="invite-sign-out" method="post" action={`/logout?next=${encodeURIComponent(here)}`} hidden>
          <input type="hidden" name="intent" value="sign-out" />
        </Form>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="accept" />
          {signedInAs}
          {invite.forViewer === null && (
            <p className="text-sm text-muted">This invite is for anyone with the link. Accepting uses it up.</p>
          )}
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pending={invite.workspace ? "Joining…" : "Accepting…"} match={{ intent: "accept" }}>
              {joinLabel(invite)}
            </SubmitButton>
            <span className="text-sm text-muted">
              Not you?{" "}
              <SubmitButton
                form="invite-sign-out"
                pending="Signing out…"
                match={{ intent: "sign-out" }}
                className="inline-flex items-center gap-1 text-fg underline underline-offset-4 disabled:opacity-50"
              >
                Sign out
              </SubmitButton>
            </span>
          </div>
        </Form>
      </>
    );
  }

  // Someone already on g1t: sign in, and the invite is accepted on return.
  if (invite.hasAccount || invite.kind === "workspace") {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-line bg-surface p-4 text-sm">
          <p className="font-medium text-fg">{invite.address ?? invite.email ?? "This address"} has a g1t account.</p>
          <p className="mt-1 text-muted">
            Sign in to it and {joinable ? `you ${invite.workspace ? `join ${invite.workspace.name}` : `get access to ${invite.repository!.name}`} straight away` : "the invite is accepted"}.
          </p>
        </div>
        <ErrorText>{error}</ErrorText>
        <ButtonLink to={`/login?next=${encodeURIComponent(back)}`}>Sign in to accept</ButtonLink>
      </div>
    );
  }
  return <SignUp loaded={loaded} error={error} />;
}

/** A code that cannot be used: why, and whom to ask. */
function Dead({ loaded }: { loaded: Loaded }) {
  const invite = loaded.invite;
  const title = !invite
    ? "This invite link does not work"
    : invite.status === "expired"
      ? "This invite has expired"
      : invite.status === "revoked"
        ? "This invite was withdrawn"
        : "This invite has been used";
  const from = invite?.invitedBy;
  return (
    <>
      <h1 className="mt-6 flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <CircleAlert size={22} className="shrink-0 text-warn" />
        {title}
      </h1>
      {invite ? (
        <p className="mt-3 text-sm leading-6 text-muted">
          It was {invite.workspace ? `an invite to join ${invite.workspace.name}` : invite.repository ? `an invite to ${invite.repository.name}` : "an invite to g1t"}
          {invite.status === "expired" && `, and stopped working on ${LONG_DATE.format(new Date(invite.expiresAt))}`}.{" "}
          {from ? "Ask the person who sent it for a new one." : "Ask for access and we will send a new one."}
        </p>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted">{loaded.error}</p>
      )}
      {from && (
        <div className="mt-5 flex items-center gap-3 rounded-lg border border-line bg-surface p-3">
          <Avatar name={from.username} image={from.avatar} size={36} />
          <p className="min-w-0 text-sm">
            Ask <span className="font-medium text-fg">{from.name ?? from.username}</span>{" "}
            <Link to={`/u/${from.username}`} className="font-mono text-muted hover:text-fg">
              @{from.username}
            </Link>{" "}
            <span className="text-muted">for a new invite.</span>
          </p>
        </div>
      )}
      <div className="mt-8 flex flex-wrap gap-3">
        <ButtonLink to="/register#request">Sign up</ButtonLink>
        <ButtonLink to={loaded.viewer ? "/" : "/login"} variant="quiet">
          {loaded.viewer ? "Go to g1t" : "Sign in"}
        </ButtonLink>
      </div>
    </>
  );
}

export default function Invite({ loaderData, actionData }: Route.ComponentProps) {
  const { invite } = loaderData;
  const error = (actionData && "error" in actionData ? actionData.error : null) ?? loaderData.acceptError;
  const usable = invite?.status === "pending";
  return (
    <main className="mx-auto flex max-w-md flex-col px-4 pt-16 pb-12 sm:pt-20">
      <Mark className="size-9" />
      {usable ? (
        <>
          <div className="mt-8">
            <Faces invite={invite} />
          </div>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight text-balance text-fg-soft">
            <Headline invite={invite} />
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted">{invitePageCopy(invite, loaderData.viewer !== null).about}</p>
          <dl className="mt-5 space-y-1 text-sm">
            {invite.invitedBy && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-faint">From</dt>
                <dd className="font-mono text-fg-soft">@{invite.invitedBy.username}</dd>
              </div>
            )}
            {invite.email && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-faint">For</dt>
                <dd className="font-mono break-all text-fg-soft">{invite.address ?? invite.email}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-faint">Works until</dt>
              <dd className="text-fg-soft">{LONG_DATE.format(new Date(invite.expiresAt))}</dd>
            </div>
          </dl>
          <div className="mt-8">
            <Next loaded={loaderData} error={error} />
          </div>
        </>
      ) : (
        <Dead loaded={loaderData} />
      )}
    </main>
  );
}
