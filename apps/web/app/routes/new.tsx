import { Form, redirect } from "react-router";

import type { Route } from "./+types/new";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { repos } from "../lib/services.server";
import { assertSameOrigin, requireUser } from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "New repository · g1t" }];
}

export function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const workspaces = (user.workspaces ?? []).map((membership) => membership.slug);
  // Repositories live in a workspace, so there has to be one first.
  if (workspaces.length === 0) throw redirect("/workspaces/new");
  const asked = new URL(request.url).searchParams.get("workspace");
  return {
    workspaces,
    selected: asked && workspaces.includes(asked) ? asked : workspaces[0],
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const result = await repos.create(user, {
    namespace: String(form.get("workspace") ?? ""),
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    isPrivate: form.get("visibility") === "private",
    importUrl: String(form.get("importUrl") ?? "").trim() || undefined,
  });
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${result.value.namespace}/${result.value.name}`);
}

export default function NewRepo({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-xl font-semibold">New repository</h1>
      <Form method="post" className="mt-8 space-y-4">
        <Field label="Name">
          <div className="flex items-center gap-2 font-mono text-sm">
            <select
              name="workspace"
              defaultValue={loaderData.selected}
              aria-label="Workspace"
              className="rounded-md border border-line bg-bg px-2 py-2 text-sm"
            >
              {loaderData.workspaces.map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </select>
            <span className="text-muted">/</span>
            <Input name="name" required autoFocus maxLength={100} />
          </div>
        </Field>
        <Field label="Description (optional)">
          <Input name="description" maxLength={200} />
        </Field>
        <Field
          label="Import from (optional)"
          hint="The address of a public repository on GitHub or any git host. Its default branch is copied, up to 40 MB. Leave empty to start with nothing."
        >
          <Input
            name="importUrl"
            type="url"
            placeholder="https://github.com/owner/repo"
          />
        </Field>
        <fieldset className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="visibility" value="public" defaultChecked />
            Public — anyone can see and clone it
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="visibility" value="private" />
            Private — only members of the workspace
          </label>
        </fieldset>
        <ErrorText>{actionData?.error}</ErrorText>
        <Button type="submit">Create repository</Button>
      </Form>
    </main>
  );
}
