import { GitCommitHorizontal, MessageSquare } from "lucide-react";
import { Suspense } from "react";
import { Await, Link } from "react-router";

import type { ShownCommit } from "../../lib/commit-people";
import { parseCommitMessage } from "../../lib/commit-message";

import type { Route } from "./+types/commits";
import { page } from "../../lib/meta";
import { CommitChecksBadge } from "../../components/commit-checks";
import { CommitText } from "../../components/commit-message";
import { CommitAvatars, CommitNames } from "../../components/commit-person";
import { NewItemsBar } from "../../components/repo-live";
import { EmptyState, TimeAgo } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { commitChecksFor } from "../../lib/commit-checks.server";
import { showCommits } from "../../lib/commit-people.server";
import { repos, work } from "../../lib/services.server";
import { countByCommit } from "../../lib/commit-comments";
import { Hint } from "../../components/ui/hint";
import { isPushTo, newCommits, repoPages } from "../../lib/repo-live";
import { useRepoLive } from "../../lib/use-repo-live";
import { getViewer, unwrap } from "../../lib/session.server";
import { useProject } from "./layout";
import { Unavailable } from "../../components/boundary";
import { isFailed, part } from "../../lib/partial";

const PAGE_SIZE = 50;

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Commits · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const viewer = getViewer(context);
  const log = unwrap(await repos.log(path, viewer, null, PAGE_SIZE));
  // Every commit's checks in one call, streamed in beside each.
  const checks = commitChecksFor(
    path,
    viewer,
    log.map((commit) => commit.hash),
  );
  // Who wrote each commit, as their account where there is one.
  const commits = await showCommits(log);
  // How many comments each has, from the repository's latest: streamed, and
  // a part, so counts that could not be read are not shown as none.
  const comments = part(
    work.commitComments(viewer, path, null).then((found): Record<string, number> => (found.ok ? countByCommit(found.value) : {})),
    "Comment counts",
  );
  return { commits, checks, comments };
}

/** How many comments a commit has, linking to them; nothing when none. */
function CommentCount({ count, to }: { count: number; to: string }) {
  if (count === 0) return null;
  const label = `${count} ${count === 1 ? "comment" : "comments"}`;
  return (
    <Hint label={label}>
      <Link to={to} aria-label={label} className="relative z-10 flex shrink-0 items-center gap-1 rounded px-1 text-xs text-faint tabular-nums hover:text-fg">
        <MessageSquare size={13} />
        {count}
      </Link>
    </Hint>
  );
}

/** Commits by the day they were made, newest first. */
function byDay(commits: ShownCommit[]): [string, ShownCommit[]][] {
  const days = new Map<string, ShownCommit[]>();
  for (const commit of commits) {
    const day = commit.authoredAt.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), commit]);
  }
  return [...days];
}

function dayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function Commits({ loaderData, params }: Route.ComponentProps) {
  const { commits, checks, comments } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  // Live: new commits on the branch wait under "N new commits" rather than
  // moving the list under the reader; checks on the shown ones update.
  const branch = useProject()?.repo.defaultBranch ?? null;
  const pushed = (change: Parameters<typeof isPushTo>[0]) => change.kind === "git.push" && isPushTo(change, branch);
  const { held, show } = useRepoLive({
    match: repoPages.commits(
      branch,
      commits.map((commit) => commit.hash),
    ),
    hold: commits.length > 0 ? pushed : undefined,
  });
  if (commits.length === 0) {
    return <EmptyState title="No commits yet" />;
  }
  return (
    <>
      <NewItemsBar held={held.length > 0} count={newCommits(held, branch)} noun={["commit", "commits"]} onShow={show} />
      <Suspense fallback={null}>
        <Await resolve={comments}>
          {(counts) =>
            isFailed(counts) ? (
              <div className="mb-4">
                <Unavailable what={counts.what} compact />
              </div>
            ) : null
          }
        </Await>
      </Suspense>
      <div className="relative space-y-8 before:absolute before:top-3 before:bottom-3 before:left-1.75 before:w-px before:bg-line">
        {byDay(commits).map(([day, list]) => (
          <section key={day} className="relative pl-7">
            <h2 className="flex items-center gap-2 text-xs font-medium text-muted">
              <GitCommitHorizontal size={15} className="absolute left-0 bg-bg text-faint" />
              {dayLabel(day)}
            </h2>
            <Card asChild tone="plain" divided className="mt-3 overflow-hidden">
              <ol>
                {list.map((commit) => {
                  // The body's prose: trailers (co-authors and their addresses) are not shown.
                  const { subject, body: rest } = parseCommitMessage(commit.message);
                  const to = `${base}/commit/${commit.hash}`;
                  return (
                    <li key={commit.hash} className="group relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface">
                      <span className="mt-0.5 flex">
                        <CommitAvatars commit={commit} size={24} />
                      </span>
                      <div className="min-w-0 grow">
                        <div className="flex min-w-0 items-start gap-1.5 sm:items-center">
                          <span className="line-clamp-2 font-medium wrap-break-word sm:line-clamp-1">
                            <CommitText text={subject} base={base} to={to} linkClassName="after:absolute after:inset-0 group-hover:text-accent" />
                          </span>
                          <CommitChecksBadge checks={checks} sha={commit.hash} />
                          <Suspense fallback={null}>
                            <Await resolve={comments}>
                              {(counts) => (isFailed(counts) ? null : <CommentCount count={counts[commit.hash] ?? 0} to={`${to}#commit-comments`} />)}
                            </Await>
                          </Suspense>
                        </div>
                        {rest && (
                          <p className="mt-1 line-clamp-1 text-sm text-muted">
                            <CommitText text={rest} base={base} refClassName="text-fg-soft hover:text-accent hover:underline" />
                          </p>
                        )}
                        <p className="mt-1 text-xs text-faint">
                          <CommitNames commit={commit} className="text-muted hover:text-fg" /> committed <TimeAgo at={commit.authoredAt} />
                          {commit.parents.length > 1 && " · merge"}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-md border border-line px-2 py-0.5 font-mono text-xs text-muted group-hover:border-line-strong group-hover:text-fg">
                        {commit.hash.slice(0, 7)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </Card>
          </section>
        ))}
      </div>
    </>
  );
}
