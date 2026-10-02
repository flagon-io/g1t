import { env } from "cloudflare:workers";
import { data } from "react-router";

import type { Route } from "./+types/profile";
import { RepoList } from "../components/repo-list";
import { Avatar } from "../components/ui";
import { identity } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.owner} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const [user, repos] = await Promise.all([
    identity.userByUsername(params.owner),
    env.REPOS.list(getViewer(context), { namespace: params.owner }),
  ]);
  if (!user) throw data(null, { status: 404 });
  return { user, repos };
}

export default function Profile({ loaderData }: Route.ComponentProps) {
  const { user, repos } = loaderData;
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex items-center gap-4">
        <Avatar name={user.username} size={56} />
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            {user.username}
          </h1>
          <p className="text-sm text-muted">
            {repos.length} {repos.length === 1 ? "repository" : "repositories"}
          </p>
        </div>
      </div>
      <h2 className="mt-10 text-sm font-medium text-muted">Repositories</h2>
      <RepoList repos={repos} />
    </main>
  );
}
