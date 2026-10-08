import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/login-two-factor";
import { AuthCard } from "../components/auth-card";
import { ErrorText, Field, Input, SubmitButton } from "../components/ui";
import { PENDING_COOKIE, TWO_FACTOR_COOKIE, cookie, readCookie } from "../lib/github";
import { githubSignIn } from "../lib/github.server";
import { page } from "../lib/meta";
import { identity } from "../lib/services.server";
import { assertSameOrigin, clientOf, getViewer, nextPath, startSession } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Two-factor authentication · g1t" });
}

/** Only reached with a sign-in waiting for its code; anyone else signs in first. */
export async function loader({ request, context }: Route.LoaderArgs) {
  if (getViewer(context)) throw redirect(nextPath(request));
  if (!readCookie(request.headers.get("cookie"), TWO_FACTOR_COOKIE)) {
    const next = nextPath(request);
    throw redirect(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  }
  return { next: nextPath(request) };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const cookies = request.headers.get("cookie");
  const challenge = readCookie(cookies, TWO_FACTOR_COOKIE);
  if (!challenge) return { error: "This sign-in has expired. Sign in again.", expired: true };
  const form = await request.formData();
  const result = await identity.twoFactorSignIn(challenge, String(form.get("code") ?? ""), clientOf(request));
  if (!result.ok) {
    const expired = result.error.message.includes("expired");
    return { error: result.error.message, expired };
  }
  const headers = new Headers({ "set-cookie": startSession(result.value.sessionToken) });
  headers.append("set-cookie", cookie(TWO_FACTOR_COOKIE, "", 0));
  // A GitHub sign-in waiting to be linked links now, as after a password.
  const pending = readCookie(cookies, PENDING_COOKIE);
  if (pending) {
    await githubSignIn.claim(pending, result.value.user).catch(() => null);
    headers.append("set-cookie", cookie(PENDING_COOKIE, "", 0));
  }
  throw redirect(nextPath(request), { headers });
}

export default function LoginTwoFactor({ actionData }: Route.ComponentProps) {
  return (
    <AuthCard
      title="Two-factor authentication"
      subtitle="Enter the code from your authenticator app"
      footer={
        <Link to="/login" className="text-fg underline underline-offset-4">
          Sign in again
        </Link>
      }
    >
      <Form method="post" className="space-y-4">
        <Field label="Code" hint="Lost your phone? Enter one of your recovery codes instead.">
          <Input name="code" required autoFocus autoComplete="one-time-code" inputMode="numeric" maxLength={20} placeholder="123 456" />
        </Field>
        <ErrorText>{actionData?.error}</ErrorText>
        <div className="pt-2 *:w-full">
          <SubmitButton pending="Checking…">Verify</SubmitButton>
        </div>
      </Form>
    </AuthCard>
  );
}
