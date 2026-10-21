import { waitUntil } from "cloudflare:workers";
import { Box, GitFork, Link2, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Outlet, type ShouldRevalidateFunctionArgs, data, useLocation, useRouteLoaderData } from "react-router";

import type { Project } from "@g1t/contracts";

import type { Route } from "./+types/layout";
import { AboutEditor, LinkList } from "../../components/project-about";
import { Topics } from "../../components/topics";
import { projectHomepage } from "../../lib/about";
import { page } from "../../lib/meta";
import { type Tab as PageTab, tabsFor } from "../../lib/project-nav";
import { Badge } from "../../components/ui/badge";
import { Hint } from "../../components/ui/hint";
import { NavTab, NavTabs } from "../../components/ui/nav-tabs";
import { ProjectStrip } from "../../components/mobile";
import { seesSettings } from "../../lib/access";
import { WatchMenu } from "../../components/notifications";
import { PinButton } from "../../components/pin-button";
import { StarButton } from "../../components/star-button";
import { ForkButton, type Forking } from "../../components/fork-button";
import { ArchivedBanner } from "../../components/repo-lifecycle";
import { WelcomeBanner } from "../../components/welcome";
import { clearWelcome, welcomes } from "../../lib/invites";
import { notFound } from "../../lib/not-found.server";
import { redirectIfRenamed, redirectIfTransferred } from "../../lib/renamed.server";
import { accessFor, countsFor, projectFor, repoFor } from "../../lib/access.server";
import { shortCache } from "../../lib/cache.server";
import { inbox, projects, repos, work } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";
import { isFailed, orElse, part } from "../../lib/partial";

/** How many forks the header counts before it says "100+". */
const FORKS_COUNTED = 100;

