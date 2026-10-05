import { Download } from "lucide-react";
import { Form, redirect, useNavigation } from "react-router";

import { PROVIDERS } from "@g1t/contracts";

import type { Route } from "./+types/issue-new";
import { page } from "../../lib/meta";
import { Button, ErrorText, Field, Input, Textarea } from "../../components/ui";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Label } from "../../components/work";
import { integrations, work } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New issue · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const path = { namespace: params.owner, name: params.repo };
  const [labels, connections] = await Promise.all([
    work.listLabels(path, user),
    integrations.list(params.owner.toLowerCase(), user),
  ]);
  // Systems a ticket can be imported from.
  const sources = connections.ok
    ? [...new Set(connections.value.filter((c) => c.kind === "tracker" || c.provider === "sentry").map((c) => c.provider))]
    : [];
  return { labels: unwrap(labels), sources };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if (form.get("intent") === "import") {
    const imported = await integrations.import(
      user,
      { namespace: params.owner, name: params.repo },
      String(form.get("reference") ?? ""),
      form.get("assign") === "on",
    );
    if (!imported.ok) return { importError: imported.error.message };
    throw redirect(`/${params.owner}/${params.repo}/issues/${imported.value.number}`);
  }
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
  const busy = useNavigation().state === "submitting";
  const names = loaderData.sources.map((source) => PROVIDERS[source].label);
  return (
    <div className="max-w-2xl">
      {names.length > 0 && (
        <Form method="post" className="mb-8 rounded-xl border border-line bg-surface p-4">
          <input type="hidden" name="intent" value="import" />
          <p className="flex items-center gap-2 text-sm font-medium">
            <Download size={15} className="text-muted" />
            Bring one in from {names.join(" or ")}
          </p>
          <p className="mt-1 text-xs text-muted">
            Give a key such as TECH-1234 or paste its address. The issue stays linked: agents read the
            original, and it hears back when the work lands.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="min-w-56 grow">
              <Input name="reference" required placeholder="TECH-1234" aria-label="Ticket key or address" />
            </div>
            <CheckboxOption name="assign" label="Put an agent on it" className="items-center" labelClassName="text-muted" />
            <Button type="submit" variant="quiet" disabled={busy}>
              Import
            </Button>
          </div>
          {actionData && "importError" in actionData && (
            <div className="mt-2">
              <ErrorText>{actionData.importError}</ErrorText>
            </div>
          )}
        </Form>
      )}
      <Form method="post" className="space-y-4">
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
              <CheckboxOption key={name} name="label" value={name} label={<Label name={name} />} className="items-center gap-1.5" />
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
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
        <Button type="submit">Open issue</Button>
      </Form>
    </div>
  );
}
