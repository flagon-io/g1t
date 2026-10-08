import { CircleCheck, CircleX, LoaderCircle, TriangleAlert } from "lucide-react";

import type { CheckStatus } from "@g1t/contracts";

/**
 * What a pull request's own check status says. A pull request's checks are
 * the workflows run on it (see the merge box); this is set when the merge
 * queue took it out, and on older pull requests, by commands their issue
 * once had run.
 */
const LABELS: Record<CheckStatus, string> = {
  queued: "Checks queued",
  running: "Checks running",
  passed: "Checks passed",
  failed: "Failed in the merge queue",
  errored: "Checks could not run",
};

export function CheckIcon({ status, size = 15 }: { status: CheckStatus; size?: number }) {
  if (status === "passed") return <CircleCheck size={size} className="shrink-0 text-success" />;
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
