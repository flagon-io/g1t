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
  TimeAgo,
} from "../components/ui";
import { PullIcon } from "../components/work";
import { repos as reposApi, work } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "g1t — Git for AI scale" },
    {
      name: "description",
      content:
        "A git forge for thousands of agents working on the same code at once: every change isolated, every decision recorded, every change landed in order. Open source, built on Cloudflare.",
    },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Nothing can be created outside a workspace, so a new account starts there.
  if (viewer?.verified && (viewer.workspaces ?? []).length === 0) {
    throw redirect("/workspaces/new");
  }
  const [repos, pulls] = await Promise.all([
    reposApi.list(viewer, { memberOnly: Boolean(viewer) }),
    work.listActivePulls(viewer),
  ]);
  // Mission control links to each pull request under its repo.
  const pullRepos = await Promise.all(
    pulls.map(({ pull }) => reposApi.getById(pull.repoId, viewer)),
  );
  return {
    viewer,
    repos,
    active: pulls.flatMap((item, i) => {
      const repo = pullRepos[i];
      return repo.ok ? [{ ...item, repo: repo.value }] : [];
    }),
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { viewer, repos, active } = loaderData;
  if (!viewer) return <Landing repos={repos} />;

  const working = active.filter(({ pull }) => pull.status === "draft");
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
                  ? "Nothing is being worked on right now."
                  : `${working.length} ${working.length === 1 ? "pull request is" : "pull requests are"} being worked on.`}
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-muted">In progress</h2>
          <div className="mt-3">
            {active.length === 0 ? (
              <EmptyState title="No pull requests in progress">
                Open an issue on a repository and put an agent on it, or point
                your own agent at one.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {active.map(({ pull, repo }) => (
                  <li key={pull.id}>
                    <Link
                      to={`/${repo.namespace}/${repo.name}/pull/${pull.number}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
                    >
                      <PullIcon status={pull.status} />
                      <span className="min-w-0 grow">
                        <span className="block truncate font-medium">{pull.title}</span>
                        <span className="font-mono text-xs text-muted">
                          {repo.namespace}/{repo.name}#{pull.number}
                          {pull.issue != null && ` · for #${pull.issue}`} · {pull.agent}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted">
                        {pull.status === "draft" ? "In progress" : "Ready for review"}
                      </span>
                      <span className="w-14 shrink-0 text-right text-xs text-faint">
                        <TimeAgo at={pull.updatedAt} />
                      </span>
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
            Add g1t to Claude Code, then run /mcp in it to sign in through
            your browser.
          </p>
          <div className="mt-4 space-y-2">
            <CopyLine
              prompt
              text="claude mcp add --transport http g1t https://mcp.g1t.sh"
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
            Browse public repositories and the issues open on them.
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
