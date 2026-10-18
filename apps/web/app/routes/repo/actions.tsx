import { Archive, ChevronRight, AlertTriangle, BadgeCheck, FileCode2, GitBranch, Play, PlayCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link, useSearchParams } from "react-router";

import { type DispatchInput, type Workflow, type WorkflowRun, isManagedWorkflow } from "@g1t/contracts";

import type { Route } from "./+types/actions";
import { groupWorkflows, isArchivedWorkflow } from "../../lib/workflow-history";
import { page } from "../../lib/meta";
import { Duration, Notes, StatusIcon, shortRef } from "../../components/actions";
import { AddCiPrompt } from "../../components/add-ci";
import { ComputeNote, CopyLine, EmptyState, ErrorText, SubmitButton, TimeAgo, usePending } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { useAddresses } from "../../lib/addresses";
import { badgeMarkdown, badgeUrl } from "../../lib/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { computeNoteFor } from "../../lib/compute.server";
import { isFailed, part } from "../../lib/partial";
import { Unavailable } from "../../components/boundary";
import { actions } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { accessFor, refusal, repoFor } from "../../lib/access.server";
import { useRefreshWhile } from "../../lib/refresh";
import { repoPages } from "../../lib/repo-live";
import { useRepoLive } from "../../lib/use-repo-live";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Workflows · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const repo = { namespace: params.owner, name: params.repo };
  const selected = new URL(request.url).searchParams.get("workflow") ?? undefined;
  const found = await repoFor(context, params);
  const can = found.ok ? accessFor(viewer, found.value).can : null;
  // Starting runs needs Write; turning a workflow on or off, Maintain.
  const member = can?.run ?? false;
  // Who may open the pull request that adds a starter workflow.
  const canPush = can?.push ?? false;
  // The runs are what the page is about; the list of workflows beside them
  // is a part, which says so in its place when it cannot be read.
  const [workflows, runs, computeNote] = await Promise.all([
    part(actions.workflows(repo, viewer), "Workflows"),
    actions.runs(repo, viewer, { workflow: selected, limit: 50 }),
    // Jobs run on g1t's machines as the workspace's plan allows, or from
    // the open-source pool on a public repository; members are told
    // before a run is refused for it. A note that cannot be read is left
    // out: it only warns ahead of a refusal that says the same itself.
    member && found.ok
      ? computeNoteFor(params.owner, "workflow", !found.value.isPrivate).catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    workflows: isFailed(workflows) ? workflows : unwrap(workflows),
    runs: runs.ok ? runs.value : [],
    member,
    canPush,
    manage: can?.manage_settings ?? false,
    computeNote,
    selected: selected ?? null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const workflow = String(form.get("workflow") ?? "");
  const refused = await refusal(context, params, form.get("intent") === "toggle" ? "manage_settings" : "run");
  if (refused) return { error: refused };
  if (form.get("intent") === "toggle") {
    const changed = await actions.setWorkflowEnabled(user, repo, workflow, form.get("enabled") === "true");
    return changed.ok ? {} : { error: changed.error.message };
  }
  const inputs: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("input.")) inputs[key.slice(6)] = value === "on" ? true : value;
  }
  // An unticked checkbox sends nothing: it is false.
  for (const key of String(form.get("booleans") ?? "").split(",").filter(Boolean)) {
    if (!(key in inputs)) inputs[key] = false;
  }
  const ref = String(form.get("ref") ?? "").trim() || undefined;
  const started = await actions.dispatch(user, repo, workflow, ref, inputs);
  return started.ok ? { started: started.value } : { error: started.error.message };
}

/**
 * Runs start, move and finish live (lib/use-repo-live.ts). While something
 * runs the page also asks again now and then, in case a change was missed:
 * every 30 s with the live socket, every few seconds without it.
 */
function useLiveWhile(running: boolean) {
  const { live } = useRepoLive({ match: repoPages.runs() });
  useRefreshWhile(running, live ? 30_000 : 3000);
}

const EVENT_WORDS: Record<string, string> = {
  push: "push",
  pull_request: "pull request",
  pull_request_target: "pull request (target)",
  pull_request_review: "review",
  work_item: "work item",
  work_item_comment: "comment",
  // Runs from before work items, under the events they had then.
  issues: "work item",
  issue_comment: "comment",
  schedule: "schedule",
  workflow_dispatch: "manual",
};

