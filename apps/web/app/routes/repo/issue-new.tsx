import { Download } from "lucide-react";
import { Form, redirect } from "react-router";

import { PROVIDERS } from "@g1t/contracts";

import type { Route } from "./+types/issue-new";
import { page } from "../../lib/meta";
import { ErrorText, Field, Input, SubmitButton, Textarea } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { CheckboxOption } from "../../components/ui/checkbox";
import { SelectField } from "../../components/ui/select";
import { LabelChip } from "../../components/labels";
import { integrations, work } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";
import { accessTo } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New issue · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const path = { namespace: params.owner, name: params.repo };
  const { can } = await accessTo(context, params);
  const [labels, milestones, connections] = await Promise.all([
    work.listLabels(path, user),
    can.triage ? work.listMilestones(path, user, "open") : null,
    integrations.list(params.owner.toLowerCase(), user),
  ]);
  // Systems a ticket can be imported from.
  const sources = connections.ok
    ? [...new Set(connections.value.filter((c) => c.kind === "tracker" || c.provider === "sentry").map((c) => c.provider))]
    : [];
  return {
    labels: unwrap(labels),
    milestones: milestones?.ok ? milestones.value : [],
    // Making labels, and choosing a milestone, need Triage.
    canTriage: can.triage,
    // Making labels needs Write; choosing them and a milestone, Triage.
    canMakeLabels: can.manage_labels,
    sources,
  };
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
      false,
    );
    if (!imported.ok) return { importError: imported.error.message };
    throw redirect(`/${params.owner}/${params.repo}/issues/${imported.value.number}`);
  }
  const path = { namespace: params.owner, name: params.repo };
  const result = await work.openIssue(
    user,
    path,
    {
      title: String(form.get("title") ?? ""),
      body: String(form.get("body") ?? ""),
      labels: [
        ...form.getAll("label").map(String),
        ...String(form.get("labels") ?? "").split(","),
      ],
      milestone: Number(form.get("milestone")) || undefined,
    },
  );
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${params.owner}/${params.repo}/issues/${result.value.number}`);
}

export default function NewIssue({ loaderData, actionData }: Route.ComponentProps) {
  const names = loaderData.sources.map((source) => PROVIDERS[source].label);
  return (
    <div className="max-w-2xl">
      {names.length > 0 && (
        <Card asChild className="mb-8 p-4">
          <Form method="post">
            <input type="hidden" name="intent" value="import" />
            <p className="flex items-center gap-2 text-sm font-medium">
              <Download size={15} className="text-muted" />
              Bring one in from {names.join(" or ")}
            </p>
            <p className="mt-1 text-xs text-muted">
              Give a key such as TECH-1234 or paste its address. The issue stays linked to the
              original, and it hears back when the work lands.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="min-w-56 grow">
                <Input name="reference" required placeholder="TECH-1234" aria-label="Ticket key or address" />
              </div>
              <SubmitButton variant="outline" match={{ intent: "import" }} pending="Importing…">
                Import
              </SubmitButton>
            </div>
            {actionData && "importError" in actionData && (
              <div className="mt-2">
                <ErrorText>{actionData.importError}</ErrorText>
              </div>
            )}
          </Form>
        </Card>
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
          hint="What is wrong or wanted, and anything needed to act on it. A coding agent given this issue works from this text. To say what done looks like, add a list under a “## Definition of done” heading. Pull requests for it merge once the checks the default branch requires pass."
        >
          <Textarea name="body" rows={8} />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-muted">Labels</legend>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {loaderData.labels.map((label) => (
              <CheckboxOption
                key={label.name}
                name="label"
                value={label.name}
                label={<LabelChip name={label.name} color={label.color} />}
                className="items-center gap-1.5"
              />
            ))}
          </div>
          {loaderData.canMakeLabels && (
            <div className="mt-2">
              <Input
                name="labels"
                aria-label="New labels"
                placeholder="New labels, separated by commas: performance, area: cli"
              />
            </div>
          )}
        </fieldset>
        {loaderData.canTriage && loaderData.milestones.length > 0 && (
          <Field label="Milestone">
            <SelectField
              name="milestone"
              defaultValue=""
              options={[
                { value: "", label: "None" },
                ...loaderData.milestones.map((milestone) => ({
                  value: String(milestone.number),
                  label: milestone.dueOn ? `${milestone.title} (due ${milestone.dueOn})` : milestone.title,
                })),
              ]}
            />
          </Field>
        )}
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
        <SubmitButton name="intent" value="open" pending="Opening…">
          Open issue
        </SubmitButton>
      </Form>
    </div>
  );
}
