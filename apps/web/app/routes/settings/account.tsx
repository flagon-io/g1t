import { Link, redirect } from "react-router";

import type { Route } from "./+types/account";
import { DeleteAccountAction } from "../../components/delete-account";
import { DangerZone } from "../../components/danger-zone";
import { githubSignIn } from "../../lib/github.server";
import { page } from "../../lib/meta";
import { accounts } from "../../lib/services.server";
import { assertSameOrigin, clientOf, endSession, requireUser, sessionTokenOf } from "../../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Account · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  // What deleting it would take, and anything in the way, shown before
  // anyone types: workspaces you own alone, each with what billing needs.
  const [deletion, github] = await Promise.all([
    accounts.checkAccountDeletion(user).catch(() => null),
    githubSignIn.account(user).catch(() => null),
  ]);
  return {
    username: user.username,
    deletion: deletion?.ok ? deletion.value : null,
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
      <DangerZone>
        <DeleteAccountAction
          username={username}
          deletion={deletion}
          hasPassword={hasPassword}
          error={actionData?.deleteError}
        />
      </DangerZone>
    </div>
  );
}