function RunRow({ run, base, showWorkflow }: { run: WorkflowRun; base: string; showWorkflow: boolean }) {
  return (
    <li className="border-t border-line first:border-t-0">
      <Link to={`${base}/actions/runs/${run.id}`} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-raised/40">
        <span className="mt-0.5">
          <StatusIcon status={run.status} conclusion={run.conclusion} />
        </span>
        <span className="min-w-0 grow">
          <span className="block truncate text-sm font-medium">{run.title || run.name}</span>
          <span className="mt-0.5 block truncate text-xs text-muted">
            {showWorkflow && <span className="text-fg/80">{run.name}</span>}
            {showWorkflow && " · "}#{run.number}
            {run.attempt > 1 && ` (attempt ${run.attempt})`}
            {" · "}
            {EVENT_WORDS[run.event] ?? run.event}
            {run.actor && ` by ${run.actor}`}
          </span>
        </span>
        <span className="hidden shrink-0 items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 font-mono text-xs text-muted sm:inline-flex">
          <GitBranch size={11} />
          {shortRef(run.ref)}
        </span>
        <span className="w-28 shrink-0 text-right text-xs text-faint">
          <TimeAgo at={run.createdAt} />
          {run.startedAt && <Duration className="block font-mono" start={run.startedAt} end={run.finishedAt} />}
        </span>
      </Link>
    </li>
  );
}

function InputField({ name, spec }: { name: string; spec: DispatchInput }) {
  const label = (
    <span className="mb-1 block text-xs font-medium text-muted">
      {spec.description || name}
      {spec.required && <span className="text-danger"> *</span>}
    </span>
  );
  const control = "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent-dim";
  if (spec.type === "boolean") {
    return (
      <CheckboxOption
        name={`input.${name}`}
        defaultChecked={spec.default === true || spec.default === "true"}
        label={spec.description || name}
      />
    );
  }
  if (spec.type === "choice" && spec.options) {
    return (
      <div>
        {label}
        <Select name={`input.${name}`} defaultValue={String(spec.default ?? spec.options[0] ?? "") || undefined}>
          <SelectTrigger size="sm" aria-label={spec.description || name}>
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            {/* A Radix item cannot have the value "". */}
            {spec.options.filter((option) => option !== "").map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <label className="block">
      {label}
      <input
        name={`input.${name}`}
        required={spec.required}
        defaultValue={spec.default == null ? "" : String(spec.default)}
        type={spec.type === "number" ? "number" : "text"}
        className={control}
        autoComplete="off"
      />
    </label>
  );
}

function RunWorkflow({ workflow }: { workflow: Workflow }) {
  const [open, setOpen] = useState(false);
  // Open, saying it is starting, until the run shows below or the error does.
  const running = usePending({ intent: "dispatch", workflow: workflow.id });
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !running) setOpen(false);
    was.current = running;
  }, [running]);
  const inputs = Object.entries(workflow.dispatch ?? {});
  const booleans = inputs.filter(([, spec]) => spec.type === "boolean").map(([name]) => name);
  return (
    <div className="relative">
      <Button type="button" variant="outline" onClick={() => setOpen((v) => !v)}>
        <Play size={14} />
        Run workflow
      </Button>
      {open && (
        <Card asChild className="absolute right-0 z-20 mt-2 w-80 space-y-3 p-4 shadow-xl">
          <Form
            method="post">
            <input type="hidden" name="intent" value="dispatch" />
            <input type="hidden" name="workflow" value={workflow.id} />
            <input type="hidden" name="booleans" value={booleans.join(",")} />
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Branch or tag</span>
              <input
                name="ref"
                placeholder="The default branch"
                className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-sm outline-none focus:border-accent-dim"
                autoComplete="off"
              />
            </label>
            {inputs.map(([name, spec]) => (
              <InputField key={name} name={name} spec={spec} />
            ))}
            <SubmitButton match={{ intent: "dispatch", workflow: workflow.id }} pending="Starting…">
              <PlayCircle size={14} />
              Run
            </SubmitButton>
          </Form>
        </Card>
      )}
    </div>
  );
}

