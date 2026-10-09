import { env } from "cloudflare:workers";
import { Download, Sparkles } from "lucide-react";
import { Form, Link, redirect, useSearchParams } from "react-router";

import { PROVIDERS } from "@g1t/contracts";

import type { Route } from "./+types/issue-new";
import { page } from "../../lib/meta";
import { ErrorText, Field, Input, SubmitButton, Textarea } from "../../components/ui";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Hint } from "../../components/ui/hint";
import { useMirrorReason } from "../../components/mirror";
import { SelectField } from "../../components/ui/select";
import { LabelChip } from "../../components/labels";
import { integrations, work } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";
import { accessTo } from "../../lib/access.server";
import { computeNoteFor } from "../../lib/compute.server";
import { delegateForm, issuePath, notStarted } from "../../lib/delegate";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New issue · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const path = { namespace: params.owner, name: params.repo };
  // Putting an agent on it needs Write (Run): Read cannot spend compute.
  const { can } = await accessTo(context, params);
  const [labels, milestones, connections, agents, computeNote] = await Promise.all([
    work.listLabels(path, user),
    can.triage ? work.listMilestones(path, user, "open") : null,
    integrations.list(params.owner.toLowerCase(), user),
    can.run ? env.RUNNER.enabled(user, path) : false,
    can.run ? computeNoteFor(params.owner, "agent") : null,
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
    canAssign: can.run,
    agents,
    computeNote,
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
      form.get("assign") === "on",
    );
    if (!imported.ok) return { importError: imported.error.message };
    throw redirect(`/${params.owner}/${params.repo}/issues/${imported.value.number}`);
  }
  const path = { namespace: params.owner, name: params.repo };
  // Assigned to g1t as it opens: one step, and the agent starts.
  if (form.get("agent") === "on") {
    const delegated = await env.RUNNER.delegate(user, path, delegateForm(form));
    if (!delegated.ok) return { error: delegated.error.message };
    const { issue, agent } = delegated.value;
    const refused = notStarted(agent, path, issue.number);
    if (!refused) throw redirect(issuePath(path, issue.number));
    return { notStarted: refused };
  }
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
  // "Put an agent on …" in the palette arrives with ?agent=1.
  const [params] = useSearchParams();
  const refused = actionData && "notStarted" in actionData ? actionData.notStarted : null;
  const names = loaderData.sources.map((source) => PROVIDERS[source].label);
  // A mirror takes no new issues until someone takes over.
  const mirrorBlocked = useMirrorReason();
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
            <Hint label={mirrorBlocked} disabled={mirrorBlocked != null}>
              <SubmitButton variant="quiet" match={{ intent: "import" }} pending="Importing…" disabled={mirrorBlocked != null}>
                Import
              </SubmitButton>
            </Hint>
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
          hint="What is wrong or wanted, and anything needed to act on it. An agent given this issue works from this text. To say what done looks like, add a list under a “## Definition of done” heading. Pull requests for it merge once the checks the default branch requires pass."
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
        {loaderData.canAssign && (
          <div className="rounded-xl border border-accent/25 bg-accent/[0.04] px-3.5 py-3">
            <CheckboxOption
              name="agent"
              defaultChecked={params.get("agent") === "1"}
              label={
                <span className="flex items-center gap-1.5 font-medium">
                  <Sparkles size={14} className="text-accent" />
                  Assign g1t now
                </span>
              }
              description="It opens a pull request for this issue in a sandbox of its own and sees it through: this repository's workflows run on it as its checks, and it revises until the required ones pass and the review approves. There is no model or agent count to choose."
            />
            {(!loaderData.agents || loaderData.computeNote) && (
              <p className="mt-2 pl-6 text-xs text-warn">
                {loaderData.computeNote ?? "This workspace's agents have no model yet. The issue still opens, and says why the agent did not start."}
              </p>
            )}
          </div>
        )}
        {refused && (
          <div className="rounded-lg border border-warn/30 bg-warn/[0.06] p-3 text-sm">
            <p>
              Opened{" "}
              <Link to={refused.to} className="font-medium text-fg hover:underline">
                #{refused.number}
              </Link>
              , but g1t did not start. {refused.message}
            </p>
            {refused.fix && (
              <Link to={refused.fix.to} className="mt-2 inline-block text-sm font-medium text-fg hover:underline">
                {refused.fix.label}
              </Link>
            )}
          </div>
        )}
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
        <Hint label={mirrorBlocked} disabled={mirrorBlocked != null}>
          <SubmitButton name="intent" value="open" pending="Opening…" disabled={mirrorBlocked != null}>
            Open issue
          </SubmitButton>
        </Hint>
      </Form>
    </div>
  );
}
