import { GitFork } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/forks";
import { ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { requireRepo } from "../../lib/access.server";
import { page } from "../../lib/meta";
import { projects, repos } from "../../lib/services.server";
import { unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Forks · ${params.owner}/${params.repo} · g1t` });
}

/** The most forks listed, newest first. */
const LISTED = 100;

export async function loader({ params, context }: Route.LoaderArgs) {
  const { viewer, repo } = await requireRepo(context, params, "read");
  const found = unwrap(await repos.forks({ namespace: params.owner, name: params.repo }, viewer, LISTED));
  // A repository has no description: its project's is shown.
  const about = await projects.descriptions(found.map((fork) => fork.id));
  return {
    forks: found.map((fork) => ({
      namespace: fork.namespace,
      name: fork.name,
      description: about[fork.id] ?? null,
      isPrivate: fork.isPrivate,
      createdAt: fork.createdAt,
      archived: Boolean(fork.archivedAt),
    })),
    forkable: !repo.isPrivate || Boolean(repo.allowForking),
    signedIn: Boolean(viewer),
  };
}

export default function Forks({ loaderData, params }: Route.ComponentProps) {
  const { forks, forkable, signedIn } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Forks{" "}
          <span className="font-normal text-faint">
            {forks.length}
            {forks.length === LISTED ? "+" : ""}
          </span>
        </h2>
        {forkable && (
          <ButtonLink variant="outline" size="sm" to={signedIn ? `${base}/fork` : `/login?next=${encodeURIComponent(`${base}/fork`)}`}>
            <GitFork size={14} />
            Fork
          </ButtonLink>
        )}
      </div>
      {forks.length === 0 ? (
        <EmptyState title="No forks yet">
          {forkable
            ? "Fork it into a workspace of yours to change it there, and it shows here."
            : "It is private and forking it is off, so it has none."}
        </EmptyState>
      ) : (
        <Card asChild tone="plain" divided className="overflow-hidden">
          <ul>
            {forks.map((fork) => (
              <li key={`${fork.namespace}/${fork.name}`} className="flex items-start gap-3 px-4 py-3">
                <GitFork size={15} className="mt-0.5 shrink-0 text-faint" />
                <div className="min-w-0 grow">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link to={`/${fork.namespace}/${fork.name}`} className="truncate font-mono text-sm hover:text-accent hover:underline">
                      <span className="text-muted">{fork.namespace}/</span>
                      <span className="font-semibold">{fork.name}</span>
                    </Link>
                    <Badge>{fork.isPrivate ? "private" : "public"}</Badge>
                    {fork.archived && <Badge>archived</Badge>}
                  </div>
                  {fork.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{fork.description}</p>}
                </div>
                <p className="shrink-0 text-xs text-faint">
                  Forked <TimeAgo at={fork.createdAt} />
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {forks.length === LISTED && (
        <p className="text-center text-sm text-faint">The {LISTED} newest forks you can see.</p>
      )}
    </div>
  );
}
