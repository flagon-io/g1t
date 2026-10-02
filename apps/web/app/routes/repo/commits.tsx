import { env } from "cloudflare:workers";

import type { Route } from "./+types/commits";
import { Avatar, EmptyState, TimeAgo } from "../../components/ui";
import { getViewer, unwrap } from "../../lib/session.server";

const PAGE_SIZE = 50;

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Commits · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  return {
    commits: unwrap(
      await env.REPOS.log(path, getViewer(context), null, PAGE_SIZE),
    ),
  };
}

export default function Commits({ loaderData }: Route.ComponentProps) {
  const { commits } = loaderData;
  if (commits.length === 0) {
    return <EmptyState title="No commits yet" />;
  }
  return (
    <ol className="divide-y divide-line overflow-hidden rounded-xl border border-line">
      {commits.map((commit) => {
        const [subject, ...body] = commit.message.split("\n");
        return (
          <li key={commit.hash} className="flex items-start gap-3 px-4 py-3">
            <Avatar name={commit.author.name} size={24} />
            <div className="min-w-0 grow">
              <p className="truncate font-medium">{subject}</p>
              {body.join("\n").trim() && (
                <p className="mt-1 line-clamp-2 text-sm whitespace-pre-line text-muted">
                  {body.join("\n").trim()}
                </p>
              )}
              <p className="mt-1 text-xs text-faint">
                {commit.author.name} committed <TimeAgo at={commit.authoredAt} />
              </p>
            </div>
            <span className="shrink-0 rounded-md border border-line px-2 py-0.5 font-mono text-xs text-muted">
              {commit.hash.slice(0, 7)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
