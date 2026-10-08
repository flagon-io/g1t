/**
 * The parts of a pull request's merge box that say what stands between it
 * and a merge: the checks the branch requires and every other check, job by
 * job, and whether
 * the change merges cleanly into its target, with what to do when not.
 */
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  RotateCw,
  Sparkles,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Form, Link } from "react-router";

import type { CheckResult, CheckRun, CommitStatus, Job, Mergeable, PullBranchUpdate, Pull, RequiredCheck } from "@g1t/contracts";

import { useAddresses } from "../lib/addresses";
import { catchUpPhase, catchUpRun, catchUpTitle, catchUpWhy } from "../lib/catch-up";
import { duration } from "./actions";
import { Elapsed, type Live, useRuns } from "./agents";
import { Button, CopyLine, ErrorText, SubmitButton, TimeAgo } from "./ui";
import { Hint } from "./ui/hint";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SkeletonLine } from "./ui/skeleton";

// --- Output ---------------------------------------------------------------

/** What the sandbox puts first when it kept only the end of the output. */
const CUT_SHORT = "… (earlier output not shown)";

/** One run of text in one style, from a line with ANSI colour codes. */
type Segment = { text: string; className: string };

const ANSI_COLOURS: Record<number, string> = {
  30: "text-faint",
  31: "text-danger",
  32: "text-accent",
  33: "text-warn",
  34: "text-info",
  35: "text-merged",
  36: "text-info",
  37: "text-fg",
  90: "text-faint",
  91: "text-danger",
  92: "text-accent",
  93: "text-warn",
  94: "text-info",
  95: "text-merged",
  96: "text-info",
  97: "text-fg",
};

/**
 * A line's text split where its colour changes. Colours and bold are kept;
 * every other escape sequence (cursor movement, erasing, links) is dropped.
 */
export function ansiSegments(line: string): Segment[] {
  const segments: Segment[] = [];
  let colour = "";
  let bold = false;
  // SGR sequences are kept apart; anything else that starts with ESC goes.
  const pattern = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
  let at = 0;
  const push = (text: string) => {
    if (text) segments.push({ text, className: [colour, bold ? "font-semibold" : ""].filter(Boolean).join(" ") });
  };
  for (const match of line.matchAll(pattern)) {
    push(line.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[1] === undefined) continue;
    const codes = match[1] === "" ? [0] : match[1].split(";").map(Number);
    for (const code of codes) {
      if (code === 0) {
        colour = "";
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) colour = "";
      else if (ANSI_COLOURS[code]) colour = ANSI_COLOURS[code];
    }
  }
  push(line.slice(at));
  return segments;
}

/** Text without any ANSI escape sequences, for copying. */
export function stripAnsi(text: string): string {
  return ansiSegments(text.replace(/\r\n/g, "\n"))
    .map((segment) => segment.text)
    .join("");
}

/** Lines as a terminal would show them: a carriage return starts the line over. */
function terminalLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1] || parts.filter(Boolean).pop() || "";
    });
}

/**
 * A command's output as a log: numbered lines, colours rendered, a copy
 * button, and a note when only the end of it was kept.
 */
