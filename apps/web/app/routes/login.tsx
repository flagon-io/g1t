import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/login";
import { page } from "../lib/meta";
import { useInviteOnly } from "../lib/registration";
import { AuthCard } from "../components/auth-card";
import { ContinueWithGithub, GithubMark, OrDivider } from "../components/github";
import { PENDING_COOKIE, cookie, readCookie } from "../lib/github";
import { githubSignIn, githubSignInEnabled } from "../lib/github.server";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { identity } from "../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  nextPath,
  clientOf,
  startSession,
} from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Sign in · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (getViewer(context)) throw redirect(nextPath(request));
  // A GitHub sign-in whose email belongs to an account: signing in to it
  // links GitHub, and nothing is linked before then.
  const pending = readCookie(request.headers.get("cookie"), PENDING_COOKIE);
  const held = pending ? await githubSignIn.pending(pending).catch(() => null) : null;
  return {
    next: nextPath(request),
    github: await githubSignInEnabled(),
    linking: held?.ok ? held.value.login : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const result = await identity.signIn(
    String(form.get("username") ?? "").trim(),
    String(form.get("password") ?? ""),
    clientOf(request),
  );
  if (!result.ok) return { error: result.error.message };
  const headers = new Headers({ "set-cookie": startSession(result.value.sessionToken) });
  const pending = readCookie(request.headers.get("cookie"), PENDING_COOKIE);
  if (pending) {
    await githubSignIn.claim(pending, result.value.user).catch(() => null);
    headers.append("set-cookie", cookie(PENDING_COOKIE, "", 0));
  }
  throw redirect(nextPath(request), { headers });
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const inviteOnly = useInviteOnly();
  const registerUrl =
    loaderData.next === "/"
      ? "/register"
      : `/register?next=${encodeURIComponent(loaderData.next)}`;
  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to g1t"
      footer={
        <>
          New to g1t?{" "}
          <Link to={registerUrl} className="text-fg underline underline-offset-4">
            {inviteOnly ? "Request access or use an invite" : "Create an account"}
          </Link>
        </>
      }
    >
      {loaderData.linking ? (
        <p className="mb-6 flex items-start gap-2 rounded-md border border-accent/40 bg-surface p-3 text-sm" role="status">
          <GithubMark className="mt-0.5 size-4 shrink-0" />
          <span>
            An account with this email exists. Sign in to link GitHub (
            <span className="font-mono">@{loaderData.linking}</span>) to it.
          </span>
        </p>
      ) : (
        loaderData.github && (
          <>
            <ContinueWithGithub href={loaderData.next === "/" ? "/auth/github" : `/auth/github?next=${encodeURIComponent(loaderData.next)}`} />
            <OrDivider />
          </>
        )
      )}
      <Form method="post" className="space-y-4">
        <Field label="Username or email">
          <Input name="username" autoComplete="username" required autoFocus />
        </Field>
        <Field label="Password">
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <ErrorText>{actionData?.error}</ErrorText>
        <div className="pt-2 *:w-full">
          <Button type="submit">Sign in</Button>
        </div>
        <p className="text-center text-sm">
          <Link to="/forgot" className="text-muted hover:text-fg">
            Forgot your password?
          </Link>
        </p>
      </Form>
    </AuthCard>
  );
}
