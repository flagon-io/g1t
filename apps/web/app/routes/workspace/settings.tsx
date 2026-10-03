import { Form, data, redirect } from "react-router";

import type { Route } from "./+types/settings";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Settings · ${params.owner} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  // Owners only; to anyone else the page does not exist.
  if (roleIn(getViewer(context), params.owner) !== "owner") {
    throw data(null, { status: 404 });
  }
  const workspace = await identity.getWorkspace(params.owner);
  if (!workspace) throw data(null, { status: 404 });
  return { workspace };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const result = await identity.updateWorkspace(user, params.owner, {
    name: String(form.get("displayName") ?? ""),
    description: String(form.get("description") ?? ""),
  });
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${result.value.slug}`);
}

export default function WorkspaceSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { workspace } = loaderData;
  return (
    <div className="max-w-lg">
      <h2 className="font-medium">Workspace details</h2>
      <Form method="post" className="mt-5 space-y-4">
        <Field label="Display name">
          <Input name="displayName" maxLength={80} defaultValue={workspace.name} />
        </Field>
        <Field label="Description" hint="One line, shown at the top of the workspace's page.">
          <Input
            name="description"
            maxLength={160}
            defaultValue={workspace.description ?? ""}
          />
        </Field>
        <Field
          label="Name in URLs"
          hint="This cannot be changed: repository addresses and clones depend on it."
        >
          <p className="font-mono text-sm text-muted">g1t.sh/{workspace.slug}</p>
        </Field>
        <ErrorText>{actionData?.error}</ErrorText>
        <Button type="submit">Save</Button>
      </Form>
    </div>
  );
}