/** How long the data centre keeps whether a project files work items, for its menus. */
const WORK_ITEMS_ENABLED_TTL_MS = 300_000;

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaded?.project?.name ?? params.repo} · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  // Members pin the workspace's projects, and what they open is their Recent.
  const member = viewer ? roleIn(viewer, params.owner) != null : false;
  const [repo, counts, found, watching, shortcuts, stars, forks, workItems] = await Promise.all([
    repoFor(context, params),
    // The repository is what the frame is about; its open counts are only
    // the tabs' badges, which do without them.
    part(countsFor(context, params), "Open counts"),
    projectFor(context, params),
    // How the person watches it, for the header's Watch menu, as soon as
    // the repository is known.
    viewer ? repoFor(context, params).then((found) => (found.ok ? inbox.watching(viewer.username, found.value.id).catch(() => null) : null)) : null,
    // Whether they pinned it, for the header's Pin button.
    member ? projects.shortcuts(params.owner, viewer).catch(() => null) : null,
    // How many starred it and whether they did, for the header's Star button.
    repos
      .stars(path, viewer)
      .then((found) => (found.ok ? found.value : null))
      .catch(() => null),
    // Its forks the viewer can see, counted up to 100, for the header's Fork button.
    repos
      .forks(path, viewer, FORKS_COUNTED)
      .then((found) => (found.ok ? found.value.length : null))
      .catch(() => null),
    // Whether work items can be filed from it (off by default in a fork): Work
    // leaves its menus when they cannot. On when it could not be read. It
    // rarely changes and every page of the project asks, so the data centre
    // keeps that one answer for the project (an unanswered read is not
    // kept); whoever changes it reads it fresh.
    shortCache(`work-items-enabled:${params.owner}/${params.repo}`.toLowerCase(), WORK_ITEMS_ENABLED_TTL_MS, async () => {
      const found = await work.getSettings(path, viewer);
      if (!found.ok) throw new Error(found.error.message);
      return found.value.workItemsEnabled ?? true;
    }).catch(() => true),
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
    // The repository still has its page when its project cannot be read: drawn by its own name.
    const own = orElse(await part(projects.byRepo(repo.value.id), "Its project"), []);
    project = own.find((p) => p.slug === params.repo.toLowerCase()) ?? own[0] ?? null;
  }
  // Opened just now: it leads their Recent, recorded after the page is sent.
  if (member && project) waitUntil(projects.visited(viewer!, project.id).catch(() => undefined));
  const value = unwrap(repo);
  // The viewer's role on the repository and what it lets them do, for the
  // pages under it and the sidebar.
  const access = accessFor(viewer, value);
  // Just given access with an invite: welcomed once (routes/invite.tsx).
  const welcome = Boolean(access.role) && welcomes(request.headers.get("cookie"), `${value.namespace}/${value.name}`);
  // Fork shows when it may be forked, and to its admins turned off when it
  // may not; never on a pull request's working copy.
  const forkable = !value.isPrivate || Boolean(value.allowForking);
  const forking: Forking | null =
    value.forkOf || forks == null || (!forkable && !access.can.administer)
      ? null
      : { count: Math.min(forks, FORKS_COUNTED), more: forks >= FORKS_COUNTED, allowed: forkable };
  const headers = welcome ? { "Set-Cookie": clearWelcome(new URL(request.url).protocol === "https:") } : undefined;
  return data(
    {
      welcome,
      repo: value,
      project,
      open: !isFailed(counts) && counts.ok ? counts.value : { items: 0, pulls: 0 },
      access,
      member: access.insider,
      watching,
      // Null for a pull request's working copy, or when it could not be read.
      stars: value.forkOf ? null : stars,
      forking,
      workItems,
      signedIn: Boolean(viewer),
      // Null when they cannot pin it: not one of their workspaces.
      pinned: member && project ? (shortcuts?.pinned ?? []).some((pinned) => pinned.id === project.id) : null,
    },
    { headers },
  );
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

/** The project's name row: its kind, owner and name, visibility, and Pin, Watch and Star at the end. */
function Header({
  project,
  isPrivate,
  archived,
  namespace,
  name,
  actions,
  parent,
}: {
  project: Project | null;
  /** The repository it was forked from, when the viewer can see it. */
  parent?: { namespace: string; name: string } | null;
  isPrivate: boolean;
  namespace: string;
  name: string;
  archived?: boolean;
  /** At the end of the row: Pin, Watch and Star. */
  actions?: ReactNode;
}) {
  const base = `/${namespace}/${name}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {/* One size on every tab, so moving between them never shifts the page under the header. */}
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
        {isPrivate ? <Lock size={14} /> : <Box size={14} />}
      </span>
      <h1 className="text-base">
        <Link to={`/${namespace}`} className="font-mono text-muted hover:text-fg">
          {namespace}
        </Link>
        <span className="mx-1.5 text-faint">/</span>
        <Link to={base} className="font-semibold hover:underline">
          {project?.name ?? name}
        </Link>
      </h1>
      <Badge size="md">{isPrivate ? "private" : "public"}</Badge>
      {archived && <Badge size="md">archived</Badge>}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      {parent && (
        <p className="flex basis-full items-center gap-1.5 text-xs text-muted">
          <GitFork size={12} className="shrink-0 text-faint" />
          forked from
          <Link to={`/${parent.namespace}/${parent.name}`} className="font-mono text-fg/80 hover:text-accent hover:underline">
            {parent.namespace}/{parent.name}
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * The views of the section the page is in (Files, Commits and the rest
 * under Code, and so on), at the top of the page's content: a secondary
 * row that belongs to what is under it, not a second header. It runs the
 * content's width on a rule of its own, so it heads everything below it
 * and outweighs the filters there. Soon tabs open their roadmap page,
 * under the same tabs.
 */
function PageTabs({ base, tabs }: { base: string; tabs: PageTab[] }) {
  const { pathname } = useLocation();
  const rest = pathname.slice(base.length + 1);
  const current = (tab: PageTab) => [tab.path, ...(tab.also ?? [])].some((path) => rest === path || (!tab.exact && rest.startsWith(`${path}/`)));
  return (
    <div className="mb-6 border-b border-line pb-3">
      <NavTabs label="Views" variant="pill">
        {tabs.map((tab) => (
          <Hint key={tab.path} label={tab.about}>
            <NavTab variant="pill" to={`${base}/${tab.path}`} current={current(tab)} soon={tab.soon}>
              {tab.label}
            </NavTab>
          </Hint>
        ))}
      </NavTabs>
    </div>
  );
}

export default function ProjectLayout({ loaderData }: Route.ComponentProps) {
  const { repo, project, member, access, welcome, watching, pinned, stars, forking, signedIn } = loaderData;
  const base = `/${repo.namespace}/${repo.name}`;
  // A repository has no description: its project's is shown.
  const description = project?.description ?? null;
  // Its homepage, else the repository's website.
  const site = projectHomepage(project) ?? repo.website ?? null;
  const { pathname } = useLocation();
  const rest = pathname.slice(base.length + 1);
  const tabs = tabsFor(rest, member, access.can);
  // One row of tabs for the project's pages, along the header's border (a
  // member's sidebar has them on a computer), and the views of the section
  // the page is in as a quieter row at the top of its content.
  return (
    <>
      <div data-page-head className="border-b border-line">
        {/* The project's pages close the header for a visitor, and on a phone; a member's sidebar lists them from 768px. */}
        <div className={`mx-auto max-w-7xl px-4 pt-4 sm:px-5 ${signedIn ? "pb-4 max-md:pb-0" : ""}`}>
          <Header
            project={project}
            isPrivate={repo.isPrivate}
            archived={Boolean(repo.archivedAt)}
            namespace={repo.namespace}
            name={repo.name}
            parent={repo.parent}
            actions={
              watching || stars || forking || (project && (pinned != null || access.can.manage_settings)) ? (
                <>
                  {project && access.can.manage_settings && <AboutEditor project={project} action={`${base}?index`} />}
                  {project && pinned != null && <PinButton workspace={project.workspace} slug={project.slug} name={project.name} pinned={pinned} />}
                  {watching && <WatchMenu action={`${base}/notifications`} level={watching.level} events={watching.events} />}
                  {forking && <ForkButton base={base} name={`${repo.namespace}/${repo.name}`} forking={forking} signedIn={signedIn} />}
                  {stars && <StarButton base={base} name={`${repo.namespace}/${repo.name}`} stars={stars} signedIn={signedIn} />}
                </>
              ) : null
            }
          />
          {/* What it is, where it lives and its topics, the same on every page of it. */}
          {description && <p className="mt-2 max-w-3xl text-sm text-muted">{description}</p>}
          {project ? (
            <LinkList links={{ ...project.links, homepage: project.links.homepage ?? site }} className="mt-2 flex flex-wrap gap-x-5 gap-y-2 space-y-0" />
          ) : (
            site && (
              <a href={site} rel="noopener nofollow" className="mt-2 inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
                <Link2 size={14} />
                {site.replace(/^https?:\/\//, "")}
              </a>
            )
          )}
          <Topics topics={repo.topics} className="mt-3" />
          <div className={signedIn ? "mt-3 md:hidden" : "mt-3"}>
            <ProjectStrip base={base} member={member} can={access.can} settings={seesSettings(access)} counts={loaderData.open} always={!signedIn} />
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-5">
        {tabs && <PageTabs base={base} tabs={tabs} />}
        {welcome && (
          <div className="mb-6">
            <WelcomeBanner title={`You're in ${repo.namespace}/${repo.name}`}>
              You have the {access.role} role on it now. Its code, work items and pull requests are yours to work on.
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
