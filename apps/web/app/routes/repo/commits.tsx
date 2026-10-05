import { GitCommitHorizontal } from "lucide-react";
import { Link } from "react-router";

import type { Commit } from "@g1t/contracts";

import type { Route } from "./+types/commits";
import { page } from "../../lib/meta";
import { Avatar, EmptyState, TimeAgo } from "../../components/ui";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

const PAGE_SIZE = 50;

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Commits · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  return {
    commits: unwrap(await repos.log(path, getViewer(context), null, PAGE_SIZE)),
  };
}

/** Commits by the day they were made, newest first. */
function byDay(commits: Commit[]): [string, Commit[]][] {
  const days = new Map<string, Commit[]>();
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
  const { commits } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  if (commits.length === 0) {
    return <EmptyState title="No commits yet" />;
  }
  return (
    <div className="relative space-y-8 before:absolute before:top-3 before:bottom-3 before:left-1.75 before:w-px before:bg-line">
      {byDay(commits).map(([day, list]) => (
        <section key={day} className="relative pl-7">
          <h2 className="flex items-center gap-2 text-xs font-medium text-muted">
            <GitCommitHorizontal size={15} className="absolute left-0 bg-bg text-faint" />
            {dayLabel(day)}
          </h2>
          <ol className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line">
            {list.map((commit) => {
              const [subject, ...body] = commit.message.split("\n");
              const rest = body.join("\n").trim();
              const to = `${base}/commit/${commit.hash}`;
              return (
                <li key={commit.hash} className="group relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface">
                  <Avatar name={commit.author.name} size={24} />
                  <div className="min-w-0 grow">
                    <Link to={to} prefetch="intent" className="block truncate font-medium after:absolute after:inset-0 group-hover:text-accent">
                      {subject}
                    </Link>
                    {rest && <p className="mt-1 line-clamp-1 text-sm text-muted">{rest}</p>}
                    <p className="mt-1 text-xs text-faint">
                      {commit.author.name} committed <TimeAgo at={commit.authoredAt} />
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
        </section>
      ))}
    </div>
  );
}
