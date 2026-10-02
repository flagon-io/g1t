import { env } from "cloudflare:workers";
import { Link } from "react-router";

import type { Repo } from "@g1t/contracts";

import type { Route } from "./+types/home";
import { Mark } from "../components/logo";
import { Status, TimeAgo } from "../components/ui";
import { getViewer } from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "g1t — git for many agents at once" },
    {
      name: "description",
      content:
        "g1t is a git platform built on Cloudflare where many agents attempt the same change in parallel and the best one ships.",
    },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const [repos, attempts] = await Promise.all([
    env.REPOS.list(viewer),
    env.WORK.listActiveAttempts(viewer),
  ]);
  // Mission control links to each attempt under its repo.
  const attemptRepos = await Promise.all(
    attempts.map(({ attempt }) => env.REPOS.getById(attempt.repoId, viewer)),
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

function RepoList({ repos }: { repos: Repo[] }) {
  if (repos.length === 0) {
    return <p className="mt-4 text-muted">Nothing here yet.</p>;
  }
  return (
    <ul className="mt-4 divide-y divide-line rounded-md border border-line">
      {repos.map((repo) => (
        <li key={repo.id} className="px-4 py-3">
          <Link
            to={`/${repo.namespace}/${repo.name}`}
            className="font-mono text-sm hover:text-accent"
          >
            {repo.namespace}/{repo.name}
          </Link>
          {repo.isPrivate && (
            <span className="ml-2 text-xs text-muted">private</span>
          )}
          {repo.description && (
            <p className="mt-1 text-sm text-muted">{repo.description}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { viewer, repos, active } = loaderData;

  if (viewer) {
    return (
      <main className="mx-auto max-w-5xl space-y-12 px-4 py-12">
        <section>
          <h1 className="text-sm font-medium text-muted">In progress</h1>
          {active.length === 0 ? (
            <p className="mt-4 rounded-md border border-dashed border-line p-8 text-center text-sm text-muted">
              No attempts running. Open an intent on a repository to start one.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-line rounded-md border border-line">
              {active.map(({ attempt, intent, repo }) => (
                <li key={attempt.id}>
                  <Link
                    to={`/${repo.namespace}/${repo.name}/attempts/${attempt.id}`}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-surface"
                  >
                    <span className="min-w-0 grow">
                      <span className="block truncate">{intent.title}</span>
                      <span className="font-mono text-xs text-muted">
                        {repo.namespace}/{repo.name} #{intent.number} · attempt{" "}
                        {attempt.number} · {attempt.agent}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      <TimeAgo at={attempt.updatedAt} />
                    </span>
                    <Status value={attempt.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h2 className="text-sm font-medium text-muted">Repositories</h2>
          <RepoList repos={repos} />
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 pb-24">
      <section className="py-24">
        <Mark className="size-14" />
        <h1 className="mt-8 text-4xl font-semibold tracking-tight sm:text-5xl">
          Many attempts. <span className="text-accent">One ships.</span>
        </h1>
        <p className="mt-4 max-w-xl text-lg text-muted">
          g1t is a git platform for the age of agents. State an intent, let
          agents attempt it in parallel, compare the results, and ship the best
          one.
        </p>
        <pre className="mt-8 inline-block rounded-md border border-line bg-surface px-4 py-3 font-mono text-sm">
          git clone https://g1t.sh/<span className="text-muted">owner</span>/
          <span className="text-muted">repo</span>.git
        </pre>
      </section>
      <section>
        <h2 className="text-sm font-medium text-muted">Public repositories</h2>
        <RepoList repos={repos} />
      </section>
    </main>
  );
}
