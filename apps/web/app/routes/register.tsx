import { Form, Link, data, redirect } from "react-router";

import { USERNAME_PATTERN } from "@g1t/contracts";

import type { Route } from "./+types/register";
import { page } from "../lib/meta";
import { AuthCard } from "../components/auth-card";
import { ContinueWithGithub, OrDivider } from "../components/github";
import { Honeypot } from "../components/honeypot";
import { githubSignInEnabled } from "../lib/github.server";
import { ErrorText, Field, Input, SubmitButton } from "../components/ui";
import { identity } from "../lib/services.server";
import { cleanCode, cleanProof, invitePath, looksAutomated } from "../lib/invites";
import { clientKey } from "../lib/registration.server";
import { TURNSTILE_FAILED, TURNSTILE_SCRIPT } from "../lib/turnstile";
import { turnstile, turnstileOk } from "../lib/turnstile.server";
import { assertSameOrigin, getViewer, nextPath, startSession } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Create an account · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (getViewer(context)) throw redirect(nextPath(request));
  const search = new URL(request.url).searchParams;
  const code = cleanCode(search.get("invite"));
  // A good invite is used on its own page, which knows whom it is from and
  // where it leads; it signs up, joins and lands in one go. The invite
  // email's proof goes with it, so the address it proves stays confirmed
  // there. Anyone may sign up, so a code that is no good is just dropped.
  if (code) {
    const checked = await identity.checkInvite(code, clientKey(request));
    if (checked.ok) throw redirect(invitePath(code, cleanProof(search.get("proof"))));
  }
  const next = nextPath(request);
  return {
    github: await githubSignInEnabled(),
    githubUrl: next !== "/" ? `/auth/github?${new URLSearchParams({ next })}` : "/auth/github",
    started: Date.now(),
    // Turnstile's public site key when it is on (lib/turnstile.ts).
    turnstile: turnstile()?.siteKey ?? null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  if (looksAutomated(form)) return data({ error: "Something went wrong. Try again." }, { status: 422 });
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