/** The address of a status badge for the workflow, and Markdown to show it, for a branch and event if chosen. */
function StatusBadge({ workflow, repo }: { workflow: Workflow; repo: string }) {
  const { site } = useAddresses();
  const [branch, setBranch] = useState("");
  const [event, setEvent] = useState("");
  const file = workflow.path.split("/").pop() ?? workflow.path;
  const options = { branch: branch.trim() || undefined, event: event || undefined };
  const control = "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent-dim";
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <BadgeCheck size={14} />
          Create status badge
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create status badge</DialogTitle>
          <DialogDescription>
            A badge that shows how {workflow.name}'s latest finished run went. Paste it into a README.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Branch</span>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="The default branch"
              className={`${control} font-mono`}
              autoComplete="off"
            />
          </label>
          <div>
            <span className="mb-1 block text-xs font-medium text-muted">Event</span>
            <Select value={event || "any"} onValueChange={(value) => setEvent(value === "any" ? "" : value)}>
              <SelectTrigger size="sm" aria-label="Event">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any event</SelectItem>
                {workflow.events.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Card tone="bg" radius="lg" className="flex min-h-10 items-center px-3 py-2">
          <img src={badgeUrl(site, repo, file, options)} alt={`${workflow.name} status`} height={20} />
        </Card>
        <CopyLine text={badgeMarkdown(site, repo, { name: workflow.name, file }, options)} />
        <p className="text-xs text-muted">
          Anyone can see a public repository's badge. A private repository's shows only to people who can see the repository.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function WorkflowHeader({ workflow, base, member, manage }: { workflow: Workflow; base: string; member: boolean; manage: boolean }) {
  const archived = isArchivedWorkflow(workflow);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold tracking-tight">{workflow.name}</h3>
          {archived ? (
            <span className="inline-flex items-center gap-1 font-mono text-xs text-faint"><FileCode2 size={12} />{workflow.path}</span>
          ) : isManagedWorkflow(workflow.path) ? (
            <ManagedLine workflow={workflow} />
          ) : (
            <Link to={`${base}/blob/HEAD/${workflow.path}`} className="inline-flex items-center gap-1 font-mono text-xs text-faint hover:text-fg">
              <FileCode2 size={12} />
              {workflow.path}
            </Link>
          )}
          {workflow.events.length > 0 && (
            <p className="mt-1.5 text-xs text-muted">On {workflow.events.map((e) => EVENT_WORDS[e] ?? e).join(", ")}</p>
          )}
        </div>
        {!workflow.error && (
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge workflow={workflow} repo={base.slice(1)} />
            {member && workflow.dispatch && workflow.state === "active" && <RunWorkflow workflow={workflow} />}
            {member && manage && workflow.managedBy?.mode !== "required" && <Form method="post">
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="workflow" value={workflow.id} />
              <input type="hidden" name="enabled" value={workflow.state === "active" ? "false" : "true"} />
              <SubmitButton
                variant="outline"
                match={{ intent: "toggle", workflow: workflow.id }}
                pending={workflow.state === "active" ? "Turning off…" : "Turning on…"}
              >
                {workflow.state === "active" ? "Turn off" : "Turn on"}
              </SubmitButton>
            </Form>}
          </div>
        )}
      </div>
      {archived ? (
        <p className="flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">
          <Archive size={16} className="mt-0.5 shrink-0" />
          <span><strong className="font-medium text-fg">Archived workflow.</strong> Its file was removed from the default branch. Past runs remain available below. Restore the file on the default branch to return it to the workflow list.</span>
        </p>
      ) : workflow.error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{workflow.error}</p>}
      {!archived && workflow.state === "disabled" && (
        <p className="rounded-lg bg-raised px-3 py-2 text-sm text-muted">Turned off: nothing starts it until someone with the Maintain role turns it on.</p>
      )}
      {!archived && <Notes notes={workflow.notes} />}
    </div>
  );
}

/** Who manages a managed workflow, and what a file of its name does. */
function ManagedLine({ workflow }: { workflow: Workflow }) {
  const by = workflow.managedBy;
  const origin = by?.origin ?? "g1t";
  const what =
    origin === "g1t"
      ? `it runs here without a file in the repository. A workflow named ${workflow.name} in .g1t/workflows/ takes its place.`
      : by?.mode === "required"
        ? `required in this repository by ${origin}'s owners. It runs here without a file in the repository; a workflow named ${workflow.name} in .g1t/workflows/ does not run while it is required, and it cannot be turned off here.`
        : `it runs here without a file in the repository. A workflow named ${workflow.name} in .g1t/workflows/ takes its place, and an admin can turn it off here.`;
  return (
    <span className="block text-xs text-faint">
      <span className="inline-flex items-center gap-1">
        <BadgeCheck size={12} className="shrink-0" />
        <span>
          Managed by {origin}: {what}
        </span>
      </span>
      {by?.source && <span className="mt-0.5 block font-mono">From {by.source}</span>}
    </span>
  );
}

const EXAMPLE = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - run: npm test`;

export default function Actions({ loaderData, actionData, params }: Route.ComponentProps) {
  const { runs, member, canPush, manage, computeNote, selected } = loaderData;
  const [search] = useSearchParams();
  const base = `/${params.owner}/${params.repo}`;
  // Workflows that could not be read leave the runs, with a note in the list's place.
  const workflowsFailed = isFailed(loaderData.workflows);
  const workflows = isFailed(loaderData.workflows) ? [] : loaderData.workflows;
  const workflow = workflows.find((w) => w.id === selected || w.path.endsWith(`/${selected}`)) ?? null;
  const { current, archived } = groupWorkflows(workflows);
  const archiveSelected = workflow != null && isArchivedWorkflow(workflow);
  useLiveWhile(runs.some((run) => run.status !== "completed"));
  const started = actionData && "started" in actionData ? actionData.started : null;
  return (
    <div className="max-w-6xl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <PlayCircle size={18} className="text-accent" />
            Workflows
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Workflows in <code className="text-fg">.g1t/workflows</code>, written as GitHub Actions and run as GitHub runs
            them. A run on a pull request counts as its checks.
          </p>
        </div>
        <a href="https://docs.g1t.sh/guides/actions/" className="text-sm text-muted underline underline-offset-4 hover:text-fg">
          How workflows run on g1t
        </a>
      </header>

      {member && computeNote && (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl bg-surface px-4 py-3 text-sm ring-1 ring-line">
          <AlertTriangle size={15} className="shrink-0 text-warn" />
          <ComputeNote note={computeNote} />
        </div>
      )}

      {!workflowsFailed && workflows.length === 0 && runs.length === 0 ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <AddCiPrompt owner={params.owner} repo={params.repo} canAdd={canPush} />
          </div>
          <EmptyState title="No workflows yet">
            Coming from GitHub? Rename <code>.github</code> to <code>.g1t</code> and push: your workflows run here as they
            are. g1t never reads <code>.github</code>.
          </EmptyState>
          <div>
            <p className="font-mono text-xs text-faint">.g1t/workflows/ci.yml</p>
            <pre className="mt-1.5 rounded-lg bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap ring-1 ring-line">
              <code>{EXAMPLE}</code>
            </pre>
          </div>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[14rem_1fr]">
          <nav aria-label="Workflows" className="space-y-0.5 text-sm">
            <Link
              to="?"
              className={`block rounded-md px-2.5 py-1.5 ${!selected ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`}
            >
              All workflows
            </Link>
            {workflowsFailed && (
              <div className="px-2.5 py-1.5">
                <Unavailable what="Workflows" compact />
              </div>
            )}
            {current.map((w) => (
              <Link
                key={w.id}
                to={`?workflow=${w.id}`}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 ${
                  w.id === workflow?.id ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"
                }`}
              >
                <span className="min-w-0 truncate">
                  {w.name}
                  {/* Two workflows of one name are told apart by their files. */}
                  {workflows.some((other) => other.id !== w.id && other.name === w.name) && (
                    <span className="block truncate font-mono text-[0.6875rem] text-faint">{w.path}</span>
                  )}
                </span>
                {w.managedBy && w.managedBy.origin !== "g1t" && (
                  <Badge tone={w.managedBy.mode === "required" ? "accent" : "neutral"} className="ml-auto">
                    {w.managedBy.origin}
                  </Badge>
                )}
                {w.error && <AlertTriangle size={12} className="shrink-0 text-danger" aria-label="Its file has a problem" />}
                {w.state === "disabled" && <span className="ml-auto shrink-0 text-xs text-faint">off</span>}
              </Link>
            ))}
            {archived.length > 0 && (
              <details key={archiveSelected ? "selected-archive" : "archive"} open={archiveSelected || undefined} className="group mt-3 border-t border-line pt-3">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2.5 py-2 text-muted hover:bg-raised/60 hover:text-fg [&::-webkit-details-marker]:hidden">
                  <ChevronRight size={14} className="shrink-0 transition-transform group-open:rotate-90" />
                  <span className="grow">Archived workflows</span>
                  <span className="text-xs tabular-nums text-faint">{archived.length}</span>
                </summary>
                <div className="mt-1 space-y-0.5">
                  {archived.map((w) => (
                    <Link key={w.id} to={`?workflow=${w.id}`} aria-current={w.id === workflow?.id ? "page" : undefined}
                      className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 ${w.id === workflow?.id ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`}>
                      <Archive size={13} className="shrink-0 text-faint" />
                      <span className="min-w-0 truncate">{w.name}<span className="block truncate font-mono text-[0.6875rem] text-faint">{w.path}</span></span>
                    </Link>
                  ))}
                </div>
              </details>
            )}
          </nav>
          <div className="min-w-0 space-y-6">
            {workflow && <WorkflowHeader workflow={workflow} base={base} member={member} manage={manage} />}
            {started && (
              <p className="text-sm text-muted">
                Started{" "}
                <Link to={`${base}/actions/runs/${started.id}`} className="text-fg underline underline-offset-4">
                  run #{started.number}
                </Link>
                .
              </p>
            )}
            <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
            {runs.length === 0 ? (
              <EmptyState title={archiveSelected ? "No retained runs" : "No runs yet"}>
                {archiveSelected ? "This archived workflow has no runs to display." : workflow?.dispatch ? "Run it by hand, or wait for what starts it." : "Runs appear here when something starts one."}
              </EmptyState>
            ) : (
              <Card asChild className="overflow-hidden">
                <ul>
                  {runs.map((run) => (
                    <RunRow key={run.id} run={run} base={base} showWorkflow={!search.get("workflow")} />
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
