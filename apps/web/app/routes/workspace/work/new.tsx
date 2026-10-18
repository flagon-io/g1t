import { Download, Info } from "lucide-react";
import { Form, data, redirect } from "react-router";

import { PROVIDERS, type User, type WorkItem } from "@g1t/contracts";

import type { Route } from "./+types/new";
import { page } from "../../../lib/meta";
import { ErrorText, Field, Input, SubmitButton } from "../../../components/ui";
import { AttachImages } from "../../../components/attach-images";
import { MentionTextarea } from "../../../components/mention-textarea";
import { Card } from "../../../components/ui/card";
import { CheckboxOption } from "../../../components/ui/checkbox";
import { SelectField } from "../../../components/ui/select";
import { LabelChip } from "../../../components/labels";
import { Unavailable } from "../../../components/boundary";
import { integrations, repos, work } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";
import { canItem } from "../../../lib/work-access";
import { isFailed, part } from "../../../lib/partial";
import { itemPath } from "../../../lib/work-items";
import { workspaceProjects } from "../../../lib/workspace-projects.server";
import { addresses } from "../../../lib/addresses.server";
import { DEFERRED_FILE_FIELD, DEFERRED_REF_FIELD, deferredRefs, resolveDeferred } from "../../../lib/attachments";
import { toBase64 } from "../../../lib/avatar-upload";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New work item · ${params.owner} · g1t` });
}

/** The repository a new item is filed from, from `?repo=web` (or `acme/web`): only one of this workspace. */
function originOf(workspace: string, value: string | null): string | null {
  const parts = (value ?? "").split("/").filter(Boolean);
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2 && parts[0]!.toLowerCase() === workspace) return parts[1]!;
  return null;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const workspace = params.owner.toLowerCase();
  const name = originOf(workspace, new URL(request.url).searchParams.get("repo"));
  // Filed from a repository, it is that repository's (its origin): anyone
  // who may take part there may. Filed in the workspace alone, a member.
  const origin = name ? await repos.get({ namespace: workspace, name }, user) : null;
  if (name && !origin?.ok) throw data(null, { status: 404 });
  const ref = origin?.ok ? { id: origin.value.id, namespace: origin.value.namespace, isPrivate: origin.value.isPrivate } : null;
  const member = roleIn(user, workspace) != null;
  if (!member && !canItem(user, workspace, ref, "participate")) throw data(null, { status: 404 });
  const triage = canItem(user, workspace, ref, "triage");
  // The form is what this page is about; what fills its choices is a part
  // each, which says so in its own place when its service fails.
  const [labels, milestones, projects, connections] = await Promise.all([
    part(work.listLabels(workspace, user), "Labels"),
    triage ? part(work.listMilestones(workspace, user, "open"), "Milestones") : null,
    // Where it may land: the workspace's repositories, for a member.
    member ? part(workspaceProjects(workspace, user), "Repositories") : null,
    // Only a hint at what can be imported: the page does without it.
    member ? integrations.list(workspace, user).catch(() => null) : null,
  ]);
  const sources = connections?.ok ? [...new Set(connections.value.filter((c) => c.kind === "tracker" || c.provider === "sentry").map((c) => c.provider))] : [];
  return {
    workspace,
    origin: name,
    labels: isFailed(labels) ? labels : labels.ok ? labels.value : [],
    milestones: isFailed(milestones) ? milestones : milestones?.ok ? milestones.value : [],
    repos:
      projects == null
        ? []
        : isFailed(projects)
          ? projects
          : projects.ok
            ? projects.value
                .filter((p) => p.workspace.toLowerCase() === workspace)
                .map((p) => p.slug)
                .sort()
            : [],
    canTriage: triage,
    // Making labels needs Write in the workspace; choosing them and a milestone, Triage.
    canMakeLabels: canItem(user, workspace, ref, "manage_labels"),
    sources,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const workspace = params.owner.toLowerCase();
  const form = await request.formData();
  const origin = originOf(workspace, String(form.get("origin") ?? "") || null);
  if (form.get("intent") === "import") {
    const imported = await integrations.import(user, workspace, String(form.get("reference") ?? ""), {
      repo: origin ? { namespace: workspace, name: origin } : undefined,
    });
    if (!imported.ok) return { importError: imported.error.message };
    throw redirect(itemPath(imported.value.workspace, imported.value.number));
  }
  const result = await work.openWorkItem(user, {
    workspace,
    repo: origin ? { namespace: workspace, name: origin } : undefined,
    targets: [...new Set(form.getAll("target").map(String).filter(Boolean))].map((name) => ({ namespace: workspace, name })),
    title: String(form.get("title") ?? ""),
    body: String(form.get("body") ?? ""),
    labels: [...form.getAll("label").map(String), ...String(form.get("labels") ?? "").split(",")].map((label) => label.trim()).filter(Boolean),
    milestone: Number(form.get("milestone")) || undefined,
  });
  if (!result.ok) return { error: result.error.message };
  await attachHeld(user, result.value, form);
  throw redirect(itemPath(result.value.workspace, result.value.number));
}

/**
 * Images put in the description of a work item filed with no repository
 * (components/attach-images.tsx, `later`): with nothing to keep them until
 * it was open, they came with the form as `![name](attachment:<ref>)`.
 * Now the work item keeps them, and its description gets their addresses,
 * as `g1t work new --attach` does. One that fails to upload is taken out
 * of the description; the box checked its type and size before it was sent.
 */
async function attachHeld(user: User, item: WorkItem, form: FormData) {
  const files = form.getAll(DEFERRED_FILE_FIELD);
  const refs = form.getAll(DEFERRED_REF_FIELD).map(String);
  const body = item.body ?? "";
  const wanted = deferredRefs(body);
  if (wanted.size === 0) return;
  const urls = new Map<string, string | null>();
  for (const [index, ref] of refs.entries()) {
    const file = files[index];
    if (!wanted.has(ref) || !file || typeof file === "string") continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kept = await work
      .uploadAttachment(user, { workspace: item.workspace, number: item.number }, { name: file.name || "image.png", data: toBase64(bytes) })
      .catch(() => null);
    urls.set(ref, kept?.ok ? `${addresses().usercontent}${kept.value.path}` : null);
  }
  // Any still not uploaded (its file did not arrive) goes too.
  for (const ref of wanted) if (!urls.has(ref)) urls.set(ref, null);
  await work.updateWorkItem(user, item.workspace, item.number, { body: resolveDeferred(body, urls) }).catch(() => null);
}

export default function NewWorkItem({ loaderData, actionData }: Route.ComponentProps) {
  const { origin, workspace } = loaderData;
  const names = loaderData.sources.map((source) => PROVIDERS[source].label);
  return (
    <div className="max-w-2xl">
      {origin && (
        <p className="mb-6 flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-muted">
          <Info size={15} className="mt-0.5 shrink-0 text-faint" />
          <span>
            Filed from{" "}
            <span className="font-mono text-fg">
              {workspace}/{origin}
            </span>
            , its origin: anyone who can read it sees this work item.
          </span>
        </p>
      )}
      {names.length > 0 && (
        <Card asChild className="mb-8 p-4">
          <Form method="post">
            <input type="hidden" name="intent" value="import" />
            <input type="hidden" name="origin" value={origin ?? ""} />
            <p className="flex items-center gap-2 text-sm font-medium">
              <Download size={15} className="text-muted" />
              Bring one in from {names.join(" or ")}
            </p>
            <p className="mt-1 text-xs text-muted">
              Give a key such as TECH-1234 or paste its address. The work item stays linked to the original, and it hears back when the work lands.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="min-w-56 grow">
                <Input name="reference" required placeholder="TECH-1234" aria-label="Ticket key or address" autoCapitalize="characters" />
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
      <Form method="post" encType="multipart/form-data" className="space-y-5">
        <input type="hidden" name="origin" value={origin ?? ""} />
        <Field label="Title">
          <Input
            name="title"
            required
            autoFocus
            maxLength={200}
            autoCapitalize="sentences"
            enterKeyHint="next"
            placeholder="Sign-in times out on slow networks"
          />
        </Field>
        <Field
          label="Description"
          htmlFor="item-body"
          hint="What is wrong or wanted, and anything needed to act on it. Whoever works on it, person or agent, works from this text. To say what done looks like, add a list under a “## Definition of done” heading."
        >
          {/* Filed from a repository, it keeps the images; with none, the work item does, once it is open. */}
          <AttachImages to={origin ? { repo: `${workspace}/${origin}` } : "later"}>
            <MentionTextarea id="item-body" name="body" rows={8} autoCapitalize="sentences" />
          </AttachImages>
        </Field>
        {isFailed(loaderData.repos) ? (
          <Field label="Where it lands">
            <Unavailable what="The workspace's repositories" compact />
          </Field>
        ) : (
          loaderData.repos.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-muted">Where it lands</legend>
              <p className="mb-2 text-xs text-muted">
                Its targets: none, one or several. It closes once what closes it has landed in every one, or with none, once anything does.
              </p>
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {loaderData.repos.map((name) => (
                  <CheckboxOption
                    key={name}
                    name="target"
                    value={name}
                    defaultChecked={name === origin}
                    label={<span className="font-mono text-sm">{name}</span>}
                    className="min-h-10 items-center gap-2"
                  />
                ))}
              </div>
            </fieldset>
          )
        )}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-muted">Labels</legend>
          {isFailed(loaderData.labels) ? (
            <Unavailable what="The workspace's labels" compact />
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {loaderData.labels.map((label) => (
                <CheckboxOption
                  key={label.name}
                  name="label"
                  value={label.name}
                  label={<LabelChip name={label.name} color={label.color} />}
                  className="min-h-8 items-center gap-1.5"
                />
              ))}
            </div>
          )}
          {loaderData.canMakeLabels && (
            <div className="mt-2">
              <Input name="labels" aria-label="New labels" placeholder="New labels, separated by commas: performance, area: cli" autoCapitalize="none" />
            </div>
          )}
        </fieldset>
        {loaderData.canTriage && isFailed(loaderData.milestones) && (
          <Field label="Milestone">
            <Unavailable what="Milestones" compact />
          </Field>
        )}
        {loaderData.canTriage && !isFailed(loaderData.milestones) && loaderData.milestones.length > 0 && (
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
        {/* Within reach on a phone, above the keyboard when it is up. */}
        <div className="sticky bottom-(--tabbar-h) -mx-4 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur in-data-[keyboard=open]:bottom-0 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none max-sm:*:w-full">
          <SubmitButton name="intent" value="open" pending="Opening…" className="max-sm:h-11">
            Open work item
          </SubmitButton>
        </div>
      </Form>
    </div>
  );
}