export function LogViewer({ text }: { text: string }) {
  const cut = text.startsWith(CUT_SHORT);
  const body = cut ? text.slice(CUT_SHORT.length).replace(/^\n/, "") : text;
  const lines = useMemo(() => {
    const all = terminalLines(body);
    while (all.length > 0 && all[all.length - 1].trim() === "") all.pop();
    return all;
  }, [body]);
  const [copied, setCopied] = useState(false);
  if (lines.length === 0) {
    return <p className="px-3 py-2 font-mono text-xs text-faint">No output.</p>;
  }
  return (
    <div className="relative">
      <Hint label="Copy the output">
        <button
          type="button"
          aria-label="Copy the output"
          className="absolute top-1.5 right-3 z-10 rounded-md border border-line bg-surface p-1.5 text-faint transition-colors hover:text-fg"
          onClick={() => {
            void navigator.clipboard.writeText(stripAnsi(body));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={13} className="text-accent" /> : <Copy size={13} />}
        </button>
      </Hint>
      {cut && (
        <p className="border-b border-line px-3 py-1.5 text-xs text-faint">
          Showing the end of the output. Earlier lines were not kept.
        </p>
      )}
      <div className="max-h-96 overflow-auto py-1.5 font-mono text-xs leading-5">
        {lines.map((line, index) => (
          <div key={index} className="flex gap-3 pr-12 pl-2 hover:bg-raised/40">
            <span className="w-9 shrink-0 text-right text-faint/70 select-none">{index + 1}</span>
            <span className="min-w-0 break-all whitespace-pre-wrap text-fg/85">
              {ansiSegments(line).map((segment, at) =>
                segment.className ? (
                  <span key={at} className={segment.className}>
                    {segment.text}
                  </span>
                ) : (
                  segment.text
                ),
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Checks ---------------------------------------------------------------

function seconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

type Standing = "passed" | "failed" | "running" | "queued" | "skipped";

function StandingIcon({ standing, size = 15 }: { standing: Standing; size?: number }) {
  if (standing === "passed") return <CircleCheck size={size} className="shrink-0 text-accent" aria-label="Passed" />;
  if (standing === "failed") return <CircleX size={size} className="shrink-0 text-danger" aria-label="Failed" />;
  if (standing === "running")
    return <LoaderCircle size={size} className="shrink-0 animate-spin text-warn" aria-label="Running" />;
  if (standing === "skipped") return <CircleAlert size={size} className="shrink-0 text-faint" aria-label="Skipped" />;
  return <LoaderCircle size={size} className="shrink-0 text-faint" aria-label="Queued" />;
}

/** The id of the workflow run a status links to, if it links to one. */
export function runIdOf(status: CommitStatus): string | null {
  return /\/actions\/runs\/([^/?#]+)/.exec(status.targetUrl ?? "")?.[1] ?? null;
}

/** Where a job stands, in the box's terms. */
function jobStanding(job: Job): Standing {
  if (job.status !== "completed") return job.status === "in_progress" || job.status === "calling" ? "running" : "queued";
  if (job.conclusion === "success") return "passed";
  if (job.conclusion === "skipped" || job.conclusion === "cancelled") return "skipped";
  return "failed";
}

function statusStanding(status: CommitStatus): Standing {
  if (status.state === "pending") return "running";
  return status.state === "success" ? "passed" : "failed";
}

/** One row of the checks list: an icon, a name, how long, and a way in. */
function CheckLine({
  standing,
  name,
  detail,
  time,
  timing = false,
  to,
}: {
  standing: Standing;
  name: React.ReactNode;
  detail?: React.ReactNode;
  time?: string;
  /** Its jobs and their times are still being read. */
  timing?: boolean;
  to?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2 text-sm">
      <StandingIcon standing={standing} />
      <span className="min-w-0 grow truncate">
        {name}
        {detail && <span className="text-muted"> — {detail}</span>}
      </span>
      {time && <span className="shrink-0 animate-fade-in font-mono text-xs text-faint">{time}</span>}
      {timing && <SkeletonLine className="w-10 shrink-0 text-xs" />}
      {to && (
        <Link to={to} className="shrink-0 text-xs text-muted hover:text-fg hover:underline">
          Details
        </Link>
      )}
    </div>
  );
}

/** A command from a run recorded before checks were workflows: what it printed, open when it failed. */
function CommandResult({ result }: { result: CheckResult }) {
  const timedOut = result.exitCode == null && !result.passed;
  return (
    <details className="group" open={!result.passed}>
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-2 text-sm hover:bg-raised/40">
        <StandingIcon standing={result.passed ? "passed" : "failed"} />
        <span className="min-w-0 grow truncate">
          <code className="font-mono text-xs">{result.command}</code>
          {!result.passed && (
            <span className="text-muted">
              {" — "}
              {timedOut ? "stopped for taking too long" : `exited with code ${result.exitCode}`}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-xs text-faint">{seconds(result.durationMs)}</span>
        <ChevronRight size={14} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
      </summary>
      <div className="mx-4 mb-3 overflow-hidden rounded-lg border border-line bg-bg">
        <LogViewer text={result.output} />
      </div>
    </details>
  );
}

/** Where a required check stands, in the box's terms. */
function requiredStanding(check: RequiredCheck): Standing {
  if (check.state === "success") return "passed";
  if (check.state === "failure") return "failed";
  return check.state === "pending" ? "running" : "queued";
}

/** How the required checks stand together: "2 of 3 passing", and what holds the rest. */
export function requiredSummary(required: RequiredCheck[]): { title: string; sub: string; standing: Standing } {
  const count = (state: RequiredCheck["state"]) => required.filter((check) => check.state === state).length;
  const passing = count("success");
  const failing = count("failure");
  const running = count("pending");
  const expected = count("expected");
  const sub = [
    failing > 0 && `${failing} failing`,
    running > 0 && `${running} running`,
    expected > 0 && `${expected} not reported yet`,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    title: `Required checks: ${passing} of ${required.length} passing`,
    sub,
    standing: failing > 0 ? "failed" : running + expected > 0 ? "running" : "passed",
  };
}

/** The repository-relative address of a status's link, when it is on g1t. */
function onSite(url: string | null): string | undefined {
  if (!url) return undefined;
  const path = url.replace(/^https:\/\/g1t\.sh(?=\/)/, "");
  return path.startsWith("/") ? path : undefined;
}

/**
 * Every check on a pull request, at a glance and in detail: first the
 * checks the default branch requires, each as it stands on the head (one
 * nothing has reported is waited for), then every workflow run on the
 * head, job by job. A record of the merge queue taking it out comes last.
 */
export function ChecksSection({
  run,
  required,
  statuses,
  jobs,
  pull,
  base,
  earlier,
  canRerunWorkflows,
  settingsUrl,
  error,
  loading = false,
}: {
  /** Set when the merge queue took it out, or for a run from before checks were workflows. */
  run: CheckRun | null;
  required: RequiredCheck[];
  statuses: CommitStatus[];
  /** Each workflow run's jobs, by run id, where they could be read. */
  jobs: Record<string, Job[]>;
  pull: Pull;
  /** The repository's path, `/<owner>/<repo>`. */
  base: string;
  earlier: CheckRun[];
  canRerunWorkflows: boolean;
  /** Where the required checks are chosen, for those who may. */
  settingsUrl?: string | null;
  error?: string | null;
  /** The workflow runs' jobs are still being read: their rows wait, busy. */
  loading?: boolean;
}) {
  if (!run && statuses.length === 0 && required.length === 0) return null;

  // Every workflow row, so they can be counted the same way they are shown.
  const workflow: Standing[] = statuses.flatMap((status) => {
    const id = runIdOf(status);
    const theirs = id ? jobs[id] : undefined;
    return theirs && theirs.length > 0 ? theirs.map(jobStanding) : [statusStanding(status)];
  });
  const failed = workflow.filter((standing) => standing === "failed").length;
  const pending = workflow.filter((standing) => standing === "running" || standing === "queued").length;
  const passed = workflow.filter((standing) => standing === "passed").length;
  const skipped = workflow.filter((standing) => standing === "skipped").length;
  const total = workflow.length;
  const queueFailed = run?.status === "failed" && run.results.length === 0;

  const summary = required.length > 0 ? requiredSummary(required) : null;
  const headline = summary
    ? summary.title
    : failed > 0
      ? `${failed} of ${total} ${total === 1 ? "check" : "checks"} failed`
      : pending > 0
        ? `${pending} of ${total} ${total === 1 ? "check is" : "checks are"} still running`
        : total > 0
          ? "All checks have passed"
          : "Checks";
  const others = [
    failed > 0 && `${failed} failed`,
    pending > 0 && `${pending} running`,
    passed > 0 && `${passed} passed`,
    skipped > 0 && `${skipped} skipped or cancelled`,
  ]
    .filter(Boolean)
    .join(", ");
  const sub = summary
    ? [summary.sub, others && `all checks: ${others}`].filter(Boolean).join(" · ")
    : [others, "none are required, so none hold the merge"].filter(Boolean).join(" · ");
  const standing: Standing = summary
    ? summary.standing
    : failed > 0
      ? "failed"
      : pending > 0
        ? "running"
        : "passed";

  const commitPath = (sha: string) =>
    pull.fork ? `/${pull.fork.namespace}/${pull.fork.name}/commit/${sha}` : `${base}/commit/${sha}`;
  const older = run != null && pull.headCommit != null && run.headCommit !== pull.headCommit;
  const failedRuns = statuses.filter((status) => statusStanding(status) === "failed" && runIdOf(status));

  return (
    <div aria-busy={loading || undefined}>
      <div className="flex items-start gap-3 px-4 py-3">
        <span className="mt-0.5 shrink-0">
          {standing === "failed" || queueFailed ? (
            <CircleX size={16} className="text-danger" />
          ) : standing === "running" ? (
            <LoaderCircle size={16} className="animate-spin text-warn" />
          ) : (
            <CircleCheck size={16} className="text-accent" />
          )}
        </span>
        <div className="min-w-0 grow">
          <p className="text-sm font-medium">{headline}</p>
          {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
          {!summary && settingsUrl && (
            <p className="mt-0.5 text-xs text-muted">
              <Link to={settingsUrl} className="text-fg hover:underline">
                Choose required checks
              </Link>{" "}
              to hold merges until they pass.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {canRerunWorkflows &&
            failedRuns.map((status) => (
              <Form method="post" key={status.context}>
                <input type="hidden" name="action" value="rerun-workflow" />
                <input type="hidden" name="run" value={runIdOf(status) ?? ""} />
                <Hint label={`Re-run the failed jobs of ${status.context}`}>
                  <SubmitButton
                    variant="quiet"
                    match={{ action: "rerun-workflow", run: runIdOf(status) ?? "" }}
                    pending="Re-running…"
                  >
                    <RotateCw size={13} />
                    Re-run failed jobs{failedRuns.length > 1 ? ` of ${status.context}` : ""}
                  </SubmitButton>
                </Hint>
              </Form>
            ))}
        </div>
      </div>
      {error && (
        <div className="px-4 pb-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}

      <div className="divide-y divide-line border-t border-line">
        {required.length > 0 && (
          <section aria-label="Required checks" className="py-1">
            <p className="px-4 pt-1.5 pb-1 text-xs font-medium text-muted">Required</p>
            {required.map((check) => (
              <CheckLine
                key={check.name}
                standing={requiredStanding(check)}
                name={
                  <>
                    {check.name}
                    <span className="ml-1.5 rounded-full border border-line px-1.5 py-px text-[0.625rem] text-faint">Required</span>
                  </>
                }
                detail={
                  check.state === "expected"
                    ? "Waiting for status to be reported"
                    : (check.description ?? (check.state === "pending" ? "running" : undefined))
                }
                to={onSite(check.targetUrl)}
              />
            ))}
          </section>
        )}

        {statuses.length > 0 && (
          <section aria-label="All checks" className="py-1">
            <p className="px-4 pt-1.5 pb-1 text-xs font-medium text-muted">{required.length > 0 ? "All checks" : "Workflows"}</p>
            {statuses.map((status) => {
              const id = runIdOf(status);
              const runPath = id ? `${base}/actions/runs/${id}` : onSite(status.targetUrl);
              const theirs = id ? jobs[id] : undefined;
              if (!theirs || theirs.length === 0) {
                return (
                  <CheckLine
                    key={status.context}
                    standing={statusStanding(status)}
                    name={status.context}
                    detail={status.description ?? undefined}
                    timing={loading && id != null}
                    to={runPath}
                  />
                );
              }
              return theirs.map((job) => (
                <CheckLine
                  key={`${status.context}-${job.id}`}
                  standing={jobStanding(job)}
                  name={
                    <>
                      <span className="text-muted">{status.context} / </span>
                      {job.name}
                    </>
                  }
                  detail={job.reason ?? (jobStanding(job) === "failed" ? "failed" : undefined)}
                  time={duration(job.startedAt, job.finishedAt) || undefined}
                  to={`${runPath}?job=${job.id}`}
                />
              ));
            })}
          </section>
        )}

        {run && (
          <section aria-label={queueFailed ? "Merge queue" : "Earlier commands"} className="py-1">
            <p className="flex flex-wrap items-center gap-x-1.5 px-4 pt-1.5 pb-1 text-xs text-faint">
              <span className="font-medium text-muted">{queueFailed ? "Merge queue" : "Commands from the issue"}</span>
              <span>· on</span>
              <Link to={commitPath(run.headCommit)} className="inline-flex items-center gap-1 font-mono hover:text-fg">
                <GitCommitHorizontal size={12} />
                {run.headCommit.slice(0, 7)}
              </Link>
              {run.finishedAt ? (
                <span>
                  · <TimeAgo at={run.finishedAt} />
                </span>
              ) : (
                <span>
                  · started <TimeAgo at={run.createdAt} />
                </span>
              )}
            </p>
            {older && !queueFailed && (
              <p className="mx-4 my-1.5 flex items-start gap-2 rounded-md bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                These ran on an older commit, before the latest push,{" "}
                <span className="font-mono">{pull.headCommit?.slice(0, 7)}</span>.
              </p>
            )}
            {run.error && (
              <p className="mx-4 my-1.5 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted">{run.error}</p>
            )}
            {run.results.map((result, index) => (
              <CommandResult key={`${result.command}-${index}`} result={result} />
            ))}
          </section>
        )}

        {earlier.length > 0 && (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs text-muted hover:text-fg">
              <History size={13} />
              Earlier records ({earlier.length})
              <ChevronRight size={13} className="transition-transform group-open:rotate-90" />
            </summary>
            <ul className="space-y-1 px-4 pb-3 text-xs">
              {earlier.map((before) => (
                <li key={before.id} className="flex items-center gap-2 text-muted">
                  <StandingIcon
                    size={13}
                    standing={
                      before.status === "passed"
                        ? "passed"
                        : before.status === "queued" || before.status === "running"
                          ? "queued"
                          : "failed"
                    }
                  />
                  <Link to={commitPath(before.headCommit)} className="font-mono hover:text-fg">
                    {before.headCommit.slice(0, 7)}
                  </Link>
                  <span className="min-w-0 truncate">
                    {before.status === "errored"
                      ? `could not run${before.error ? `: ${before.error}` : ""}`
                      : before.results.length > 0
                        ? `${before.results.filter((result) => result.passed).length} of ${before.results.length} passed`
                        : (before.error ?? before.status)}
                  </span>
                  <span className="ml-auto shrink-0 text-faint">
                    <TimeAgo at={before.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

// --- Mergeability ---------------------------------------------------------

/** How to resolve the conflicts by hand, step by step, for a branch or a fork. */
export function commandLineSteps(
  pull: Pull,
  owner: string,
  repo: string,
  defaultBranch: string,
  files: string[],
  site = "https://g1t.sh",
): string[] {
  const upstream = `${site}/${owner}/${repo}.git`;
  const add = files.length > 0 && files.length <= 6 ? `git add ${files.join(" ")}` : "git add -A";
  if (pull.branch) {
    return [
      `git fetch origin`,
      `git checkout ${pull.branch}`,
      `git merge origin/${defaultBranch}`,
      `${add} && git commit --no-edit`,
      `git push origin ${pull.branch}`,
    ];
  }
  const fork = pull.fork!;
  return [
    `git clone ${site}/${fork.namespace}/${fork.name}.git && cd ${fork.name}`,
    `git pull --no-rebase ${upstream} ${defaultBranch}`,
    `${add} && git commit --no-edit`,
    `git push`,
  ];
}

/**
 * The branch conflicts with its target: which files, and three ways out —
 * g1t, the browser (soon), or the command line.
 */
export function ConflictsSection({
  conflicts,
  pull,
  owner,
  repo,
  defaultBranch,
  changesUrl,
  canResolve,
  resolving,
  error,
}: {
  conflicts: string[];
  pull: Pull;
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Where the pull request's changes are shown, to link each file. */
  changesUrl: string;
  /** Whether the viewer may have g1t resolve them. */
  canResolve: boolean;
  /** Whether asking for it is on its way. */
  resolving: boolean;
  error?: string | null;
}) {
  const { site } = useAddresses();
  const steps = commandLineSteps(pull, owner, repo, defaultBranch, conflicts, site);
  return (
    <div className="bg-danger/5">
      <div className="flex gap-3 px-4 py-3">
        <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 grow">
          <p className="text-sm font-medium">This branch has conflicts that must be resolved</p>
          <p className="mt-0.5 text-sm text-muted">
            Merging <span className="font-mono">{defaultBranch}</span> into it stops on{" "}
            {conflicts.length === 1 ? "one file" : `${conflicts.length} files`}. It cannot merge until they are resolved.
          </p>
          {conflicts.length > 0 && (
            <>
              <p className="mt-3 text-xs font-medium text-muted">Conflicting files</p>
              <ul className="mt-1.5 space-y-1">
                {conflicts.map((path) => (
                  <li key={path}>
                    <Link
                      to={`${changesUrl}#file-${path}`}
                      className="font-mono text-xs text-fg hover:text-danger hover:underline"
                    >
                      {path}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canResolve && (
              <Form method="post">
                <input type="hidden" name="action" value="update" />
                <Button variant="primary" type="submit" disabled={resolving}>
                  {resolving ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {resolving ? "Starting g1t…" : "Resolve with g1t"}
                </Button>
              </Form>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A disabled button gets no pointer events; the span carries the tooltip. */}
                <span tabIndex={0} className="inline-flex">
                  <Button variant="quiet" type="button" disabled aria-disabled="true">
                    Resolve in the browser
                    <span className="rounded-full border border-line px-1.5 text-[0.625rem] text-faint">Soon</span>
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                An editor for conflicts in the browser is coming. Until then, have g1t resolve them, or use the
                command line.
              </TooltipContent>
            </Tooltip>
          </div>
          {error && (
            <div className="mt-2">
              <ErrorText>{error}</ErrorText>
            </div>
          )}
            <details className="group mt-3">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted hover:text-fg">
                <Terminal size={13} />
                Resolve on the command line
                <ChevronRight size={13} className="transition-transform group-open:rotate-90" />
              </summary>
              <ol className="mt-2 space-y-2 text-xs text-muted">
                {steps.map((step, index) => (
                  <li key={step}>
                    <p className="mb-1">
                      {index + 1}.{" "}
                      {step.startsWith("git add")
                        ? "Fix the conflicts in each file, removing the conflict markers, then commit the merge:"
                        : step.startsWith("git push")
                          ? "Push it. The pull request updates, and its checks run again:"
                          : step.includes("merge") || step.includes("pull")
                            ? `Merge ${defaultBranch} in. Git stops on the conflicting files:`
                            : step.startsWith("git clone")
                              ? "Clone the pull request's fork:"
                              : step.startsWith("git checkout")
                                ? "Check out the pull request's branch:"
                                : "Get the latest of both:"}
                    </p>
                    <CopyLine text={step} prompt />
                  </li>
                ))}
              </ol>
              {pull.fork && (
                <p className="mt-2 text-xs text-faint">
                  A pull request's fork takes pushes from whoever opened it.
                </p>
              )}
            </details>
        </div>
      </div>
    </div>
  );
}

/** Whether the change merges cleanly, when that is not a conflict. */
export function MergeabilityRow({
  mergeable,
  defaultBranch,
}: {
  mergeable: Mergeable;
  defaultBranch: string;
}) {
  if (mergeable === "checking") {
    return (
      <div className="flex gap-3 px-4 py-3 text-sm">
        <LoaderCircle size={16} className="mt-0.5 shrink-0 animate-spin text-faint" />
        <div>
          <p className="font-medium">Checking whether this merges cleanly…</p>
          <p className="mt-0.5 text-muted">
            It and <span className="font-mono">{defaultBranch}</span> changed some of the same files, so g1t is merging
            the two in a sandbox to see.
          </p>
        </div>
      </div>
    );
  }
  if (mergeable === "clean") {
    return (
      <div className="flex gap-3 px-4 py-3 text-sm">
        <CircleCheck size={16} className="mt-0.5 shrink-0 text-accent" />
        <p className="font-medium">
          This branch has no conflicts with <span className="font-mono">{defaultBranch}</span>
        </p>
      </div>
    );
  }
  return null;
}

/**
 * A catch-up handed to a sandbox, while it lasts: who is doing what, the
 * run's live step, and how long it has taken. It ends with the pull request
 * up to date (and this disappears), or with a plain failure and a way to
 * try again. It never spins on with no end.
 */
export function CatchUpProgress({
  owner,
  repo,
  number,
  defaultBranch,
  behind,
  update,
  startedAt,
  retrying,
  runs: initial,
}: {
  owner: string;
  repo: string;
  number: number;
  defaultBranch: string;
  behind: boolean;
  update: Extract<PullBranchUpdate, { outcome: "needs_agent" }>;
  /** When it was asked for, in ms since the epoch. */
  startedAt: number;
  /** Whether a retry is on its way. */
  retrying: boolean;
  /** The pull request's latest runs, from the page's loader. */
  runs?: Live | null;
}) {
  // The page revalidates while this is working, which reloads the runs too.
  const data = useRuns(owner, repo, { number: String(number), limit: "5" }, initial);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const run = catchUpRun(data?.runs ?? [], startedAt);
  const phase = catchUpPhase({ behind, run, startedAt, now });
  if (phase === "done") return null;
  const session = `/${owner}/${repo}/sessions/${number}`;
  if (phase !== "working") {
    return (
      <div className="flex gap-3 px-4 py-3 text-sm">
        <TriangleAlert size={16} className={`mt-0.5 shrink-0 ${phase === "failed" ? "text-danger" : "text-warn"}`} />
        <div className="min-w-0">
          <p className="font-medium">
            {phase === "failed"
              ? `Catching up with ${defaultBranch} failed`
              : `Catching up with ${defaultBranch} is taking longer than it should`}
          </p>
          <p className="mt-0.5 text-muted">
            {phase === "failed"
              ? `${run?.error ? `${run.error} ` : ""}Nothing was pushed, so the pull request is as it was.`
              : "It usually takes about a minute. It may still finish; this page updates if it does."}{" "}
            <Link to={session} className="text-fg hover:underline">
              See the session
            </Link>
            .
          </p>
          <Form method="post" className="mt-2">
            <input type="hidden" name="action" value="update" />
            <Button variant="quiet" type="submit" disabled={retrying}>
              {retrying ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCw size={14} />}
              {retrying ? "Trying again…" : "Try again"}
            </Button>
          </Form>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3 px-4 py-3 text-sm">
      <LoaderCircle size={16} className="mt-0.5 shrink-0 animate-spin text-merged" />
      <div className="min-w-0 grow">
        <p className="font-medium">{catchUpTitle(update.reason, defaultBranch)}</p>
        <p className="mt-0.5 text-muted">
          {catchUpWhy(update, defaultBranch)} This usually takes about a minute; the pull request updates here when it
          is pushed.
        </p>
        {update.paths.length > 0 && (
          <Hint label={update.paths.join(", ")}>
            <p className="mt-1 truncate font-mono text-xs text-faint">
              {update.paths.slice(0, 5).join(", ")}
              {update.paths.length > 5 && ` and ${update.paths.length - 5} more`}
            </p>
          </Hint>
        )}
        <Hint label={run?.step}>
          <p className="mt-2 truncate rounded-lg bg-bg px-3 py-2 font-mono text-xs text-fg/85 ring-1 ring-line">
            <span className="mr-2 inline-block size-1.5 animate-pulse rounded-full bg-merged align-middle" />
            {run?.step ?? (run ? "Starting a sandbox…" : "Waiting for a sandbox…")}
          </p>
        </Hint>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-muted">
          <Elapsed from={new Date(startedAt).toISOString()} />
          <Link to={session} className="hover:text-fg">
            Watch the session
          </Link>
        </p>
      </div>
    </div>
  );
}
