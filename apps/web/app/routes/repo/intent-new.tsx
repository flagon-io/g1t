import { env } from "cloudflare:workers";
import { Form, redirect } from "react-router";

import type { Route } from "./+types/intent-new";
import { Button, ErrorText, Field, Input, Textarea } from "../../components/ui";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export function loader({ request, context }: Route.LoaderArgs) {
  requireUser(context, request);
  return null;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const result = await env.WORK.openIntent(
    user,
    { namespace: params.owner, name: params.repo },
    {
      title: String(form.get("title") ?? ""),
      brief: String(form.get("brief") ?? ""),
      checks: String(form.get("checks") ?? "").split("\n"),
    },
  );
  if (!result.ok) return { error: result.error.message };
  throw redirect(
    `/${params.owner}/${params.repo}/intents/${result.value.number}`,
  );
}

export default function NewIntent({ actionData }: Route.ComponentProps) {
  return (
    <Form method="post" className="mt-6 max-w-2xl space-y-4">
      <Field label="Goal">
        <Input
          name="title"
          required
          autoFocus
          maxLength={200}
          placeholder="Make the parser streaming"
        />
      </Field>
      <Field
        label="Brief"
        hint="What an agent is given to work from: the outcome you want, constraints, and anything it should know."
      >
        <Textarea name="brief" rows={8} />
      </Field>
      <Field
        label="Acceptance checks (optional)"
        hint="One command per line. An attempt is accepted when they all pass."
      >
        <Textarea name="checks" rows={3} placeholder="cargo test" />
      </Field>
      <ErrorText>{actionData?.error}</ErrorText>
      <Button type="submit">Open intent</Button>
    </Form>
  );
}
