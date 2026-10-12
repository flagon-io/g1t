import { ArrowLeft, GitBranch, GitCommitHorizontal } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/work-session";
import { Actor, HarnessBadge, SessionStateBadge } from "../../components/coordination";
import { SessionEntries } from "../../components/session-entries";
import { EmptyState, TimeAgo } from "../../components/ui";
import { PersonLink } from "../../components/work";
import { requireRepo } from "../../lib/access.server";
import { harnessName } from "../../lib/coordination";
import { page } from "../../lib/meta";
import { notFound } from "../../lib/not-found.server";
import { useRefreshWhile } from "../../lib/refresh";
import { work } from "../../lib/services.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const session = loaderData?.session;
  const name = session ? `${session.title ?? `${session.actor.username}'s ${harnessName(session.harness)} session`} · ` : "";
  return page(args, { title: `${name}Session · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { viewer } = await requireRepo(context, params, "read");
  const found = await work.getWorkSession({ namespace: params.owner, name: params.repo }, params.id, viewer).catch(() => null);
  if (!found?.ok) throw notFound("page");
  return found.value;
}

/** One harness session: who ran it, where, what it is on, and what it recorded. */
export default function WorkSessionPage({ loaderData, params }: Route.ComponentProps) {
  const { session, entries } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  useRefreshWhile(session.state === "active", 10_000);
  const tools = entries.filter((entry) => entry.kind === "tool_call").length;
  return (
    <div className="max-w-4xl">
      <Link to={`${base}/work`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Work
      </Link>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Actor username={session.actor.username} harness={session.harness} size={24} />
        <h2 className="min-w-0 grow text-lg font-semibold tracking-tight">
          {session.title ?? `${session.actor.username}'s session`}
        </h2>
        <HarnessBadge harness={session.harness} />
        <SessionStateBadge state={session.state} />
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <PersonLink name={session.actor.username} className="font-medium text-fg hover:underline" />
        <span>
          started <TimeAgo at={session.startedAt} />
        </span>
        <span>
          · {session.state === "ended" ? "ended" : "last heard from"} <TimeAgo at={session.endedAt ?? session.lastSeenAt} />
          {session.endReason && ` (${session.endReason === "timed_out" ? "timed out" : session.endReason})`}
        </span>
        {session.issue != null && (
          <span>
            · on{" "}
            <Link to={`${base}/issues/${session.issue}`} className="text-fg hover:text-accent">
              #{session.issue}
            </Link>
          </span>
        )}
        {session.pull != null && (
          <span>
            · in{" "}
            <Link to={`${base}/pull/${session.pull}`} className="text-fg hover:text-accent">
              #{session.pull}
            </Link>
          </span>
        )}
        {session.branch && (
          <span className="inline-flex items-center gap-1 font-mono text-xs">
            · <GitBranch size={12} />
            {session.branch}
          </span>
        )}
        {session.headCommit && (
          <span className="inline-flex items-center gap-1 font-mono text-xs">
            · <GitCommitHorizontal size={12} />
            {session.headCommit.slice(0, 7)}
          </span>
        )}
      </p>
      <p className="mt-1 text-xs text-faint">
        Run by {session.actor.username}'s token in {harnessName(session.harness)}, as the harness declared. What it records is its own
        account; the commits, checks and merges are the record.
      </p>

      <section className="mt-8">
        <h3 className="text-sm font-medium">
          What it recorded <span className="font-normal text-muted">· {entries.length} entries, {tools} tool calls</span>
        </h3>
        <div className="mt-3">
          {entries.length === 0 ? (
            <EmptyState title="Nothing recorded yet">Prompts, messages, tool calls and notes show here as the session records them.</EmptyState>
          ) : (
            <SessionEntries entries={entries} />
          )}
        </div>
      </section>
    </div>
  );
}
