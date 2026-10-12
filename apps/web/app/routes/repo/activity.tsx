import { GitBranch, GitBranchMinus, GitBranchPlus, GitCommitHorizontal, GitMerge, Tag as TagIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { EventType } from "@g1t/contracts";

import type { Route } from "./+types/activity";
import { encodeTag } from "../../components/releases";
import { ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { Avatar } from "../../components/ui/avatar";
import { Card } from "../../components/ui/card";
import { requireRepo } from "../../lib/access.server";
import { ACTIVITY_TYPES, type ActivityLine, aboutBranch, activityLine } from "../../lib/about";
import { page } from "../../lib/meta";
import { events, identity } from "../../lib/services.server";
import { UserAvatar, UserCard } from "../../components/user-card";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Activity · ${params.owner}/${params.repo} · g1t` });
}

const PAGE = 50;

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { repo } = await requireRepo(context, params, "read");
  const url = new URL(request.url);
  const before = url.searchParams.get("before") ?? undefined;
  // One branch's activity (the Branches page links here): each page of
  // events is read whole and only that branch's lines are kept.
  const only = url.searchParams.get("branch")?.trim() || null;
  const found = await events
    .list({ repoId: repo.id, types: [...ACTIVITY_TYPES] as EventType[], before, limit: PAGE })
    .catch(() => []);
  const lines = found.flatMap((event) => {
    const line = activityLine(event);
    return line && (!only || aboutBranch(line, only, repo.defaultBranch)) ? [{ id: event.id, time: event.time, actor: event.actor, line }] : [];
  });
  // Who: people by their name now; g1t as itself, and as a workspace
  // acting under its own identity (lib/mission.ts), never named after it.
  const ids = [...new Set(lines.map((line) => line.actor).filter((actor): actor is string => !!actor && actor !== "g1t"))];
  const names = ids.length > 0 ? await identity.usernames(ids.filter((id) => !id.startsWith("wsp_"))).catch(() => ({}) as Record<string, string>) : {};
  const g1t = (actor: string | null) => actor === "g1t" || !!actor?.startsWith("wsp_");
  return {
    lines: lines.map((line) => ({ ...line, who: g1t(line.actor) ? "g1t" : line.actor ? (names[line.actor] ?? null) : null })),
    next: found.length === PAGE ? found[found.length - 1].id : null,
    defaultBranch: repo.defaultBranch,
    branch: only,
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
    case "deleted":
      return {
        icon: <GitBranchMinus size={15} />,
        text: (
          <>
            deleted <span className="font-mono text-[0.8125rem] text-fg">{line.branch}</span> at {commit(line.commit)}
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
  const { lines, next, branch } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          Activity{branch && <> on <span className="font-mono text-base">{branch}</span></>}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {branch ? (
            <>
              Pushes to it, and when it was made, renamed or deleted, newest first.{" "}
              <Link to={base + "/activity"} className="text-fg hover:underline">
                All activity
              </Link>
            </>
          ) : (
            "Pushes, merges, new and deleted branches, tags, and branch renames, newest first, by person or agent."
          )}
        </p>
      </div>
      {lines.length === 0 ? (
        <EmptyState title={branch ? (next ? "Nothing on this branch here" : "No activity on this branch") : "No activity yet"}>
          {branch && next ? "Nothing in this stretch of the repository's activity was about it. Look further back." : "Pushes and merges show here as they happen."}
        </EmptyState>
      ) : (
        <Card asChild divided className="overflow-hidden">
          <ul>
            {lines.map(({ id, time, who, line }) => {
              const { icon, text } = describe(line, base);
              return (
                <li key={id} className="flex items-start gap-3 px-4 py-3 text-sm">
                  <span className="mt-0.5 shrink-0 text-faint">{icon}</span>
                  <span className="min-w-0 grow">
                    <span className="inline-flex items-center gap-1.5 align-middle">
                      {who && who !== "g1t" ? (
                        <UserAvatar username={who} size={18} />
                      ) : (
                        <Avatar name={who ?? "someone"} image={null} size={18} system={who === "g1t"} />
                      )}
                      {who && who !== "g1t" ? (
                        <UserCard username={who}>
                          <Link to={`/u/${who}`} className="font-medium hover:text-accent">
                            {who}
                          </Link>
                        </UserCard>
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
        </Card>
      )}
      {next && (
        <div className="flex justify-center">
          <ButtonLink variant="outline" to={`?${branch ? `branch=${encodeURIComponent(branch)}&` : ""}before=${encodeURIComponent(next)}`}>
            Older
          </ButtonLink>
        </div>
      )}
    </div>
  );
}
