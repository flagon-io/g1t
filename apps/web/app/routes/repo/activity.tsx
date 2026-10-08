import { GitBranch, GitBranchPlus, GitCommitHorizontal, GitMerge, Tag as TagIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { EventType } from "@g1t/contracts";

import type { Route } from "./+types/activity";
import { encodeTag } from "../../components/releases";
import { Avatar, ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { requireRepo } from "../../lib/access.server";
import { ACTIVITY_TYPES, type ActivityLine, activityLine } from "../../lib/about";
import { page } from "../../lib/meta";
import { events, identity } from "../../lib/services.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Activity · ${params.owner}/${params.repo} · g1t` });
}

const PAGE = 50;

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { repo } = await requireRepo(context, params, "read");
  const before = new URL(request.url).searchParams.get("before") ?? undefined;
  const found = await events
    .list({ repoId: repo.id, types: [...ACTIVITY_TYPES] as EventType[], before, limit: PAGE })
    .catch(() => []);
  const lines = found.flatMap((event) => {
    const line = activityLine(event);
    return line ? [{ id: event.id, time: event.time, actor: event.actor, line }] : [];
  });
  // Who: people by their name now; g1t as itself.
  const ids = [...new Set(lines.map((line) => line.actor).filter((actor): actor is string => !!actor && actor !== "g1t"))];
  const names = ids.length > 0 ? await identity.usernames(ids).catch(() => ({}) as Record<string, string>) : {};
  return {
    lines: lines.map((line) => ({ ...line, who: line.actor === "g1t" ? "g1t" : line.actor ? (names[line.actor] ?? null) : null })),
    next: found.length === PAGE ? found[found.length - 1].id : null,
    defaultBranch: repo.defaultBranch,
  };
}

function describe(line: ActivityLine, base: string): { icon: ReactNode; text: ReactNode } {
  const branch = (name: string) => (
    <Link to={`${base}/tree/${encodeTag(name)}`} className="font-mono text-[0.8125rem] font-medium text-fg hover:text-accent">
      {name}
    </Link>
  );
  const commit = (hash: string) => (
    <Link to={`${base}/commit/${hash}`} className="font-mono text-[0.8125rem] text-muted hover:text-accent">
      {hash.slice(0, 7)}
    </Link>
  );
  switch (line.kind) {
    case "push":
      return line.created
        ? { icon: <GitBranchPlus size={15} />, text: <>created {branch(line.branch)} at {commit(line.commit)}</> }
        : {
            icon: <GitCommitHorizontal size={15} />,
            text: (
              <>
                pushed to {branch(line.branch)}{" "}
                {line.before ? (
                  <Link to={`${base}/compare/${line.before}...${line.commit}`} className="font-mono text-[0.8125rem] text-muted hover:text-accent">
                    {line.before.slice(0, 7)}…{line.commit.slice(0, 7)}
                  </Link>
                ) : (
                  commit(line.commit)
                )}
              </>
            ),
          };
    case "tag":
      return { icon: <TagIcon size={15} />, text: <>tagged {branch(line.tag)} at {commit(line.commit)}</> };
    case "merge":
      return {
        icon: <GitMerge size={15} />,
        text: (
          <>
            merged{" "}
            <Link to={`${base}/pull/${line.number}`} className="font-medium text-fg hover:text-accent">
              #{line.number}
            </Link>{" "}
            as {commit(line.commit)}
          </>
        ),
      };
    case "renamed":
      return { icon: <GitBranch size={15} />, text: <>renamed <span className="font-mono text-[0.8125rem]">{line.from}</span> to {branch(line.to)}</> };
    case "default":
      return { icon: <GitBranch size={15} />, text: <>made {branch(line.to)} the default branch, in place of <span className="font-mono text-[0.8125rem]">{line.from}</span></> };
  }
}

export default function ActivityPage({ loaderData, params }: Route.ComponentProps) {
  const { lines, next } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
        <p className="mt-1 text-sm text-muted">Pushes, merges, new branches and tags, and branch renames, newest first, by person or agent.</p>
      </div>
      {lines.length === 0 ? (
        <EmptyState title="No activity yet">Pushes and merges show here as they happen.</EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {lines.map(({ id, time, who, line }) => {
            const { icon, text } = describe(line, base);
            return (
              <li key={id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <span className="mt-0.5 shrink-0 text-faint">{icon}</span>
                <span className="min-w-0 grow">
                  <span className="inline-flex items-center gap-1.5 align-middle">
                    <Avatar name={who ?? "someone"} size={18} system={who === "g1t"} />
                    {who && who !== "g1t" ? (
                      <Link to={`/u/${who}`} className="font-medium hover:text-accent">
                        {who}
                      </Link>
                    ) : (
                      <span className="font-medium">{who ?? "Someone"}</span>
                    )}
                  </span>{" "}
                  <span className="text-muted">{text}</span>
                </span>
                <span className="shrink-0 text-xs text-faint">
                  <TimeAgo at={time} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <div className="flex justify-center">
          <ButtonLink variant="quiet" to={`?before=${encodeURIComponent(next)}`}>
            Older
          </ButtonLink>
        </div>
      )}
    </div>
  );
}
