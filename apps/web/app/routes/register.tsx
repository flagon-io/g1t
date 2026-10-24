import { CheckCircle2 } from "lucide-react";
import { Form, Link, data, redirect } from "react-router";

import { MAX_WAITLIST_ABOUT, USERNAME_PATTERN } from "@g1t/contracts";

import type { Route } from "./+types/register";
import { page } from "../lib/meta";
import { AuthCard } from "../components/auth-card";
import { ContinueWithGithub, OrDivider } from "../components/github";
import { Honeypot } from "../components/honeypot";
import { githubSignInEnabled } from "../lib/github.server";
import { ErrorText, Field, Input, SubmitButton } from "../components/ui";
import { Textarea } from "../components/ui/textarea";
import { identity } from "../lib/services.server";
import { cleanCode, cleanProof, invitePath, looksAutomated } from "../lib/invites";
import { clientKey, registrationMode } from "../lib/registration.server";
import { TURNSTILE_FAILED, TURNSTILE_SCRIPT } from "../lib/turnstile";
import { turnstile, turnstileOk } from "../lib/turnstile.server";
import { assertSameOrigin, getViewer, nextPath, startSession } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: args.loaderData?.inviteOnly ? "Request access · g1t" : "Create an account · g1t" });
}

/** What identity says to a new account without an invite in private preview; the page says the same. */
const PRIVATE_PREVIEW = "g1t is in private preview. Ask for access and we'll email you an invite.";

export async function loader({ request, context }: Route.LoaderArgs) {
  if (getViewer(context)) throw redirect(nextPath(request));
  const search = new URL(request.url).searchParams;
  const code = cleanCode(search.get("invite"));
  // A good invite is used on its own page, which knows whom it is from and
  // where it leads; it signs up, joins and lands in one go. The invite
  // email's proof goes with it, so the address it proves stays confirmed
  // there. A code that is no good is just dropped: the form, or in private
  // preview the Request access form, is shown.
  if (code) {
    const checked = await identity.checkInvite(code, clientKey(request));
    if (checked.ok) throw redirect(invitePath(code, cleanProof(search.get("proof"))));
  }
  const next = nextPath(request);
  const [mode, github] = await Promise.all([registrationMode(), githubSignInEnabled()]);
  return {
    // In private preview there is no account form to fill in: people ask
    // for access, and an invite's email links to its own page.
    inviteOnly: mode === "invite",
    github,
    githubUrl: next !== "/" ? `/auth/github?${new URLSearchParams({ next })}` : "/auth/github",
    started: Date.now(),
    // Turnstile's public site key when it is on (lib/turnstile.ts).
    turnstile: turnstile()?.siteKey ?? null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  if (form.get("intent") === "request-access") {
    // A bot gets the same thanks as a person, and nothing is kept.
    if (looksAutomated(form)) return { requested: true as const };
    if (!(await turnstileOk(form, clientKey(request)))) return data({ requestError: TURNSTILE_FAILED }, { status: 422 });
    const result = await identity.requestAccess(String(form.get("email") ?? ""), String(form.get("about") ?? ""), clientKey(request));
    if (!result.ok) return data({ requestError: result.error.message }, { status: 422 });
    return { requested: true as const };
  }
  if (looksAutomated(form)) return data({ error: "Something went wrong. Try again." }, { status: 422 });
  // Identity refuses an account without an invite in private preview too;
  // saying so here spares a form posted from a page loaded before it began.
  if ((await registrationMode()) === "invite") return data({ error: PRIVATE_PREVIEW }, { status: 403 });
  if (!(await turnstileOk(form, clientKey(request)))) return data({ error: TURNSTILE_FAILED }, { status: 422 });
  const result = await identity.register(
    String(form.get("username") ?? ""),
    String(form.get("email") ?? ""),
    String(form.get("password") ?? ""),
    null,
    clientKey(request),
  );
  if (!result.ok) return data({ error: result.error.message }, { status: 422 });
  throw redirect(nextPath(request), {
    headers: { "set-cookie": startSession(result.value.sessionToken) },
  });
}

export default function Register({ loaderData, actionData }: Route.ComponentProps) {
  if (loaderData.inviteOnly) return <RequestAccess loaderData={loaderData} actionData={actionData} />;
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  return (
    <AuthCard
      title="Create your account"
      subtitle="Where your team and its coding agents ship code"
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="text-fg underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      {loaderData.github && (
        <>
          <ContinueWithGithub href={loaderData.githubUrl} />
          <OrDivider />
        </>
      )}
      <Form method="post" className="relative space-y-4">
        <Honeypot started={loaderData.started} />
        <Field label="Username" hint="Letters, digits and single hyphens. It is how you sign in, and how others see you, in the case you type it.">
          <Input name="username" autoComplete="username" required autoFocus maxLength={39} pattern={USERNAME_PATTERN} />
        </Field>
        <Field label="Email" hint="We send a code to this address to confirm it.">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input name="password" type="password" autoComplete="new-password" required minLength={10} />
        </Field>
        {loaderData.turnstile && (
          <>
            <script src={TURNSTILE_SCRIPT} async defer />
            <div className="cf-turnstile" data-sitekey={loaderData.turnstile} data-theme="auto" data-size="flexible" />
          </>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="pt-2 *:w-full">
          <SubmitButton pending="Creating account…">Create account</SubmitButton>
        </div>
      </Form>
    </AuthCard>
  );
}

/** Private preview: no account form; leave an address, and an invite comes to it when there is room. */
function RequestAccess({ loaderData, actionData }: Pick<Route.ComponentProps, "loaderData" | "actionData">) {
  const requested = actionData && "requested" in actionData;
  const error = actionData && "requestError" in actionData ? actionData.requestError : actionData && "error" in actionData ? actionData.error : undefined;
  return (
    <AuthCard
      title="Request access"
      subtitle="g1t is in private preview"
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="text-fg underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      {requested ? (
        <p className="flex items-start gap-2 rounded-md border border-success/40 bg-surface p-3 text-sm" role="status">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
          <span>Thanks, you are on the list. We will email your invite to that address when there is a place for you.</span>
        </p>
      ) : (
        <>
          <p className="mb-5 text-sm text-muted">Leave your email and we will send you an invite as we open up. Someone already on g1t can invite you too.</p>
          <Form method="post" className="relative space-y-4">
            <input type="hidden" name="intent" value="request-access" />
            <Honeypot started={loaderData.started} />
            <Field label="Email">
              <Input name="email" type="email" autoComplete="email" required maxLength={254} autoFocus />
            </Field>
            <Field label="What will you build?" hint="Optional. It helps us decide who to invite first.">
              <Textarea name="about" rows={3} maxLength={MAX_WAITLIST_ABOUT} />
            </Field>
            {loaderData.turnstile && (
              <>
                <script src={TURNSTILE_SCRIPT} async defer />
                <div className="cf-turnstile" data-sitekey={loaderData.turnstile} data-theme="auto" data-size="flexible" />
              </>
            )}
            <ErrorText>{error}</ErrorText>
            <div className="pt-2 *:w-full">
              <SubmitButton pending="Sending…">Request access</SubmitButton>
            </div>
          </Form>
        </>
      )}
      <p className="mt-6 text-xs text-faint">Have an invite? Use the link in your invite email.</p>
    </AuthCard>
  );
}
