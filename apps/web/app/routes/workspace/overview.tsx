import { ArrowRight, ArrowUpRight, Box, CircleDot, GitBranch, GitPullRequest, KeyRound, Lock, Pin, Plus, Rocket } from "lucide-react";
import { Link, redirect } from "react-router";

import type { PackageSummary, Project, ProjectDeploys, User } from "@g1t/contracts";

import type { Route } from "./+types/overview";
import { DeployLink, host, StatusDot } from "../../components/deploy";
import { Avatar, ButtonLink, CopyLine, Pill, TimeAgo } from "../../components/ui";
import { UsageCard } from "../../components/usage-card";
import { PullIcon } from "../../components/work-icons";
import { openedBy } from "../../lib/opened-by";
import { cloneUrl, useAddresses } from "../../lib/addresses";
import { kindLabel, libraryPackages, packageLine, packagePath, primaryLink } from "../../lib/project-kind";
import { PinButton } from "../../components/pin-button";
import { sortProjects } from "../../lib/project-list";
import { usageFor } from "../../lib/workspace-usage.server";
import { deployments, identity, packages, projects as projectsApi, work } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";
import { workspaceProjects } from "../../lib/workspace-projects.server";

/** Projects whose open issues and pull requests are counted: the most active. */
const MAX_COUNTED = 30;
/** Projects shown under Recently active, after the pins. */
const MAX_ACTIVE = 6;
/** Projects whose pull requests are listed under "In progress". */
const MAX_LISTED = 8;
const MAX_PULLS = 8;
const MAX_FACES = 8;
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  // A member's way in is Today; this page
  // is the workspace as a visitor sees it.
  if (role) throw redirect(`/${slug}/-/today`);
  const [listed, members, deploys, usage, published, shortcuts] = await Promise.all([
    // The listing the sidebar and the Projects tab share.
    workspaceProjects(slug, viewer),
    role ? identity.listMembers(slug, viewer) : null,
    role ? deployments.overview(slug, viewer) : null,
    role ? usageFor(slug, viewer) : null,
    // One listing for every card: a library's card shows its package where an app's shows production.
    packages.list(slug, viewer).catch(() => null),
    // The viewer's pins lead the page, as they lead the sidebar.
    role ? projectsApi.shortcuts(slug, viewer).catch(() => null) : null,
  ]);
  const projects = listed.ok ? listed.value : [];
  const pinnedIds = new Set((shortcuts?.pinned ?? []).map((project) => project.id));
  const byId = new Map(projects.map((project) => [project.id, project]));
  const pinned = (shortcuts?.pinned ?? []).map((pin) => byId.get(pin.id)).filter((project): project is Project => project != null);
  // However many there are: the most active first, archived ones last.
  const byActivity = sortProjects(
    projects.map((project) => ({ ...project, pushedAt: project.pushedAt ?? null, activity: project.activity ?? 0, deploying: false })),
    "active",
  )
    .sort((a, b) => Number(a.archived) - Number(b.archived))
    .map((listedProject) => byId.get(listedProject.id)!);
  const active = byActivity.filter((project) => !pinnedIds.has(project.id)).slice(0, MAX_ACTIVE);

  const pathOf = (project: Project) =>
    project.source.kind === "hosted" ? project.source.repo : { namespace: project.workspace, name: project.slug };
  const counted = [...new Map([...pinned, ...active, ...byActivity].map((project) => [project.id, project])).values()].slice(0, Math.max(MAX_COUNTED, pinned.length + active.length));
  const counts = await Promise.all(counted.map((project) => work.counts(pathOf(project), viewer)));
  const open: Record<string, { issues: number; pulls: number }> = {};
  counted.forEach((project, i) => {
    const result = counts[i];
    if (result.ok) open[project.id] = result.value;
  });

  const busy = counted.filter((project) => (open[project.id]?.pulls ?? 0) > 0).slice(0, MAX_LISTED);
  const lists = await Promise.all(busy.map((project) => work.listPulls(pathOf(project), viewer, "open")));
  const pulls = lists
    .flatMap((result, i) => (result.ok ? result.value.map((pull) => ({ pull, project: busy[i] })) : []))
    .sort((a, b) => b.pull.updatedAt.localeCompare(a.pull.updatedAt))
    .slice(0, MAX_PULLS);

  const bySlug: Record<string, ProjectDeploys> = {};
  for (const entry of deploys?.ok ? deploys.value : []) bySlug[entry.slug] = entry;

  const byRepo = new Map<string, PackageSummary[]>();
  for (const pkg of published?.ok ? published.value : []) {
    if (pkg.repo) byRepo.set(pkg.repo.id, [...(byRepo.get(pkg.repo.id) ?? []), pkg]);
  }
  const packageOf: Record<string, PackageSummary> = {};
  for (const project of [...pinned, ...active]) {
    if ((project.kind !== "library" && project.kind !== "tool") || project.source.kind !== "hosted") continue;
    const first = libraryPackages(byRepo.get(project.source.repoId) ?? [])[0];
    if (first) packageOf[project.id] = first;
  }

  return {
    slug,
    role,
    total: projects.length,
    elsewhere: projects.filter((project) => project.runs === "elsewhere" && project.productionUrl).length,
    pinned,
    active,
    open,
    deploys: bySlug,
    packageOf,
    pulls: pulls.map(({ pull, project }) => ({ pull, slug: project.slug, name: project.name })),
    members: members?.ok ? members.value : null,
    usage,
  };
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <p className="text-xl font-semibold tabular-nums tracking-tight">{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

/** What a member sees in a workspace with no projects yet. */
function GetStarted({ slug }: { slug: string }) {
  const addresses = useAddresses();
  return (
    <div className="rounded-2xl border border-line bg-surface p-8">
      <span className="flex size-10 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/30">
        <Box size={18} />
      </span>
      <h2 className="mt-4 text-lg font-semibold tracking-tight">Create your first project</h2>
      <p className="mt-1.5 max-w-xl text-sm text-muted">
        A project is what you build and run: its code, the issues that say what should change, the agents and
        people who change it, and where it is deployed.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <ButtonLink to={`/new?workspace=${slug}`} variant="accent">
          <Plus size={14} />
          New project
        </ButtonLink>
      </div>
      <p className="mt-6 text-sm text-muted">Or push code you already have, and it becomes a project:</p>
      <div className="mt-2 max-w-xl">
        <CopyLine prompt text={`git push ${cloneUrl(addresses, `${slug}/my-project`)} main`} />
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  open,
  deploys,
  pkg,
  member,
  pinned,
}: {
  project: Project;
  open: { issues: number; pulls: number } | undefined;
  deploys: ProjectDeploys | undefined;
  /** For a library, the package it publishes. */
  pkg: PackageSummary | undefined;
  member: boolean;
  /** Whether the viewer pinned it; null when they cannot pin. */
  pinned: boolean | null;
}) {
  // A library or a tool shows the package it publishes.
  const library = project.kind === "library" || project.kind === "tool";
  const base = `/${project.workspace}/${project.slug}`;
  const production = deploys?.production ?? null;
  // Production where g1t serves it or elsewhere, else its homepage or docs.
  const link = primaryLink(project, production?.url);
  const latest = deploys?.latest ?? null;
  const source = project.source.kind === "hosted" ? project.source : null;
  return (
    <li className="group relative flex flex-col rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-line-strong">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted ring-1 ring-line">
          {project.private ? <Lock size={15} /> : <Box size={15} />}
        </span>
        <div className="min-w-0 grow">
          <Link to={base} prefetch="intent" className="font-medium after:absolute after:inset-0 hover:underline">
            {project.name}
          </Link>
          {link && !(library && pkg && !production) ? (
            <DeployLink
              href={link}
              className="relative z-10 mt-0.5 flex items-center gap-1 truncate font-mono text-xs text-muted hover:text-accent"
            >
              {host(link)}
              <ArrowUpRight size={11} className="shrink-0" />
            </DeployLink>
          ) : library && pkg ? (
            <Link
              to={packagePath(pkg)}
              className="relative z-10 mt-0.5 block truncate font-mono text-xs text-muted hover:text-accent"
            >
              {packageLine(pkg)}
            </Link>
          ) : (
            <p className="mt-0.5 truncate text-xs text-faint">
              {project.description ??
                (library
                  ? "Not published yet"
                  : project.runs === "g1t"
                    ? deploys?.enabled
                      ? "Not deployed yet"
                      : "Deployments are off"
                    : kindLabel(project))}
            </p>
          )}
        </div>
        {(project.private || project.archived) && (
          <span className="flex shrink-0 gap-1.5">
            {project.private && <Pill>private</Pill>}
            {project.archived && <Pill>archived</Pill>}
          </span>
        )}
        {pinned != null && (
          <PinButton workspace={project.workspace} slug={project.slug} name={project.name} pinned={pinned} compact className="-mt-1.5 -mr-2" />
        )}
      </div>

      {project.description && (link || (library && pkg)) && <p className="mt-3 line-clamp-2 text-sm text-muted">{project.description}</p>}

      <div className="mt-auto pt-5">
        {member && latest && (
          <p className="mb-3 flex items-center gap-2 text-xs text-muted">
            <StatusDot status={latest.status} />
            <span className="truncate">
              {latest.kind === "production" ? "Production" : `Preview of ${latest.branch}`}
            </span>
            <span className="ml-auto shrink-0 text-faint">
              <TimeAgo at={latest.createdAt} />
            </span>
          </p>
        )}
        <div className="flex items-center gap-4 border-t border-line pt-3 text-xs text-muted">
          {source && (
            <span className="flex min-w-0 items-center gap-1.5 font-mono">
              <GitBranch size={12} className="shrink-0 text-faint" />
              <span className="truncate">{source.defaultBranch}</span>
            </span>
          )}
          <span className="flex items-center gap-1">
            <CircleDot size={12} className="text-faint" />
            {open?.issues ?? 0}
          </span>
          <span className="flex items-center gap-1">
            <GitPullRequest size={12} className="text-faint" />
            {open?.pulls ?? 0}
          </span>
          {member && deploys?.enabled && (deploys.previews ?? 0) > 0 && (
            <span className="ml-auto flex items-center gap-1 text-success">
              <Rocket size={12} />
              {deploys.previews} {deploys.previews === 1 ? "preview" : "previews"}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export default function WorkspaceOverview({ loaderData }: Route.ComponentProps) {
  const { slug, role, total, pinned, active, open, deploys, pulls, members, usage } = loaderData;
  const card = (project: Project, isPinned: boolean) => (
    <ProjectCard
      key={project.id}
      project={project}
      open={open[project.id]}
      deploys={deploys[project.slug]}
      pkg={loaderData.packageOf[project.id]}
      member={role != null}
      pinned={role ? isPinned : null}
    />
  );
  const totals = Object.values(open).reduce(
    (sum, counts) => ({ issues: sum.issues + counts.issues, pulls: sum.pulls + counts.pulls }),
    { issues: 0, pulls: 0 },
  );
  // Live on g1t, or deployed elsewhere with an address.
  const liveApps =
    Object.values(deploys).filter((entry) => entry.production).length +
    loaderData.elsewhere;
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-10">
        {total === 0 && role ? (
          <GetStarted slug={slug} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat value={total} label={total === 1 ? "Project" : "Projects"} />
              <Stat value={liveApps} label="In production" />
              <Stat value={totals.issues} label="Open issues" />
              <Stat value={totals.pulls} label="Pull requests in progress" />
            </div>

            {role && (
              <section aria-labelledby="pinned">
                <h2 id="pinned" className="text-sm font-medium text-muted">
                  Pinned
                </h2>
                {pinned.length > 0 ? (
                  <ul className="mt-3 grid gap-4 sm:grid-cols-2">{pinned.map((project) => card(project, true))}</ul>
                ) : (
                  <p className="mt-3 flex items-center gap-2 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">
                    <Pin size={14} className="shrink-0 text-faint" />
                    Pin the projects you use most, from their page or from Projects, to keep them here and in your sidebar.
                  </p>
                )}
              </section>
            )}

            {active.length > 0 && (
              <section aria-labelledby="active">
                <div className="flex items-center justify-between">
                  <h2 id="active" className="text-sm font-medium text-muted">
                    {role ? "Recently active" : "Projects"}
                  </h2>
                  {role && (
                    <Link to={`/new?workspace=${slug}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                      <Plus size={13} />
                      New project
                    </Link>
                  )}
                </div>
                <ul className="mt-3 grid gap-4 sm:grid-cols-2">{active.map((project) => card(project, false))}</ul>
              </section>
            )}

            <Link
              to={`/${slug}/-/projects`}
              prefetch="intent"
              className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-sm transition-colors hover:border-line-strong"
            >
              <span>
                All projects <span className="tabular-nums text-muted">({total})</span>
              </span>
              <span className="flex items-center gap-1 text-xs text-muted">
                Search, filter and sort
                <ArrowRight size={13} />
              </span>
            </Link>

            {pulls.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-muted">In progress</h2>
                <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                  {pulls.map(({ pull, slug: project, name }) => (
                    <li key={pull.id}>
                      <Link
                        prefetch="intent"
                        to={`/${slug}/${project}/pull/${pull.number}`}
                        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
                      >
                        <PullIcon status={pull.status} />
                        <span className="min-w-0 grow">
                          <span className="block truncate font-medium">{pull.title}</span>
                          <span className="text-xs text-muted">
                            {name} <span className="font-mono">#{pull.number}</span>
                            {pull.issue != null && ` · for #${pull.issue}`} · {openedBy(pull).name}
                          </span>
                        </span>
                        <span className="hidden shrink-0 text-xs text-muted sm:block">
                          {pull.status === "draft" ? "Being worked on" : "Ready for review"}
                        </span>
                        <span className="w-14 shrink-0 text-right text-xs text-faint">
                          <TimeAgo at={pull.updatedAt} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      <aside className="space-y-6">
        {role && usage && <UsageCard slug={slug} glance={usage} owner={role === "owner"} />}

        {members ? (
          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Members</h2>
              <Link to={`/${slug}/-/people`} className="text-xs text-muted hover:text-fg">
                {role === "owner" ? "Manage" : "See all"}
              </Link>
            </div>
            <ul className="mt-3 space-y-1.5">
              {members.slice(0, MAX_FACES).map((member) => (
                <li key={member.username} className="flex items-center gap-2 text-sm">
                  <Avatar name={member.username} />
                  <span className="grow truncate font-mono">{member.username}</span>
                  {member.role === "owner" && <Pill>owner</Pill>}
                </li>
              ))}
            </ul>
            {members.length > MAX_FACES && <p className="mt-2 text-xs text-faint">and {members.length - MAX_FACES} more</p>}
          </section>
        ) : (
          <p className="text-sm text-muted">
            Members of this workspace build its projects. Anyone can open an issue or a pull request on a public one.
          </p>
        )}

        {role && (
          <section className="rounded-xl border border-line bg-surface p-5">
            <h2 className="flex items-center gap-2 font-medium">
              <Rocket size={15} className="text-faint" />
              Deploy on g1t.page
            </h2>
            <p className="mt-1.5 text-sm text-muted">
              Off until you turn them on for a project, under its Settings. Then production builds from its default
              branch, with a live preview for every pull request. Apps cost nothing while no one visits.
            </p>
            <Link
              prefetch="intent"
              to={`/${slug}/-/billing`}
              className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline"
            >
              Billing and plans <ArrowRight size={13} />
            </Link>
          </section>
        )}

        {role && (
          <section className="rounded-xl border border-line bg-surface p-5">
            <h2 className="flex items-center gap-2 font-medium">
              <KeyRound size={15} className="text-faint" />
              Automate without a service account
            </h2>
            <p className="mt-1.5 text-sm text-muted">
              A workspace has access tokens of its own for CI, integrations and agents. They act as the workspace,
              not as a person.
            </p>
            <Link
              prefetch="intent"
              to={`/${slug}/-/tokens`}
              className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline"
            >
              Access tokens <ArrowRight size={13} />
            </Link>
          </section>
        )}
      </aside>
    </div>
  );
}
