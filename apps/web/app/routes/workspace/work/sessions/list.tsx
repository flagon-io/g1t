import { Activity, GitMerge, History, Layers, Radio } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { type EventType, MAX_LIST_REPOS, type RepoPull } from "@g1t/contracts";

import type { Route } from "./+types/list";
import { Unavailable } from "../../../../components/boundary";
import { CoordinationFeed } from "../../../../components/coordination";
import { QueueTrain } from "../../../../components/merge-queue";
import { SessionCard, SessionRow, SessionsFiltersBar, SessionsViews } from "../../../../components/sessions";
import { EmptyState, TimeAgo } from "../../../../components/ui";
import { Avatar } from "../../../../components/ui/avatar";
import { Card } from "../../../../components/ui/card";
import { PullIcon } from "../../../../components/work-icons";
import { COORDINATION_TYPES, feedLine } from "../../../../lib/coordination";
import { page } from "../../../../lib/meta";
import { isFailed, part } from "../../../../lib/partial";
import { useRefreshWhile } from "../../../../lib/refresh";
import { repoPages, workPages } from "../../../../lib/repo-live";
import { events, work } from "../../../../lib/services.server";
import { getViewer, unwrap } from "../../../../lib/session.server";
import { narrowed, peopleIn, repoName, sessionsFilters, splitLive } from "../../../../lib/sessions";
import { useLive } from "../../../../lib/use-repo-live";
import { itemPath, sessionsPath } from "../../../../lib/work-items";

/** How many coordination events What happened shows. */
const FEED = 30;
/** How many ended sessions Recent shows under Live now. */
const RECENT = 20;

