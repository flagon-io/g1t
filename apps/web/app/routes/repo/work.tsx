import { Activity, GitMerge, History, Layers, Radio } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { EventType, Pull, WorkSession } from "@g1t/contracts";

import type { Route } from "./+types/work";
import { CoordinationFeed, ClaimLine, SessionLine } from "../../components/coordination";
import { QueueTrain } from "../../components/merge-queue";
import { CopyLine, EmptyState, TimeAgo } from "../../components/ui";
import { Avatar } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { IssueIcon, PullIcon } from "../../components/work-icons";
import { requireRepo } from "../../lib/access.server";
import { COORDINATION_TYPES, type LiveIssue, feedLine, liveByIssue } from "../../lib/coordination";
import { page } from "../../lib/meta";
import { useRefreshWhile } from "../../lib/refresh";
import { repoPages } from "../../lib/repo-live";
import { events, work } from "../../lib/services.server";
import { useRepoLive } from "../../lib/use-repo-live";

/** How many coordination events the feed shows. */
const FEED = 30;
/** How many merged pull requests Just landed shows. */
const LANDED = 6;

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Work · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { viewer, repo } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  // One round: who is on what, the queue, what happened, what landed.
  const [claims, active, idle, queue, recent, open, closed] = await Promise.all([
    work.listClaims(path, viewer).catch(() => null),
    work.listWorkSessions(path, viewer, { state: "active" }).catch(() => null),
    work.listWorkSessions(path, viewer, { state: "idle" }).catch(() => null),
    work.queue(path, viewer).catch(() => null),
    events
      .list({
        repoId: repo.id,
        types: [...COORDINATION_TYPES] as EventType[],
        limit: FEED,
      })
      .catch(() => []),
    // The titles of the issues being worked on.
    work.listIssues(path, viewer, { state: "open" }).catch(() => null),
    work.listPulls(path, viewer, "closed").catch(() => null),
  ]);
  const titles: Record<number, string> = {};
  for (const issue of open?.ok ? open.value : []) titles[issue.number] = issue.title;
  const landed = (closed?.ok ? closed.value : [])
    .filter((pull) => pull.status === "merged" && pull.mergedAt)
    .sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!))
    .slice(0, LANDED);
  return {
    claims: claims?.ok ? claims.value : [],
    sessions: [...(active?.ok ? active.value : []), ...(idle?.ok ? idle.value : [])],
    queue: queue?.ok ? queue.value : null,
    feed: recent.flatMap((event) => feedLine(event) ?? []),
    titles,
    landed,
    defaultBranch: repo.defaultBranch,
  };
}

function LiveIssueCard({ group, title, base, now }: { group: LiveIssue; title: string | undefined; base: string; now: number }) {
  return (
    <Card asChild divided>
      <li>
        <div className="flex items-start gap-2.5 px-4 py-3">
          <span className="mt-1">
            <IssueIcon issue={{ state: "open", reason: null }} />
          </span>
          <Link to={`${base}/issues/${group.issue}`} prefetch="intent" className="min-w-0 grow font-medium hover:text-accent">
            {title ?? `Issue #${group.issue}`} <span className="font-normal text-faint">#{group.issue}</span>
          </Link>
          {group.claims.length > 1 && <Badge tone="warn">{group.claims.length} claims</Badge>}
        </div>
        {group.claims.map((claim) => (
          <div key={claim.id} className="px-4 py-3">
            <ClaimLine claim={claim} now={now} base={base} />
          </div>
        ))}
        {group.sessions.map((session) => (
          <div key={session.id} className="px-4 py-3">
            <SessionLine session={session} base={base} />
          </div>
        ))}
      </li>
    </Card>
  );
}

/** What to do when nothing is being worked on: bring a harness. */
function StartHere() {
  return (
    <EmptyState title="Nobody is working on this repository right now">
      <div className="mx-auto mt-3 max-w-lg space-y-3 text-left">
        <p>Install the g1t plugin in Claude Code, and each session shows here as it works:</p>
        <CopyLine text="claude plugin marketplace add https://g1t.sh/flagon-io/g1t.git" prompt />
        <CopyLine text="claude plugin install g1t@g1t" prompt />
        <p>From any other harness, or by hand, claim an issue with the g1t CLI:</p>
        <CopyLine text="g1t work claim 12" prompt />
        <p>
          <a href="https://docs.g1t.sh/guides/sessions/" className="text-fg underline underline-offset-4">
            Sessions, claims and dependencies
          </a>{" "}
          says how it works.
        </p>
      </div>
    </EmptyState>
  );
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

function LandedRow({ pull, base }: { pull: Pull; base: string }) {
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
          {pull.issue != null && (
            <Link to={`${base}/issues/${pull.issue}`} className="hover:text-fg">
              for #{pull.issue}
            </Link>
          )}
          <Link to={`${base}/pull/${pull.number}?tab=session`} className="hover:text-fg">
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

export default function WorkPage({ loaderData, params }: Route.ComponentProps) {
  const { claims, sessions, queue, feed, titles, landed, defaultBranch } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const now = Date.now();
  const live = liveByIssue(claims, sessions);
  const working = claims.length > 0 || sessions.length > 0;
  // Claims, sessions, overlaps, integration results and merges as they happen.
  useRepoLive({ match: repoPages.work() });
  // Claims lapse and sessions go idle with no event to say so.
  useRefreshWhile(working || (queue?.active.length ?? 0) > 0, 15_000);

  return (
    <div className="max-w-4xl">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <Activity size={19} className="text-accent" />
        Work
      </h2>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">
        Who is working on what right now, each in their own harness: the issues they claimed, their sessions, the merge queue combining
        their changes, and what happened along the way.
      </p>

      <Section
        icon={<Radio size={15} className={working ? "text-success" : "text-faint"} />}
        title="Live now"
        aside={
          working
            ? `${claims.length} ${claims.length === 1 ? "claim" : "claims"}, ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`
            : undefined
        }
      >
        {!working ? (
          <StartHere />
        ) : (
          <ol className="space-y-3">
            {live.issues.map((group) => (
              <LiveIssueCard key={group.issue} group={group} title={titles[group.issue]} base={base} now={now} />
            ))}
            {live.loose.length > 0 && (
              <Card asChild divided>
                <li>
                  <p className="px-4 py-3 text-sm text-muted">Not on an issue yet</p>
                  {live.loose.map((session: WorkSession) => (
                    <div key={session.id} className="px-4 py-3">
                      <SessionLine session={session} base={base} />
                    </div>
                  ))}
                </li>
              </Card>
            )}
          </ol>
        )}
      </Section>

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
        {feed.length === 0 ? (
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
          landed.length > 0 ? (
            <Link to={`${base}/pulls?state=closed`} className="hover:text-fg">
              All merged pull requests
            </Link>
          ) : undefined
        }
      >
        {landed.length === 0 ? (
          <EmptyState title="Nothing merged yet">Merged pull requests show here, each with the session behind it.</EmptyState>
        ) : (
          <Card asChild divided>
            <ol>
              {landed.map((pull) => (
                <LandedRow key={pull.id} pull={pull} base={base} />
              ))}
            </ol>
          </Card>
        )}
      </Section>
    </div>
  );
}
