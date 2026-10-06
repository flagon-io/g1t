import { AlertTriangle, FileCode2, GitBranch, Play, PlayCircle } from "lucide-react";
import { useState } from "react";
import { Form, Link, useNavigation, useSearchParams } from "react-router";

import type { DispatchInput, Workflow, WorkflowRun } from "@g1t/contracts";

import type { Route } from "./+types/actions";
import { page } from "../../lib/meta";
import { Notes, StatusIcon, duration, shortRef } from "../../components/actions";
import { AddCiPrompt } from "../../components/add-ci";
import { Button, ComputeNote, EmptyState, ErrorText, TimeAgo } from "../../components/ui";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { computeNoteFor } from "../../lib/compute.server";
import { actions } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { accessFor, refusal, repoFor } from "../../lib/access.server";
import { useRefreshWhile } from "../../lib/refresh";

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
  const [workflows, runs, computeNote] = await Promise.all([
    actions.workflows(repo, viewer),
    actions.runs(repo, viewer, { workflow: selected, limit: 50 }),
    // Jobs run on g1t's machines as the workspace's plan allows, or from
    // the open-source pool on a public repository; members are told
    // before a run is refused for it.
    member && found.ok
      ? computeNoteFor(params.owner, "workflow", !found.value.isPrivate).catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    workflows: unwrap(workflows),
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

/** Re-reads the page every few seconds while something is still running. */
function useLiveWhile(running: boolean) {
  useRefreshWhile(running, 3000);
}

const EVENT_WORDS: Record<string, string> = {
  push: "push",
  pull_request: "pull request",
  pull_request_target: "pull request (target)",
  pull_request_review: "review",
  issues: "issue",
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
          {run.startedAt && <span className="block font-mono">{duration(run.startedAt, run.finishedAt)}</span>}
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
  const busy = useNavigation().state === "submitting";
  const inputs = Object.entries(workflow.dispatch ?? {});
  const booleans = inputs.filter(([, spec]) => spec.type === "boolean").map(([name]) => name);
  return (
    <div className="relative">
      <Button type="button" variant="quiet" onClick={() => setOpen((v) => !v)}>
        <Play size={14} />
        Run workflow
      </Button>
      {open && (
        <Form
          method="post"
          onSubmit={() => setOpen(false)}
          className="absolute right-0 z-20 mt-2 w-80 space-y-3 rounded-xl border border-line bg-surface p-4 shadow-xl"
        >
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
          <Button type="submit" disabled={busy}>
            <PlayCircle size={14} />
            Run
          </Button>
        </Form>
      )}
    </div>
  );
}

function WorkflowHeader({ workflow, base, member, manage }: { workflow: Workflow; base: string; member: boolean; manage: boolean }) {
  const busy = useNavigation().state === "submitting";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold tracking-tight">{workflow.name}</h3>
          <Link to={`${base}/blob/HEAD/${workflow.path}`} className="inline-flex items-center gap-1 font-mono text-xs text-faint hover:text-fg">
            <FileCode2 size={12} />
            {workflow.path}
          </Link>
          {workflow.events.length > 0 && (
            <p className="mt-1.5 text-xs text-muted">On {workflow.events.map((e) => EVENT_WORDS[e] ?? e).join(", ")}</p>
          )}
        </div>
        {member && !workflow.error && (
          <div className="flex items-center gap-2">
            {workflow.dispatch && workflow.state === "active" && <RunWorkflow workflow={workflow} />}
            {manage && <Form method="post">
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="workflow" value={workflow.id} />
              <input type="hidden" name="enabled" value={workflow.state === "active" ? "false" : "true"} />
              <Button type="submit" variant="quiet" disabled={busy}>
                {workflow.state === "active" ? "Turn off" : "Turn on"}
              </Button>
            </Form>}
          </div>
        )}
      </div>
      {workflow.error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{workflow.error}</p>}
      {workflow.state === "disabled" && (
        <p className="rounded-lg bg-raised px-3 py-2 text-sm text-muted">Turned off: nothing starts it until someone with the Maintain role turns it on.</p>
      )}
      <Notes notes={workflow.notes} />
    </div>
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
  const { workflows, runs, member, canPush, manage, computeNote, selected } = loaderData;
  const [search] = useSearchParams();
  const base = `/${params.owner}/${params.repo}`;
  const workflow = workflows.find((w) => w.id === selected || w.path.endsWith(`/${selected}`)) ?? null;
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

      {workflows.length === 0 ? (
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
            {workflows.map((w) => (
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
                {w.error && <AlertTriangle size={12} className="shrink-0 text-danger" aria-label="Its file has a problem" />}
                {w.state === "disabled" && <span className="ml-auto shrink-0 text-xs text-faint">off</span>}
              </Link>
            ))}
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
              <EmptyState title="No runs yet">
                {workflow?.dispatch ? "Run it by hand, or wait for what starts it." : "Runs appear here when something starts one."}
              </EmptyState>
            ) : (
              <ul className="overflow-hidden rounded-xl border border-line bg-surface">
                {runs.map((run) => (
                  <RunRow key={run.id} run={run} base={base} showWorkflow={!search.get("workflow")} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
