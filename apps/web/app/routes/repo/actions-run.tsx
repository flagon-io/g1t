import { AlertTriangle, ChevronRight, Download, GitBranch, GitCommitHorizontal, Info, Package, RotateCw, Square, XCircle } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Form, Link, useNavigation, useRevalidator, useSearchParams } from "react-router";

import type { Annotation, Job, StepState } from "@g1t/contracts";

import type { Route } from "./+types/actions-run";
import { LogText, Notes, StatusIcon, duration, shortRef, standingWord, useJobLog } from "../../components/actions";
import { Button, ErrorText, TimeAgo } from "../../components/ui";
import { listArtifacts } from "../../lib/artifacts.server";
import { actions } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ loaderData, params }: Route.MetaArgs) {
  const run = loaderData?.detail.run;
  return [{ title: `${run ? `${run.title || run.name} #${run.number}` : "Run"} · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const detail = unwrap(await actions.run({ namespace: params.owner, name: params.repo }, viewer, params.id));
  const artifacts = await listArtifacts(params.id).catch(() => []);
  return { detail, artifacts, member: roleIn(viewer, params.owner) != null };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const repo = { namespace: params.owner, name: params.repo };
  const intent = String((await request.formData()).get("intent"));
  const done =
    intent === "cancel"
      ? await actions.cancel(user, repo, params.id)
      : await actions.rerun(user, repo, params.id, intent === "rerun-failed");
  return done.ok ? {} : { error: done.error.message };
}

const ANNOTATION_ICON: Record<Annotation["level"], ReactNode> = {
  error: <XCircle size={14} className="mt-0.5 shrink-0 text-danger" />,
  warning: <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />,
  notice: <Info size={14} className="mt-0.5 shrink-0 text-muted" />,
};

function StepRow({ step, text, defaultOpen }: { step: StepState; text: string | undefined; defaultOpen: boolean }) {
  return (
    <details className="group border-t border-line first:border-t-0" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-2 text-sm hover:bg-raised/40">
        <ChevronRight size={14} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
        <StatusIcon status={step.status} conclusion={step.conclusion} size={14} />
        <span className={`min-w-0 truncate ${step.conclusion === "skipped" ? "text-faint" : ""}`}>{step.name}</span>
        <span className="ml-auto shrink-0 font-mono text-xs text-faint">{duration(step.startedAt, step.finishedAt)}</span>
      </summary>
      <div className="border-t border-line bg-bg/60">
        {text === undefined ? (
          <p className="px-4 py-2 text-xs text-faint">{step.status === "queued" ? "Not started." : step.conclusion === "skipped" ? "Skipped." : "No output yet."}</p>
        ) : (
          <LogText text={text} />
        )}
      </div>
    </details>
  );
}

function JobView({ job, base }: { job: Job; base: string }) {
  const live = job.status !== "completed";
  const log = useJobLog(`${base}/actions/jobs/${job.id}/log`, live);
  const failed = job.steps.find((s) => s.conclusion === "failure");
  const running = job.steps.find((s) => s.status === "in_progress");
  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusIcon status={job.status} conclusion={job.conclusion} size={18} />
        <h3 className="text-base font-semibold">{job.name}</h3>
        <span className="text-sm text-muted">
          {standingWord(job)}
          {job.startedAt && ` · ${duration(job.startedAt, job.finishedAt)}`}
        </span>
      </div>
      {job.reason && <p className="rounded-lg bg-raised px-3 py-2 text-sm text-muted">{job.reason}</p>}
      {job.annotations.length > 0 && (
        <ul className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
          {job.annotations.map((note, index) => (
            <li key={index} className="flex gap-2">
              {ANNOTATION_ICON[note.level]}
              <span className="min-w-0">
                {note.title && <span className="font-medium">{note.title}: </span>}
                <span className="whitespace-pre-wrap">{note.message}</span>
                {note.file && (
                  <span className="block font-mono text-xs text-faint">
                    {note.file}
                    {note.line != null && `:${note.line}`}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <StepRow
          step={{ number: 0, name: "Set up job", status: job.startedAt ? "completed" : "queued", conclusion: job.startedAt ? "success" : null, startedAt: job.startedAt, finishedAt: job.startedAt }}
          text={log.get(0)}
          defaultOpen={false}
        />
        {job.steps.map((step) => (
          <StepRow
            key={step.number}
            step={step}
            text={log.get(step.number)}
            defaultOpen={step.number === (failed ?? running)?.number}
          />
        ))}
      </div>
    </section>
  );
}

export default function ActionsRun({ loaderData, actionData, params }: Route.ComponentProps) {
  const { detail, artifacts, member } = loaderData;
  const { run, jobs, notes } = detail;
  const base = `/${params.owner}/${params.repo}`;
  const [search] = useSearchParams();
  const busy = useNavigation().state === "submitting";
  const revalidator = useRevalidator();
  const live = run.status !== "completed";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle" && document.visibilityState === "visible") revalidator.revalidate();
    }, 2500);
    return () => clearInterval(timer);
  }, [live, revalidator]);

  // The job asked for, else one that failed, is running, or the first.
  const selected =
    jobs.find((job) => job.id === search.get("job")) ??
    jobs.find((job) => job.conclusion === "failure" && job.steps.length > 0) ??
    jobs.find((job) => job.status === "in_progress") ??
    jobs[0];
  const anyFailed = jobs.some((job) => job.conclusion === "failure" || job.conclusion === "cancelled");

  return (
    <div className="max-w-6xl space-y-6">
      <header className="space-y-3">
        <Link to={`${base}/actions?workflow=${run.workflowId}`} className="text-sm text-muted hover:text-fg">
          {run.name}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h2 className="flex min-w-0 items-center gap-2.5 text-xl font-semibold tracking-tight">
            <StatusIcon status={run.status} conclusion={run.conclusion} size={20} />
            <span className="min-w-0 truncate">{run.title || run.name}</span>
            <span className="font-normal text-muted">#{run.number}</span>
          </h2>
          {member && !run.error && (
            <Form method="post" className="flex gap-2">
              {live ? (
                <Button type="submit" name="intent" value="cancel" variant="quiet" disabled={busy}>
                  <Square size={13} />
                  Cancel run
                </Button>
              ) : (
                <>
                  {anyFailed && (
                    <Button type="submit" name="intent" value="rerun-failed" variant="quiet" disabled={busy}>
                      <RotateCw size={13} />
                      Re-run failed jobs
                    </Button>
                  )}
                  <Button type="submit" name="intent" value="rerun" variant="quiet" disabled={busy}>
                    <RotateCw size={13} />
                    Re-run all jobs
                  </Button>
                </>
              )}
            </Form>
          )}
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span>{standingWord(run)}</span>
          <span className="inline-flex items-center gap-1 font-mono text-xs">
            <GitBranch size={12} />
            {shortRef(run.ref)}
          </span>
          <Link to={`${base}/commit/${run.sha}`} className="inline-flex items-center gap-1 font-mono text-xs hover:text-fg">
            <GitCommitHorizontal size={12} />
            {run.sha.slice(0, 7)}
          </Link>
          {run.pull != null && (
            <Link to={`${base}/pull/${run.pull}`} className="hover:text-fg">
              #{run.pull}
            </Link>
          )}
          <span>
            {run.event}
            {run.actor && ` by ${run.actor}`} · <TimeAgo at={run.createdAt} />
          </span>
          {run.startedAt && <span className="font-mono text-xs">{duration(run.startedAt, run.finishedAt)}</span>}
          {run.attempt > 1 && <span>Attempt {run.attempt}</span>}
        </p>
      </header>

      <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      {run.error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm">
          <p className="font-medium text-danger">The workflow file could not be used</p>
          <p className="mt-1 whitespace-pre-wrap text-fg/85">{run.error}</p>
        </div>
      )}
      <Notes notes={notes} />
      {artifacts.length > 0 && (
        <section className="rounded-xl border border-line bg-surface p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Package size={14} className="text-muted" />
            Artifacts
            <span className="font-normal text-faint">· kept for 14 days</span>
          </h3>
          <ul className="mt-3 divide-y divide-line text-sm">
            {artifacts.map((artifact) => (
              <li key={artifact.name} className="flex items-center gap-3 py-2">
                <span className="min-w-0 grow truncate font-mono text-[0.8125rem]">{artifact.name}</span>
                <span className="shrink-0 text-xs text-faint">{Math.max(1, Math.round(artifact.size / 1024))} KB</span>
                <a
                  href={`${base}/actions/runs/${run.id}/artifacts/${encodeURIComponent(artifact.name)}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted ring-1 ring-line hover:text-fg"
                >
                  <Download size={12} />
                  Download
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {jobs.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
          <nav aria-label="Jobs" className="space-y-0.5 text-sm">
            {jobs.map((job) => (
              <Link
                key={job.id}
                to={`?job=${job.id}`}
                preventScrollReset
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 ${
                  job.id === selected?.id ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"
                }`}
              >
                <StatusIcon status={job.status} conclusion={job.conclusion} size={14} />
                <span className="min-w-0 truncate">{job.name}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-faint">{duration(job.startedAt, job.finishedAt)}</span>
              </Link>
            ))}
          </nav>
          {selected && <JobView key={selected.id} job={selected} base={base} />}
        </div>
      )}
    </div>
  );
}
