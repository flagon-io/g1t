import {
  Check,
  CircleDashed,
  GitCommitHorizontal,
  GitMerge,
  Layers,
  Loader2,
  Minus,
  X,
} from "lucide-react";
import { Link } from "react-router";

import type { QueueEntry, QueueState } from "@g1t/contracts";

import type { Route } from "./+types/queue";
import { page } from "../../lib/meta";
import { Avatar, ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { work } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";
import { accessFor, repoFor } from "../../lib/access.server";
import { useRefreshWhile } from "../../lib/refresh";


export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Merge queue · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const [queue, repo] = await Promise.all([work.queue(path, viewer), repoFor(context, params)]);
  return {
    queue: unwrap(queue),
    defaultBranch: unwrap(repo).defaultBranch,
    // Turning the queue on is a setting: Maintain and up.
    member: repo.ok && accessFor(viewer, repo.value).can.manage_settings,
  };
}

const STATE: Record<QueueState, { label: string; tone: string; icon: React.ReactNode }> = {
  waiting: { label: "Waiting", tone: "text-muted border-line", icon: <CircleDashed size={13} /> },
  testing: {
    label: "Testing",
    tone: "text-accent border-accent/40 bg-accent/10",
    icon: <Loader2 size={13} className="animate-spin" />,
  },
  passed: { label: "Passed", tone: "text-accent border-accent/40 bg-accent/10", icon: <Check size={13} /> },
  failed: { label: "Failed", tone: "text-danger border-danger/40 bg-danger/10", icon: <X size={13} /> },
  landed: { label: "Landed", tone: "text-merged border-merged/40 bg-merged/10", icon: <GitMerge size={13} /> },
  removed: { label: "Removed", tone: "text-faint border-line", icon: <Minus size={13} /> },
};

function StateBadge({ state }: { state: QueueState }) {
  const { label, tone, icon } = STATE[state];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${tone}`}>
      {icon}
      {label}
    </span>
  );
}

/** `main + #12 + #14`: the state an entry is being tested in. */
function TestedAs({ entry, branch }: { entry: QueueEntry; branch: string }) {
  return (
    <span className="flex flex-wrap items-center gap-1 font-mono text-xs text-muted">
      <span className="rounded border border-line px-1.5 py-px">{branch}</span>
      {[...entry.ahead, entry.number].map((number) => (
        <span key={number} className="flex items-center gap-1">
          <span className="text-faint">+</span>
          <span
            className={`rounded border px-1.5 py-px ${
              number === entry.number ? "border-accent/40 text-fg" : "border-line"
            }`}
          >
            #{number}
          </span>
        </span>
      ))}
    </span>
  );
}

function Entry({ entry, base, branch, position }: { entry: QueueEntry; base: string; branch: string; position?: number }) {
  const ran = entry.results.length;
  const passed = entry.results.filter((result) => result.passed).length;
  return (
    <li className="relative pl-10">
      {/* Its place on the rail. */}
      <span
        className={`absolute top-4 left-[13px] size-3 rounded-full border-2 ${
          entry.state === "testing"
            ? "animate-pulse border-accent bg-accent/30"
            : entry.state === "passed" || entry.state === "landed"
              ? "border-accent bg-accent"
              : entry.state === "failed"
                ? "border-danger bg-danger"
                : "border-line-strong bg-bg"
        }`}
      />
      <div className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {position != null && <span className="font-mono text-xs text-faint">{position}</span>}
          <Link to={`${base}/pull/${entry.number}`} prefetch="intent" className="min-w-0 grow font-medium hover:text-accent">
            {entry.title} <span className="font-normal text-faint">#{entry.number}</span>
          </Link>
          <StateBadge state={entry.state} />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          {(entry.state === "testing" || entry.state === "passed" || entry.state === "failed") && (
            <TestedAs entry={entry} branch={branch} />
          )}
          {ran > 0 && (
            <span className={passed === ran ? "text-accent" : "text-danger"}>
              {passed}/{ran} checks passed
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <Avatar name={entry.agent} size={14} />
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
                <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-bg p-3 text-xs text-muted"><code>{result.output}</code></pre>
              </details>
            ))}
      </div>
    </li>
  );
}

export default function Queue({ loaderData, params }: Route.ComponentProps) {
  const { queue, defaultBranch, member } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const moving = queue.active.length > 0;
  useRefreshWhile(moving);

  const testing = queue.active.filter((entry) => entry.state !== "waiting").length;
  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Layers size={19} className="text-accent" />
            Merge queue
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Each pull request is tested together with everything ahead of it, several
            combinations at once, and {defaultBranch} only ever moves to a combination that
            passed. One that fails goes back to its author; the ones behind it are tested
            again without it.
          </p>
        </div>
        {member && (
          <ButtonLink to={`${base}/settings`}>{queue.enabled ? "Settings" : "Turn it on"}</ButtonLink>
        )}
      </div>

      {!queue.enabled && queue.active.length === 0 && queue.recent.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="This repository merges directly">
            Turn on <b>Merge through a queue</b> in the repository's settings, and merging a
            pull request adds it here instead of changing {defaultBranch} at once.
          </EmptyState>
        </div>
      ) : (
        <>
          <section className="mt-8">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-medium">In the queue</h3>
              <span className="text-xs text-muted">
                {queue.active.length} waiting to land{testing > 0 && `, ${testing} being tested now`}
              </span>
            </div>
            <ol className="relative mt-3 space-y-3 before:absolute before:top-0 before:bottom-4 before:left-[18px] before:w-px before:bg-line">
              <li className="relative flex items-center gap-2 pl-10 text-xs text-muted">
                <span className="absolute left-[11px] flex size-4 items-center justify-center rounded-full bg-raised ring-1 ring-line-strong">
                  <GitCommitHorizontal size={10} />
                </span>
                <span className="font-mono text-fg">{defaultBranch}</span>
                {queue.active[0]?.baseCommit && (
                  <span className="font-mono">at {queue.active[0].baseCommit.slice(0, 7)}</span>
                )}
              </li>
              {queue.active.map((entry, index) => (
                <Entry key={entry.id} entry={entry} base={base} branch={defaultBranch} position={index + 1} />
              ))}
              {queue.active.length === 0 && (
                <li className="pl-10 text-sm text-muted">Nothing is waiting. Merged pull requests appear here.</li>
              )}
            </ol>
          </section>

          {queue.recent.length > 0 && (
            <section className="mt-10">
              <h3 className="text-sm font-medium">Recently</h3>
              <ol className="mt-3 space-y-3">
                {queue.recent.map((entry) => (
                  <Entry key={entry.id} entry={entry} base={base} branch={defaultBranch} />
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </div>
  );
}
