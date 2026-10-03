import { ArrowRight, Hand, Plus } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Link, data, useRevalidator } from "react-router";

import type { Lifecycle, Pull, Repo } from "@g1t/contracts";

import type { Route } from "./+types/home";
import { Landing } from "../components/landing";
import { STAGE_LABEL, StageDots } from "../components/lifecycle";
import { RepoList } from "../components/repo-list";
import {
  Avatar,
  ButtonLink,
  CopyLine,
  EmptyState,
  TimeAgo,
} from "../components/ui";
import { Assignee, IssueIcon, PullIcon } from "../components/work";
import { repos as reposApi, work } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

const REFRESH_MS = 5000;

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

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return { "Server-Timing": loaderHeaders.get("Server-Timing") ?? "" };
}

export async function loader({ context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const started = Date.now();
  const times: Record<string, number> = {};
  const timed = <T,>(name: string, promise: Promise<T>) =>
    promise.then((value) => ((times[name] = Date.now() - started), value));
  const [repos, pulls, assigned] = await Promise.all([
    timed("repos", reposApi.list(viewer, { memberOnly: Boolean(viewer) })),
    timed("pulls", work.listActivePulls(viewer)),
    timed("assigned", work.listAssignedIssues(viewer)),
  ]);
  // Each issue and pull request is shown under its repository. Most are in
  // the viewer's own, already listed; the rest are looked up once each, all
  // at once. One the viewer can no longer see drops out.
  const known = new Map<string, Repo>(repos.map((repo) => [repo.id, repo]));
  const missing = [
    ...new Set([...assigned.map((issue) => issue.repoId), ...pulls.map(({ pull }) => pull.repoId)]),
  ].filter((id) => !known.has(id));
  const looked = await Promise.all(missing.map((id) => reposApi.getById(id, viewer)));
  for (const found of looked) if (found.ok) known.set(found.value.id, found.value);
  times.lookups = Date.now() - started;
  const serverTiming = Object.entries(times)
    .map(([name, ms]) => `${name};dur=${ms}`)
    .join(", ");
  return data({
    viewer,
    repos,
    assigned: assigned.flatMap((issue) => {
      const repo = known.get(issue.repoId);
      return repo ? [{ issue, repo }] : [];
    }),
    active: pulls.flatMap((item) => {
      const repo = known.get(item.pull.repoId);
      return repo ? [{ ...item, repo }] : [];
    }),
  }, { headers: { "Server-Timing": serverTiming } });
}

type Active = { pull: Pull; lifecycle: Lifecycle | null; repo: Repo };

/** What a pull request is waiting on, in a word or two. */
function standing({ pull, lifecycle }: Active): string {
  if (lifecycle) return STAGE_LABEL[lifecycle.stage];
  return pull.status === "draft" ? "In progress" : "Ready for review";
}

function PullRows({ items, detail }: { items: Active[]; detail?: boolean }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {items.map((item) => {
        const { pull, lifecycle, repo } = item;
        return (
          <li key={pull.id}>
            <Link
              prefetch="intent"
              to={`/${repo.namespace}/${repo.name}/pull/${pull.number}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
            >
              <PullIcon status={pull.status} />
              <span className="min-w-0 grow">
                <span className="block truncate font-medium">{pull.title}</span>
                <span className="block truncate font-mono text-xs text-muted">
                  {repo.namespace}/{repo.name}#{pull.number}
                  {pull.issue != null && ` · for #${pull.issue}`} · {pull.agent}
                </span>
                {detail && lifecycle && (
                  <span className="mt-1 block text-xs text-muted">{lifecycle.detail}</span>
                )}
              </span>
              {lifecycle && (
                <span className="hidden shrink-0 sm:block">
                  <StageDots stage={lifecycle.stage} />
                </span>
              )}
              <span className="w-28 shrink-0 text-right text-xs text-muted">
                {standing(item)}
              </span>
              <span className="hidden w-14 shrink-0 text-right text-xs text-faint sm:block">
                <TimeAgo at={pull.updatedAt} />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h2 className="flex items-center gap-2 text-sm font-medium text-muted">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { viewer, repos, active, assigned } = loaderData;

  const needsYou = active.filter((item) => item.lifecycle?.stage === "needs_you");
  const ready = active.filter((item) => item.lifecycle?.stage === "ready");
  const moving = active.filter(
    (item) => item.lifecycle?.stage !== "needs_you" && item.lifecycle?.stage !== "ready",
  );
  // Agents are at work, so the page changes without anyone touching it.
  const changing = moving.some((item) => item.lifecycle || item.pull.status === "draft");
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!changing) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [changing, revalidator]);

  if (!viewer) return <Landing repos={repos} />;

  const summary = [
    moving.length > 0 && `${moving.length} in progress`,
    ready.length > 0 && `${ready.length} ready to merge`,
    needsYou.length > 0 && plural(needsYou.length, "needs you", "need you"),
    assigned.length > 0 && `${assigned.length} assigned to you`,
  ].filter(Boolean);
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
                {summary.length === 0
                  ? "Nothing is being worked on right now."
                  : `${summary.join(" · ")}.`}
              </p>
            </div>
          </div>
        </section>

        {needsYou.length > 0 && (
          <Section
            title={
              <>
                <Hand size={14} className="text-warn" />
                Needs you
              </>
            }
          >
            <PullRows items={needsYou} detail />
          </Section>
        )}

        {ready.length > 0 && (
          <Section title="Ready to merge">
            <PullRows items={ready} />
          </Section>
        )}

        {assigned.length > 0 && (
          <Section title="Assigned to you">
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {assigned.map(({ issue, repo }) => (
                <li key={issue.id}>
                  <Link
                    prefetch="intent"
                    to={`/${repo.namespace}/${repo.name}/issues/${issue.number}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
                  >
                    <IssueIcon issue={issue} />
                    <span className="min-w-0 grow">
                      <span className="block truncate font-medium">{issue.title}</span>
                      <span className="block truncate font-mono text-xs text-muted">
                        {repo.namespace}/{repo.name}#{issue.number}
                      </span>
                    </span>
                    {issue.agent && <Assignee agent={issue.agent} />}
                    <span className="hidden w-14 shrink-0 text-right text-xs text-faint sm:block">
                      <TimeAgo at={issue.updatedAt} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="In progress">
          {moving.length === 0 ? (
            <EmptyState title="No pull requests in progress">
              Assign issues to the g1t agent from a repository's Issues tab,
              or point your own agent at one.
            </EmptyState>
          ) : (
            <PullRows items={moving} />
          )}
        </Section>

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
