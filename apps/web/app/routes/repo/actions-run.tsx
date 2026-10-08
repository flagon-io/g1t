import { AlertTriangle, Check, ChevronRight, Cloud, Download, GitBranch, GitCommitHorizontal, Hourglass, Info, Package, Play, RotateCw, ServerCog, ShieldAlert, Square, Users, X, XCircle } from "lucide-react";
import { type ReactNode } from "react";
import { Form, Link, useLoaderData, useSearchParams } from "react-router";

import type { Annotation, EnvironmentReviewer, Job, PendingDeployment, RunApproval, StepState } from "@g1t/contracts";

import type { Route } from "./+types/actions-run";
import { page } from "../../lib/meta";
import { LogText, Notes, StatusIcon, duration, shortRef, standingWord, useJobLog } from "../../components/actions";
import { ErrorText, SubmitButton, TimeAgo, usePending } from "../../components/ui";
import { Hint } from "../../components/ui/hint";
import { listArtifacts } from "../../lib/artifacts.server";
import { actions } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";
import { accessTo, refusal } from "../../lib/access.server";
import { useRefreshWhile } from "../../lib/refresh";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const run = loaderData?.detail.run;
  return page(args, { title: `${run ? `${run.title || run.name} #${run.number}` : "Run"} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const detail = unwrap(await actions.run({ namespace: params.owner, name: params.repo }, viewer, params.id));
  const artifacts = await listArtifacts(params.id).catch(() => []);
  // Cancelling and re-running need Write.
  return {
    detail,
    artifacts,
    member: (await accessTo(context, params)).can.run,
    // The runners page is the workspace owners'.
    runnersPage: roleIn(viewer, params.owner) === "owner",
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const intent = String(form.get("intent"));
  // Reviewing a deployment is the environment's reviewers' to do: the
  // service says who may.
  if (intent === "approve-deployment" || intent === "reject-deployment") {
    const environment = String(form.get("environment") ?? "");
    const comment = String(form.get("comment") ?? "").trim();
    const done = await actions.reviewDeployments(
      user,
      repo,
      params.id,
      intent === "approve-deployment" ? "approved" : "rejected",
      environment ? [environment] : [],
      comment || undefined,
    );
    return done.ok ? {} : { error: done.error.message };
  }
  // Everything else, approving a run from outside included, needs Write.
  const refused = await refusal(context, params, "run");
  if (refused) return { error: refused };
  const done =
    intent === "approve-run"
      ? await actions.approveRun(user, repo, params.id)
      : intent === "cancel"
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

/** Why a job did not run as asked, with "Integrations" linked where it says so. */
function Reason({ text, workspace }: { text: string; workspace: string }) {
  const [before, after] = text.split("Integrations");
  return (
    <p className="rounded-lg bg-raised px-3 py-2 text-sm text-muted">
      {after === undefined ? (
        text
      ) : (
        <>
          {before}
          <Link to={`/${workspace}/-/integrations`} className="text-accent hover:underline">
            Integrations
          </Link>
          {after}
        </>
      )}
    </p>
  );
}

/** Where the job ran: g1t's own runners, or a self-hosted one by name. */
function RanOn({ job, workspace }: { job: Job; workspace: string }) {
  const runnersPage = useLoaderData<typeof loader>().runnersPage;
  if (job.selfHosted) {
    const badge = "ml-auto inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted";
    const label = (
      <>
        <ServerCog size={13} />
        {job.runner ? `Self-hosted: ${job.runner}` : "Self-hosted"}
      </>
    );
    // A link to the runners for those who manage them, a label for everyone else.
    return runnersPage ? (
      <Hint label="Self-hosted runner">
        <Link to={`/${workspace}/-/runners`} className={`${badge} hover:text-fg`}>
          {label}
        </Link>
      </Hint>
    ) : (
      <Hint label="Self-hosted runner">
        <span className={badge}>{label}</span>
      </Hint>
    );
  }
  if (!job.startedAt) return null;
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
      <Cloud size={13} />
      g1t
    </span>
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
        <StatusIcon status={job.status} conclusion={job.conclusion} of="job" environment={job.environment} size={18} />
        <h3 className="text-base font-semibold">{job.name}</h3>
        <span className="text-sm text-muted">
          {standingWord({ ...job, of: "job" })}
          {job.startedAt && ` · ${duration(job.startedAt, job.finishedAt)}`}
        </span>
        <RanOn job={job} workspace={base.split("/")[1]!} />
      </div>
      {job.reason && <Reason text={job.reason} workspace={base.split("/")[1]} />}
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

/** A run held by its environments, in words that say what for: a review, or only a wait timer. */
function runWord(status: string, deployments: PendingDeployment[]): string | null {
  if (status !== "waiting") return null;
  const waiting = deployments.filter((deployment) => deployment.state === "waiting");
  return waiting.length > 0 && waiting.every((deployment) => !deployment.needsReview) ? "Waiting for a wait timer" : null;
}

/** Whether a wait timer has yet to run out. */
function timerRunning(deployment: PendingDeployment): boolean {
  return Boolean(deployment.waitUntil && new Date(deployment.waitUntil).getTime() > Date.now());
}

/** Whether environments still hold some of the run's jobs. */
function held(deployments: PendingDeployment[]): boolean {
  return deployments.some(
    (deployment) => deployment.state === "waiting" || (deployment.state === "approved" && timerRunning(deployment)),
  );
}

/** `in 12m`, `in 2h 5m`: how long until a time. */
function untilWords(at: string): string {
  const minutes = Math.max(1, Math.ceil((new Date(at).getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `in ${Math.round(hours / 24)}d`;
}

/** A user by name, a team as @team. */
function ReviewerChip({ reviewer }: { reviewer: EnvironmentReviewer }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 font-mono text-xs text-fg/85">
      {reviewer.type === "team" && <Users size={11} className="text-muted" />}
      {reviewer.type === "team" ? `@${reviewer.name}` : reviewer.name}
    </span>
  );
}

/** A pull request's run from outside, waiting for someone with Write to let it start. */
function ApprovalPanel({ approval, member, busy }: { approval: RunApproval; member: boolean; busy: boolean }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-warn/30 bg-warn/5 p-4 sm:flex-row sm:items-start">
      <ShieldAlert size={18} className="mt-0.5 hidden shrink-0 text-warn sm:block" />
      <div className="min-w-0 grow space-y-1.5 text-sm">
        <h3 className="flex items-center gap-2 font-medium">
          <ShieldAlert size={16} className="shrink-0 text-warn sm:hidden" />
          Approval required
        </h3>
        <p className="text-fg/85">{approval.reason}</p>
        <p className="text-muted">
          Nothing in this run starts, and it gets no secrets and no token, until someone with the Write role approves it.
          {!member && " Ask someone with the Write role on this repository to approve it."}
        </p>
      </div>
      {member && (
        <Form method="post" className="shrink-0">
          <SubmitButton name="intent" value="approve-run" variant="accent" disabled={busy} pending="Approving…">
            <Play size={13} />
            Approve and run
          </SubmitButton>
        </Form>
      )}
    </section>
  );
}

const DEPLOYMENT_ICON: Record<PendingDeployment["state"], ReactNode> = {
  waiting: <Hourglass size={15} className="shrink-0 text-warn" />,
  approved: (
    <span className="inline-flex shrink-0 rounded-full bg-success/15 p-0.5 text-success">
      <Check size={11} strokeWidth={3} />
    </span>
  ),
  rejected: (
    <span className="inline-flex shrink-0 rounded-full bg-danger/15 p-0.5 text-danger">
      <X size={11} strokeWidth={3} />
    </span>
  ),
};

/** Where one environment's rules stand for this run, and a way to review it for those who may. */
function DeploymentRow({ deployment, busy }: { deployment: PendingDeployment; busy: boolean }) {
  const waiting = deployment.state === "waiting";
  const timer = timerRunning(deployment);
  const words =
    deployment.state === "approved"
      ? timer
        ? "Approved · waiting for its wait timer"
        : "Approved"
      : deployment.state === "rejected"
        ? "Rejected"
        : deployment.needsReview
          ? "Waiting for review"
          : "Waiting for its wait timer";
  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {DEPLOYMENT_ICON[deployment.state]}
        <span className="font-mono text-sm font-medium">{deployment.environment}</span>
        <span className="text-sm text-muted">{words}</span>
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[7rem_1fr]">
        {deployment.jobs.length > 0 && (
          <>
            <dt className="text-muted">{deployment.jobs.length === 1 ? "Job" : "Jobs"}</dt>
            <dd className="flex min-w-0 flex-wrap gap-1.5">
              {deployment.jobs.map((job) => (
                <span key={job} className="rounded-md bg-raised px-1.5 py-0.5 text-xs">
                  {job}
                </span>
              ))}
            </dd>
          </>
        )}
        {deployment.reviewers.length > 0 && (
          <>
            <dt className="text-muted">Reviewers</dt>
            <dd className="flex min-w-0 flex-wrap gap-1.5">
              {deployment.reviewers.map((reviewer) => (
                <ReviewerChip key={`${reviewer.type}:${reviewer.name}`} reviewer={reviewer} />
              ))}
            </dd>
          </>
        )}
        {deployment.waitUntil && (waiting || timer) && (
          <>
            <dt className="text-muted">Wait timer</dt>
            <dd>
              {timer ? (
                <>
                  Starts at{" "}
                  <time dateTime={deployment.waitUntil} suppressHydrationWarning>
                    {new Date(deployment.waitUntil).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                  </time>{" "}
                  <span className="text-muted" suppressHydrationWarning>
                    ({untilWords(deployment.waitUntil)})
                  </span>
                </>
              ) : (
                "Done"
              )}
            </dd>
          </>
        )}
        {deployment.reviewedBy && (
          <>
            <dt className="text-muted">{deployment.state === "rejected" ? "Rejected by" : "Approved by"}</dt>
            <dd className="min-w-0">
              <span className="font-mono text-xs">{deployment.reviewedBy}</span>
              {deployment.reviewedAt && (
                <span className="text-muted">
                  {" "}
                  · <TimeAgo at={deployment.reviewedAt} />
                </span>
              )}
              {deployment.comment && <p className="mt-1 whitespace-pre-wrap break-words text-fg/85">{deployment.comment}</p>}
            </dd>
          </>
        )}
      </dl>
      {waiting && deployment.needsReview && deployment.canReview && (
        <Form method="post" className="space-y-3">
          <input type="hidden" name="environment" value={deployment.environment} />
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Comment (optional)</span>
            <textarea
              name="comment"
              rows={2}
              maxLength={1000}
              placeholder="Why you approve or reject it"
              className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <SubmitButton name="intent" value="approve-deployment" variant="accent" disabled={busy} pending="Approving…">
              <Check size={13} />
              Approve and deploy
            </SubmitButton>
            <SubmitButton name="intent" value="reject-deployment" variant="danger" disabled={busy} pending="Rejecting…">
              <X size={13} />
              Reject
            </SubmitButton>
          </div>
        </Form>
      )}
      {waiting && deployment.needsReview && !deployment.canReview && (
        <p className="text-sm text-muted">
          {deployment.reviewers.length > 0
            ? "Only its reviewers can approve or reject it."
            : "Only someone this environment's rules name can approve or reject it."}
        </p>
      )}
    </li>
  );
}

/** The environments holding the run's jobs, each with where its rules stand. */
function DeploymentsPanel({ deployments, busy }: { deployments: PendingDeployment[]; busy: boolean }) {
  const review = deployments.some((deployment) => deployment.state === "waiting" && deployment.needsReview);
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <header className="flex items-start gap-2.5 border-b border-line px-4 py-3">
        <Hourglass size={16} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{review ? "Waiting for review" : "Waiting to deploy"}</h3>
          <p className="mt-0.5 text-sm text-muted">
            Jobs that deploy to these environments wait until each environment's protection rules let them through, and
            only then get its secrets.
          </p>
        </div>
      </header>
      <ul className="divide-y divide-line">
        {deployments.map((deployment) => (
          <DeploymentRow key={deployment.environment} deployment={deployment} busy={busy} />
        ))}
      </ul>
    </section>
  );
}

export default function ActionsRun({ loaderData, actionData, params }: Route.ComponentProps) {
  const { detail, artifacts, member } = loaderData;
  const { run, jobs, notes } = detail;
  const deployments = detail.pendingDeployments ?? [];
  const base = `/${params.owner}/${params.repo}`;
  const [search] = useSearchParams();
  // One of the run's buttons is working: the others wait for it.
  const busy = usePending();
  const live = run.status !== "completed";
  // Waiting on a person needs no quick refresh; a running job does.
  useRefreshWhile(live, run.status === "action_required" || run.status === "waiting" ? 8000 : 2500);

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
                <SubmitButton name="intent" value="cancel" variant="quiet" disabled={busy} pending="Cancelling…">
                  <Square size={13} />
                  Cancel run
                </SubmitButton>
              ) : (
                <>
                  {anyFailed && (
                    <SubmitButton name="intent" value="rerun-failed" variant="quiet" disabled={busy} pending="Re-running…">
                      <RotateCw size={13} />
                      Re-run failed jobs
                    </SubmitButton>
                  )}
                  <SubmitButton name="intent" value="rerun" variant="quiet" disabled={busy} pending="Re-running…">
                    <RotateCw size={13} />
                    Re-run all jobs
                  </SubmitButton>
                </>
              )}
            </Form>
          )}
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span>{runWord(run.status, deployments) ?? standingWord(run)}</span>
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
          {detail.approval?.state === "approved" && detail.approval.approvedBy && <span>Approved by {detail.approval.approvedBy}</span>}
        </p>
      </header>

      <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      {detail.approval?.state === "required" && <ApprovalPanel approval={detail.approval} member={member} busy={busy} />}
      {live && held(deployments) && <DeploymentsPanel deployments={deployments} busy={busy} />}
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
                <StatusIcon status={job.status} conclusion={job.conclusion} of="job" environment={job.environment} size={14} />
                <span className="min-w-0 truncate">{job.name}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-faint">{duration(job.startedAt, job.finishedAt)}</span>
              </Link>
            ))}
          </nav>
          {/* Run again, a job keeps its id but its log starts afresh. */}
          {selected && <JobView key={`${selected.id}:${run.attempt}`} job={selected} base={base} />}
        </div>
      )}
    </div>
  );
}