export function meta({ params, location, ...args }: Route.MetaArgs) {
  const repo = new URLSearchParams(location.search).get("repo");
  return page({ location, ...args }, { title: `Sessions${repo ? ` · ${repo}` : ""} · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const filters = sessionsFilters(new URL(request.url).searchParams);
  const narrow = {
    repo: filters.repo ?? undefined,
    person: filters.person ?? undefined,
    harness: filters.harness ?? undefined,
    kind: filters.kind ?? undefined,
    item: filters.item ?? undefined,
  };
  const every = filters.state === "recent";
  // What is going now is what the page is about; what ended, a part of its own.
  const [now, ended] = await Promise.all([
    work.listWorkspaceSessions(workspace, viewer, { ...narrow, shown: every ? "recent" : "live", limit: every ? 120 : 60 }),
    every ? null : part(work.listWorkspaceSessions(workspace, viewer, { ...narrow, shown: "ended", sessionsOnly: true, limit: RECENT }), "Recent sessions"),
  ]);
  const found = unwrap(now);
  const paths = new Map(found.repos.map((repo) => [repo.id, repo.path]));
  // What happened, across the repositories looked in (the one asked for, or every one the viewer may read).
  const recent = await part(
    events.list({ repoIds: found.repos.slice(0, MAX_LIST_REPOS).map((repo) => repo.id), types: [...COORDINATION_TYPES] as EventType[], limit: FEED }),
    "What happened",
  );
  const feed = isFailed(recent)
    ? recent
    : recent.flatMap((event) => {
        const line = feedLine(event);
        if (!line) return [];
        const repo = event.repoId ? paths.get(event.repoId) : undefined;
        return [repo ? { ...line, repo } : line];
      });
  return {
    workspace,
    filters,
    signedIn: viewer != null,
    me: viewer?.username ?? null,
    sessions: found.sessions,
    queue: found.queue,
    landed: found.landed,
    repos: found.repos,
    ended: ended == null ? null : isFailed(ended) ? ended : ended.ok ? ended.value.sessions : [],
    feed,
  };
}

function Section({ icon, title, aside, children, id }: { icon: ReactNode; title: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-9 first:mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </h2>
        {aside && <span className="text-xs text-muted">{aside}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function LandedRow({ pull, workspace }: { pull: RepoPull; workspace: string }) {
  const base = `/${pull.repo}`;
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <span className="mt-0.5">
        <PullIcon status={pull.status} />
      </span>
      <span className="flex min-w-0 grow flex-wrap items-center gap-x-3 gap-y-1">
        <Link to={`${base}/pull/${pull.number}`} prefetch="intent" className="min-w-0 grow font-medium wrap-break-word hover:text-accent">
          {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
        </Link>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <Link to={base} className="font-mono hover:text-fg">
            {repoName(pull.repo, workspace)}
          </Link>
          {pull.item != null && (
            <Link to={itemPath(workspace, pull.item)} className="hover:text-fg">
              for #{pull.item}
            </Link>
          )}
          <Link to={`${base}/pull/${pull.number}/session`} className="hover:text-fg">
            Why
          </Link>
          {pull.mergedBy && (
            <span className="flex items-center gap-1.5">
              <Avatar name={pull.mergedBy} size={14} />
              {pull.mergedBy}
            </span>
          )}
          {pull.mergedAt && <TimeAgo at={pull.mergedAt} />}
        </span>
      </span>
    </li>
  );
}

/**
 * Sessions: what is cooking across the workspace, in every repository of
 * it the viewer may read. Live now first (people's harnesses and their
 * subagents, sessions started on g1t, g1t's agent, what is being recorded
 * on pull requests), then the merge queues, what just landed, what
 * happened and what ended.
 */
export default function SessionsPage({ loaderData }: Route.ComponentProps) {
  const { workspace, filters, sessions, queue, landed, repos, ended, feed, signedIn, me } = loaderData;
  const every = filters.state === "recent";
  const { active, idle } = splitLive(sessions);
  const going = active.length + idle.length;
  const waiting = queue.reduce((sum, one) => sum + one.active.length, 0);
  const repoNames = repos.map((repo) => repoName(repo.path, workspace)).sort();
  const people = peopleIn([...sessions, ...(ended && !isFailed(ended) ? ended : [])]);
  // Sessions, claims, overlaps, integration results and merges in any of its repositories, and its work items.
  useLive({
    match: repoPages.work(),
    repos: repos.map((repo) => ({ id: repo.id, path: repo.path })),
    signedIn,
    workspace: { slug: workspace, match: workPages.list() },
  });
  // Sessions go idle and time out with no event to say so.
  useRefreshWhile(going > 0 || waiting > 0, 15_000);

  return (
    <div className="max-w-5xl">
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <Activity size={19} className="text-accent" />
        Sessions
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">
        What is cooking across {workspace}: everyone's harness sessions and their subagents, sessions started on g1t, g1t's own agent,
        the merge queues combining their changes, and what landed.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SessionsViews workspace={workspace} filters={filters} />
        <SessionsFiltersBar workspace={workspace} filters={filters} repos={repoNames} people={people} me={me} />
      </div>

      {every ? (
        <Section icon={<History size={15} className="text-accent" />} title="Every session" aside={`${sessions.length} most recently heard from`}>
          {sessions.length === 0 ? (
            <EmptyState title={narrowed(filters) ? "No sessions match these filters" : "No sessions yet"}>
              Sessions start when someone works with g1t's plugin in their harness, starts one on a work item, or an agent records its work on a pull request.
            </EmptyState>
          ) : (
            <Card asChild divided>
              <ol>
                {sessions.map((session) => (
                  <SessionRow key={session.id} session={session} workspace={workspace} />
                ))}
              </ol>
            </Card>
          )}
        </Section>
      ) : (
        <Section
          icon={<Radio size={15} className={going > 0 ? "text-success" : "text-faint"} />}
          title="Live now"
          aside={going > 0 ? `${active.length} going${idle.length > 0 ? `, ${idle.length} idle` : ""}` : undefined}
        >
          {going === 0 ? (
            <EmptyState title={narrowed(filters) ? "Nothing matching is running right now" : "Nothing is running right now"}>
              Sessions show here as they go: Claude Code, Codex or Cursor with g1t's plugin, sessions started on a work item, and g1t's own agent.
              {narrowed(filters) && (
                <>
                  {" "}
                  <Link to={sessionsPath(workspace)} className="text-fg underline underline-offset-4">
                    Clear the filters
                  </Link>
                  .
                </>
              )}
            </EmptyState>
          ) : (
            <ol className="grid gap-3 md:grid-cols-2">
              {[...active, ...idle].map((session) => (
                <SessionCard key={session.id} session={session} workspace={workspace} />
              ))}
            </ol>
          )}
        </Section>
      )}

      {queue.length > 0 && (
        <Section id="merge-queue" icon={<Layers size={15} className="text-accent" />} title="Merge queue" aside={`${waiting} waiting to land`}>
          <div className="space-y-4">
            {queue.map((one) => (
              <div key={one.repo}>
                <p className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
                  <Link to={`/${one.repo}`} className="font-mono hover:text-fg">
                    {repoName(one.repo, workspace)}
                  </Link>
                  <Link to={`/${one.repo}/queue`} className="hover:text-fg">
                    The whole queue
                  </Link>
                </p>
                <QueueTrain active={one.active} base={`/${one.repo}`} branch={one.defaultBranch} empty="Nothing is waiting to land." />
              </div>
            ))}
          </div>
        </Section>
      )}

      {!every && (
        <Section icon={<GitMerge size={15} className="text-merged" />} title="Just landed">
          {landed.length === 0 ? (
            <EmptyState title="Nothing merged yet">Merged pull requests show here, each with the session behind it.</EmptyState>
          ) : (
            <Card asChild divided>
              <ol>
                {landed.map((pull) => (
                  <LandedRow key={pull.id} pull={pull} workspace={workspace} />
                ))}
              </ol>
            </Card>
          )}
        </Section>
      )}

      {!every && (
        <Section icon={<History size={15} className="text-accent" />} title="What happened">
          {isFailed(feed) ? (
            <Unavailable what={feed.what} />
          ) : feed.length === 0 ? (
            <EmptyState title="Nothing yet">
              Claims, sessions, overlapping changes, dependencies and what the merge queue finds when it combines changes are listed here as they happen.
            </EmptyState>
          ) : (
            <CoordinationFeed lines={feed} base={`/${workspace}/-/work`} />
          )}
        </Section>
      )}

      {ended != null && (
        <Section
          icon={<History size={15} className="text-faint" />}
          title="Recent"
          aside={
            <Link to={sessionsPath(workspace, { state: "recent", repo: filters.repo, person: filters.person, harness: filters.harness, kind: filters.kind, item: filters.item ? String(filters.item) : null })} className="hover:text-fg">
              Every session
            </Link>
          }
        >
          {isFailed(ended) ? (
            <Unavailable what={ended.what} />
          ) : ended.length === 0 ? (
            <EmptyState title="Nothing ended yet">Sessions that ended show here, newest first.</EmptyState>
          ) : (
            <Card asChild divided>
              <ol>
                {ended.map((session) => (
                  <SessionRow key={session.id} session={session} workspace={workspace} />
                ))}
              </ol>
            </Card>
          )}
        </Section>
      )}
    </div>
  );
}
