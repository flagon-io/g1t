import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Code2,
  GitBranch,
  GitCommitHorizontal,
  Hand,
  HeartPulse,
  Lock,
  Package as PackageGlyph,
  Radio,
  Rocket,
  RotateCw,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { Await, Form, Link } from "react-router";

import { type ErrorGroup, type PackageSummary, type Project, type TelemetryOverview, workOwner } from "@g1t/contracts";

import type { Route } from "./+types/overview";
import { DeployLink, host, StatusDot } from "../../components/deploy";
import { useRefreshWhile } from "../../lib/refresh";
import { DeployStrip, NeedsList, Panel, Quiet, Unavailable, percent as share } from "../../components/mission";
import { PackageIcon } from "../../components/package-icon";
import { Hint } from "../../components/ui/hint";
import { Loading, Skeleton, SkeletonRows } from "../../components/ui/skeleton";
import { ProductionShot } from "../../components/production-shot";
import { GithubLinkStrip } from "../../components/github";
import { githubApp } from "../../lib/github.server";
import { ButtonLink, CopyLine, SoonPill, SubmitButton, TimeAgo } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { type LivePull, LiveNowList, StartHere } from "../../components/coordination";
import { awakeAndIdle, liveByIssue } from "../../lib/coordination";
import { type Need, ageBuckets, rankNeeds, runHealth } from "../../lib/mission";
import { count, duration, percent } from "../../lib/observability";
import { ECOSYSTEM_LABEL, installCommands } from "../../lib/packages";
import {
  PUBLISH_GUIDES,
  kindLabel,
  latestTag,
  libraryPackages,
  packageName,
  packagePath,
  projectChanges,
  projectPlan,
  publishGuide,
} from "../../lib/project-kind";
import { KindMenu } from "../../components/project-about";
import { DocsHead, ElsewhereHead, type ExternalDeployment, OtherHead, WhereItRuns, deploymentStatus } from "../../components/project-head";
import { actions, deployments, packages, projects, repos, telemetry, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";
import { accessTo, countsFor, projectFor, refusal, repoFor } from "../../lib/access.server";
import { shotVersion } from "./production-screenshot";
import { DeploymentStateIcon, DeploymentsPanel } from "../../components/deployments-panel";
import { STATE_WORD, environmentUrl, productionEnvironment, reportedProduction } from "../../lib/deployments";
import { cardSources, externalTarget, externalVersion, productionImageUrl } from "../../lib/production-image";
import { useAddresses } from "../../lib/addresses";
import { commitChecksFor } from "../../lib/commit-checks.server";
import { CommitChecksSummary } from "../../components/commit-checks";
import { projectCheckSections, hasSeparateAttempt } from "../../lib/project-checks";
import { StatusIcon, Duration, shortRef, standingWord } from "../../components/actions";
import { resolveRange, rangeLabel } from "../../lib/usage";
import { deliveryDays, duration as deliveryDuration } from "../../lib/workspace-insights";
import { repoPages } from "../../lib/repo-live";
import { useRepoLive } from "../../lib/use-repo-live";

/** A library's packages shown on its overview; the rest are a link away. */
const PACKAGES_SHOWN = 3;
/** Issues being worked on that Live now lists; Work has the rest. */
const LIVE_SHOWN = 4;
/** Open errors the Observability card names. */
const ERRORS_SHOWN = 3;
const DAY_MS = 86_400_000;

/**
 * A project's overview: what it is and whether it is healthy (production,
 * its traffic and errors, its checks), and who is working on it right now.
 * The repository itself (files, branches, commits) is Code's; pull
 * requests and the merge queue are Work's and Pull requests'. This page
 * links to them rather than repeating them.
 *
 * It streams: the layout's header and tabs go out at once with a skeleton
 * below them, and everything here follows in the same response as it
 * settles. Crawlers wait for all of it (entry.server.tsx).
 */
export function loader({ params, context }: Route.LoaderArgs) {
  return { overview: overviewData({ params, context }) };
}

async function overviewData({ params, context }: Pick<Route.LoaderArgs, "params" | "context">) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const ref = { workspace: params.owner, slug: params.repo };
  const now = Date.now();
  // A section whose service fails shows its own empty state; the page stays up.
  const soft = <T,>(promise: Promise<T> | null): Promise<T | null> =>
    promise ? promise.catch((error) => (console.warn("overview:", error), null)) : Promise.resolve(null);
  // People with a role of their own here see its running parts: its
  // builds, previews and observability; everyone who can read it sees the
  // rest. Not awaited: only those sections wait on the repository lookup,
  // which the layout makes in this request too.
  const accessP = accessTo(context, params);
  const memberP = accessP.then((access) => access.insider);
  const forMembers = <T,>(start: () => Promise<T>): Promise<T | null> =>
    memberP.then((member) => (member ? soft(start()) : null));
  const repoP = soft(repoFor(context, params));
  const projectP = soft(projectFor(context, params));
  // Deployments from anywhere (g1t.page, g1t Actions, the API), by environment, for anyone who can read it.
  const environmentsP = projectP.then((found) =>
    soft(deployments.environments(found?.ok && found.value.source.kind === "hosted" ? found.value.source.repo : path, viewer)),
  );
  const planP = projectP.then((project) => (project?.ok ? projectPlan(project.value) : null));
  // A library or a tool shows its packages where an app shows production.
  const libraryRepoP = Promise.all([planP, repoP]).then(([plan, repo]) => (plan === "release" && repo?.ok ? repo.value : null));
  const packagesP = libraryRepoP.then((repo) => (repo ? soft(packages.list(params.owner, viewer, { repoId: repo.id })) : null));
  const workflowRunsP = soft(actions.runs(path, viewer, { limit: 30 }));
  // What waits on someone signed in: their pull requests' lifecycles, and the open ones.
  const minePullsP = repoP.then((repo) =>
    repo?.ok && viewer
      ? soft(work.listActivePulls(viewer)).then((list) => (list ?? []).filter((item) => item.pull.repoId === repo.value.id))
      : null,
  );
  const openP = viewer ? soft(work.listPulls(path, viewer, "open")) : Promise.resolve(null);
  // Where its code came from on GitHub, for members.
  const githubP = repoP.then((repo) => (repo?.ok ? forMembers(() => githubApp.link(repo.value.id)) : null));
  const listP = forMembers(() => deployments.list(ref, viewer));
  // Its running software's last day, for members, on an installation with Observability.
  const service = telemetry;
  const telemetryP = service
    ? projectP.then((found) =>
      found?.ok
        ? forMembers(async () => {
          const project_id = found.value.id;
          const [overview, errors] = await Promise.all([
            soft(service.overview({ project_id, workspace: params.owner, from_us: (now - DAY_MS) * 1000, to_us: now * 1000, step_s: 3600 })),
            soft(service.errors({ project_id, workspace: params.owner, state: "open" })),
          ]);
          return { overview, errors };
        })
        : null,
    )
    : Promise.resolve(null);
  const commitP = soft(repos.log(path, viewer, null, 1)).then((log) => log?.ok ? (log.value[0] ?? null) : null);
  const range = resolveRange("30d", {}, new Date(now));
  const insightsP = repoP.then((repo) => repo?.ok
    ? forMembers(() => work.deliveryInsights([repo.value.id], viewer, range.from, range.until))
    : null);

  const [
    { insider: member, can },
    project,
    settings,
    list,
    open,
    counts,
    issues,
    claims,
    active,
    idle,
    mine,
    packageList,
    tagList,
    insights,
    workflowRuns,
    observed,
    commit,
    environments,
    github,
  ] = await Promise.all([
    accessP,
    projectP,
    forMembers(() => deployments.settings(ref, viewer)),
    listP,
    openP,
    soft(countsFor(context, params)),
    soft(work.listIssues(path, viewer, { state: "open" })),
    // Who is working on it right now, as Work shows them.
    soft(work.listClaims(path, viewer)),
    soft(work.listWorkSessions(path, viewer, { state: "active" })),
    soft(work.listWorkSessions(path, viewer, { state: "idle" })),
    minePullsP,
    packagesP,
    // The latest release, for About.
    soft(repos.tags(path, viewer)),
    insightsP,
    workflowRunsP,
    telemetryP,
    commitP,
    environmentsP,
    githubP,
  ]);
  const ok = <T,>(result: { ok: true; value: T } | { ok: false } | null): T | null => (result?.ok ? result.value : null);

  const openPulls = ok(open) ?? [];
  const builds = ok(list)?.deployments ?? [];
  const lifecycleOf = new Map((mine ?? []).map((item) => [item.pull.number, item.lifecycle]));

  // --- Needs you ---------------------------------------------------------------
  const base = `/${params.owner}/${params.repo}`;
  const needs: Need[] = [];
  const latestProduction = builds.find((build) => build.kind === "production") ?? null;
  if (latestProduction?.status === "failed") {
    needs.push({
      key: "deploy",
      kind: "deploy",
      title: "The production build failed",
      detail: latestProduction.error ?? "Production still serves the build before it.",
      to: `${base}/deployments/${latestProduction.id}`,
      action: "See the build",
      at: Date.parse(latestProduction.finishedAt ?? latestProduction.createdAt),
      where: latestProduction.commit.slice(0, 7),
    });
  }
  const me = viewer?.username.toLowerCase();
  for (const pull of openPulls) {
    const to = `${base}/pull/${pull.number}`;
    const where = `#${pull.number}`;
    const lifecycle = lifecycleOf.get(pull.number);
    if (lifecycle?.stage === "needs_you") {
      const conflict = /conflict/i.test(lifecycle.detail);
      needs.push({ key: `pull:${pull.number}`, kind: conflict ? "conflict" : "stalled", title: pull.title, detail: lifecycle.detail, to, action: conflict ? "Resolve" : "Decide", at: Date.parse(pull.updatedAt), where });
    } else if (lifecycle?.stage === "ready") {
      needs.push({ key: `pull:${pull.number}`, kind: "ready", title: pull.title, detail: "Ready to land when you merge it.", to, action: "Merge", at: Date.parse(pull.updatedAt), where });
    }
    // Never your own, nor one g1t made for you; whoever it is for asked.
    const owner = workOwner(pull).username;
    if (me && pull.status === "open" && owner.toLowerCase() !== me && pull.reviewers.some((name) => name.toLowerCase() === me)) {
      needs.push({ key: `review:${pull.number}`, kind: "review", title: pull.title, detail: `${owner} asked for your review.`, to, action: "Review", at: Date.parse(pull.updatedAt), where });
    }
    if (member && pull.status === "open" && pull.checkStatus === "failed" && !lifecycle) {
      needs.push({ key: `checks:${pull.number}`, kind: "checks", title: pull.title, detail: "Its checks failed.", to, action: "See checks", at: Date.parse(pull.updatedAt), where });
    }
  }

  // --- Health ------------------------------------------------------------------
  const openIssues = ok(issues);

  // --- Live now ------------------------------------------------------------------
  const titles: Record<number, string> = {};
  for (const issue of openIssues ?? []) titles[issue.number] = issue.title;
  // For sessions on a pull request or a branch of their own, with no issue yet.
  const livePulls: Record<number, LivePull> = {};
  for (const pull of openPulls) livePulls[pull.number] = { title: pull.title, status: pull.status };
  const repoValue = await repoP;
  const defaultBranch = repoValue?.ok ? repoValue.value.defaultBranch : null;

  // --- Where it runs ------------------------------------------------------------
  const environmentList = ok(environments);
  // Production deployed somewhere other than g1t.page (by g1t Actions, or
  // reported through the API): the slot an app deployed elsewhere shows.
  const deployment: ExternalDeployment | null = reportedProduction(environmentList?.environments ?? []);
  // An app that has not said where it runs, but reports production from
  // elsewhere, runs elsewhere.
  const found = ok(project);
  const projectValue = found && deployment && found.kind === "app" && found.runs == null ? { ...found, runs: "elsewhere" as const } : found;
  const isLibrary = projectValue != null && projectPlan(projectValue) === "release";
  const published = libraryPackages(ok(packageList) ?? []);
  const live = ok(list)?.live ?? [];
  // Production's newest deployment, wherever it ran: the head's status for everyone.
  const productionEnv = productionEnvironment(environmentList?.environments ?? []);
  const productionLatest = productionEnv?.latest ?? null;
  // What production serves on g1t.page. Members have it from the builds;
  // anyone else from the production environment, which they may read.
  const liveProduction = live.find((app) => app.kind === "production") ?? null;
  const current = productionEnv?.current ?? null;
  const production = liveProduction
    ? { url: liveProduction.url, commit: liveProduction.commit, deployedAt: liveProduction.deployedAt }
    : productionEnv && current?.source === "g1t_page" && environmentUrl(productionEnv)
      ? { url: environmentUrl(productionEnv)!, commit: current.sha, deployedAt: current.updated_at }
      : null;
  const telemetryData = observed?.overview && (observed.overview.totals.requests > 0 || (observed.errors?.length ?? 0) > 0) ? observed : null;

  return {
    member,
    workspaceMember: roleIn(viewer, params.owner) != null,
    can,
    github,
    project: projectValue,
    settings: ok(settings),
    builds: builds.slice(0, 30),
    previews: live.filter((app) => app.kind === "preview"),
    production,
    serving: current ? { id: current.id, sha: current.sha, ref: current.ref, at: current.updated_at, creator: current.creator, runUrl: current.run_url } : null,
    // The screenshot of production on g1t.page, for members (like its builds).
    productionShot: member && liveProduction ? shotVersion(liveProduction) : null,
    latestProductionBuild: latestProduction ? { status: latestProduction.status } : null,
    productionLatest: productionLatest
      ? { id: productionLatest.id, sha: productionLatest.sha, state: productionLatest.state, at: productionLatest.updated_at, environment: productionEnv!.name }
      : null,
    commit: commit ? { hash: commit.hash, authoredAt: commit.authoredAt } : null,
    // The commit's checks, streamed in after the page.
    checks: commitChecksFor(path, viewer, [commit?.hash, current?.sha, production?.commit]),
    workflowRuns: ok(workflowRuns),
    insights,
    range,
    release: latestTag(ok(tagList) ?? []),
    // Production as reported from outside g1t, for an app deployed elsewhere.
    deployment,
    // Its screenshot's address on the site (production-elsewhere.ts), when it has one to show.
    elsewhereShot: elsewhereShot(projectValue, deployment, base),
    // Every environment's latest deployment, for the Deployments panel.
    environments: environmentList,
    open: ok(counts) ?? { issues: openIssues?.length ?? 0, pulls: openPulls.length },
    needs: rankNeeds(needs),
    claims: ok(claims) ?? [],
    sessions: [...(ok(active) ?? []), ...(ok(idle) ?? [])],
    // Who may end a session by hand from Live now: its own runner, or anyone with write access.
    ender: { viewerId: viewer?.id ?? null, canPush: can.push },
    liveLoaded: claims?.ok === true || active?.ok === true,
    // Sections that could not be read say so in their place, rather than
    // reading as empty: what needs someone signed in (their open pull
    // requests), the deployments panel, and a member's observability.
    needsLoaded: viewer == null || open != null,
    environmentsLoaded: environments != null,
    telemetryLoaded: observed == null || observed.overview != null,
    titles,
    livePulls,
    defaultBranch,
    health: {
      ...runHealth(ok(workflowRuns) ?? []),
      ages: openIssues ? ageBuckets(openIssues.map((issue) => issue.createdAt), now) : null,
    },
    telemetry: telemetryData ? { overview: telemetryData.overview!, errors: telemetryData.errors ?? [] } : null,
    library: isLibrary
      ? { packages: published.slice(0, PACKAGES_SHOWN), total: published.length, loaded: packageList?.ok ?? false }
      : null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData().catch(() => null);
  const intent = form?.get("intent");
  // What it is, where it runs, its description and links: its settings.
  if (form && (intent === "kind" || intent === "about")) {
    const refused = await refusal(context, params, "manage_settings");
    if (refused) return { error: refused };
    const saved = await projects.update(user, params.owner, params.repo, projectChanges(form));
    return saved.ok ? { notice: "Saved." } : { error: saved.error.message };
  }
  // Deploying is compute.
  const refused = await refusal(context, params, "run");
  if (refused) return { error: refused };
  const started = await deployments.redeploy(user, { workspace: params.owner, slug: params.repo }, null);
  return started.ok ? { notice: "Production is building." } : { error: started.error.message };
}

type Loaded = Awaited<ReturnType<typeof overviewData>>;

/**
 * Where an app's overview shows production, a library's shows what it
 * publishes: each package with its latest version and how to install it,
 * or, before there is one, how to publish a first version.
 */
function LibraryHead({
  library,
  project,
  base,
  workspace,
}: {
  library: { packages: PackageSummary[]; total: number; loaded: boolean };
  project: Project | null;
  base: string;
  workspace: string;
}) {
  const guide = publishGuide(project?.ecosystem ?? null);
  const name = project?.name ?? base.split("/").pop();
  return (
    <div className="p-5 sm:p-6">
      <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
        <PackageGlyph size={13} className="text-accent" />
        Packages
      </p>
      {library.packages.length > 0 ? (
        <>
          <ul className="mt-3 space-y-4">
            {library.packages.map((pkg) => {
              const commands = installCommands(pkg, pkg.latest, "you");
              return (
                <li key={pkg.id} className="flex flex-col gap-2.5 lg:flex-row lg:items-start lg:gap-5">
                  <Link to={packagePath(pkg)} className="group flex min-w-0 items-center gap-3 lg:w-72 lg:shrink-0">
                    <PackageIcon ecosystem={pkg.ecosystem} size={32} />
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[0.9375rem] font-medium group-hover:text-accent">{packageName(pkg)}</span>
                      <span className="block text-xs text-muted">
                        {ECOSYSTEM_LABEL[pkg.ecosystem]} · {pkg.latest ?? "no versions yet"}
                        {pkg.versions > 1 && ` · ${pkg.versions} versions`}
                      </span>
                    </span>
                  </Link>
                  <div className="min-w-0 grow space-y-1.5">
                    {/* The workspace's registry first, or the tool installs a package of the same name from elsewhere. */}
                    {commands.registry && <CopyLine prompt text={commands.registry} />}
                    <CopyLine prompt text={commands.install} />
                  </div>
                </li>
              );
            })}
          </ul>
          {library.total > library.packages.length && (
            <Link to={`/${workspace}/-/packages`} className="mt-3 inline-block text-xs text-muted hover:text-fg">
              All {library.total} packages
            </Link>
          )}
        </>
      ) : (
        <>
          <p className="mt-2 text-lg font-medium">{library.loaded ? "Not published yet" : "Packages could not be loaded just now"}</p>
          {guide ? (
            <>
              <p className="mt-1 max-w-lg text-sm text-muted">
                Publish a first version of {name} to the workspace's {guide.label} registry, for others to install
                {guide.start ? ":" : "."}
              </p>
              {guide.start && (
                <div className="mt-3 max-w-lg">
                  <CopyLine prompt text={guide.start} />
                </div>
              )}
              <a href={guide.guide} className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline">
                Publishing to {guide.label} <ArrowUpRight size={13} />
              </a>
            </>
          ) : (
            <>
              <p className="mt-1 max-w-lg text-sm text-muted">Publish a first version of {name} to one of the workspace's registries:</p>
              <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {PUBLISH_GUIDES.map((one) => (
                  <a key={one.label} href={one.guide} className="inline-flex items-center gap-1 text-accent hover:underline">
                    {one.label} <ArrowUpRight size={13} />
                  </a>
                ))}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Where the overview asks for the screenshot of production deployed
 * elsewhere, with `?v=` naming the reported deploy or the day; null when
 * there is none to show (lib/production-image.ts `externalTarget`).
 */
function elsewhereShot(project: Project | null | undefined, deployment: ExternalDeployment | null, base: string): string | null {
  const target = project ? externalTarget(project, deployment, Date.now()) : null;
  return target ? `${base}/production-elsewhere.jpg?v=${externalVersion(target)}` : null;
}

export default function ProjectOverview({ loaderData, actionData, params }: Route.ComponentProps) {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <Await resolve={loaderData.overview} errorElement={<OverviewFailed />}>
        {(overview) => (
          // Faded in over its outline, not switched for it.
          <div className="animate-fade-in">
            <Overview loaderData={overview} actionData={actionData} params={params} />
          </div>
        )}
      </Await>
    </Suspense>
  );
}

/** The overview's sections as they will sit, while they stream in. */
function OverviewSkeleton() {
  return <Loading className="space-y-8" aria-label="Loading the overview">
    <Card className="overflow-hidden rounded-2xl">
      <div className="border-b border-line p-5"><Skeleton className="h-5 w-48" /></div>
      <div className="grid gap-6 p-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Skeleton className="aspect-16/10 w-full rounded-lg" />
        <SkeletonRows rows={5} />
      </div>
    </Card>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((key) => <Card key={key} className="p-5"><SkeletonRows rows={4} /></Card>)}</div>
  </Loading>;
}

function OverviewFailed() {
  return (
    <Card asChild className="rounded-2xl p-6 text-sm text-muted">
      <p>The overview could not be loaded just now. Reload the page to try again.</p>
    </Card>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** One line to the repository, where its files, branches and commits are: Code. */
function CodeLine({ project, base }: { project: Project; base: string }) {
  if (project.source.kind !== "hosted") return null;
  const { repo, rootDir } = project.source;
  return (
    <Link
      to={`${base}/code`}
      prefetch="intent"
      className="group flex min-w-0 items-center gap-2 border-t border-line px-5 py-2.5 text-xs text-muted transition-colors hover:bg-raised/50 hover:text-fg sm:px-6"
    >
      {project.private ? <Lock size={12} className="shrink-0 text-faint" /> : <Code2 size={12} className="shrink-0 text-faint" />}
      <span className="min-w-0 truncate font-mono text-fg-soft">
        {repo.namespace}/{repo.name}
        {rootDir ? `/${rootDir}` : ""}
      </span>
      {project.pushedAt && (
        <span className="hidden shrink-0 md:inline">
          · pushed <TimeAgo at={project.pushedAt} />
        </span>
      )}
      <span className="grow" />
      <span className="inline-flex shrink-0 items-center gap-1 font-medium group-hover:text-accent">
        Code <ArrowRight size={12} />
      </span>
    </Link>
  );
}

/** Production on g1t.page: its picture, address and state. Actions live in the card header. */
function ProductionHead({ loaderData, base, name, upload, addImage }: {
  loaderData: Loaded;
  base: string;
  name: string;
  upload: { url: string; preferred: boolean } | null;
  addImage: string | null;
}) {
  const { member, settings, production, latestProductionBuild, productionLatest } = loaderData;
  // The project's own domain, once it is active, is where production is visited.
  const productionUrl = production ? (settings?.primaryDomain ? `https://${settings.primaryDomain}` : production.url) : null;
  return (
    <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:p-6">
      {/* Always a picture: the screenshot (members, like the deployments), the uploaded image, or the frame. */}
      <ProductionShot
        sources={cardSources(loaderData.productionShot ? `${base}/production.jpg?v=${loaderData.productionShot}` : null, upload)}
        href={productionUrl}
        label={productionUrl ? host(productionUrl) : settings?.productionUrl ? host(settings.productionUrl) : ""}
        note={!production && settings?.enabled ? "A screenshot appears after the next deploy" : null}
        addImage={addImage}
        className="w-full shrink-0 sm:w-60 lg:w-72"
      />
      <div className="flex min-w-0 grow flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
            <Rocket size={13} className="text-accent" />
            Production
          </p>
          {production && productionUrl ? (
            <>
              <DeployLink href={productionUrl} className="mt-2 flex items-center gap-1.5 truncate font-mono text-lg font-medium hover:text-accent">
                {host(productionUrl)}
                <ArrowUpRight size={16} className="shrink-0 text-faint" />
              </DeployLink>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                {latestProductionBuild ? (
                  <StatusDot status={latestProductionBuild.status} label={latestProductionBuild.status === "ready" ? "Live" : undefined} />
                ) : (
                  // Anyone else has the production environment's newest deployment.
                  productionLatest && (
                    <StatusDot status={deploymentStatus(productionLatest.state)} label={productionLatest.state === "success" ? "Live" : undefined} />
                  )
                )}
                <span className="inline-flex items-center gap-1 font-mono">
                  <GitCommitHorizontal size={13} className="text-faint" />
                  {production.commit.slice(0, 7)}
                </span>
                <span>
                  deployed <TimeAgo at={production.deployedAt} />
                </span>
                {settings?.primaryDomain && <span className="text-faint">also at {host(production.url)}</span>}
              </p>
            </>
          ) : settings?.enabled ? (
            <>
              <p className="mt-2 font-mono text-lg text-muted">{host(settings.productionUrl)}</p>
              <p className="mt-1.5 text-xs text-muted">
                {latestProductionBuild ? (
                  <StatusDot status={latestProductionBuild.status} label={latestProductionBuild.status === "failed" ? "The last build failed" : undefined} />
                ) : (
                  "Not deployed yet. Push to the default branch, or deploy it now."
                )}
              </p>
            </>
          ) : member ? (
            <>
              <p className="mt-2 text-lg font-medium">Deployments are off</p>
              <p className="mt-1 max-w-lg text-sm text-muted">
                Nothing builds or runs until you turn them on. Then {name} goes up on g1t.page: production from the default branch, and a
                live preview for every pull request. It runs only while someone visits.
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-lg font-medium">Not deployed</p>
              <p className="mt-1 max-w-lg text-sm text-muted">{name} has no production deployment to visit yet.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The running deployment owns these fields; a newer attempt never changes its status. */
function ProductionSummary({ loaderData: d, base, upload, addImage, elsewhere }: {
  loaderData: Loaded; base: string; upload: { url: string; preferred: boolean } | null;
  addImage: string | null; elsewhere: boolean;
}) {
  const current = d.serving;
  const sha = current?.sha ?? d.production?.commit;
  const url = elsewhere ? d.deployment?.url ?? d.project?.productionUrl : d.settings?.primaryDomain ? `https://${d.settings.primaryDomain}` : d.production?.url;
  const at = current?.at ?? d.production?.deployedAt;
  const latest = d.productionLatest;
  const newerAttempt = latest && hasSeparateAttempt(current?.id, sha, latest);
  const screenshot = elsewhere ? d.elsewhereShot : d.productionShot ? `${base}/production.jpg?v=${d.productionShot}` : null;
  return (
    <>
      <div className="grid gap-6 p-5 sm:p-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-8">
        <ProductionShot sources={cardSources(screenshot, upload)} href={url ?? null} label={url ? host(url) : ""} addImage={addImage} className="w-full self-start" />
        <dl className="grid min-w-0 content-start grid-cols-2 gap-x-5 gap-y-5 text-sm">
          <div className="col-span-2 min-w-0">
            <dt className="text-xs text-muted">Deployment</dt>
            <dd className="mt-1 break-words font-medium">
              {current ? <Link to={`${base}/deployments/${current.id}`} className="hover:text-accent">Current production <ArrowUpRight size={14} className="inline text-faint" /></Link> : <span>Production</span>}
            </dd>
          </div>
          <div className="col-span-2 min-w-0">
            <dt className="text-xs text-muted">Domain</dt>
            <dd className="mt-1">{url ? <DeployLink href={url} className="inline-flex max-w-full items-center gap-1.5 font-medium hover:text-accent"><span className="truncate">{host(url)}</span><ArrowUpRight size={14} className="shrink-0 text-faint" /></DeployLink> : <span className="text-muted">No address reported</span>}</dd>
            {!elsewhere && d.settings?.primaryDomain && d.production && <dd className="mt-1 text-xs text-muted"><DeployLink href={d.production.url} className="break-all hover:text-fg">{host(d.production.url)}</DeployLink></dd>}
          </div>
          <div><dt className="text-xs text-muted">Status</dt><dd className="mt-1"><StatusDot status="ready" label="Ready" /></dd></div>
          <div><dt className="text-xs text-muted">Deployed</dt><dd className="mt-1 text-xs">{at && <TimeAgo at={at} />}{current?.creator && <span className="text-muted"> by {current.creator}</span>}</dd></div>
          <div className="col-span-2 min-w-0">
            <dt className="text-xs text-muted">Source</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
              {current?.ref && current.ref !== sha && <Link to={`${base}/tree/${encodeURIComponent(current.ref)}`} className="inline-flex min-w-0 items-center gap-1.5 hover:text-accent"><GitBranch size={14} className="shrink-0 text-faint" /><span className="truncate">{current.ref}</span></Link>}
              {sha && <Link to={`${base}/commit/${sha}`} className="inline-flex items-center gap-1.5 font-mono text-xs hover:text-accent"><GitCommitHorizontal size={14} className="text-faint" />{sha.slice(0, 7)}</Link>}
              {current?.runUrl && <Link to={current.runUrl} className="text-xs text-muted hover:text-fg">View workflow <ArrowUpRight size={12} className="inline" /></Link>}
            </dd>
            {sha && sha !== d.commit?.hash && <dd className="mt-3"><CommitChecksSummary checks={d.checks} sha={sha} label="Checks for deployed commit" /></dd>}
          </div>
        </dl>
      </div>
      {newerAttempt && <Link to={`${base}/deployments/${latest.id}`} className="flex flex-wrap items-center gap-2 border-t border-line bg-raised/30 px-5 py-3 text-xs hover:bg-raised/60 sm:px-6"><DeploymentStateIcon state={latest.state} size={14} /><span>Latest attempt: {STATE_WORD[latest.state]}</span><span className="font-mono text-muted">{latest.sha.slice(0, 7)}</span><span className="text-muted"><TimeAgo at={latest.at} /></span><span className="ml-auto text-muted">View deployment <ArrowRight size={12} className="inline" /></span></Link>}
    </>
  );
}

/** Branch health belongs to the repository head, independently of what is deployed. */
function BranchCard({ loaderData: d, base }: { loaderData: Loaded; base: string }) {
  const branch = projectCheckSections(d.commit?.hash, d.defaultBranch, null)[0];
  return <Card asChild className="min-w-0 p-5"><section aria-labelledby="overview-branch">
    <h2 id="overview-branch" className="flex items-center gap-2 text-sm font-semibold"><GitBranch size={14} className="text-faint" />Latest on {d.defaultBranch ?? "default branch"}</h2>
    {branch ? <><div className="my-4 flex flex-wrap items-center gap-2 text-xs"><Link to={`${base}/commit/${branch.sha}`} className="font-mono hover:text-accent">{branch.sha.slice(0, 7)}</Link><span className="text-muted">committed {d.commit && <TimeAgo at={d.commit.authoredAt} />}</span></div><CommitChecksSummary checks={d.checks} sha={branch.sha} /></> : <p className="my-4 text-xs text-muted">The latest commit is unavailable.</p>}
    <dl className="mt-4 space-y-3 border-t border-line pt-4 text-xs">
      <div className="flex justify-between gap-3"><dt className="text-muted">Latest release</dt><dd><Link to={`${base}/tags`} className="font-mono hover:text-accent">{d.release?.name ?? "None yet"}</Link>{d.release?.at && <span className="ml-2 text-muted"><TimeAgo at={d.release.at} /></span>}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted">Open pull requests</dt><dd><Link to={`${base}/pulls`} className="tabular-nums hover:text-accent">{d.open.pulls}</Link></dd></div>
    </dl>
  </section></Card>;
}

/** Production controls share a header, whether g1t or a workflow hosts it. */
function ProductionActions({ loaderData, base, elsewhere }: { loaderData: Loaded; base: string; elsewhere: boolean }) {
  const { member, settings, production, project, can } = loaderData;
  const url = elsewhere
    ? loaderData.deployment?.url ?? project?.productionUrl
    : production ? (settings?.primaryDomain ? `https://${settings.primaryDomain}` : production.url) : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {member && (can.run || can.manage_integrations) && (
        <Hint disabled label="Instant rollback is coming soon. It is not available yet.">
          <Button disabled variant="outline" size="sm">
            <RotateCcw size={14} />
            Instant rollback <SoonPill />
          </Button>
        </Hint>
      )}
      {!elsewhere && member && settings?.enabled && can.run && (
        <Form method="post">
          <Hint label="Build production again from the default branch">
            <SubmitButton variant="outline" size="sm" name="intent" value="redeploy" pending="Redeploying…">
              <RotateCw size={14} /> Redeploy
            </SubmitButton>
          </Hint>
        </Form>
      )}
      {!elsewhere && member && !settings?.enabled && can.manage_integrations && (
        <ButtonLink to={`${base}/settings/deployments`} variant="accent" size="sm">
          <Rocket size={14} /> Turn on deployments
        </ButtonLink>
      )}
      {url && (
        <ButtonLink to={url} variant="accent" size="sm" reloadDocument target="_blank" rel="noopener noreferrer">
          Visit <ArrowUpRight size={14} />
        </ButtonLink>
      )}
    </div>
  );
}

function Overview({
  loaderData,
  actionData,
  params,
}: {
  loaderData: Loaded;
  actionData: Route.ComponentProps["actionData"];
  params: Route.ComponentProps["params"];
}) {
  const { member, project, needs, library, claims, sessions, titles, livePulls, defaultBranch, previews } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const name = project?.name ?? params.repo;
  const plan = project ? projectPlan(project) : "production";
  const canChange = member && loaderData.can.manage_settings;
  const deployedSha = loaderData.serving?.sha ?? loaderData.production?.commit;
  const productionPlan = plan === "production" || plan === "elsewhere";
  const hasProduction = productionPlan && Boolean(deployedSha);
  const addresses = useAddresses();
  // The production card's picture: an uploaded image, served from the
  // usercontent origin, and where someone who may change it adds one.
  const upload = project?.productionImage
    ? { url: productionImageUrl(project.productionImage.file, addresses.usercontent), preferred: project.productionImage.preferred }
    : null;
  const addImage = canChange ? `${base}/settings#production-image` : null;
  const elsewhereUrl = loaderData.deployment?.url ?? project?.productionUrl ?? null;
  // Idle sessions fold under the list (LiveNowList); the counts are of the rest.
  const { awake, idle } = awakeAndIdle(sessions);
  const busy = claims.length + awake.length > 0;
  const working = busy || idle.length > 0;
  // Deployments, checks, releases, claims and sessions show as they happen.
  useRepoLive({ match: (change) => repoPages.overview()(change) || repoPages.runs()(change) || change.kind === "git.push" });
  // Claims lapse and sessions go idle with no event to say so.
  useRefreshWhile(working || (loaderData.workflowRuns ?? []).some((run) => run.status !== "completed"), 15_000);
  const live = liveByIssue(claims, awake);
  const moreIssues = live.issues.length - LIVE_SHOWN;

  return (
    <div className="space-y-8">
      {loaderData.github && <GithubLinkStrip link={loaderData.github} />}
      {/* What the project is, whether it is running and healthy, and a line to its code. */}
      <Card asChild className="overflow-hidden rounded-2xl">
        <section aria-label="Production">
          {(project || plan === "production") && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 text-xs sm:px-6">
              <div className="flex flex-wrap items-center gap-3">
                {(plan === "production" || plan === "elsewhere") && <h2 className="text-sm font-semibold">Production deployment</h2>}
                {project && <KindMenu project={project} label={kindLabel(project)} canChange={canChange} />}
              </div>
              {(plan === "production" || plan === "elsewhere") && <ProductionActions loaderData={loaderData} base={base} elsewhere={plan === "elsewhere"} />}
            </div>
          )}
          {hasProduction ? (
            <ProductionSummary loaderData={loaderData} base={base} upload={upload} addImage={addImage} elsewhere={plan === "elsewhere"} />
          ) : plan === "elsewhere" && project ? (
            <ElsewhereHead
              project={project}
              base={base}
              canChange={canChange}
              deployment={loaderData.deployment}
              shot={
                <ProductionShot
                  sources={cardSources(loaderData.elsewhereShot, upload)}
                  href={elsewhereUrl}
                  label={elsewhereUrl ? host(elsewhereUrl).replace(/\/$/, "") : ""}
                  addImage={addImage}
                  className="w-full shrink-0 sm:w-60 lg:w-72"
                />
              }
            />
          ) : plan === "unknown" && project ? (
            <WhereItRuns project={project} base={base} canChange={canChange} canDeploy={member && loaderData.can.manage_integrations} />
          ) : plan === "docs" && project ? (
            <DocsHead project={project} base={base} canChange={canChange} canDeploy={member && loaderData.can.manage_integrations} />
          ) : plan === "other" && project ? (
            <OtherHead project={project} base={base} canChange={canChange} />
          ) : library ? (
            <LibraryHead library={library} project={project} base={base} workspace={params.owner} />
          ) : (
            <ProductionHead loaderData={loaderData} base={base} name={name} upload={upload} addImage={addImage} />
          )}
          {actionData && (
            <p className={`border-t border-line px-6 py-2.5 text-sm ${"error" in actionData ? "text-danger" : "text-success"}`}>
              {"error" in actionData ? actionData.error : actionData.notice}
            </p>
          )}
          {productionPlan && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 sm:px-6">
            <span className="text-xs text-muted">{plan === "elsewhere" ? "Production is deployed by its own pipeline." : !loaderData.settings?.enabled ? "Deployments are not enabled for this project." : <>Push to <span className="font-mono text-fg-soft">{defaultBranch ?? "the default branch"}</span> to update production.</>}</span>
            <div className="flex flex-wrap items-center gap-2">
              {member && loaderData.can.manage_integrations && <ButtonLink to={`${base}/settings/deployments`} variant="ghost" size="sm"><Settings2 size={14} />Deployment settings</ButtonLink>}
              <ButtonLink to={`${base}/deployments`} variant="outline" size="sm"><Rocket size={14} />Deployments{loaderData.environments && <span className="text-muted">{loaderData.environments.total_count}</span>}</ButtonLink>
            </div>
          </div>}
          {project && <CodeLine project={project} base={base} />}
        </section>
      </Card>

      <div className={`grid items-start gap-4 md:grid-cols-2 ${loaderData.telemetry || !loaderData.telemetryLoaded ? "xl:grid-cols-3" : ""}`}>
        <BranchCard loaderData={loaderData} base={base} />
        {!loaderData.telemetryLoaded && <Unavailable what="Observability" compact />}
        {loaderData.telemetry && <ObservabilityCard overview={loaderData.telemetry.overview} errors={loaderData.telemetry.errors} base={base} />}
        <HealthCard loaderData={loaderData} base={base} plan={plan} />
      </div>

      {previews.length > 0 && (
        <Panel title="Preview deployments" icon={<GitBranch size={14} />} count={previews.length}>
          <Card asChild divided className="overflow-hidden">
            <ul>
              {previews.map((app) => (
                <li key={app.url} className="flex flex-wrap items-center gap-3 px-5 py-4 text-sm">
                  <GitBranch size={16} className="shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-[0.8125rem] font-medium">{app.branch}</span>
                      {app.number != null && <Link to={`${base}/pull/${app.number}`} className="text-xs text-muted hover:text-accent">#{app.number}</Link>}
                    </div>
                    <DeployLink href={app.url} className="mt-1 block truncate text-xs text-muted hover:text-accent">{host(app.url)}</DeployLink>
                  </div>
                  <span className="shrink-0 text-xs text-faint"><TimeAgo at={app.deployedAt} /></span>
                  <ButtonLink to={app.url} variant="outline" size="sm" reloadDocument target="_blank" rel="noopener noreferrer">Visit <ArrowUpRight size={14} /></ButtonLink>
                </li>
              ))}
            </ul>
          </Card>
        </Panel>
      )}

      {/* Deployments panel (deployments-panel.tsx): each environment's latest deployment. */}
      {loaderData.environmentsLoaded ? (
        <DeploymentsPanel base={base} summary={loaderData.environments} excludeEnvironment={productionPlan ? loaderData.productionLatest?.environment : undefined} className="rounded-xl border border-line bg-surface p-5" />
      ) : (
        <Unavailable what="Deployments" compact />
      )}

      <div className="min-w-0 space-y-8">
        {!loaderData.needsLoaded && (
          <Panel title="Needs you" icon={<Hand size={14} className="text-warn" />}>
            <Unavailable what="What needs you" />
          </Panel>
        )}
        {loaderData.needsLoaded && needs.length > 0 && (
          <Panel title="Needs you" icon={<Hand size={14} className="text-warn" />} count={needs.length}>
            <NeedsList needs={needs} limit={5} />
          </Panel>
        )}

        <Panel
          title="Live now"
          icon={<Radio size={14} className={busy ? "text-success" : undefined} />}
          extra={
            working ? (
              <span className="text-xs text-muted">
                {plural(awake.length, "session")} · {plural(claims.length, "claim")}
                {idle.length > 0 && ` · ${idle.length} idle`}
              </span>
            ) : null
          }
          all={{ to: `${base}/work`, label: "Work" }}
        >
          {!loaderData.liveLoaded ? (
            <Unavailable what="Who is working" />
          ) : working ? (
            <>
              <LiveNowList
                claims={claims}
                sessions={sessions}
                titles={titles}
                pulls={livePulls}
                defaultBranch={defaultBranch}
                base={base}
                now={Date.now()}
                limit={LIVE_SHOWN}
                ender={loaderData.ender}
              />
              {moreIssues > 0 && (
                <Link to={`${base}/work`} className="mt-2 inline-block px-1 text-xs text-muted hover:text-fg">
                  {plural(moreIssues, "more issue")} being worked on
                </Link>
              )}
            </>
          ) : member ? (
            <StartHere title={`Nobody is working on ${name} right now`} />
          ) : (
            <Quiet>
              Nobody is working on {name} right now. When people and their coding agents claim an issue or start a session, it shows here.
            </Quiet>
          )}
        </Panel>

        <div className="grid items-start gap-6 xl:grid-cols-2"><DeliveryPanel loaderData={loaderData} base={base} /><WorkflowPanel loaderData={loaderData} base={base} /></div>

      </div>
    </div>
  );
}

/** The last day of requests as a row of bars, an hour each, oldest on the left. */
function RequestBars({ points }: { points: TelemetryOverview["points"] }) {
  const most = Math.max(1, ...points.map((p) => p.requests));
  return (
    <div className="flex h-10 items-end gap-px" role="img" aria-label="Requests over the last day, an hour each, oldest first">
      {points.map((point) => {
        const failed = Math.max(point.errors, point.status_5xx);
        const label = `${new Date(point.time_us / 1000).toLocaleTimeString("en-US", { hour: "numeric" })}: ${plural(point.requests, "request")}${failed ? `, ${failed} failed` : ""}`;
        return (
          <Hint key={point.time_us} label={label}>
            <span
              className={`min-h-0.5 flex-1 rounded-sm ${point.requests && failed / point.requests >= 0.05 ? "bg-danger/80" : "bg-accent/60"}`}
              style={{ height: `${Math.max(4, (point.requests / most) * 100)}%` }}
            />
          </Hint>
        );
      })}
    </div>
  );
}

/** Its running software's last day, at a glance: traffic, latency, and the errors still open. */
function ObservabilityCard({ overview, errors, base }: { overview: TelemetryOverview; errors: ErrorGroup[]; base: string }) {
  const shown = [...errors].sort((a, b) => b.last_us - a.last_us).slice(0, ERRORS_SHOWN);
  return (
    <Card asChild className="p-5">
      <section aria-labelledby="overview-observability">
        <div className="flex items-center justify-between">
          <h2 id="overview-observability" className="flex items-center gap-1.5 text-sm font-semibold">
            <Activity size={14} className="text-faint" />
            Observability
          </h2>
          <Link to={`${base}/observability`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
            Last 24 hours <ArrowRight size={12} />
          </Link>
        </div>
        <div className="mt-4">
          <RequestBars points={overview.points} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <div><dt className="text-faint">Requests</dt><dd className="mt-0.5 font-medium tabular-nums">{count(overview.totals.requests)}</dd></div>
          <div><dt className="text-faint">Error rate</dt><dd className="mt-0.5 font-medium tabular-nums"><Link to={`${base}/observability/errors`} className={overview.totals.error_rate >= 0.01 ? "text-danger" : "hover:text-accent"}>{percent(overview.totals.error_rate)}</Link><span className="ml-1 text-muted">({count(overview.totals.errors)})</span></dd></div>
          <div>
            <dt className="text-faint">Latency p50</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{duration(overview.totals.latency.p50)}</dd>
          </div>
          <div>
            <dt className="text-faint">Latency p95</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{duration(overview.totals.latency.p95)}</dd>
          </div>
        </dl>
        <div className="mt-4 border-t border-line pt-3 text-xs">
          {shown.length === 0 ? (
            <p className="text-muted">No open errors.</p>
          ) : (
            <ul className="space-y-2.5">
              {shown.map((error) => (
                <li key={error.fingerprint} className="min-w-0">
                  <Link to={`${base}/observability/errors#${error.fingerprint}`} className="block min-w-0 hover:text-accent">
                    <span className="block truncate font-mono text-danger">{error.name}</span>
                    <span className="block truncate text-fg-soft">{error.message}</span>
                  </Link>
                  <span className="text-faint">
                    {plural(error.count, "time")} · last <TimeAgo at={error.last_us / 1000} />
                  </span>
                </li>
              ))}
              {errors.length > shown.length && (
                <li>
                  <Link to={`${base}/observability/errors`} className="text-muted hover:text-fg">
                    {plural(errors.length - shown.length, "more open error")}
                  </Link>
                </li>
              )}
            </ul>
          )}
        </div>
      </section>
    </Card>
  );
}

/** How it is keeping up: its recent builds, for members, and its open issues by age. */
function HealthCard({ loaderData, base, plan }: { loaderData: Loaded; base: string; plan: string }) {
  const { member, builds, open, health } = loaderData;
  const ages = health.ages;
  const oldest = ages ? Math.max(1, ...ages.map((a) => a.count)) : 1;
  return (
    <Card asChild className="p-5">
      <section aria-labelledby="overview-health">
        <h2 id="overview-health" className="flex items-center gap-1.5 text-sm font-semibold">
          <HeartPulse size={14} className="text-faint" />
          Health
        </h2>
        <div className="mt-4 space-y-4 text-xs">
          {member && (plan === "production" || builds.length > 0) && (
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-muted">Builds</span>
                <Link to={`${base}/deployments`} className="text-faint hover:text-fg">
                  {builds.length ? `last ${Math.min(builds.length, 20)}` : "none yet"}
                </Link>
              </div>
              <div className="mt-1.5">
                <DeployStrip builds={builds} base={base} />
              </div>
            </div>
          )}
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted">Open issues by age</span>
              <Link to={`${base}/issues`} className="font-medium tabular-nums hover:text-accent">
                {open.issues}
              </Link>
            </div>
            {ages ? (
              <ul className="mt-2 space-y-1.5">
                {ages.map((bucket) => (
                  <li key={bucket.label} className="grid grid-cols-[6.5rem_1fr_1.5rem] items-center gap-2">
                    <span className="text-faint">{bucket.label}</span>
                    <span className="block h-1.5 overflow-hidden rounded-full bg-line">
                      <span
                        className={`block h-full rounded-full ${bucket.label === "Older" ? "bg-warn" : "bg-fg-soft/60"}`}
                        style={{ width: `${(bucket.count / oldest) * 100}%` }}
                      />
                    </span>
                    <span className="text-right tabular-nums text-muted">{bucket.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-faint">Issues could not be loaded just now.</p>
            )}
          </div>
        </div>
      </section>
    </Card>
  );
}

/** The same date range and metrics as the project's workspace Insights. */
function DeliveryPanel({ loaderData: d, base }: { loaderData: Loaded; base: string }) {
  if (!d.member) return null;
  const metrics = d.insights?.projects[0];
  const days = deliveryDays(d.range.from, d.range.until, d.insights?.days ?? []);
  const peak = Math.max(1, ...days.map((day) => day.merged));
  return (
    <Panel title="Delivery" icon={<Activity size={14} />} extra={<span className="text-xs text-muted">Last 30 days</span>}
      all={d.workspaceMember ? { to: `/${base.split("/")[1]}/-/insights?period=30d&project=${encodeURIComponent(base.split("/")[2])}`, label: "Insights" } : undefined}>
      {!metrics ? <Unavailable what="Delivery insights" /> : (
        <Card className="overflow-hidden">
          <dl className="grid grid-cols-1 divide-y divide-line border-b border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {[
              { label: "Pull requests merged", value: metrics.merged },
              { label: "Average time to merge", value: deliveryDuration(metrics.merged ? metrics.leadSeconds / metrics.merged : null) },
              { label: "Average first review", value: deliveryDuration(metrics.reviewed ? metrics.reviewSeconds / metrics.reviewed : null) },
            ].map((stat) => <div key={stat.label} className="p-4"><dt className="text-xs text-muted">{stat.label}</dt><dd className="mt-2 text-xl font-semibold tabular-nums">{stat.value}</dd></div>)}
          </dl>
          <div className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted"><span>Merged pull requests per day</span><span>{rangeLabel(d.range.from, d.range.until)} · UTC</span></div>
            <div className="flex h-16 items-end gap-1" role="img" aria-label={`${metrics.merged} pull requests merged in the last 30 days`}>
              {days.map((day) => <Hint key={day.day} label={`${day.day}: ${plural(day.merged, "merged pull request")}`}><span className={`min-w-0 flex-1 rounded-sm ${day.merged ? "bg-accent/70" : "bg-line"}`} style={{ height: `${Math.max(4, day.merged / peak * 100)}%` }} /></Hint>)}
            </div>
            {metrics.merged === 0 && <p className="mt-3 text-xs text-faint">No pull requests merged in this period. Direct pushes appear in workflows below.</p>}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line px-4 py-3 text-xs text-muted">
            <Link to={`${base}/pulls`} className="hover:text-fg">{metrics.active} active pull requests</Link>
            <Link to={`${base}/pulls`} className="hover:text-fg">{metrics.unreviewed} awaiting first review</Link>
            <Link to={`${base}/queue`} className="hover:text-fg">{metrics.queued} in merge queue</Link>
          </div>
        </Card>
      )}
    </Panel>
  );
}

/** The latest sample, with real times, outcomes and links to each run. */
function WorkflowPanel({ loaderData: d, base }: { loaderData: Loaded; base: string }) {
  const runs = d.workflowRuns;
  const oldest = runs?.at(-1);
  return (
    <Panel title="Recent workflows" icon={<Activity size={14} />} all={{ to: `${base}/actions`, label: "All workflows" }}>
      {runs == null ? <Unavailable what="Workflows" /> : runs.length === 0 ? <Quiet>No workflows have run yet.</Quiet> : (
        <Card className="overflow-hidden">
          <div className="space-y-3 border-b border-line p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span>Latest {plural(runs.length, "run")} · all branches</span>
              <span>{oldest && <TimeAgo at={oldest.createdAt} />} → latest</span>
            </div>
            <div className="flex gap-1" aria-label="Workflow history, oldest first">
              {[...runs].reverse().map((run) => <Hint key={run.id} label={`${run.name}: ${standingWord(run)} · ${run.createdAt}`}>
                <Link to={`${base}/actions/runs/${run.id}`} aria-label={`${run.name}: ${standingWord(run)}`} className={`h-6 min-w-0 flex-1 rounded-sm transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-accent ${run.status !== "completed" ? "bg-warn/70 motion-safe:animate-pulse" : run.conclusion === "success" ? "bg-success/70" : run.conclusion === "failure" ? "bg-danger/70" : "bg-line"}`} />
              </Hint>)}
            </div>
            <p className="text-xs text-muted">{d.health.checkRuns ? `${share(d.health.passRate)} succeeded across ${d.health.checkRuns} completed runs. Cancelled and skipped runs excluded.` : "No completed successful or failed runs in this sample."}</p>
          </div>
          <ul className="divide-y divide-line">
            {runs.slice(0, 5).map((run) => <li key={run.id}>
              <Link to={`${base}/actions/runs/${run.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-raised/40">
                <StatusIcon status={run.status} conclusion={run.conclusion} />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{run.title || run.name}</span><span className="block truncate text-xs text-muted">{run.name} · {shortRef(run.ref)} · {standingWord(run)}{run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}</span></span>
                <span className="shrink-0 text-right text-xs text-muted"><TimeAgo at={run.createdAt} />{run.startedAt && <Duration className="block" start={run.startedAt} end={run.finishedAt} />}</span>
              </Link>
            </li>)}
          </ul>
        </Card>
      )}
    </Panel>
  );
}
