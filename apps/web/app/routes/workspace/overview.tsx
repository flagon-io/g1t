import { ArrowRight, ArrowUpRight, Box, CircleDot, GitBranch, GitPullRequest, KeyRound, Lock, Plus, Rocket } from "lucide-react";
import { Link } from "react-router";

import type { PackageSummary, Project, ProjectDeploys, User } from "@g1t/contracts";

import type { Route } from "./+types/overview";
import { host, StatusDot } from "../../components/deploy";
import { Avatar, ButtonLink, CopyLine, Pill, TimeAgo } from "../../components/ui";
import { UsageCard } from "../../components/usage-card";
import { PullIcon } from "../../components/work-icons";
import { planStatus, type UsageGlance, usageGlance } from "../../lib/billing";
import { openedBy } from "../../lib/opened-by";
import { cloneUrl, useAddresses } from "../../lib/addresses";
import { libraryPackages, packageLine, packagePath } from "../../lib/project-kind";
import { billing, deployments, identity, packages, projects as projectsApi, work } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";

/** Projects whose open issues and pull requests are counted. */
const MAX_COUNTED = 30;
/** Projects whose pull requests are listed under "In progress". */
const MAX_LISTED = 8;
const MAX_PULLS = 8;
const MAX_FACES = 8;
/** The trial as published, when the price book cannot be read. */
const DEFAULT_TRIAL_MICROS = 5_000_000;

/**
 * The month for the Usage card, for members only: what was spent, what
 * pays first and what it went on. Fetched here, not with the sidebar, so
 * only this page pays for it; a billing service that cannot answer leaves
 * the card out rather than the page.
 */
async function usageFor(slug: string, viewer: User | null): Promise<UsageGlance | null> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [account, usage, features, entitlements, limit, book] = await Promise.all([
    billing.account(slug, viewer).catch(() => null),
    billing.usage(slug, viewer, monthStart).catch(() => null),
    billing.features(slug, viewer).catch(() => null),
    billing.entitlements(slug).catch(() => null),
    billing.limit(slug, viewer).catch(() => null),
    billing.prices().catch(() => null),
  ]);
  if (!account?.ok || !usage?.ok) return null;
  // Without payments set up (a g1t run without billing), there is no plan to show.
  if (!account.value.status.enabled && !usage.value.free) return null;
  const plan = features?.ok ? (features.value.find((state) => state.plan.feature === "plan") ?? null) : null;
  return usageGlance({
    usage: usage.value,
    status: planStatus(plan, entitlements),
    entitlements,
    limit: limit?.ok ? limit.value : null,
    trialMicros: book?.free?.trialWorkspaceMicros ?? DEFAULT_TRIAL_MICROS,
  });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  const [listed, members, deploys, usage, published] = await Promise.all([
    projectsApi.list(slug, viewer),
    role ? identity.listMembers(slug, viewer) : null,
    role ? deployments.overview(slug, viewer) : null,
    role ? usageFor(slug, viewer) : null,
    // One listing for every card: a library's card shows its package where an app's shows production.
    packages.list(slug, viewer).catch(() => null),
  ]);
  const projects = listed.ok ? listed.value : [];

  const pathOf = (project: Project) =>
    project.source.kind === "hosted" ? project.source.repo : { namespace: project.workspace, name: project.slug };
  const counted = projects.slice(0, MAX_COUNTED);
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
  for (const project of projects) {
    if (project.kind !== "library" || project.source.kind !== "hosted") continue;
    const first = libraryPackages(byRepo.get(project.source.repoId) ?? [])[0];
    if (first) packageOf[project.id] = first;
  }

  return {
    slug,
    role,
    projects,
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
}: {
  project: Project;
  open: { issues: number; pulls: number } | undefined;
  deploys: ProjectDeploys | undefined;
  /** For a library, the package it publishes. */
  pkg: PackageSummary | undefined;
  member: boolean;
}) {
  const library = project.kind === "library";
  const base = `/${project.workspace}/${project.slug}`;
  const production = deploys?.production ?? null;
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
          {production ? (
            <a
              href={production.url}
              className="relative z-10 mt-0.5 flex items-center gap-1 truncate font-mono text-xs text-muted hover:text-accent"
            >
              {host(production.url)}
              <ArrowUpRight size={11} className="shrink-0" />
            </a>
          ) : library && pkg ? (
            <Link
              to={packagePath(pkg)}
              className="relative z-10 mt-0.5 block truncate font-mono text-xs text-muted hover:text-accent"
            >
              {packageLine(pkg)}
            </Link>
          ) : (
            <p className="mt-0.5 truncate text-xs text-faint">
              {project.description ?? (library ? "Not published yet" : deploys?.enabled ? "Not deployed yet" : "Deployments are off")}
            </p>
          )}
        </div>
        {(project.private || project.archived) && (
          <span className="flex shrink-0 gap-1.5">
            {project.private && <Pill>private</Pill>}
            {project.archived && <Pill>archived</Pill>}
          </span>
        )}
      </div>

      {project.description && (production || (library && pkg)) && <p className="mt-3 line-clamp-2 text-sm text-muted">{project.description}</p>}

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
            <span className="ml-auto flex items-center gap-1 text-accent">
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
  const { slug, role, projects, open, deploys, pulls, members, usage } = loaderData;
  const totals = Object.values(open).reduce(
    (sum, counts) => ({ issues: sum.issues + counts.issues, pulls: sum.pulls + counts.pulls }),
    { issues: 0, pulls: 0 },
  );
  const liveApps = Object.values(deploys).filter((entry) => entry.production).length;
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-10">
        {projects.length === 0 && role ? (
          <GetStarted slug={slug} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat value={projects.length} label={projects.length === 1 ? "Project" : "Projects"} />
              <Stat value={liveApps} label="In production" />
              <Stat value={totals.issues} label="Open issues" />
              <Stat value={totals.pulls} label="Pull requests in progress" />
            </div>

            <section>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-muted">Projects</h2>
                {role && (
                  <Link to={`/new?workspace=${slug}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                    <Plus size={13} />
                    New project
                  </Link>
                )}
              </div>
              <ul className="mt-3 grid gap-4 sm:grid-cols-2">
                {projects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    open={open[project.id]}
                    deploys={deploys[project.slug]}
                    pkg={loaderData.packageOf[project.id]}
                    member={role != null}
                  />
                ))}
              </ul>
            </section>

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
