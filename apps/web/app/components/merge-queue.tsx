/**
 * The merge queue as a train: the default branch, then each entry in
 * order with the combination it is tested as and how its checks stand.
 * The Merge queue page shows it whole; the Work page shows what is moving.
 */
import { Check, CircleDashed, GitCommitHorizontal, GitMerge, Loader2, Minus, X } from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { Await, Link } from "react-router";

import type { QueueEntry, QueueState } from "@g1t/contracts";

import { TimeAgo } from "./ui";
import { Avatar } from "./ui/avatar";
import { Badge, type BadgeTone } from "./ui/badge";
import { Card } from "./ui/card";

/** A merge_group workflow run on a combined state. */
export type GroupRun = { id: string; name: string };

const STATE: Record<QueueState, { label: string; tone: BadgeTone; icon: ReactNode }> = {
  waiting: { label: "Waiting", tone: "neutral", icon: <CircleDashed size={13} /> },
  testing: { label: "Testing", tone: "accent", icon: <Loader2 size={13} className="animate-spin" /> },
  passed: { label: "Passed", tone: "success", icon: <Check size={13} /> },
  failed: { label: "Failed", tone: "danger", icon: <X size={13} /> },
  landed: { label: "Landed", tone: "merged", icon: <GitMerge size={13} /> },
  removed: { label: "Removed", tone: "neutral", icon: <Minus size={13} /> },
};

export function QueueStateBadge({ state }: { state: QueueState }) {
  const { label, tone, icon } = STATE[state];
  return (
    <Badge tone={tone} size="md" className="gap-1.5">
      {icon}
      {label}
    </Badge>
  );
}

/** `main + #12 + #14`: the state an entry is being tested in. */
export function TestedAs({ entry, branch }: { entry: QueueEntry; branch: string }) {
  return (
    <span className="flex flex-wrap items-center gap-1 font-mono text-xs text-muted">
      <Badge shape="tag">{branch}</Badge>
      {[...entry.ahead, entry.number].map((number) => (
        <span key={number} className="flex items-center gap-1">
          <span className="text-faint">+</span>
          <Badge shape="tag" tone={number === entry.number ? "accent" : "neutral"}>
            #{number}
          </Badge>
        </span>
      ))}
    </span>
  );
}

/**
 * How an entry's checks went, linked to the merge_group run on its combined
 * state; with several runs, each is named and linked after the count.
 */
function GroupChecks({ entry, base, runs }: { entry: QueueEntry; base: string; runs: GroupRun[] }) {
  const ran = entry.results.length;
  const passed = entry.results.filter((result) => result.passed).length;
  const [first, ...more] = runs;
  const tone = passed === ran ? "text-success" : "text-danger";
  const count = ran > 0 ? `${passed}/${ran} checks passed` : first ? "merge_group run" : null;
  if (!count) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {first ? (
        <Link to={`${base}/actions/runs/${first.id}`} className={`underline-offset-2 hover:underline ${ran > 0 ? tone : "text-muted"}`}>
          {count}
          {more.length > 0 && ` · ${first.name}`}
        </Link>
      ) : (
        <span className={tone}>{count}</span>
      )}
      {more.map((run) => (
        <Link key={run.id} to={`${base}/actions/runs/${run.id}`} className="text-muted underline-offset-2 hover:text-fg hover:underline">
          {run.name}
        </Link>
      ))}
    </span>
  );
}

const NO_RUNS: Promise<Record<string, GroupRun[]>> = Promise.resolve({});

/** Where an entry sits on the train's rail. */
const STOP: Record<QueueState, string> = {
  waiting: "border-line-strong bg-bg",
  testing: "animate-pulse border-accent bg-accent/30",
  passed: "border-success bg-success",
  landed: "border-success bg-success",
  failed: "border-danger bg-danger",
  removed: "border-line-strong bg-bg",
};

export function QueueEntryCard({
  entry,
  base,
  branch,
  position,
  groupRuns = NO_RUNS,
}: {
  entry: QueueEntry;
  base: string;
  branch: string;
  position?: number;
  /** The merge_group runs on each combined state, by commit. */
  groupRuns?: Promise<Record<string, GroupRun[]>>;
}) {
  const runsOf = (found: Record<string, GroupRun[]>) => (entry.combinedCommit ? (found[entry.combinedCommit] ?? []) : []);
  return (
    <li className="relative pl-10">
      <span className={`absolute top-4 left-3.25 size-3 rounded-full border-2 ${STOP[entry.state]}`} />
      <Card className="p-4 transition-colors hover:border-line-strong">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {position != null && <span className="font-mono text-xs text-faint">{position}</span>}
          <Link to={`${base}/pull/${entry.number}`} prefetch="intent" className="min-w-0 grow font-medium hover:text-accent">
            {entry.title} <span className="font-normal text-faint">#{entry.number}</span>
          </Link>
          <QueueStateBadge state={entry.state} />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          {(entry.state === "testing" || entry.state === "passed" || entry.state === "failed") && <TestedAs entry={entry} branch={branch} />}
          <Suspense fallback={<GroupChecks entry={entry} base={base} runs={[]} />}>
            <Await resolve={groupRuns} errorElement={<GroupChecks entry={entry} base={base} runs={[]} />}>
              {(found) => <GroupChecks entry={entry} base={base} runs={runsOf(found)} />}
            </Await>
          </Suspense>
          <span className="flex items-center gap-1.5">
            <Avatar name={entry.agent} image={null} size={14} />
            {entry.agent}
          </span>
          <span>
            queued by {entry.enqueuedBy} <TimeAgo at={entry.createdAt} />
          </span>
          {entry.combinedCommit && (
            <span className="flex items-center gap-1 font-mono">
              <GitCommitHorizontal size={12} />
              {entry.combinedCommit.slice(0, 7)}
            </span>
          )}
        </div>
        {entry.error && <p className="mt-2.5 text-xs text-danger">{entry.error}</p>}
        {entry.state === "failed" &&
          entry.results
            .filter((result) => !result.passed)
            .slice(0, 2)
            .map((result) => (
              <details key={result.command} className="mt-2">
                <summary className="cursor-pointer font-mono text-xs text-danger">{result.command}</summary>
                <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-bg p-3 text-xs text-muted">
                  <code>{result.output}</code>
                </pre>
              </details>
            ))}
      </Card>
    </li>
  );
}

/** The train: the default branch at the commit the front is built on, then each entry in order. */
export function QueueTrain({
  active,
  base,
  branch,
  groupRuns,
  empty = "Nothing is waiting. Merged pull requests appear here.",
}: {
  active: QueueEntry[];
  base: string;
  branch: string;
  groupRuns?: Promise<Record<string, GroupRun[]>>;
  empty?: ReactNode;
}) {
  return (
    <ol className="relative space-y-3 before:absolute before:top-0 before:bottom-4 before:left-4.5 before:w-px before:bg-line">
      <li className="relative flex items-center gap-2 pl-10 text-xs text-muted">
        <span className="absolute left-2.75 flex size-4 items-center justify-center rounded-full bg-raised ring-1 ring-line-strong">
          <GitCommitHorizontal size={10} />
        </span>
        <span className="font-mono text-fg">{branch}</span>
        {active[0]?.baseCommit && <span className="font-mono">at {active[0].baseCommit.slice(0, 7)}</span>}
      </li>
      {active.map((entry, index) => (
        <QueueEntryCard key={entry.id} entry={entry} base={base} branch={branch} position={index + 1} groupRuns={groupRuns} />
      ))}
      {active.length === 0 && <li className="pl-10 text-sm text-muted">{empty}</li>}
    </ol>
  );
}
