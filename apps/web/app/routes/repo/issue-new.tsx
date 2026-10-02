import { Form, redirect } from "react-router";

import type { Route } from "./+types/issue-new";
import { Button, ErrorText, Field, Input, Textarea } from "../../components/ui";
import { Label } from "../../components/work";
import { work } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `New issue · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const path = { namespace: params.owner, name: params.repo };
  return { labels: unwrap(await work.listLabels(path, user)) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const result = await work.openIssue(
    user,
    { namespace: params.owner, name: params.repo },
    {
      title: String(form.get("title") ?? ""),
      body: String(form.get("body") ?? ""),
      labels: [
        ...form.getAll("label").map(String),
        ...String(form.get("labels") ?? "").split(","),
      ],
      checks: String(form.get("checks") ?? "").split("\n"),
    },
  );
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${params.owner}/${params.repo}/issues/${result.value.number}`);
}

export default function NewIssue({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <Form method="post" className="max-w-2xl space-y-4">
      <Field label="Title">
        <Input
          name="title"
          required
          autoFocus
          maxLength={200}
          placeholder="Parser drops the last line of a file without a trailing newline"
        />
      </Field>
      <Field
        label="Description"
        hint="What is wrong or wanted, and anything needed to act on it. An agent given this issue works from this text."
      >
        <Textarea name="body" rows={8} />
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-muted">Labels</legend>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {loaderData.labels.map((name) => (
            <label key={name} className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" name="label" value={name} className="accent-accent" />
              <Label name={name} />
            </label>
          ))}
        </div>
        <div className="mt-2">
          <Input
            name="labels"
            aria-label="Other labels"
            placeholder="Others, separated by commas: performance, good first issue"
          />
        </div>
      </fieldset>
      <Field
        label="Acceptance checks (optional)"
        hint="One command per line. A pull request for this issue should make them all pass."
      >
        <Textarea name="checks" rows={3} placeholder="cargo test" />
      </Field>
      <ErrorText>{actionData?.error}</ErrorText>
      <Button type="submit">Open issue</Button>
    </Form>
  );
}
