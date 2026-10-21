import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/account";
import { DeleteAccountAction } from "../../components/delete-account";
import { DangerZone } from "../../components/danger-zone";
import { DeveloperModeSwitch } from "../../components/developer-mode-switch";
import { ThemeSwitch } from "../../components/theme-switch";
import { ErrorText, SubmitButton } from "../../components/ui";
import { githubSignIn } from "../../lib/github.server";
import { page } from "../../lib/meta";
import { accounts, privacy } from "../../lib/services.server";
import { Unavailable } from "../../components/boundary";
import { isFailed, part } from "../../lib/partial";
import { assertSameOrigin, clientOf, endSession, requireUser, sessionTokenOf } from "../../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Account · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  // What deleting it would take, and anything in the way, shown before
  // anyone types: workspaces you own alone, each with what billing needs.
  // Each section reads its own: one that could not be read says so in its
  // place, and its form is not offered on what is not known. Whether they
  // have a password only says whether deleting asks for one, and identity
  // checks that anyway: asking for it is the safe guess.
  const [deletion, github, erasure] = await Promise.all([
    part(accounts.checkAccountDeletion(user), "What deleting your account would take"),
    githubSignIn.account(user).catch(() => null),
    part(privacy.mine(user), "Your erasure request"),
  ]);
  return {
    erasure,
    username: user.username,
    deletion: isFailed(deletion) ? deletion : deletion.ok ? deletion.value : null,
    hasPassword: github?.hasPassword ?? true,
  };
}

/**
 * Deleting the account: identity checks the person, the typed username,
 * the proof that it is them, protection and the workspaces they own alone.
 * Once it is deleted, this browser is signed out and sent home.
 */
export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if (form.get("intent") === "request-erasure") {
    // Identity unreachable is not a refusal: say so, and where else to ask.
    const result = await privacy.request(user).catch(() => null);
    if (!result) return { erasureError: "We could not record your request just now. Try again, or email support@g1t.sh." };
    return result.ok
      ? { erasureNotice: `Request ${result.value.id} received. We will respond by ${result.value.due_at.slice(0, 10)}.` }
      : { erasureError: result.error.message };
  }
  if (form.get("intent") !== "delete-account") return null;
  const password = String(form.get("password") ?? "");
  const result = await accounts.deleteAccount(user, String(form.get("confirm") ?? ""), {
    sessionToken: sessionTokenOf(request),
    password: password || null,
    client: clientOf(request),
  });
  if (!result.ok) return { deleteError: result.error.message, reauth: result.error.code === "reauth_required" };
  throw redirect("/", { headers: { "set-cookie": await endSession(request) } });
}

export default function AccountSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { username, deletion, hasPassword } = loaderData;
  return (
    <div className="space-y-8">
      <section aria-labelledby="username-heading">
        <h2 id="username-heading" className="font-medium">
          Username
        </h2>
        <p className="mt-1 text-sm text-muted">
          You are <span className="font-mono text-fg">{username}</span>. Your profile is at{" "}
          <Link to={`/${username}`} className="text-accent underline-offset-4 hover:underline">
            g1t.sh/{username}
          </Link>
          .
        </p>
      </section>
      <section aria-labelledby="appearance-heading">
        <h2 id="appearance-heading" className="font-medium">
          Appearance
        </h2>
        <p className="mt-1 text-sm text-muted">Light, dark, or Auto to follow your system. This browser remembers it.</p>
        <ThemeSwitch className="mt-3 w-full max-w-xs" />
      </section>
      <section id="developer" aria-labelledby="developer-heading" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
        <h2 id="developer-heading" className="font-medium">
          Developer
        </h2>
        <p className="mt-1 text-sm text-muted">For reporting what went wrong when something breaks.</p>
        <div className="mt-3">
          <DeveloperModeSwitch />
        </div>
      </section>
      <section aria-labelledby="erasure-heading" className="space-y-3">
        <h2 id="erasure-heading" className="font-medium">
          Erase my personal data
        </h2>
        <p className="text-sm text-muted">
          Request erasure even if workspace ownership or billing prevents account closure. We review shared content and any records we must retain, then explain
          the outcome. This request does not immediately delete your account.
        </p>
        {isFailed(loaderData.erasure) ? (
          <Unavailable what="Your erasure request" />
        ) : loaderData.erasure ? (
          <p className="text-sm">
            Request {loaderData.erasure.id}: {loaderData.erasure.status}. Response due {loaderData.erasure.due_at.slice(0, 10)}.
          </p>
        ) : null}
        {actionData?.erasureNotice && (
          <p role="status" className="text-sm">
            {actionData.erasureNotice}
          </p>
        )}
        <ErrorText>{actionData?.erasureError}</ErrorText>
        {!isFailed(loaderData.erasure) && (!loaderData.erasure || ["completed", "refused"].includes(loaderData.erasure.status)) && (
          <Form method="post">
            <SubmitButton name="intent" value="request-erasure" pending="Recording request...">
              Request erasure
            </SubmitButton>
          </Form>
        )}
        <p className="text-sm text-muted">
          For specific content, a request without signing in, or a question about an existing request, email{" "}
          <a href="mailto:support@g1t.sh" className="underline">
            support@g1t.sh
          </a>
          .
        </p>
      </section>
      <DangerZone>
        {isFailed(deletion) ? (
          <Unavailable what="What deleting your account would take" />
        ) : (
          <DeleteAccountAction username={username} deletion={deletion} hasPassword={hasPassword} error={actionData?.deleteError} />
        )}
      </DangerZone>
    </div>
  );
}
