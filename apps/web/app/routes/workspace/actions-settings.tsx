import { BadgeCheck, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, useFetcher } from "react-router";

import type { WorkspaceActionsSettings, WorkspaceManagedWorkflow } from "@g1t/contracts";

import type { Route } from "./+types/actions-settings";
import { SettingsSection as Section } from "../../components/settings-section";
import { EmptyState, ErrorText, Field, Input, SubmitButton, Textarea, TimeAgo } from "../../components/ui";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { SelectField } from "../../components/ui/select";
import { Unavailable } from "../../components/boundary";
import { page } from "../../lib/meta";
import { isFailed, part, type Failed } from "../../lib/partial";
import { actions } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Actions · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Members may see the policy; owners change it.
  const role = roleIn(viewer, params.owner);
  if (!role) throw new Response(null, { status: 404 });
  const workspace = params.owner.toLowerCase();
  const settings = unwrap(await actions.workspaceActionsSettings(workspace, viewer));
  // The workflows it manages, and their sources, are its owners' to see.
  // They are a section beside the policy: when Actions does not answer for
  // them, that section says so and the policy's form stays.
  const listed = role === "owner" ? await part(actions.workspaceManagedWorkflows(workspace, viewer), "Managed workflows") : null;
  const managed = listed === null ? [] : isFailed(listed) ? listed : unwrap(listed);
  return { settings, managed, owner: role === "owner" };
}

