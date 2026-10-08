import { Plus, Tag as TagIcon } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/releases";
import { ReleaseCard } from "../../components/releases";
import { ButtonLink, EmptyState } from "../../components/ui";
import { requireRepo } from "../../lib/access.server";
import { page } from "../../lib/meta";
import { repos } from "../../lib/services.server";
import { unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Releases · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { viewer, access } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  return { releases: unwrap(await repos.releases(path, viewer)), canPush: access.can.push };
}

export default function Releases({ loaderData, params }: Route.ComponentProps) {
  const { releases, canPush } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const repo = { namespace: params.owner, name: params.repo };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Releases <span className="font-normal text-faint">{releases.length}</span>
        </h2>
        <div className="flex items-center gap-2">
          <Link to={`${base}/tags`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent">
            <TagIcon size={14} className="text-faint" />
            Tags
          </Link>
          {canPush && (
            <ButtonLink to={`${base}/releases/new`}>
              <Plus size={15} />
              Draft a new release
            </ButtonLink>
          )}
        </div>
      </div>
      {releases.length === 0 ? (
        <EmptyState title="No releases published">
          A release is a tag with a title and notes, for people to see what changed and download it.
          {canPush ? (
            <>
              {" "}
              <Link to={`${base}/releases/new`} className="text-accent hover:underline">
                Create a new release
              </Link>
              .
            </>
          ) : null}
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {releases.map((release) => (
            <ReleaseCard key={release.id} release={release} repo={repo} />
          ))}
        </div>
      )}
    </div>
  );
}
