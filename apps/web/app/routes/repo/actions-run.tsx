import {
  AlertTriangle,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  FileCode,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  History,
  Hourglass,
  Info,
  LayoutList,
  Package,
  Play,
  RotateCw,
  Search,
  ServerCog,
  ShieldAlert,
  Square,
  Trash2,
  Users,
  Workflow,
  X,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Form, Link, useLoaderData, useSearchParams } from "react-router";

import type { Annotation, EnvironmentReviewer, Job, JobSummary, PendingDeployment, RunApproval, RunAttempt, StepState } from "@g1t/contracts";

import type { Route } from "./+types/actions-run";
import { page } from "../../lib/meta";
import { Duration, LogText, Notes, StatusIcon, shortRef, standingWord, useJobLog } from "../../components/actions";
import { Markdown } from "../../components/markdown";
import { RunGraph } from "../../components/run-graph";
import { DetailsDisclosure } from "../../components/details-disclosure";
import { Button, ErrorText, SubmitButton, TimeAgo, usePending } from "../../components/ui";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Hint } from "../../components/ui/hint";
import { useWorkflowReason } from "../../components/mirror";
import { searchLog } from "../../lib/log-lines";
import { listArtifacts, withLegacyArtifacts } from "../../lib/artifacts.server";
import { expiresIn, formatBytes, legacyArtifactsWorthAsking } from "../../lib/artifacts";
import { actions } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";
import { accessTo, refusal } from "../../lib/access.server";
import { useRefreshWhile } from "../../lib/refresh";
import { type GraphJob, type Unit, groupJobs, jobsOf, unitStanding } from "../../lib/run-graph";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const run = loaderData?.detail.run;
  return page(args, { title: `${run ? `${run.title || run.name} #${run.number}` : "Run"} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const repo = { namespace: params.owner, name: params.repo };
  // An earlier attempt, when one is asked for.
  const asked = Number(new URL(request.url).searchParams.get("attempt") ?? "");
  const attempt = Number.isInteger(asked) && asked > 0 ? asked : undefined;
  const [detail, kept, summaries] = await Promise.all([
    actions.run(repo, viewer, params.id, attempt).then(unwrap),
    listArtifacts(repo, viewer, params.id).catch(() => []),
    actions
      .summaries(repo, viewer, params.id, attempt)
      .then((found) => (found.ok ? found.value : []))
      .catch((): JobSummary[] => []),
  ]);
  // Artifacts an older runner kept in KV: asked for only once the service
  // has shown the viewer the run, and never while it is still going.
  const artifacts = legacyArtifactsWorthAsking(detail.run) ? await withLegacyArtifacts(kept, params.id) : kept;
  // Cancelling and re-running need Write.
  return {
    detail,
    artifacts,
    summaries,
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
  if (intent === "delete-artifact") {
    const deleted = await actions.deleteArtifact(user, repo, Number(form.get("artifact")));
    return deleted.ok ? {} : { error: deleted.error.message };
  }
  // Debug logging, for a re-run that asks for it.
  const debug = form.get("debug") === "on";
  const job = String(form.get("job") ?? "") || undefined;
  const done =
    intent === "approve-run"
      ? await actions.approveRun(user, repo, params.id)
      : intent === "cancel" || intent === "force-cancel"
        ? await actions.cancel(user, repo, params.id, intent === "force-cancel")
        : await actions.rerun(user, repo, params.id, intent === "rerun-failed", { job: intent === "rerun-job" ? job : undefined, debug });
  return done.ok ? {} : { error: done.error.message };
}

const ANNOTATION_ICON: Record<Annotation["level"], ReactNode> = {
  error: <XCircle size={14} className="mt-0.5 shrink-0 text-danger" />,
  warning: <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />,
  notice: <Info size={14} className="mt-0.5 shrink-0 text-muted" />,
};

function StepRow({
  step,
  text,
  defaultOpen,
  query = "",
  matches = 0,
}: {
  step: StepState;
  text: string | undefined;
  defaultOpen: boolean;
  /** A search of the job's log: only its matching lines are shown. */
  query?: string;
  matches?: number;
}) {
  return (
    <details className="group border-t border-line first:border-t-0" open={defaultOpen}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2.5 px-3 py-2 text-sm hover:bg-raised/40 sm:min-h-0 sm:px-4">
        <ChevronRight size={14} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
        <StatusIcon status={step.status} conclusion={step.conclusion} size={14} />
        <span className={`min-w-0 truncate ${step.conclusion === "skipped" ? "text-faint" : ""}`}>{step.name}</span>
        {query && (
          <span className="shrink-0 rounded-full bg-accent/15 px-1.5 text-xs text-accent">
            {matches} {matches === 1 ? "line" : "lines"}
          </span>
        )}
        <Duration className="ml-auto shrink-0 font-mono text-xs text-faint" start={step.startedAt} end={step.finishedAt} />
      </summary>
      <div className="border-t border-line bg-bg/60">
        {text === undefined ? (
          <p className="px-4 py-2 text-xs text-faint">{step.status === "queued" ? "Not started." : step.conclusion === "skipped" ? "Skipped." : "No output yet."}</p>
        ) : (
          <LogText text={text} query={query} />
        )}
      </div>
    </details>
  );
}

/**
 * Runs again, after asking whether with debug logging: the whole run, its
 * failed jobs, or one job (with the jobs that need it).
 */
function RerunDialog({
  intent,
  job,
  title,
  description,
  children,
  busy,
}: {
  intent: "rerun" | "rerun-failed" | "rerun-job";
  job?: string;
  title: string;
  description: string;
  /** What opens it. */
  children: (open: () => void) => ReactNode;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Open, saying it is starting, until the new attempt shows or the error does.
  const running = usePending({ intent });
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !running) setOpen(false);
    was.current = running;
  }, [running]);
  return (
    <>
      {children(() => setOpen(true))}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <Form method="post" preventScrollReset className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            {job && <input type="hidden" name="job" value={job} />}
            <CheckboxOption
              name="debug"
              label="Enable debug logging"
              description="Sets RUNNER_DEBUG=1 and ACTIONS_STEP_DEBUG: ::debug:: lines are shown, and how each step's if: read."
            />
            <DialogFooter>
              <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton name="intent" value={intent} variant="accent" disabled={busy} pending="Re-running…">
                <RotateCw size={13} />
                {title}
              </SubmitButton>
            </DialogFooter>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A link or menu button that sits beside the run's quiet buttons, at their size. */
const QUIET_LINK =
  "inline-flex items-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-medium text-fg/80 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg";

/** The run's attempts, newest first, each a link to how it went. */
function AttemptPicker({ attempts, shown }: { attempts: RunAttempt[]; shown: number }) {
  const latest = attempts[attempts.length - 1]?.attempt ?? shown;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={QUIET_LINK}>
          <History size={13} />
          Attempt #{shown}
          <ChevronDown size={13} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        {[...attempts].reverse().map((attempt) => (
          <DropdownMenuItem key={attempt.attempt} asChild>
            <Link
              to={attempt.attempt === latest ? "?" : `?attempt=${attempt.attempt}`}
              preventScrollReset
              className={`flex items-center gap-2 ${attempt.attempt === shown ? "text-fg" : ""}`}
            >
              <StatusIcon status={attempt.status} conclusion={attempt.conclusion} size={14} />
              <span className="font-medium">Attempt #{attempt.attempt}</span>
              {attempt.debug && <Bug size={12} className="text-faint" aria-label="Debug logging" />}
              <span className="ml-auto truncate text-xs text-faint">
                {attempt.actor && `${attempt.actor} · `}
                {attempt.startedAt ? <TimeAgo at={attempt.startedAt} /> : "not started"}
              </span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What the jobs' steps wrote to $GITHUB_STEP_SUMMARY, a card per job. */
function Summaries({
  summaries,
  repo,
  jobHref,
}: {
  summaries: JobSummary[];
  repo: { namespace: string; name: string };
  jobHref: (job: { id: string }) => string;
}) {
  if (summaries.length === 0) return null;
  return (
    <section aria-label="Job summaries" className="space-y-4">
      {summaries.map((summary) => (
        <article key={summary.jobId} className="overflow-hidden rounded-xl border border-line bg-surface">
          <header className="flex min-w-0 items-center gap-2 border-b border-line px-4 py-2.5 text-sm">
            <FileText size={14} className="shrink-0 text-muted" />
            <Link to={jobHref({ id: summary.jobId })} preventScrollReset className="min-w-0 truncate font-medium hover:underline">
              {summary.name}
            </Link>
            <span className="shrink-0 text-faint">summary</span>
          </header>
          <div className="space-y-4 px-5 py-4">
            {summary.steps.map((step) => (
              <Markdown key={step.step} source={step.markdown} repo={repo} />
            ))}
          </div>
        </article>
      ))}
    </section>
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

function JobView({ job, base, rerun }: { job: Job; base: string; rerun: ReactNode }) {
  const live = job.status !== "completed";
  const log = useJobLog(`${base}/actions/jobs/${job.id}/log`, live);
  const [query, setQuery] = useState("");
  const failed = job.steps.find((s) => s.conclusion === "failure");
  const running = job.steps.find((s) => s.status === "in_progress");
  const searching = query.trim().length > 0;
  const setUp: StepState = {
    number: 0,
    name: "Set up job",
    status: job.startedAt ? "completed" : "queued",
    conclusion: job.startedAt ? "success" : null,
    startedAt: job.startedAt,
    finishedAt: job.startedAt,
  };
  // While searching, the steps with a match, each with how many.
  const steps = [setUp, ...job.steps]
    .map((step) => ({ step, matches: searching ? searchLog(log.get(step.number) ?? "", query).length : 0 }))
    .filter(({ matches }) => !searching || matches > 0);
  const total = steps.reduce((sum, { matches }) => sum + matches, 0);
  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusIcon status={job.status} conclusion={job.conclusion} of="job" environment={job.environment} size={18} />
        <h3 className="text-base font-semibold">{job.name}</h3>
        <span className="text-sm text-muted">
          {job.cancelling ? "Cancelling: running its cleanup steps" : standingWord({ ...job, of: "job" })}
          {job.startedAt && (
            <>
              {" · "}
              <Duration start={job.startedAt} end={job.finishedAt} />
            </>
          )}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {rerun}
          {job.startedAt && (
            <Hint label="Download this job's log">
              <a
                href={`${base}/actions/jobs/${job.id}/log.txt`}
                aria-label={`Download the log of ${job.name}`}
                className="inline-flex items-center rounded-md p-1.5 text-muted ring-1 ring-line hover:text-fg"
              >
                <Download size={13} />
              </a>
            </Hint>
          )}
          <RanOn job={job} workspace={base.split("/")[1]!} />
        </span>
      </div>
      {job.reason && <Reason text={job.reason} workspace={base.split("/")[1]} />}
      {job.annotations.length > 0 && (
        <ul className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
          {job.annotations.map((note, index) => (
            <li key={index} className="flex gap-2">
              {ANNOTATION_ICON[note.level]}
              <span className="min-w-0">
                {note.title && <span className="font-medium">{note.title}: </span>}
                <span className="whitespace-pre-wrap wrap-break-word">{note.message}</span>
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
      {job.startedAt && (
        <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm focus-within:border-accent-dim">
          <Search size={14} className="shrink-0 text-faint" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search logs"
            aria-label={`Search the log of ${job.name}`}
            className="min-w-0 grow bg-transparent outline-none placeholder:text-faint"
          />
          {searching && (
            <span className="shrink-0 text-xs text-muted" aria-live="polite">
              {total} {total === 1 ? "line" : "lines"}
            </span>
          )}
        </label>
      )}
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {searching && steps.length === 0 && <p className="px-4 py-3 text-sm text-muted">No line of this job's log holds “{query.trim()}”.</p>}
        {steps.map(({ step, matches }) => (
          <StepRow
            // Searching opens every step with a match; clearing it puts them back.
            key={`${step.number}:${searching}`}
            step={step}
            text={log.get(step.number)}
            defaultOpen={searching || (step.number !== 0 && step.number === (failed ?? running)?.number)}
            query={searching ? query : ""}
            matches={matches}
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

type RunData = Route.ComponentProps["loaderData"];

/** Where the run came from, how it stands, how long it took and what it kept. */
function RunCard({
  detail,
  artifacts,
  standing,
  cancelling,
  base,
}: {
  detail: RunData["detail"];
  artifacts: RunData["artifacts"];
  standing: string;
  cancelling: boolean;
  base: string;
}) {
  const { run } = detail;
  const label = "text-xs text-muted";
  return (
    <section
      aria-label="Run"
      className="grid gap-x-6 gap-y-4 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]"
    >
      <div className="min-w-0 space-y-1.5">
        <p className={label}>
          Triggered via {run.event} <TimeAgo at={run.createdAt} />
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {run.actor && <span className="font-medium">{run.actor}</span>}
          <Link to={`${base}/commit/${run.sha}`} className="inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-fg">
            <GitCommitHorizontal size={12} />
            {run.sha.slice(0, 7)}
          </Link>
          {run.pull != null && /^refs\/pull\//.test(run.ref) ? (
            <Link to={`${base}/pull/${run.pull}`} className="rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-xs text-accent hover:underline">
              #{run.pull}
            </Link>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-xs text-accent">
              <GitBranch size={11} className="shrink-0" />
              <span className="truncate">{shortRef(run.ref)}</span>
            </span>
          )}
        </p>
        {detail.approval?.state === "approved" && detail.approval.approvedBy && (
          <p className="text-xs text-muted">Approved by {detail.approval.approvedBy}</p>
        )}
      </div>
      <div className="grid grid-cols-3 gap-4 sm:contents">
        <div className="min-w-0 space-y-1.5">
          <p className={label}>Status</p>
          <p className="flex items-center gap-1.5 font-medium">
            <StatusIcon status={run.status} conclusion={run.conclusion} size={14} />
            <span className="truncate">{standing}</span>
          </p>
          {cancelling && <p className="text-xs text-warn">Its jobs are running their cleanup steps</p>}
        </div>
        <div className="min-w-0 space-y-1.5">
          <p className={label}>Total duration</p>
          <p className="font-medium">{run.startedAt ? <Duration start={run.startedAt} end={run.finishedAt} /> : "—"}</p>
          {run.attempt > 1 && <p className="text-xs text-muted">Attempt #{run.attempt}</p>}
        </div>
        <div className="min-w-0 space-y-1.5">
          <p className={label}>Artifacts</p>
          <p className="font-medium">
            {artifacts.length > 0 ? (
              <a href="#artifacts" className="text-accent hover:underline">
                {artifacts.length}
              </a>
            ) : (
              "—"
            )}
          </p>
        </div>
      </div>
    </section>
  );
}

const LEVELS: { level: Annotation["level"]; one: string; many: string }[] = [
  { level: "error", one: "error", many: "errors" },
  { level: "warning", one: "warning", many: "warnings" },
  { level: "notice", one: "notice", many: "notices" },
];

/** Every job's errors, warnings and notices, folded under how many of each. */
function AnnotationsPanel({ jobs, jobHref }: { jobs: Job[]; jobHref: (job: { id: string }) => string }) {
  const notes = jobs.flatMap((job) => job.annotations.map((note) => ({ job, note })));
  if (notes.length === 0) return null;
  const counts = LEVELS.flatMap(({ level, one, many }) => {
    const count = notes.filter(({ note }) => note.level === level).length;
    return count > 0 ? [`${count} ${count === 1 ? one : many}`] : [];
  });
  return (
    <details open className="group overflow-hidden rounded-xl border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm hover:bg-raised/40">
        <ChevronRight size={14} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
        <span className="font-medium">Annotations</span>
        <span className="min-w-0 truncate text-muted">{counts.join(", ")}</span>
      </summary>
      <ul className="divide-y divide-line border-t border-line text-sm">
        {notes.map(({ job, note }, index) => (
          <li key={index} className="flex gap-2 px-4 py-3">
            {ANNOTATION_ICON[note.level]}
            <span className="min-w-0">
              <Link to={jobHref(job)} preventScrollReset className="block text-xs font-medium text-muted hover:text-fg hover:underline">
                {job.name}
              </Link>
              {note.title && <span className="font-medium">{note.title}: </span>}
              <span className="whitespace-pre-wrap wrap-break-word">{note.message}</span>
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
    </details>
  );
}

/** What the run kept, to download (and, with Write, to delete now). */
function ArtifactsList({
  artifacts,
  member,
  busy,
  base,
  runId,
}: {
  artifacts: RunData["artifacts"];
  member: boolean;
  busy: boolean;
  base: string;
  runId: string;
}) {
  if (artifacts.length === 0) return null;
  return (
    <section id="artifacts" className="scroll-mt-20 rounded-xl border border-line bg-surface p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Package size={14} className="text-muted" />
        Artifacts
        <span className="font-normal text-faint">
          · {artifacts.length} · {formatBytes(artifacts.reduce((sum, a) => sum + a.size, 0))}
        </span>
      </h3>
      <ul className="mt-3 divide-y divide-line text-sm">
        {artifacts.map((artifact) => (
          <li key={artifact.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span className="min-w-0 grow basis-full truncate font-mono text-[0.8125rem] sm:basis-40">{artifact.name}</span>
            <span className="flex shrink-0 items-center gap-3 text-xs text-faint">
              <span>{formatBytes(artifact.size)}</span>
              {artifact.expiresAt && <span>{expiresIn(artifact.expiresAt)}</span>}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <a
                href={`${base}/actions/runs/${runId}/artifacts/${encodeURIComponent(artifact.name)}`}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted ring-1 ring-line hover:text-fg"
              >
                <Download size={12} />
                Download
              </a>
              {member && artifact.id != null && (
                <Form method="post" preventScrollReset>
                  <input type="hidden" name="artifact" value={artifact.id} />
                  <Hint label={`Delete ${artifact.name} now`}>
                    <SubmitButton
                      name="intent"
                      value="delete-artifact"
                      icon
                      disabled={busy}
                      aria-label={`Delete ${artifact.name}`}
                      className="inline-flex items-center rounded-md p-1.5 text-muted ring-1 ring-line hover:text-danger disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                    </SubmitButton>
                  </Hint>
                </Form>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The run at a glance: the card, its jobs as a graph, their annotations, summaries and artifacts. */
function RunSummary({
  detail,
  artifacts,
  summaries,
  standing,
  cancelling,
  member,
  busy,
  base,
  jobHref,
}: {
  detail: RunData["detail"];
  artifacts: RunData["artifacts"];
  summaries: JobSummary[];
  standing: string;
  cancelling: boolean;
  member: boolean;
  busy: boolean;
  base: string;
  jobHref: (job: { id: string }) => string;
}) {
  const { run, jobs } = detail;
  const [namespace = "", name = ""] = base.slice(1).split("/");
  return (
    <section aria-label="Summary" className="min-w-0 space-y-4">
      <RunCard detail={detail} artifacts={artifacts} standing={standing} cancelling={cancelling} base={base} />
      <RunGraph jobs={jobs} title={run.path.split("/").pop() || run.name} trigger={run.event} href={jobHref} />
      <AnnotationsPanel jobs={jobs} jobHref={jobHref} />
      <Summaries summaries={summaries} repo={{ namespace, name }} jobHref={jobHref} />
      <ArtifactsList artifacts={artifacts} member={member} busy={busy} base={base} runId={run.id} />
    </section>
  );
}

const NAV_ROW = "flex min-h-11 items-center gap-2 rounded-md px-2.5 py-1.5 sm:min-h-0";

function navRow(active: boolean): string {
  return `${NAV_ROW} ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`;
}

/** A job's row in the jobs list. */
function NavJob({ job, label, selected, jobHref }: { job: GraphJob; label: string; selected: Job | null; jobHref: (job: { id: string }) => string }) {
  const active = job.id === selected?.id;
  return (
    <Link to={jobHref(job)} preventScrollReset aria-current={active ? "page" : undefined} className={navRow(active)}>
      <StatusIcon status={job.status} conclusion={job.conclusion} of="job" environment={job.environment} size={14} />
      <span className="min-w-0 truncate">{label}</span>
      <Duration className="ml-auto shrink-0 font-mono text-xs text-faint" start={job.startedAt} end={job.finishedAt} />
    </Link>
  );
}

/** One unit of the jobs list: a job, or a matrix or called workflow folded under its name. */
function NavUnit({ unit, selected, jobHref }: { unit: Unit; selected: Job | null; jobHref: (job: { id: string }) => string }) {
  if (unit.kind === "job") return <NavJob job={unit.job} label={unit.label} selected={selected} jobHref={jobHref} />;
  const inside = jobsOf(unit).some((job) => job.id === selected?.id);
  const standing = unitStanding(unit);
  return (
    <details open={unit.kind === "call" || inside} className="group/unit">
      <summary className={`${NAV_ROW} cursor-pointer list-none text-muted hover:bg-raised/60 hover:text-fg`}>
        <ChevronRight size={13} className="shrink-0 text-faint transition-transform group-open/unit:rotate-90" />
        <StatusIcon
          status={standing.status === "calling" ? "in_progress" : standing.status}
          conclusion={standing.conclusion}
          of="job"
          size={14}
        />
        <span className="min-w-0 truncate">{unit.label}</span>
        {unit.kind === "matrix" && <span className="ml-auto shrink-0 text-xs text-faint">{unit.jobs.length}</span>}
      </summary>
      <div className="ml-3 space-y-0.5 border-l border-line pl-1.5">
        {unit.kind === "matrix" ? (
          unit.jobs.map((job) => (
            <NavJob key={job.id} job={job} label={job.name.split(" / ").pop() ?? job.name} selected={selected} jobHref={jobHref} />
          ))
        ) : (
          <>
            {unit.callers.map((job) => (
              <Link
                key={job.id}
                to={jobHref(job)}
                preventScrollReset
                aria-current={job.id === selected?.id ? "page" : undefined}
                className={navRow(job.id === selected?.id)}
              >
                <Workflow size={14} className="shrink-0 text-faint" />
                <span className="min-w-0 truncate">{unit.uses ? `Calls ${unit.uses.split("/").pop()}` : job.name}</span>
              </Link>
            ))}
            {unit.units.map((inner) => (
              <NavUnit key={inner.key} unit={inner} selected={selected} jobHref={jobHref} />
            ))}
          </>
        )}
      </div>
    </details>
  );
}

/** The run's pages: its summary, its jobs grouped as the graph groups them, and where it came from. */
function RunNav({
  run,
  jobs,
  selected,
  base,
  jobHref,
  summaryHref,
}: {
  run: RunData["detail"]["run"];
  jobs: Job[];
  selected: Job | null;
  base: string;
  jobHref: (job: { id: string }) => string;
  summaryHref: string;
}) {
  const units = groupJobs(jobs);
  const heading = "px-2.5 pt-4 pb-1 text-xs font-medium text-faint";
  return (
    <nav aria-label="Run" className="space-y-0.5 text-sm">
      <Link to={summaryHref} preventScrollReset aria-current={selected ? undefined : "page"} className={navRow(!selected)}>
        <LayoutList size={14} className="shrink-0" />
        Summary
      </Link>
      <p className={heading}>All jobs</p>
      {units.map((unit) => (
        <NavUnit key={unit.key} unit={unit} selected={selected} jobHref={jobHref} />
      ))}
      <p className={heading}>Run details</p>
      <Link to={`${base}/blob/${run.sha}/${run.path}`} className={navRow(false)}>
        <FileCode size={14} className="shrink-0" />
        Workflow file
      </Link>
    </nav>
  );
}

export default function ActionsRun({ loaderData, actionData, params }: Route.ComponentProps) {
  const { detail, artifacts, member, summaries } = loaderData;
  const { run, jobs, notes } = detail;
  const deployments = detail.pendingDeployments ?? [];
  const attempts = detail.attempts ?? [];
  const latest = attempts.length === 0 || run.attempt === attempts[attempts.length - 1]!.attempt;
  const base = `/${params.owner}/${params.repo}`;
  const [search] = useSearchParams();
  // One of the run's buttons is working: the others wait for it.
  const busy = usePending();
  const live = run.status !== "completed";
  // Cancelled, while its jobs run their cleanup steps.
  const cancelling = live && run.conclusion === "cancelled";
  // Re-running is for the latest attempt of a finished run.
  const canRerun = member && !run.error && !live && latest;
  // A mirror standing by runs nothing; in CI failover it runs them again.
  const rerunBlocked = useWorkflowReason();
  const logsUrl = `${base}/actions/runs/${run.id}/logs.zip${latest ? "" : `?attempt=${run.attempt}`}`;
  // Waiting on a person needs no quick refresh; a running job does.
  useRefreshWhile(live, run.status === "action_required" || run.status === "waiting" ? 8000 : 2500);

  // The job asked for; none is the run's summary.
  const selected = jobs.find((job) => job.id === search.get("job")) ?? null;
  const jobHref = (job: { id: string }) => (latest ? `?job=${job.id}` : `?attempt=${run.attempt}&job=${job.id}`);
  const summaryHref = latest ? "?" : `?attempt=${run.attempt}`;
  const standing = runWord(run.status, deployments) ?? (cancelling ? "Cancelling" : standingWord(run));
  const anyFailed = jobs.some((job) => job.conclusion === "failure" || job.conclusion === "cancelled");

  return (
    <div className="max-w-6xl space-y-6">
      <header className="space-y-3">
        <Link to={`${base}/actions?workflow=${run.workflowId}`} className="text-sm text-muted hover:text-fg">
          {run.name}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h2 className="flex min-w-0 items-start gap-2.5 text-xl font-semibold tracking-tight sm:items-center">
            <span className="mt-1 shrink-0 sm:mt-0">
              <StatusIcon status={run.status} conclusion={run.conclusion} size={20} />
            </span>
            <span className="min-w-0 wrap-break-word sm:truncate">{run.title || run.name}</span>
            <span className="font-normal text-muted">#{run.number}</span>
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {attempts.length > 1 && <AttemptPicker attempts={attempts} shown={run.attempt} />}
            {jobs.some((job) => job.startedAt) && (
              <Hint label={latest ? "Every job's log, as a zip" : `Attempt #${run.attempt}'s logs, as a zip`}>
                <a href={logsUrl} className={QUIET_LINK}>
                  <Download size={13} />
                  Download logs
                </a>
              </Hint>
            )}
            {member && !run.error && live && (
              <Form method="post" className="flex gap-2">
                {cancelling ? (
                  <Hint label="Stop its jobs now, without waiting for their cleanup steps">
                    <SubmitButton name="intent" value="force-cancel" variant="danger" disabled={busy} pending="Stopping…">
                      <Square size={13} />
                      Force cancel
                    </SubmitButton>
                  </Hint>
                ) : (
                  <SubmitButton name="intent" value="cancel" variant="quiet" disabled={busy} pending="Cancelling…">
                    <Square size={13} />
                    Cancel run
                  </SubmitButton>
                )}
              </Form>
            )}
            {canRerun && anyFailed && (
              <RerunDialog
                intent="rerun-failed"
                title="Re-run failed jobs"
                description="The jobs that did not succeed run again as a new attempt, with every job that needs them. The others keep how they ended."
                busy={busy}
              >
                {(open) => (
                  <Hint label={rerunBlocked} disabled={rerunBlocked != null}>
                    <Button type="button" variant="quiet" disabled={busy || rerunBlocked != null} onClick={open}>
                      <RotateCw size={13} />
                      Re-run failed jobs
                    </Button>
                  </Hint>
                )}
              </RerunDialog>
            )}
            {canRerun && (
              <RerunDialog
                intent="rerun"
                title="Re-run all jobs"
                description="Every job runs again as a new attempt. This attempt stays here, with its logs."
                busy={busy}
              >
                {(open) => (
                  <Hint label={rerunBlocked} disabled={rerunBlocked != null}>
                    <Button type="button" variant="quiet" disabled={busy || rerunBlocked != null} onClick={open}>
                      <RotateCw size={13} />
                      Re-run all jobs
                    </Button>
                  </Hint>
                )}
              </RerunDialog>
            )}
          </div>
        </div>
        {selected && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span>{standing}</span>
            {/* A pull request's ref is its number, which the link beside it already shows. */}
            {!(run.pull != null && /^refs\/pull\//.test(run.ref)) && (
              <span className="inline-flex items-center gap-1 font-mono text-xs">
                <GitBranch size={12} />
                {shortRef(run.ref)}
              </span>
            )}
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
            {run.startedAt && <Duration className="font-mono text-xs" start={run.startedAt} end={run.finishedAt} />}
            {run.attempt > 1 && attempts.length <= 1 && <span>Attempt {run.attempt}</span>}
            {cancelling && <span className="text-warn">Its jobs are running their cleanup steps</span>}
            {detail.approval?.state === "approved" && detail.approval.approvedBy && <span>Approved by {detail.approval.approvedBy}</span>}
          </p>
        )}
      </header>

      <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      {!latest && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
          <History size={15} className="shrink-0" />
          <span>
            This is attempt #{run.attempt} of {attempts.length}, as it ended.
          </span>
          <Link to="?" className="text-accent hover:underline">
            See the latest attempt
          </Link>
        </p>
      )}
      {detail.approval?.state === "required" && <ApprovalPanel approval={detail.approval} member={member} busy={busy} />}
      {live && held(deployments) && <DeploymentsPanel deployments={deployments} busy={busy} />}
      {run.error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm">
          <p className="font-medium text-danger">The workflow file could not be used</p>
          <p className="mt-1 whitespace-pre-wrap wrap-break-word text-fg/85">{run.error}</p>
        </div>
      )}
      <Notes notes={notes} />

      {jobs.length === 0 ? (
        <RunSummary
          detail={detail}
          artifacts={artifacts}
          summaries={summaries}
          standing={standing}
          cancelling={cancelling}
          member={member}
          busy={busy}
          base={base}
          jobHref={jobHref}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
          <DetailsDisclosure label="Jobs" summary={selected ? `${jobs.length} · ${selected.name}` : `${jobs.length} · Summary`} bodyClassName="space-y-0.5">
            <RunNav run={run} jobs={jobs} selected={selected} base={base} jobHref={jobHref} summaryHref={summaryHref} />
          </DetailsDisclosure>
          {/* Run again, a job keeps its id but its log starts afresh. */}
          {selected ? (
            <JobView
              key={`${selected.id}:${run.attempt}`}
              job={selected}
              base={base}
              rerun={
                canRerun && selected.status === "completed" ? (
                  <RerunDialog
                    intent="rerun-job"
                    job={selected.id}
                    title="Re-run this job"
                    description={`${selected.name} runs again as a new attempt, with every job that needs it. A job of a matrix runs again with the rest of its matrix.`}
                    busy={busy}
                  >
                    {(open) => (
                      <Hint label={rerunBlocked ?? "Re-run this job"} disabled={rerunBlocked != null}>
                        <button
                          type="button"
                          aria-label={`Re-run ${selected.name}`}
                          disabled={busy || rerunBlocked != null}
                          onClick={open}
                          className="inline-flex items-center rounded-md p-1.5 text-muted ring-1 ring-line hover:text-fg disabled:opacity-50"
                        >
                          <RotateCw size={13} />
                        </button>
                      </Hint>
                    )}
                  </RerunDialog>
                ) : null
              }
            />
          ) : (
            <RunSummary
              detail={detail}
              artifacts={artifacts}
              summaries={summaries}
              standing={standing}
              cancelling={cancelling}
              member={member}
              busy={busy}
              base={base}
              jobHref={jobHref}
            />
          )}
        </div>
      )}
    </div>
  );
}