/** One per line, or separated by commas. */
function patterns(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

type ManagedResult = { ok: true; error: null } | { ok: false; error: string };

async function managedAction(form: FormData, user: Parameters<typeof actions.removeWorkspaceManagedWorkflow>[0], workspace: string): Promise<ManagedResult> {
  const intent = form.get("intent");
  const name = String(form.get("name") ?? "").trim();
  const done = (result: { ok: true } | { ok: false; error: { message: string } }): ManagedResult =>
    result.ok ? { ok: true, error: null } : { ok: false, error: result.error.message };
  if (intent === "managed-remove") return done(await actions.removeWorkspaceManagedWorkflow(user, workspace, name));
  if (intent === "managed-refresh") return done(await actions.setWorkspaceManagedWorkflow(user, workspace, name, { refresh: true }));
  const mode = form.get("mode") === "required" ? "required" : "default";
  const visibility = String(form.get("visibility") ?? "all") as "all" | "public" | "private";
  const change = {
    source: String(form.get("source") ?? "").trim() || undefined,
    mode,
    repositories: form.get("target") === "all" ? [] : patterns(String(form.get("repositories") ?? "")),
    visibility,
  } as const;
  return done(await actions.setWorkspaceManagedWorkflow(user, workspace, name, change, form.get("create") === "true"));
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (roleIn(getViewer(context), params.owner) !== "owner") throw new Response(null, { status: 404 });
  const user = requireUser(context, request);
  const form = await request.formData();
  if (String(form.get("intent") ?? "").startsWith("managed-")) {
    return { saved: false, error: null, managed: await managedAction(form, user, params.owner.toLowerCase()) };
  }
  const level = (name: string): "read" | "write" => (form.get(name) === "write" ? "write" : "read");
  const change: Partial<WorkspaceActionsSettings> = {
    defaultPermissions: level("defaultPermissions"),
    maxPermissions: level("maxPermissions"),
    canApprovePullRequests: form.get("canApprovePullRequests") === "on",
  };
  const saved = await actions.setWorkspaceActionsSettings(user, params.owner.toLowerCase(), change);
  return saved.ok ? { saved: true, error: null } : { saved: false, error: saved.error.message };
}

/** Where a workflow runs, in words. */
function targetWords(workflow: WorkspaceManagedWorkflow): string {
  const which = workflow.repositories.length === 0 ? "Every repository" : workflow.repositories.join(", ");
  if (workflow.visibility === "public") return `${which}, public ones only`;
  if (workflow.visibility === "private") return `${which}, private ones only`;
  return which;
}

/** The form that adds a managed workflow, or changes one. */
function ManagedWorkflowDialog({ workspace, workflow }: { workspace: string; workflow?: WorkspaceManagedWorkflow }) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<{ managed?: ManagedResult }>();
  const result = fetcher.data?.managed;
  const [target, setTarget] = useState(workflow && workflow.repositories.length > 0 ? "selected" : "all");
  useEffect(() => {
    if (fetcher.state === "idle" && result?.ok) setOpen(false);
  }, [fetcher.state, result]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {workflow ? (
          <Button variant="outline" size="sm">
            Edit
          </Button>
        ) : (
          <Button variant="outline">
            <Plus size={14} />
            Add workflow
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{workflow ? `Edit ${workflow.workflowName}` : "Add a workflow"}</DialogTitle>
          <DialogDescription>
            It runs in each repository it targets as that repository's own workflow, with its token and secrets. g1t copies the file when you save, and that
            copy runs until you copy it again.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="managed-save" />
          <input type="hidden" name="create" value={workflow ? "false" : "true"} />
          {workflow ? (
            <input type="hidden" name="name" value={workflow.name} />
          ) : (
            <Field label="Name" hint="Lowercase letters, digits and hyphens. It runs as managed/<name>.yml.">
              <Input name="name" required pattern="[a-z0-9-]{1,64}" placeholder="security-scan" />
            </Field>
          )}
          <Field label="Source" hint={`A workflow file in one of ${workspace}'s repositories, at a branch, tag or commit.`}>
            <Input name="source" required defaultValue={workflow?.source} placeholder={`${workspace}/policies/.g1t/workflows/scan.yml@main`} />
          </Field>
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted">Mode</p>
            <RadioGroup name="mode" defaultValue={workflow?.mode ?? "required"} className="gap-3">
              <RadioOption
                value="required"
                label="Required"
                description="Runs in every repository it targets. A repository's workflow of the same name does not run in its place, and no one can turn it off there, so a ruleset can require its check."
              />
              <RadioOption
                value="default"
                label="Default"
                description="Runs where the repository has no workflow of the same name. A repository's admins can turn it off."
              />
            </RadioGroup>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted">Repositories</p>
            <RadioGroup name="target" value={target} onValueChange={setTarget} className="gap-3">
              <RadioOption value="all" label="All repositories" />
              <RadioOption
                value="selected"
                label="Repositories that match"
                description="Names or patterns, one per line. * matches any characters; !name leaves one out."
              />
            </RadioGroup>
            {target === "selected" && (
              <Textarea
                name="repositories"
                rows={4}
                aria-label="Repository names and patterns"
                defaultValue={workflow?.repositories.join("\n")}
                placeholder={"web\napi-*\n!api-sandbox"}
              />
            )}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted">Visibility</p>
            <SelectField
              name="visibility"
              defaultValue={workflow?.visibility ?? "all"}
              aria-label="Visibility"
              options={[
                { value: "all", label: "Public and private repositories" },
                { value: "public", label: "Public repositories only" },
                { value: "private", label: "Private repositories only" },
              ]}
            />
            <p className="text-xs text-faint">A source in a private repository runs in private repositories only.</p>
          </div>
          <ErrorText>{result && !result.ok ? result.error : null}</ErrorText>
          <DialogFooter>
            <SubmitButton fetcher={fetcher} pending="Saving…">
              {workflow ? "Save" : "Add workflow"}
            </SubmitButton>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function ManagedWorkflowCard({ workspace, workflow }: { workspace: string; workflow: WorkspaceManagedWorkflow }) {
  const fetcher = useFetcher<{ managed?: ManagedResult }>();
  const result = fetcher.data?.managed;
  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {workflow.workflowName}
            <Badge tone={workflow.mode === "required" ? "accent" : "neutral"}>{workflow.mode === "required" ? "Required" : "Default"}</Badge>
          </p>
          <p className="mt-0.5 font-mono text-xs break-all text-faint">{workflow.path}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ManagedWorkflowDialog workspace={workspace} workflow={workflow} />
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="managed-refresh" />
            <input type="hidden" name="name" value={workflow.name} />
            <SubmitButton variant="outline" size="sm" fetcher={fetcher} pending="Copying…">
              Copy again
            </SubmitButton>
          </fetcher.Form>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm">
                Remove
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="managed-remove" />
                <input type="hidden" name="name" value={workflow.name} />
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {workflow.workflowName}?</AlertDialogTitle>
                  <AlertDialogDescription>It stops running in {workspace}'s repositories. Its runs stay.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
                  <SubmitButton variant="destructive" fetcher={fetcher} pending="Removing…">
                    Remove
                  </SubmitButton>
                </AlertDialogFooter>
              </fetcher.Form>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[7rem_1fr]">
        <dt className="text-muted">From</dt>
        <dd className="min-w-0 font-mono text-xs break-all">
          {workflow.source}
          {workflow.sourceSha && <span className="text-faint"> at {workflow.sourceSha.slice(0, 7)}</span>}
        </dd>
        <dt className="text-muted">Runs in</dt>
        <dd>{targetWords(workflow)}</dd>
        <dt className="text-muted">Copied</dt>
        <dd className="text-muted">
          <TimeAgo at={workflow.updatedAt} /> by {workflow.updatedBy}
        </dd>
      </dl>
      <ErrorText>{result && !result.ok ? result.error : null}</ErrorText>
    </li>
  );
}

function ManagedWorkflows({ workspace, managed }: { workspace: string; managed: WorkspaceManagedWorkflow[] | Failed }) {
  return (
    <section className="max-w-4xl space-y-4 border-t border-line pt-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-medium">
            <BadgeCheck size={16} className="text-accent" />
            Workflows this workspace manages
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Workflows that run in {workspace}'s repositories without a file in them, each as <code className="font-mono text-xs">managed/&lt;name&gt;.yml</code>
            . Each repository's Actions page lists them, managed by {workspace}.
          </p>
        </div>
        <ManagedWorkflowDialog workspace={workspace} />
      </div>
      {isFailed(managed) ? (
        <Unavailable what={managed.what} />
      ) : managed.length === 0 ? (
        <EmptyState title="No managed workflows">
          Add a workflow file from one of the workspace's repositories to run it in all of them, or in those you choose.
        </EmptyState>
      ) : (
        <Card asChild divided className="overflow-hidden">
          <ul>
            {managed.map((workflow) => (
              <ManagedWorkflowCard key={workflow.name} workspace={workspace} workflow={workflow} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

export default function WorkspaceActionsSettingsPage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { settings, managed, owner } = loaderData;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Actions</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          What the token of each workflow job in this workspace's repositories may do when its workflow writes no{" "}
          <code className="font-mono text-xs">permissions:</code>. Each repository can choose for itself under its Settings, Actions, within these limits.
        </p>
      </header>
      <Form method="post" className="max-w-4xl space-y-8">
        <fieldset disabled={!owner} className="space-y-8">
          <Section title="Default for new repositories" about="What a repository made from now on gets, until it chooses.">
            <RadioGroup name="defaultPermissions" defaultValue={settings.defaultPermissions} className="gap-3">
              <RadioOption
                value="read"
                label="Read repository contents and packages"
                description={
                  <>
                    <code className="font-mono">contents: read</code> and <code className="font-mono">packages: read</code>. The default.
                  </>
                }
              />
              <RadioOption value="write" label="Read and write" description="Every permission a job's token can have." />
            </RadioGroup>
            <p className="text-sm text-muted">Repositories made before restricted tokens keep read and write until someone chooses otherwise.</p>
          </Section>

          <Section title="Most a repository may choose" about="No repository's default goes past this.">
            <RadioGroup name="maxPermissions" defaultValue={settings.maxPermissions} className="gap-3">
              <RadioOption value="write" label="Read and write" description="Each repository chooses. The default." />
              <RadioOption
                value="read"
                label="Read only"
                description="Every repository's jobs get read-only tokens unless their workflow writes permissions:."
              />
            </RadioGroup>
          </Section>

          <Section title="Pull requests" about="Whether a job's token may open pull requests and approve them. Off by default.">
            <CheckboxOption
              name="canApprovePullRequests"
              defaultChecked={settings.canApprovePullRequests}
              label="Allow repositories to let g1t Actions create and approve pull requests"
              description="Each repository still turns it on for itself, under its Settings, Actions."
            />
          </Section>
        </fieldset>

        {owner ? (
          <div className="sticky bottom-(--tabbar-h) in-data-[keyboard=open]:bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
            <SubmitButton pending="Saving…">Save settings</SubmitButton>
            {actionData?.saved && <span className="text-sm text-muted">Saved.</span>}
            <ErrorText>{actionData?.error}</ErrorText>
          </div>
        ) : (
          <p className="text-sm text-muted">Only the workspace's owners can change these.</p>
        )}
      </Form>
      {owner ? (
        <ManagedWorkflows workspace={params.owner.toLowerCase()} managed={managed} />
      ) : (
        <section className="max-w-4xl border-t border-line pt-8">
          <h2 className="font-medium">Workflows this workspace manages</h2>
          <p className="mt-1 text-sm text-muted">
            Only the workspace's owners can see and change the workflows it runs in its repositories. Each repository's Actions page lists the ones that run
            there.
          </p>
        </section>
      )}
    </div>
  );
}
