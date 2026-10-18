import { Activity, GitMerge, History, Layers, Radio, ScrollText } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { EventType, Pull } from "@g1t/contracts";

import type { Route } from "./+types/sessions";
import { CoordinationFeed, type LivePull, LiveNowList, StartHere } from "../../components/coordination";
import { QueueTrain } from "../../components/merge-queue";
import { EmptyState, TimeAgo } from "../../components/ui";
import { Avatar } from "../../components/ui/avatar";
import { Card } from "../../components/ui/card";
import { PullIcon } from "../../components/work-icons";
import { requireRepo } from "../../lib/access.server";
import { COORDINATION_TYPES, awakeAndIdle, feedLine } from "../../lib/coordination";
import { page } from "../../lib/meta";
import { useRefreshWhile } from "../../lib/refresh";
import { repoPages } from "../../lib/repo-live";
import { agents, events, work } from "../../lib/services.server";
import { useRepoLive } from "../../lib/use-repo-live";
import { Unavailable } from "../../components/boundary";
import { type Failed, isFailed, part } from "../../lib/partial";
import { itemPath } from "../../lib/work-items";

/** How many coordination events the feed shows. */
const FEED = 30;
/** How many merged pull requests Just landed shows. */
const LANDED = 6;
/** How many sessions recorded on pull requests the page lists. */
const RECORDED = 10;

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Sessions · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { viewer, repo, access } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  const workspace = params.owner.toLowerCase();
  // One round: who is on what, the queue, what happened, what landed, and
  // what was recorded. Each section is a part of its own (lib/partial.ts):
  // one whose service fails says so in its place, and the others stay.
  const [claims, active, idle, queue, recent, open, closed, openPulls, recorded] = await Promise.all([
    part(work.listClaims(workspace, viewer, { repo: path }), "Who is working"),
    part(work.listWorkSessions(path, viewer, { state: "active" }), "Who is working"),
    part(work.listWorkSessions(path, viewer, { state: "idle" }), "Who is working"),
    part(work.queue(path, viewer), "The merge queue"),
    part(events.list({ repoId: repo.id, types: [...COORDINATION_TYPES] as EventType[], limit: FEED }), "What happened"),
    // The titles of the work items being worked on: only labels for Live
    // now's rows, which still name each by its number without them.
    work.listWorkItems(workspace, viewer, { state: "open", repo: path }).catch(() => null),
    part(work.listPulls(path, viewer, "closed"), "Just landed"),
    // The titles of the pull requests sessions with no work item are on; the same.
    work.listPulls(path, viewer, "open").catch(() => null),
    // What coding agents recorded on its pull requests with record_session.
    part(agents.listSessions(viewer, path, {}), "Recorded sessions"),
  ]);
  const titles: Record<number, string> = {};
  for (const item of open?.ok ? open.value : []) titles[item.number] = item.title;
  const pulls: Record<number, LivePull> = {};
  for (const pull of openPulls?.ok ? openPulls.value : []) pulls[pull.number] = { title: pull.title, status: pull.status };
  const landed = isFailed(closed)
    ? closed
    : (closed.ok ? closed.value : [])
        .filter((pull) => pull.status === "merged" && pull.mergedAt)
        .sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!))
        .slice(0, LANDED);
  // Live now is one list of claims and sessions: it is whole or it is unavailable.
  const live: Failed | null = [claims, active, idle].find(isFailed) ?? null;
  return {
    workspace,
    live,
    claims: isFailed(claims) || !claims.ok ? [] : claims.value,
    sessions: [...(isFailed(active) || !active.ok ? [] : active.value), ...(isFailed(idle) || !idle.ok ? [] : idle.value)],
    queue: isFailed(queue) ? queue : queue.ok ? queue.value : null,
    feed: isFailed(recent) ? recent : recent.flatMap((event) => feedLine(event) ?? []),
    titles,
    pulls,
    landed,
    recorded: isFailed(recorded) ? recorded : recorded.ok ? recorded.value.slice(0, RECORDED) : [],
    defaultBranch: repo.defaultBranch,
    // Who may end a session by hand from Live now: its own runner, or anyone with write access.
    ender: { viewerId: viewer?.id ?? null, canPush: access.can.push },
  };
}

