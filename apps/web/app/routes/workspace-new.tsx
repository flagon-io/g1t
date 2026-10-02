import { Form, redirect } from "react-router";

import type { Route } from "./+types/workspace-new";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { identity } from "../lib/services.server";
import { assertSameOrigin, requireUser } from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "New workspace · g1t" }];
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
    String(form.get("name") ?? ""),
  );
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${result.value.slug}`);
}

export default function NewWorkspace({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { user, first } = loaderData;
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-xl font-semibold">
        {first ? "Create your first workspace" : "New workspace"}
      </h1>
      <p className="mt-2 text-sm text-muted">
        A workspace owns repositories and is the first part of their address:{" "}
        <span className="font-mono text-fg">g1t.sh/workspace/repo</span>. Use
        one for yourself, and one for each team or company you work with.
      </p>
      <Form method="post" className="mt-8 space-y-4">
        <Field
          label="Name in URLs"
          hint="Lowercase letters, digits and single hyphens. It cannot be changed later."
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
          <Input name="name" maxLength={80} />
        </Field>
        <ErrorText>{actionData?.error}</ErrorText>
        <Button type="submit">Create workspace</Button>
      </Form>
    </main>
  );
}
