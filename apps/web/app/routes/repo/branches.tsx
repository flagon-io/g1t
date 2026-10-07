import { GitBranch, Search } from "lucide-react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/branches";
import { ActiveBranches } from "../../components/branches";
import { Avatar, EmptyState, TimeAgo, notACredential } from "../../components/ui";
import { readBranches } from "../../lib/branches.server";
import { page } from "../../lib/meta";
import { deployments, repos, work } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

/** The most branches read for one page; past that, search narrows them. */
const BRANCHES_READ = 60;
/** A branch whose last commit is older than this is stale. */
const STALE_DAYS = 90;

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Branches · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const viewer = getViewer(context);
  const query = new URL(request.url).searchParams.get("q")?.trim().toLowerCase() || null;
  const soft = <T,>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);
  const [repo, list, pulls, deploys] = await Promise.all([
    repos.get(path, viewer),
    repos.branches(path, viewer),
    soft(work.listPulls(path, viewer, "open")),
    // Previews are for people with a role here; everyone else sees none.
    soft(deployments.list({ workspace: params.owner, slug: params.repo }, viewer)),
  ]);
  const found = unwrap(repo);
  // The merge queue's own branches (g1t-queue/<entry>) are its working
  // copies, not anyone's branch to look at.
  const all = unwrap(list).filter((branch) => !branch.name.startsWith("g1t-queue/"));
  const matching = query ? all.filter((branch) => branch.name === found.defaultBranch || branch.name.toLowerCase().includes(query)) : all;
  const read = await readBranches(
    path,
    viewer,
    {
      defaultBranch: found.defaultBranch,
      branches: matching,
      pulls: pulls?.ok ? pulls.value : [],
      previews: deploys?.ok ? deploys.value.live.filter((app) => app.kind === "preview") : [],
    },
    BRANCHES_READ,
  );
  const staleBefore = Date.now() - STALE_DAYS * 86_400_000;
  const isStale = (at: string | undefined) => at != null && Date.parse(at) < staleBefore;
  return {
    main: found.defaultBranch,
    head: read.head,
    active: read.shown.filter((branch) => !isStale(branch.commit?.at)),
    stale: read.shown.filter((branch) => isStale(branch.commit?.at)),
    // Every branch but the default, and how many matched the search.
    total: all.length - 1,
    matched: read.total,
    unread: Math.max(0, read.total - read.shown.length),
    query,
  };
}

export default function Branches({ loaderData, params }: Route.ComponentProps) {
  const { main, head, active, stale, total, matched, unread, query } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Branches <span className="font-normal text-faint">{total + 1}</span>
        </h2>
        <Form method="get" role="search" className="relative w-full sm:w-72">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <input
            name="q"
            defaultValue={query ?? ""}
            {...notACredential()}
            placeholder="Search branches"
            aria-label="Search branches"
            className="h-8 w-full rounded-md border border-line bg-surface pr-3 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
          />
        </Form>
      </div>

      <section>
        <h3 className="mb-2 text-sm font-medium text-muted">Default</h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3">
          <GitBranch size={15} className="shrink-0 text-faint" />
          <Link to={`${base}/tree/${encodeURIComponent(main)}`} className="font-mono text-[0.8125rem] font-medium hover:text-accent">
            {main}
          </Link>
          <span className="rounded-full border border-line px-2 py-px text-xs text-muted">default</span>
          {head && (
            <span className="flex min-w-0 grow basis-64 items-center gap-1.5 text-xs text-muted">
              <Avatar name={head.author} size={13} />
              <span className="shrink-0">{head.author}</span>
              <span className="text-faint">·</span>
              <Link to={`${base}/commit/${head.hash}`} className="min-w-0 truncate hover:text-fg" title={head.message}>
                {head.message}
              </Link>
              <span className="shrink-0 text-faint">
                · <TimeAgo at={head.at} />
              </span>
            </span>
          )}
        </div>
      </section>

      {query && (
        <p className="text-sm text-muted">
          {matched} of {total} {total === 1 ? "branch matches" : "branches match"} “{query}”.{" "}
          <Link to={`${base}/branches`} className="text-fg hover:underline">
            Clear
          </Link>
        </p>
      )}

      {active.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-muted">Active</h3>
          <ActiveBranches branches={active} base={base} main={main} />
        </section>
      )}
      {stale.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-muted">Stale</h3>
          <p className="-mt-1 mb-2 text-xs text-faint">No commits in the last 90 days.</p>
          <ActiveBranches branches={stale} base={base} main={main} />
        </section>
      )}
      {active.length === 0 && stale.length === 0 && (
        <EmptyState title={query ? "No branch matches" : "Only the default branch"}>
          {query
            ? "Try another part of the name."
            : "Branches agents and people push show here, each with its pull request, checks and how far it has moved from the default branch."}
        </EmptyState>
      )}
      {unread > 0 && (
        <p className="text-xs text-faint">
          {unread} more {unread === 1 ? "branch is" : "branches are"} not shown. Search to find one by name.
        </p>
      )}
    </div>
  );
}