function Section({ icon, title, aside, children }: { icon: ReactNode; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </h3>
        {aside && <span className="text-xs text-muted">{aside}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function LandedRow({ pull, base, workspace }: { pull: Pull; base: string; workspace: string }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <span className="mt-0.5">
        <PullIcon status={pull.status} />
      </span>
      <span className="flex min-w-0 grow flex-wrap items-center gap-x-3 gap-y-1">
        <Link to={`${base}/pull/${pull.number}`} prefetch="intent" className="min-w-0 grow font-medium hover:text-accent">
          {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
        </Link>
        <span className="flex items-center gap-3 text-xs text-muted">
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

const OUTCOMES: Record<Pull["status"], string> = {
  draft: "In progress",
  open: "Ready for review",
  merged: "Merged",
  closed: "Closed",
};

export default function SessionsPage({ loaderData, params }: Route.ComponentProps) {
  const { live, claims, sessions, feed, titles, pulls, landed, defaultBranch, ender, workspace, recorded } = loaderData;
  const queue = isFailed(loaderData.queue) ? null : loaderData.queue;
  const base = `/${params.owner}/${params.repo}`;
  const now = Date.now();
  // Idle sessions fold under the list (LiveNowList); the counts are of the rest.
  const { awake, idle } = awakeAndIdle(sessions);
  const busy = claims.length + awake.length > 0;
  const working = busy || idle.length > 0;
  // Claims, sessions, overlaps, integration results and merges as they happen.
  useRepoLive({ match: repoPages.work() });
  // Claims lapse and sessions go idle with no event to say so.
  useRefreshWhile(working || (queue?.active.length ?? 0) > 0, 15_000);

  return (
    <div className="max-w-4xl">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <Activity size={19} className="text-accent" />
        Sessions
      </h2>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">
        Who is working on what right now, each in their own harness: the work items they claimed, their sessions, the merge queue
        combining their changes, and what happened along the way.
      </p>

      <Section
        icon={<Radio size={15} className={busy ? "text-success" : "text-faint"} />}
        title="Live now"
        aside={
          working && !live
            ? `${claims.length} ${claims.length === 1 ? "claim" : "claims"}, ${awake.length} ${awake.length === 1 ? "session" : "sessions"}${idle.length > 0 ? `, ${idle.length} idle` : ""}`
            : undefined
        }
      >
        {live ? (
          <Unavailable what={live.what} />
        ) : !working ? (
          <StartHere title="Nobody is working on this repository right now" />
        ) : (
          <LiveNowList claims={claims} sessions={sessions} titles={titles} pulls={pulls} defaultBranch={defaultBranch} base={base} now={now} ender={ender} />
        )}
      </Section>

      {isFailed(loaderData.queue) && (
        <Section icon={<Layers size={15} className="text-accent" />} title="Merge queue">
          <Unavailable what={loaderData.queue.what} />
        </Section>
      )}
      {queue && (queue.enabled || queue.active.length > 0) && (
        <Section
          icon={<Layers size={15} className="text-accent" />}
          title="Merge queue"
          aside={
            <Link to={`${base}/queue`} className="hover:text-fg">
              {queue.active.length} waiting to land · the whole queue
            </Link>
          }
        >
          <QueueTrain active={queue.active} base={base} branch={defaultBranch} empty="Nothing is waiting to land." />
        </Section>
      )}

      <Section icon={<History size={15} className="text-accent" />} title="What happened">
        {isFailed(feed) ? (
          <Unavailable what={feed.what} />
        ) : feed.length === 0 ? (
          <EmptyState title="Nothing yet">
            Claims, sessions, overlapping changes, dependencies and what the merge queue finds when it combines changes are listed here as
            they happen.
          </EmptyState>
        ) : (
          <CoordinationFeed lines={feed} base={base} />
        )}
      </Section>

      <Section
        icon={<GitMerge size={15} className="text-merged" />}
        title="Just landed"
        aside={
          !isFailed(landed) && landed.length > 0 ? (
            <Link to={`${base}/pulls?state=closed`} className="hover:text-fg">
              All merged pull requests
            </Link>
          ) : undefined
        }
      >
        {isFailed(landed) ? (
          <Unavailable what={landed.what} />
        ) : landed.length === 0 ? (
          <EmptyState title="Nothing merged yet">Merged pull requests show here, each with the session behind it.</EmptyState>
        ) : (
          <Card asChild divided>
            <ol>
              {landed.map((pull) => (
                <LandedRow key={pull.id} pull={pull} base={base} workspace={workspace} />
              ))}
            </ol>
          </Card>
        )}
      </Section>

      {/* What coding agents recorded on its pull requests: each opens on the pull request's Session tab. */}
      {(isFailed(recorded) || recorded.length > 0) && (
        <Section icon={<ScrollText size={15} className="text-accent" />} title="Recorded on pull requests">
          {isFailed(recorded) ? (
            <Unavailable what={recorded.what} />
          ) : (
            <Card asChild divided>
              <ul>
                {recorded.map((session) => (
                  <li key={session.number} className="px-4 py-3.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <Avatar name={session.agent} image={null} size={18} />
                      <Link to={`${base}/pull/${session.number}/session`} prefetch="intent" className="min-w-0 grow font-medium hover:text-accent">
                        {session.title} <span className="font-normal text-faint">#{session.number}</span>
                      </Link>
                      <span className="text-xs text-muted">{OUTCOMES[session.status]}</span>
                    </div>
                    {session.prompt && <p className="mt-1.5 line-clamp-1 text-sm text-muted">{session.prompt}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
                      <span>{session.entries} entries</span>
                      <span>{session.tools} tool calls</span>
                      <span className="grow" />
                      <span>
                        <TimeAgo at={session.lastAt} />
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </Section>
      )}
    </div>
  );
}
