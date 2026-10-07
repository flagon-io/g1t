import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/auth-github-username";
import { AuthCard } from "../components/auth-card";
import { GithubMark } from "../components/github";
import { ErrorText, Field, Input, SubmitButton } from "../components/ui";
import { PENDING_COOKIE, cookie, readCookie } from "../lib/github";
import { githubSignIn } from "../lib/github.server";
import { page } from "../lib/meta";
import { safeNext } from "../lib/next";
import { assertSameOrigin, startSession } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Choose a username · g1t" });
}

/** A new account from GitHub, once its username (and invite) are settled. */
export async function loader({ request }: Route.LoaderArgs) {
  const pending = readCookie(request.headers.get("cookie"), PENDING_COOKIE);
  if (!pending) throw redirect("/register");
  const found = await githubSignIn.pending(pending);
  if (!found.ok || found.value.kind !== "username") {
    throw redirect("/register", { headers: { "set-cookie": cookie(PENDING_COOKIE, "", 0) } });
  }
  return found.value;
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const pending = readCookie(request.headers.get("cookie"), PENDING_COOKIE);
  if (!pending) throw redirect("/register");
  const form = await request.formData();
  // Where to go afterwards, read before the pending sign-in is used up.
  const found = await githubSignIn.pending(pending).catch(() => null);
  const result = await githubSignIn.signUp(
    pending,
    String(form.get("username") ?? ""),
    String(form.get("invite") ?? "").trim() || null,
  );
  if (!result.ok) return { error: result.error.message };
  const headers = new Headers({ "set-cookie": startSession(result.value.sessionToken) });
  headers.append("set-cookie", cookie(PENDING_COOKIE, "", 0));
  throw redirect(safeNext(found?.ok ? found.value.next : "/"), { headers });
}

export default function GithubUsername({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <AuthCard
      title="Create your account"
      subtitle={loaderData.inviteRequired ? "g1t is invite-only for now" : "Choose your username"}
      footer={
        <>
          Have an account already?{" "}
          <Link to="/login?github=link" className="text-fg underline underline-offset-4">
            Sign in to link GitHub
          </Link>
        </>
      }
    >
      <p className="mb-6 flex items-center gap-2 text-sm text-muted">
        <GithubMark />
        Signed in to GitHub as <span className="font-mono text-fg">@{loaderData.login}</span>
      </p>
      <Form method="post" className="space-y-4">
        <Field
          label="Username"
          hint="Lowercase letters, digits and hyphens. It is how others see you on g1t."
        >
          <Input
            name="username"
            autoComplete="username"
            required
            autoFocus
            maxLength={39}
            defaultValue={loaderData.suggestion ?? ""}
            pattern="[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*"
          />
        </Field>
        {loaderData.inviteRequired && (
          <Field label="Invite code" hint="g1t is invite-only. Ask someone on g1t for one of their invites.">
            <Input name="invite" required autoComplete="off" spellCheck={false} />
          </Field>
        )}
        <ErrorText>{actionData?.error}</ErrorText>
        <div className="pt-2 *:w-full">
          <SubmitButton pending="Creating account…">
            Create account
          </SubmitButton>
        </div>
      </Form>
    </AuthCard>
  );
}
