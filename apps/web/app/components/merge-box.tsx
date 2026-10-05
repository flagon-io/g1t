/**
 * The parts of a pull request's merge box that say what stands between it
 * and a merge: every check, with what a failed one printed, and whether
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
import { useMemo, useState } from "react";
import { Form, Link } from "react-router";

import type { CheckResult, CheckRun, CommitStatus, Job, Mergeable, Pull } from "@g1t/contracts";

import { duration } from "./actions";
import { Button, CopyLine, ErrorText, TimeAgo } from "./ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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
      <button
        type="button"
        aria-label="Copy the output"
        title="Copy the output"
        className="absolute top-1.5 right-3 z-10 rounded-md border border-line bg-surface p-1.5 text-faint transition-colors hover:text-fg"
        onClick={() => {
          void navigator.clipboard.writeText(stripAnsi(body));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={13} className="text-accent" /> : <Copy size={13} />}
      </button>
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
  to,
}: {
  standing: Standing;
  name: React.ReactNode;
  detail?: React.ReactNode;
  time?: string;
  to?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2 text-sm">
      <StandingIcon standing={standing} />
      <span className="min-w-0 grow truncate">
        {name}
        {detail && <span className="text-muted"> — {detail}</span>}
      </span>
      {time && <span className="shrink-0 font-mono text-xs text-faint">{time}</span>}
      {to && (
        <Link to={to} className="shrink-0 text-xs text-muted hover:text-fg hover:underline">
          Details
        </Link>
      )}
    </div>
  );
}

/** An acceptance check: its command, and, open when it failed, what it printed. */
function AcceptanceCheck({ result }: { result: CheckResult }) {
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

/**
 * Every check on a pull request, at a glance and in detail: its issue's
 * acceptance checks, run in a clean sandbox, and the workflows run on its
 * head, job by job.
 */
export function ChecksSection({
  run,
  commands,
  statuses,
  jobs,
  pull,
  base,
  earlier,
  canRerun,
  canRerunWorkflows,
  error,
}: {
  run: CheckRun | null;
  /** The issue's acceptance checks, shown before a run has results. */
  commands: string[];
  statuses: CommitStatus[];
  /** Each workflow run's jobs, by run id, where they could be read. */
  jobs: Record<string, Job[]>;
  pull: Pull;
  /** The repository's path, `/<owner>/<repo>`. */
  base: string;
  earlier: CheckRun[];
  canRerun: boolean;
  canRerunWorkflows: boolean;
  error?: string | null;
}) {
  if (!run && statuses.length === 0) return null;

  // Every row, so they can be counted the same way they are shown.
  const acceptance: Standing[] = run
    ? run.results.length > 0
      ? run.results.map((result) => (result.passed ? "passed" : "failed"))
      : run.status === "queued" || run.status === "running"
        ? commands.map(() => (run.status === "running" ? "running" : "queued"))
        : run.status === "errored"
          ? ["failed"]
          : []
    : [];
  const workflow: Standing[] = statuses.flatMap((status) => {
    const id = runIdOf(status);
    const theirs = id ? jobs[id] : undefined;
    return theirs && theirs.length > 0 ? theirs.map(jobStanding) : [statusStanding(status)];
  });
  const all = [...acceptance, ...workflow];
  const failed = all.filter((standing) => standing === "failed").length;
  const pending = all.filter((standing) => standing === "running" || standing === "queued").length;
  const passed = all.filter((standing) => standing === "passed").length;
  const total = all.length;

  const headline =
    failed > 0
      ? `${failed} of ${total} ${total === 1 ? "check" : "checks"} failed`
      : pending > 0
        ? `${pending} of ${total} ${total === 1 ? "check is" : "checks are"} still running`
        : total > 0
          ? "All checks have passed"
          : "Checks";
  const sub = [
    failed > 0 && pending > 0 && `${pending} still running`,
    passed > 0 && `${passed} passed`,
    all.filter((standing) => standing === "skipped").length > 0 &&
      `${all.filter((standing) => standing === "skipped").length} skipped or cancelled`,
  ]
    .filter(Boolean)
    .join(", ");

  const pending_ = run?.status === "queued" || run?.status === "running";
  const commitPath = (sha: string) =>
    pull.fork ? `/${pull.fork.namespace}/${pull.fork.name}/commit/${sha}` : `${base}/commit/${sha}`;
  const older = run != null && pull.headCommit != null && run.headCommit !== pull.headCommit;
  const failedRuns = statuses.filter((status) => statusStanding(status) === "failed" && runIdOf(status));

  return (
    <div>
      <div className="flex items-start gap-3 px-4 py-3">
        <span className="mt-0.5 shrink-0">
          {failed > 0 ? (
            <CircleX size={16} className="text-danger" />
          ) : pending > 0 ? (
            <LoaderCircle size={16} className="animate-spin text-warn" />
          ) : (
            <CircleCheck size={16} className="text-accent" />
          )}
        </span>
        <div className="min-w-0 grow">
          <p className="text-sm font-medium">{headline}</p>
          {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {canRerun && run && !pending_ && (
            <Form method="post">
              <input type="hidden" name="action" value="recheck" />
              <Button variant="quiet" type="submit">
                <RotateCw size={13} />
                Re-run checks
              </Button>
            </Form>
          )}
          {canRerunWorkflows &&
            failedRuns.map((status) => (
              <Form method="post" key={status.context}>
                <input type="hidden" name="action" value="rerun-workflow" />
                <input type="hidden" name="run" value={runIdOf(status) ?? ""} />
                <Button variant="quiet" type="submit" title={`Re-run the failed jobs of ${status.context}`}>
                  <RotateCw size={13} />
                  Re-run failed jobs{failedRuns.length > 1 ? ` of ${status.context}` : ""}
                </Button>
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
        {run && (
          <section aria-label="Acceptance checks" className="py-1">
            <p className="flex flex-wrap items-center gap-x-1.5 px-4 pt-1.5 pb-1 text-xs text-faint">
              <span className="font-medium text-muted">Acceptance checks</span>
              <span>· in a clean sandbox, on</span>
              <Link to={commitPath(run.headCommit)} className="inline-flex items-center gap-1 font-mono hover:text-fg">
                <GitCommitHorizontal size={12} />
                {run.headCommit.slice(0, 7)}
              </Link>
              {run.finishedAt ? (
                <span>
                  · finished <TimeAgo at={run.finishedAt} />
                </span>
              ) : (
                <span>
                  · started <TimeAgo at={run.createdAt} />
                </span>
              )}
            </p>
            {older && (
              <p className="mx-4 my-1.5 flex items-start gap-2 rounded-md bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                These checks ran on an older commit. The latest push,{" "}
                <span className="font-mono">{pull.headCommit?.slice(0, 7)}</span>, has not been checked yet.
              </p>
            )}
            {run.status === "errored" && (
              <div className="mx-4 my-1.5 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-sm">
                <p className="flex items-center gap-2 font-medium text-danger">
                  <TriangleAlert size={14} />
                  The checks could not be run
                </p>
                {run.error && <p className="mt-1 text-muted">{run.error}</p>}
              </div>
            )}
            {run.status === "failed" && run.error && (
              <p className="mx-4 my-1.5 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted">{run.error}</p>
            )}
            {run.results.length > 0
              ? run.results.map((result, index) => <AcceptanceCheck key={`${result.command}-${index}`} result={result} />)
              : pending_ &&
                commands.map((command) => (
                  <CheckLine
                    key={command}
                    standing={run.status === "running" ? "running" : "queued"}
                    name={<code className="font-mono text-xs">{command}</code>}
                    detail={run.status === "running" ? "running" : "waiting for a sandbox"}
                  />
                ))}
          </section>
        )}

        {statuses.length > 0 && (
          <section aria-label="Workflows" className="py-1">
            <p className="px-4 pt-1.5 pb-1 text-xs font-medium text-muted">Workflows</p>
            {statuses.map((status) => {
              const id = runIdOf(status);
              const runPath = id ? `${base}/actions/runs/${id}` : undefined;
              const theirs = id ? jobs[id] : undefined;
              if (!theirs || theirs.length === 0) {
                return (
                  <CheckLine
                    key={status.context}
                    standing={statusStanding(status)}
                    name={status.context}
                    detail={status.description ?? undefined}
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

        {earlier.length > 0 && (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs text-muted hover:text-fg">
              <History size={13} />
              Earlier runs of the acceptance checks ({earlier.length})
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
                        : before.status}
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
export function commandLineSteps(pull: Pull, owner: string, repo: string, defaultBranch: string, files: string[]): string[] {
  const upstream = `https://g1t.sh/${owner}/${repo}.git`;
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
    `git clone https://g1t.sh/${fork.namespace}/${fork.name}.git && cd ${fork.name}`,
    `git pull --no-rebase ${upstream} ${defaultBranch}`,
    `${add} && git commit --no-edit`,
    `git push`,
  ];
}

/**
 * The branch conflicts with its target: which files, and three ways out —
 * the g1t agent, the browser (soon), or the command line.
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
  onResolve,
  error,
}: {
  conflicts: string[];
  pull: Pull;
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Where the pull request's changes are shown, to link each file. */
  changesUrl: string;
  /** Whether the viewer may have the g1t agent resolve them. */
  canResolve: boolean;
  resolving: boolean;
  onResolve: () => void;
  error?: string | null;
}) {
  const steps = commandLineSteps(pull, owner, repo, defaultBranch, conflicts);
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
              <Form method="post" onSubmit={onResolve}>
                <input type="hidden" name="action" value="update" />
                <Button variant="primary" type="submit" disabled={resolving}>
                  <Sparkles size={14} />
                  {resolving ? "The g1t agent is resolving them…" : "Resolve with g1t agent"}
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
                An editor for conflicts in the browser is coming. Until then, have the g1t agent resolve them, or use the
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
