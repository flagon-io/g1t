import { Form, redirect } from "react-router";

import type { Route } from "./+types/new";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { repos } from "../lib/services.server";
import { assertSameOrigin, requireUser } from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "New repository · g1t" }];
}

export function loader({ request, context }: Route.LoaderArgs) {
  return { user: requireUser(context, request) };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const result = await repos.create(user, {
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    isPrivate: form.get("visibility") === "private",
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
            <span className="text-muted">{loaderData.user.username}/</span>
            <Input name="name" required autoFocus maxLength={100} />
          </div>
        </Field>
        <Field label="Description (optional)">
          <Input name="description" maxLength={200} />
        </Field>
        <fieldset className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="visibility" value="public" defaultChecked />
            Public — anyone can see and clone it
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="visibility" value="private" />
            Private — only you
          </label>
        </fieldset>
        <ErrorText>{actionData?.error}</ErrorText>
        <Button type="submit">Create repository</Button>
      </Form>
    </main>
  );
}
