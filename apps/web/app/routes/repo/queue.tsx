import { Layers } from "lucide-react";
import { Link } from "react-router";

import type { QueueEntry, RepoPath, Viewer } from "@g1t/contracts";

import type { Route } from "./+types/queue";
import { page } from "../../lib/meta";
import { ButtonLink, EmptyState } from "../../components/ui";
import { type GroupRun, QueueEntryCard, QueueTrain } from "../../components/merge-queue";
import { actions, work } from "../../lib/services.server";
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
  const view = unwrap(queue);
  return {
    queue: view,
    // The merge_group runs on each combined state, to link its checks to:
    // streamed, so the queue shows at once.
    groupRuns: mergeGroupRuns(path, viewer, [...view.active, ...view.recent]),
    defaultBranch: unwrap(repo).defaultBranch,
    // Turning the queue on is a setting: Maintain and up.
    member: repo.ok && accessFor(viewer, repo.value).can.manage_settings,
  };
}

/** The merge_group runs on each entry's combined state, by commit; empty where none could be read. */
function mergeGroupRuns(path: RepoPath, viewer: Viewer, entries: QueueEntry[]): Promise<Record<string, GroupRun[]>> {
  const commits = [...new Set(entries.map((entry) => entry.combinedCommit).filter((sha) => sha != null))].slice(0, 20);
  return Promise.all(
    commits.map((sha) =>
      actions
        .runs(path, viewer, { sha, event: "merge_group", limit: 10 })
        .then((found) => [sha, found.ok ? found.value.map((run) => ({ id: run.id, name: run.name })) : []] as const)
        .catch(() => [sha, []] as const),
    ),
  ).then((found) => Object.fromEntries(found));
}

export default function Queue({ loaderData, params }: Route.ComponentProps) {
  const { queue, defaultBranch, member, groupRuns } = loaderData;
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
          <ButtonLink to={`${base}/settings/rules`}>{queue.enabled ? "Settings" : "Turn it on"}</ButtonLink>
        )}
      </div>

      {!queue.enabled && queue.active.length === 0 && queue.recent.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="This repository merges directly">
            Add the rule <b>Require the merge queue</b> for {defaultBranch} under{" "}
            {member ? (
              <Link to={`${base}/settings/rules`} className="text-fg underline underline-offset-2">
                Settings → Rules
              </Link>
            ) : (
              "Settings → Rules"
            )}
            , and merging a pull request adds it here instead of changing {defaultBranch} at once.
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
            <div className="mt-3">
              <QueueTrain active={queue.active} base={base} branch={defaultBranch} groupRuns={groupRuns} />
            </div>
          </section>

          {queue.recent.length > 0 && (
            <section className="mt-10">
              <h3 className="text-sm font-medium">Recently</h3>
              <ol className="mt-3 space-y-3">
                {queue.recent.map((entry) => (
                  <QueueEntryCard key={entry.id} entry={entry} base={base} branch={defaultBranch} groupRuns={groupRuns} />
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </div>
  );
}
