import { Form } from "react-router";

import type { Route } from "./+types/github";
import { page } from "../../lib/meta";
import { ErrorText, SubmitButton, TimeAgo } from "../../components/ui";
import { Hint } from "../../components/ui/hint";
import { assertSameOrigin, requireUser } from "../../lib/session.server";
import { GithubMark } from "../../components/github";
import { githubSignIn } from "../../lib/github.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "GitHub · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  return { github: await githubSignIn.account(user).catch(() => null) };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if (form.get("intent") === "unlink-github") {
    const result = await githubSignIn.unlink(user);
    return result.ok ? null : { githubError: result.error.message };
  }
  return null;
}

export default function GithubSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { github } = loaderData;
  if (!github?.enabled) {
    return <p className="text-sm text-muted">Signing in with GitHub is not set up here.</p>;
  }
  return (
    <section id="github" className="scroll-mt-20">
      {github.account ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-line px-4 py-3">
          <GithubMark className="size-5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm">
              Linked to <span className="font-mono">@{github.account.login}</span>
            </p>
            <p className="text-xs text-faint">
              Since <TimeAgo at={github.account.linkedAt} />
              {!github.account.authorized && " · access ended: link it again to import repositories"}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {!github.account.authorized && (
              <a href="/auth/github?link=1" className="text-sm text-muted hover:text-fg">
                Link again
              </a>
            )}
            <Form method="post">
              <input type="hidden" name="intent" value="unlink-github" />
              <Hint label={github.hasPassword ? undefined : "GitHub is how you sign in. Set a password first."} disabled={!github.hasPassword}>
                <SubmitButton variant="outline" pending="Unlinking…" match={{ intent: "unlink-github" }} disabled={!github.hasPassword}>
                  Unlink
                </SubmitButton>
              </Hint>
            </Form>
          </div>
        </div>
      ) : (
        <a
          href="/auth/github?link=1"
          className="inline-flex items-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-medium text-fg/90 hover:border-line-strong hover:bg-surface hover:text-fg"
        >
          <GithubMark /> Link GitHub
        </a>
      )}
      {github.account && !github.hasPassword && (
        <p className="mt-2 text-xs text-faint">
          GitHub is the only way you sign in, so it cannot be unlinked yet. Sign out and use Forgot your password to set one.
        </p>
      )}
      <ErrorText>{actionData?.githubError}</ErrorText>
    </section>
  );
}
