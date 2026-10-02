import { ChevronRight, CircleCheck, CircleX, LoaderCircle, RotateCw, TriangleAlert } from "lucide-react";
import { Form } from "react-router";

import type { CheckRun, CheckStatus } from "@g1t/contracts";

const LABELS: Record<CheckStatus, string> = {
  queued: "Checks queued",
  running: "Checks running",
  passed: "Checks passed",
  failed: "Checks failed",
  errored: "Checks could not run",
};

export function CheckIcon({ status, size = 15 }: { status: CheckStatus; size?: number }) {
  if (status === "passed") return <CircleCheck size={size} className="shrink-0 text-accent" />;
  if (status === "failed") return <CircleX size={size} className="shrink-0 text-danger" />;
  if (status === "errored") return <TriangleAlert size={size} className="shrink-0 text-muted" />;
  return <LoaderCircle size={size} className="shrink-0 animate-spin text-info" />;
}

/** The state of a pull request's checks at a glance, for lists. */
export function CheckBadge({ status }: { status: CheckStatus | null }) {
  if (!status) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted" title={LABELS[status]}>
      <CheckIcon status={status} size={13} />
      <span className="sr-only">{LABELS[status]}</span>
    </span>
  );
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** The latest run of the acceptance checks: each command and what it printed. */
export function ChecksPanel({
  run,
  commands,
  canRerun,
}: {
  run: CheckRun | null;
  /** The issue's checks, shown before any run exists. */
  commands: string[];
  canRerun: boolean;
}) {
  if (commands.length === 0 && !run) return null;
  const pending = run?.status === "queued" || run?.status === "running";
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        {run && <CheckIcon status={run.status} />}
        <h3 className="grow text-sm font-medium">
          {run ? LABELS[run.status] : "Acceptance checks"}
        </h3>
        {canRerun && !pending && (
          <Form method="post">
            <button
              type="submit"
              name="action"
              value="recheck"
              title="Run the checks again"
              className="rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-fg"
            >
              <RotateCw size={14} />
              <span className="sr-only">Run the checks again</span>
            </button>
          </Form>
        )}
      </div>
      {run ? (
        <p className="mt-1 text-xs text-muted">
          On <span className="font-mono">{run.headCommit.slice(0, 7)}</span>, in a clean
          sandbox.
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted">
          They run in a clean sandbox once the pull request is ready for review.
        </p>
      )}
      {run?.error && <p className="mt-2 text-xs text-muted">{run.error}</p>}
      <ul className="mt-3 space-y-1.5">
        {run && run.results.length > 0
          ? run.results.map((result) => (
              <li key={result.command}>
                <details className="group rounded-md border border-line bg-bg">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5">
                    <ChevronRight
                      size={13}
                      className="shrink-0 text-faint transition-transform group-open:rotate-90"
                    />
                    <span className="min-w-0 grow truncate font-mono text-xs">
                      {result.command}
                    </span>
                    <span className="shrink-0 text-[0.6875rem] text-faint">
                      {seconds(result.durationMs)}
                    </span>
                    {result.passed ? (
                      <CircleCheck size={14} className="shrink-0 text-accent" />
                    ) : (
                      <CircleX size={14} className="shrink-0 text-danger" />
                    )}
                  </summary>
                  <pre className="max-h-72 overflow-auto border-t border-line p-2.5 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-muted">
                    {result.output || "No output."}
                    {result.exitCode != null && result.exitCode !== 0 && `\n\nExit code ${result.exitCode}.`}
                  </pre>
                </details>
              </li>
            ))
          : commands.map((command) => (
              <li
                key={command}
                className="truncate rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-xs text-muted"
              >
                {command}
              </li>
            ))}
      </ul>
    </section>
  );
}
