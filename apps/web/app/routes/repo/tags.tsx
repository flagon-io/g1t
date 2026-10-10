import { FileArchive, Tag as TagIcon } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/tags";
import { CommitChecksBadge } from "../../components/commit-checks";
import { CommitAvatars, CommitNames } from "../../components/commit-person";
import { EmptyState, TimeAgo } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
import { page } from "../../lib/meta";
import { commitChecksFor } from "../../lib/commit-checks.server";
import { showCommits } from "../../lib/commit-people.server";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Tags · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const viewer = getViewer(context);
  const found = unwrap(await repos.tags(path, viewer));
  // Each tagged commit's checks, in one call, streamed in beside it.
  const checks = commitChecksFor(path, viewer, found.map((tag) => tag.commit?.hash));
  // Every tagged commit's people, in one identity call.
  const shown = await showCommits(found.flatMap((tag) => (tag.commit ? [tag.commit] : [])));
  const byHash = new Map(shown.map((commit) => [commit.hash, commit]));
  const tags = found.map((tag) => ({ name: tag.name, commit: tag.commit ? byHash.get(tag.commit.hash)! : null }));
  return { tags, checks };
}

export default function Tags({ loaderData, params }: Route.ComponentProps) {
  const { tags, checks } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const path = (name: string) => name.split("/").map(encodeURIComponent).join("/");
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight">
        Tags <span className="font-normal text-faint">{tags.length}</span>
      </h2>
      {tags.length === 0 ? (
        <EmptyState title="No tags yet">
          A tag marks a version of the code: <code className="font-mono text-xs">git tag v1.0.0 && git push --tags</code>. Each
          one shows here with its commit and a download.
        </EmptyState>
      ) : (
        <Card asChild divided className="overflow-hidden">
          <ul>
            {tags.map((tag) => (
              <li key={tag.name} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                <TagIcon size={15} className="shrink-0 text-faint" />
                <span className="min-w-0 grow basis-56">
                  <Link to={`${base}/tree/${path(tag.name)}`} className="block truncate font-mono text-[0.8125rem] font-medium hover:text-accent">
                    {tag.name}
                  </Link>
                  {tag.commit && (
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                      <CommitAvatars commit={tag.commit} size={14} max={2} />
                      <span className="shrink-0">
                        <CommitNames commit={tag.commit} className="hover:text-fg" />
                      </span>
                      <span className="text-faint">·</span>
                      <Hint label={tag.commit.message}>
                        <Link to={`${base}/commit/${tag.commit.hash}`} className="min-w-0 truncate hover:text-fg">
                          {tag.commit.message.split("\n")[0]}
                        </Link>
                      </Hint>
                      <CommitChecksBadge checks={checks} sha={tag.commit.hash} className="size-5" />
                      <span className="shrink-0 text-faint">
                        · <TimeAgo at={tag.commit.authoredAt} />
                      </span>
                    </span>
                  )}
                </span>
                <span className="ml-6.5 flex shrink-0 items-center gap-3 text-xs sm:ml-0">
                  {tag.commit && (
                    <Link to={`${base}/commit/${tag.commit.hash}`} className="font-mono text-faint hover:text-fg">
                      {tag.commit.hash.slice(0, 7)}
                    </Link>
                  )}
                  <a
                    href={`${base}/archive/${path(tag.name)}.zip`}
                    download
                    className="inline-flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 text-muted hover:border-line-strong hover:text-fg"
                  >
                    <FileArchive size={12} />
                    ZIP
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
