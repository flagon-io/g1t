import { BookMarked, CircleDot, Code2, GitPullRequest, History, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { Pill } from "../../components/ui";
import { repos, work } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

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
  };
}

function Tab({
  to,
  also,
  end,
  icon,
  count,
  children,
}: {
  to: string;
  /** Another path prefix under which this tab is the current one. */
  also?: string;
  end?: boolean;
  icon: ReactNode;
  count?: number;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `-mb-px flex items-center gap-2 border-b-2 px-1 pb-3 text-sm transition-colors ${
          isActive || (also && pathname.startsWith(also + "/"))
            ? "border-accent font-medium text-fg"
            : "border-transparent text-muted hover:text-fg"
        }`
      }
    >
      {icon}
      {children}
      {count != null && count > 0 && (
        <span className="rounded-full bg-raised px-1.5 py-px text-xs text-muted">
          {count}
        </span>
      )}
    </NavLink>
  );
}

export default function RepoLayout({ loaderData }: Route.ComponentProps) {
  const { repo, open } = loaderData;
  const base = `/${repo.namespace}/${repo.name}`;
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
          </nav>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </div>
    </>
  );
}
