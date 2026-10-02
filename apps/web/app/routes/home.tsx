import { ArrowRight, Plus } from "lucide-react";
import { Link, redirect } from "react-router";

import type { Route } from "./+types/home";
import { Landing } from "../components/landing";
import { RepoList } from "../components/repo-list";
import {
  Avatar,
  ButtonLink,
  CopyLine,
  EmptyState,
  Status,
  TimeAgo,
} from "../components/ui";
import { repos as reposApi, work } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "g1t — Git for AI scale" },
    {
      name: "description",
      content:
        "A git forge for thousands of agents working on the same code at once: every attempt isolated, every decision recorded, every change landed in order. Open source, built on Cloudflare.",
    },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Nothing can be created outside a workspace, so a new account starts there.
  if (viewer?.verified && (viewer.workspaces ?? []).length === 0) {
    throw redirect("/workspaces/new");
  }
  const [repos, attempts] = await Promise.all([
    reposApi.list(viewer, { memberOnly: Boolean(viewer) }),
    work.listActiveAttempts(viewer),
  ]);
  // Mission control links to each attempt under its repo.
  const attemptRepos = await Promise.all(
    attempts.map(({ attempt }) => reposApi.getById(attempt.repoId, viewer)),
  );
  return {
    viewer,
    repos,
    active: attempts.flatMap((item, i) => {
      const repo = attemptRepos[i];
      return repo.ok ? [{ ...item, repo: repo.value }] : [];
    }),
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { viewer, repos, active } = loaderData;
  if (!viewer) return <Landing repos={repos} />;

  const working = active.filter(({ attempt }) => attempt.status === "working");
  return (
    <main className="mx-auto grid max-w-6xl gap-10 px-4 py-10 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0 space-y-10">
        <section>
          <div className="flex items-center gap-3">
            <Avatar name={viewer.username} size={36} />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                Mission control
              </h1>
              <p className="text-sm text-muted">
                {working.length === 0
                  ? "Nothing is running right now."
                  : `${working.length} ${working.length === 1 ? "attempt is" : "attempts are"} running.`}
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-muted">In progress</h2>
          <div className="mt-3">
            {active.length === 0 ? (
              <EmptyState title="No attempts in progress">
                Open an intent on a repository and start an attempt, or point
                your agent at one.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {active.map(({ attempt, intent, repo }) => (
                  <li key={attempt.id}>
                    <Link
                      to={`/${repo.namespace}/${repo.name}/attempts/${attempt.id}`}
                      className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-raised"
                    >
                      <span className="min-w-0 grow">
                        <span className="block truncate font-medium">
                          {intent.title}
                        </span>
                        <span className="font-mono text-xs text-muted">
                          {repo.namespace}/{repo.name} #{intent.number} · attempt{" "}
                          {attempt.number} · {attempt.agent}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-faint">
                        <TimeAgo at={attempt.updatedAt} />
                      </span>
                      <Status value={attempt.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted">Your repositories</h2>
            <ButtonLink to="/new" variant="quiet">
              <Plus size={14} />
              New
            </ButtonLink>
          </div>
          <RepoList repos={repos} />
        </section>
      </div>

      <aside className="space-y-4">
        <div className="rounded-xl border border-line bg-surface p-5">
          <h2 className="font-medium">Connect an agent</h2>
          <p className="mt-1.5 text-sm text-muted">
            Create an access token in settings, then add g1t to Claude Code.
          </p>
          <div className="mt-4 space-y-2">
            <CopyLine
              prompt
              text='claude mcp add --transport http g1t https://mcp.g1t.sh --header "Authorization: Bearer $G1T_TOKEN"'
            />
          </div>
          <Link
            to="https://docs.g1t.sh/guides/bring-your-own-agent/"
            className="mt-4 inline-flex items-center gap-1 text-sm text-accent hover:underline"
          >
            How it works <ArrowRight size={13} />
          </Link>
        </div>
        <div className="rounded-xl border border-line bg-surface p-5">
          <h2 className="font-medium">Explore</h2>
          <p className="mt-1.5 text-sm text-muted">
            Browse public repositories and the intents open on them.
          </p>
          <Link
            to="/explore"
            className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline"
          >
            Public repositories <ArrowRight size={13} />
          </Link>
        </div>
      </aside>
    </main>
  );
}
