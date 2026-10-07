import { Form, redirect } from "react-router";

import type { Route } from "./+types/new";
import { page } from "../../lib/meta";
import { ErrorText, Field, Input, SubmitButton } from "../../components/ui";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, nextPath, requireUser } from "../../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "New workspace · g1t" });
}

export function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  return { user, first: (user.workspaces ?? []).length === 0 };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const result = await identity.createWorkspace(
    user,
    String(form.get("slug") ?? ""),
    String(form.get("displayName") ?? ""),
  );
  if (!result.ok) return { error: result.error.message };
  // Someone sent here on their way elsewhere carries on to it.
  const next = nextPath(request);
  throw redirect(next === "/" ? `/${result.value.slug}` : next);
}

export default function NewWorkspace({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { user, first } = loaderData;
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-xl font-semibold">
        {first ? "Create your workspace" : "New workspace"}
      </h1>
      <p className="mt-2 text-sm text-muted">
        {first && "Everything on g1t lives in a workspace, so this comes first. "}
        A workspace holds repositories, the people who work on them and the
        access tokens that automate them, and is the first part of every
        address: <span className="font-mono text-fg">g1t.sh/workspace/repo</span>.
        Use one for yourself, and one for each team or company you work with.
      </p>
      {!user.verified && (
        <p className="mt-4 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm">
          Confirm your email address first. We sent you a link.
        </p>
      )}
      <Form method="post" className="mt-8 space-y-4">
        <Field
          label="Name in URLs"
          hint="Lowercase letters, digits and single hyphens. An owner can change it later; old addresses redirect for 90 days."
        >
          <div className="flex items-center gap-2 font-mono text-sm">
            <span className="text-muted">g1t.sh/</span>
            <Input
              name="slug"
              required
              autoFocus
              maxLength={39}
              defaultValue={first ? user.username : ""}
              pattern="[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*"
            />
          </div>
        </Field>
        <Field label="Display name (optional)">
          <Input name="displayName" maxLength={80} />
        </Field>
        <ErrorText>{actionData?.error}</ErrorText>
        <SubmitButton pending="Creating…">Create workspace</SubmitButton>
      </Form>
    </main>
  );
}
