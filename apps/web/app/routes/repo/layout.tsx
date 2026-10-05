import { Box, CircleDot, Code2, GitPullRequest, History, LayoutGrid, ListTree, Lock, Rocket, Settings } from "lucide-react";
import { Link, NavLink, Outlet, data, useLocation, useRouteLoaderData } from "react-router";

import type { Project } from "@g1t/contracts";

import type { Route } from "./+types/layout";
import { page } from "../../lib/meta";
import { type Tab as PageTab, tabsFor } from "../../lib/project-nav";
import { Pill, TabLink as Tab } from "../../components/ui";
import { redirectIfRenamed } from "../../lib/renamed.server";
import { projects, repos, work } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaded?.project?.name ?? params.repo} · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const [repo, counts, found] = await Promise.all([
    repos.get(path, viewer),
    work.counts(path, viewer),
    projects.get(params.owner, params.repo, viewer),
  ]);
  if (!repo.ok && !found.ok) {
    // Under a workspace's old name, after a rename: the project is at the new one.
    await redirectIfRenamed(request, params.owner);
    throw data(null, { status: 404 });
  }
  let project: Project | null = found.ok ? found.value : null;
  // A repository made a moment ago, before its project: make it now.
  if (!project && repo.ok && !repo.value.forkOf) {
    const own = await projects.byRepo(repo.value.id);
    project = own.find((p) => p.slug === params.repo.toLowerCase()) ?? own[0] ?? null;
  }
  return {
    repo: unwrap(repo),
    project,
    open: counts.ok ? counts.value : { issues: 0, pulls: 0 },
    member: roleIn(viewer, params.owner) != null,
  };
}

/** The project the page is in, for the pages under it. */
export function useProject() {
  return useRouteLoaderData<typeof loader>("routes/repo/layout");
}

function Header({ project, isPrivate, namespace, name, description, large }: {
  project: Project | null;
  isPrivate: boolean;
  namespace: string;
  name: string;
  description: string | null;
  large?: boolean;
}) {
  const base = `/${namespace}/${name}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span
        className={`flex shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line ${large ? "size-8" : "size-6"}`}
      >
        {isPrivate ? <Lock size={large ? 15 : 13} /> : <Box size={large ? 15 : 13} />}
      </span>
      <h1 className={large ? "text-lg" : "text-[0.9375rem]"}>
        <Link to={`/${namespace}`} className="font-mono text-muted hover:text-fg">
          {namespace}
        </Link>
        <span className="mx-1.5 text-faint">/</span>
        <Link to={base} className="font-semibold hover:underline">
          {project?.name ?? name}
        </Link>
      </h1>
      <Pill>{isPrivate ? "private" : "public"}</Pill>
      {description && <p className="min-w-0 truncate text-sm text-muted">{description}</p>}
    </div>
  );
}

/**
 * The views of the page the project is on, as tabs across its top: Files,
 * Commits and what is coming under Code, and so on. Soon tabs open their
 * roadmap page, under the same tabs.
 */
function PageTabs({ base, tabs }: { base: string; tabs: PageTab[] }) {
  const { pathname } = useLocation();
  const rest = pathname.slice(base.length + 1);
  const current = (tab: PageTab) =>
    [tab.path, ...(tab.also ?? [])].some((path) => rest === path || rest.startsWith(`${path}/`));
  return (
    <nav aria-label="Views" className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map((tab) => (
        <NavLink
          key={tab.path}
          to={`${base}/${tab.path}`}
          title={tab.about}
          prefetch="intent"
          className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 pt-1 pb-2.5 text-sm transition-colors ${
            current(tab)
              ? "border-accent font-medium text-fg"
              : tab.soon
                ? "border-transparent text-faint hover:text-muted"
                : "border-transparent text-muted hover:text-fg"
          }`}
        >
          {tab.label}
          {/* Soon, said quietly: a dot, with the word for screen readers. */}
          {tab.soon && (
            <>
              <span aria-hidden="true" className="size-1.5 rounded-full bg-accent/70" />
              <span className="sr-only">(soon)</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

export default function ProjectLayout({ loaderData }: Route.ComponentProps) {
  const { repo, project, open, member } = loaderData;
  const base = `/${repo.namespace}/${repo.name}`;
  const signedIn = useRouteLoaderData("root")?.user != null;
  const description = project?.description ?? repo.description;
  const { pathname } = useLocation();
  const tabs = tabsFor(pathname.slice(base.length + 1), member);
  if (signedIn) {
    return (
      <>
        <div className="border-b border-line">
          <div className={`mx-auto max-w-6xl px-4 sm:px-6 ${tabs ? "pt-3" : "py-3"}`}>
            <Header
              project={project}
              isPrivate={repo.isPrivate}
              namespace={repo.namespace}
              name={repo.name}
              description={description}
            />
            {tabs && (
              <div className="mt-3">
                <PageTabs base={base} tabs={tabs} />
              </div>
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
      {/* The project's own header band, under the site header. */}
      <div className="border-b border-line bg-surface/60">
        <div className="mx-auto max-w-6xl px-4 pt-6">
          <Header
            project={project}
            isPrivate={repo.isPrivate}
            namespace={repo.namespace}
            name={repo.name}
            description={null}
            large
          />
          {description && <p className="mt-2 max-w-2xl text-sm text-muted">{description}</p>}
          <nav className="mt-5 flex gap-6 overflow-x-auto">
            <Tab to={base} end icon={<LayoutGrid size={15} />}>
              Overview
            </Tab>
            <Tab to={`${base}/code`} also={`${base}/tree`} icon={<Code2 size={15} />}>
              Code
            </Tab>
            <Tab to={`${base}/issues`} icon={<CircleDot size={15} />} count={open.issues}>
              Issues
            </Tab>
            <Tab to={`${base}/pulls`} also={`${base}/pull`} icon={<GitPullRequest size={15} />} count={open.pulls}>
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
              <Tab to={`${base}/deployments`} icon={<Rocket size={15} />}>
                Deployments
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
