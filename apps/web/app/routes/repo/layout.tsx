import { Box, Lock } from "lucide-react";
import { Link, NavLink, Outlet, type ShouldRevalidateFunctionArgs, data, useLocation, useRouteLoaderData } from "react-router";

import type { Project } from "@g1t/contracts";

import type { Route } from "./+types/layout";
import { Topics } from "../../components/topics";
import { page } from "../../lib/meta";
import { type Tab as PageTab, tabsFor } from "../../lib/project-nav";
import { Pill } from "../../components/ui";
import { ArchivedBanner } from "../../components/repo-lifecycle";
import { WelcomeBanner } from "../../components/welcome";
import { clearWelcome, welcomes } from "../../lib/invites";
import { notFound } from "../../lib/not-found.server";
import { redirectIfRenamed, redirectIfTransferred } from "../../lib/renamed.server";
import { accessFor, countsFor, repoFor } from "../../lib/access.server";
import { projects } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaded?.project?.name ?? params.repo} · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const [repo, counts, found] = await Promise.all([
    repoFor(context, params),
    countsFor(context, params),
    projects.get(params.owner, params.repo, viewer),
  ]);
  if (!repo.ok && !found.ok) {
    // Under a workspace's old name, after a rename: the project is at the new one.
    await redirectIfRenamed(request, params.owner);
    // A repository transferred to another workspace: it is there now.
    await redirectIfTransferred(request, params.owner, params.repo, viewer);
    throw notFound("project");
  }
  let project: Project | null = found.ok ? found.value : null;
  // A repository made a moment ago, before its project: make it now.
  if (!project && repo.ok && !repo.value.forkOf) {
    const own = await projects.byRepo(repo.value.id);
    project = own.find((p) => p.slug === params.repo.toLowerCase()) ?? own[0] ?? null;
  }
  const value = unwrap(repo);
  // The viewer's role on the repository and what it lets them do, for the
  // pages under it and the sidebar.
  const access = accessFor(viewer, value);
  // Just given access with an invite: welcomed once (routes/invite.tsx).
  const welcome = Boolean(access.role) && welcomes(request.headers.get("cookie"), `${value.namespace}/${value.name}`);
  const headers = welcome ? { "Set-Cookie": clearWelcome(new URL(request.url).protocol === "https:") } : undefined;
  return data({
    welcome,
    repo: value,
    project,
    open: counts.ok ? counts.value : { issues: 0, pulls: 0 },
    access,
    member: access.insider,
  }, { headers });
}

/**
 * The project's header, tabs and the viewer's role change with the project
 * or after something was submitted, not from one page of it to the next,
 * nor when a page refreshes itself.
 */
export function shouldRevalidate({ currentParams, nextParams, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  return currentParams.owner !== nextParams.owner || currentParams.repo !== nextParams.repo;
}

/** The project the page is in, for the pages under it. */
export function useProject() {
  return useRouteLoaderData<typeof loader>("routes/repo/layout");
}

/** A repository's topics, each a way into Explore. */
function Header({ project, isPrivate, archived, namespace, name, description, large }: {
  project: Project | null;
  isPrivate: boolean;
  namespace: string;
  name: string;
  description: string | null;
  archived?: boolean;
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
      {archived && <Pill>archived</Pill>}
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
    <nav aria-label="Views" className="relative -mb-px flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
  const { repo, project, member, access, welcome } = loaderData;
  const base = `/${repo.namespace}/${repo.name}`;
  // The project's own description, else the repository's as it is now.
  const description = (project && !project.descriptionInherited ? project.description : null) ?? repo.description;
  const { pathname } = useLocation();
  const tabs = tabsFor(pathname.slice(base.length + 1), member, access.can);
  // The files' own About says what it is and its topics, as the one place.
  const filesPage = /^(code|tree)(\/|$)/.test(pathname.slice(base.length + 1));
  // Everyone, signed in or not, finds the project's pages in the sidebar;
  // the page shows its name, and the views of the page it is on as tabs.
  return (
    <>
      <div className="border-b border-line">
        <div className={`mx-auto max-w-6xl px-4 sm:px-6 ${tabs ? "pt-3" : "py-3"}`}>
          <Header
            project={project}
            isPrivate={repo.isPrivate}
            archived={Boolean(repo.archivedAt)}
            namespace={repo.namespace}
            name={repo.name}
            // The files' own About says it there, as the one place.
            description={filesPage ? null : description}
          />
          {/* On the files' pages, About shows them. */}
          {!filesPage && <Topics topics={repo.topics} />}
          {tabs && (
            <div className="mt-3">
              <PageTabs base={base} tabs={tabs} />
            </div>
          )}
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {welcome && (
          <div className="mb-6">
            <WelcomeBanner title={`You're in ${repo.namespace}/${repo.name}`}>
              You have the {access.role} role on it now. Its code, issues and pull requests are yours to work on.
            </WelcomeBanner>
          </div>
        )}
        {repo.archivedAt && (
          <div className="mb-6">
            <ArchivedBanner base={base} owner={access.can.administer} settings={/^settings(\/|$)/.test(pathname.slice(base.length + 1))} />
          </div>
        )}
        <Outlet />
      </div>
    </>
  );
}
