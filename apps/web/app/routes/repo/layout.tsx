import {
  BookMarked,
  CircleDot,
  Code2,
  GitPullRequest,
  History,
  ListTree,
  Lock,
  Settings,
} from "lucide-react";
import { Link, Outlet, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/layout";
import { Pill, TabLink as Tab } from "../../components/ui";
import { repos, work } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const [repo, counts] = await Promise.all([
    repos.get(path, viewer),
    work.counts(path, viewer),
  ]);
  return {
    repo: unwrap(repo),
    open: counts.ok ? counts.value : { issues: 0, pulls: 0 },
    member: roleIn(viewer, params.owner) != null,
  };
}

export default function RepoLayout({ loaderData }: Route.ComponentProps) {
  const { repo, open, member } = loaderData;
  const base = `/${repo.namespace}/${repo.name}`;
  const signedIn = useRouteLoaderData("root")?.user != null;
  if (signedIn) {
    return (
      <>
        <div className="border-b border-line">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-6">
            {repo.isPrivate ? (
              <Lock size={15} className="text-faint" />
            ) : (
              <BookMarked size={15} className="text-faint" />
            )}
            <h1 className="font-mono text-[0.9375rem]">
              <Link to={`/${repo.namespace}`} className="text-muted hover:text-fg">
                {repo.namespace}
              </Link>
              <span className="mx-1 text-faint">/</span>
              <Link to={base} className="font-semibold hover:underline">
                {repo.name}
              </Link>
            </h1>
            <Pill>{repo.isPrivate ? "private" : "public"}</Pill>
            {repo.description && (
              <p className="min-w-0 truncate text-sm text-muted">{repo.description}</p>
            )}
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <Outlet />
        </div>
      </>
    );
  }
  return (
    <>
      {/* The repository's own header band, under the site header. */}
      <div className="border-b border-line bg-surface/60">
        <div className="mx-auto max-w-6xl px-4 pt-6">
          <div className="flex flex-wrap items-center gap-2.5">
            {repo.isPrivate ? (
              <Lock size={17} className="text-faint" />
            ) : (
              <BookMarked size={17} className="text-faint" />
            )}
            <h1 className="font-mono text-lg">
              <Link to={`/${repo.namespace}`} className="text-muted hover:text-fg">
                {repo.namespace}
              </Link>
              <span className="mx-1 text-faint">/</span>
              <Link to={base} className="font-semibold hover:underline">
                {repo.name}
              </Link>
            </h1>
            <Pill>{repo.isPrivate ? "private" : "public"}</Pill>
          </div>
          {repo.description && (
            <p className="mt-2 max-w-2xl text-sm text-muted">{repo.description}</p>
          )}
          <nav className="mt-5 flex gap-6">
            <Tab to={base} end icon={<Code2 size={15} />}>
              Code
            </Tab>
            <Tab to={`${base}/issues`} icon={<CircleDot size={15} />} count={open.issues}>
              Issues
            </Tab>
            <Tab
              to={`${base}/pulls`}
              also={`${base}/pull`}
              icon={<GitPullRequest size={15} />}
              count={open.pulls}
            >
              Pull requests
            </Tab>
            <Tab to={`${base}/commits`} icon={<History size={15} />}>
              Commits
            </Tab>
            {member && (
              <Tab to={`${base}/plans`} icon={<ListTree size={15} />}>
                Plan
              </Tab>
            )}
            {member && (
              <Tab to={`${base}/settings`} icon={<Settings size={15} />}>
                Settings
              </Tab>
            )}
          </nav>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </div>
    </>
  );
}
