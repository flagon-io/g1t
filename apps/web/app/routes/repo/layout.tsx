import { env } from "cloudflare:workers";
import { Link, NavLink, Outlet } from "react-router";

import type { Route } from "./+types/layout";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const [repo, intents] = await Promise.all([
    env.REPOS.get(path, viewer),
    env.WORK.listIntents(path, viewer, "open"),
  ]);
  return {
    repo: unwrap(repo),
    openIntents: intents.ok ? intents.value.length : 0,
  };
}

function Tab({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `-mb-px border-b-2 px-1 pb-2.5 text-sm ${
          isActive
            ? "border-accent text-fg"
            : "border-transparent text-muted hover:text-fg"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

export default function RepoLayout({ loaderData }: Route.ComponentProps) {
  const { repo, openIntents } = loaderData;
  const base = `/${repo.namespace}/${repo.name}`;
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-xl">
          <span className="text-muted">{repo.namespace}/</span>
          <Link to={base} className="font-semibold">
            {repo.name}
          </Link>
        </h1>
        {repo.isPrivate && (
          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
            private
          </span>
        )}
      </div>
      {repo.description && (
        <p className="mt-2 text-sm text-muted">{repo.description}</p>
      )}
      <nav className="mt-6 flex gap-6 border-b border-line">
        <Tab to={base} end>
          Code
        </Tab>
        <Tab to={`${base}/intents`}>
          Intents
          {openIntents > 0 && (
            <span className="ml-1.5 rounded-full bg-surface px-1.5 py-0.5 text-xs">
              {openIntents}
            </span>
          )}
        </Tab>
      </nav>
      <Outlet />
    </div>
  );
}
