import {
  Activity as ActivityIcon,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Plus,
  Brain,
  Globe,
  Tag,
  Code2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Hand,
  HeartPulse,
  Lock,
  Package as PackageGlyph,
  Pin,
  Rocket,
  RotateCw,
} from "lucide-react";
import { waitUntil } from "cloudflare:workers";
import { isbot } from "isbot";
import { type ReactNode, Suspense } from "react";
import { Await, Form, Link } from "react-router";

import {
  type G1tEvent,
  type Memory,
  type PackageSummary,
  type Project,
  type Pull,
  type RepoMirror,
  workOwner,
} from "@g1t/contracts";

import type { Route } from "./+types/overview";
import { InlineMarkdown } from "../../components/inline-markdown";
import { DeployLink, host, StatusDot } from "../../components/deploy";
import { CheckBadge } from "../../components/checks";
import { useRefreshWhile } from "../../lib/refresh";
import { ActivityFeed, DeployStrip, Meter, NeedsList, Panel, Quiet, Unavailable, percent } from "../../components/mission";
import { type ActiveBranch, ActiveBranches } from "../../components/branches";
import { PackageIcon } from "../../components/package-icon";
import { Hint } from "../../components/ui/hint";
import { Loading, Skeleton, SkeletonRows } from "../../components/ui/skeleton";
import { ProductionShot } from "../../components/production-shot";
import { GithubLinkStrip } from "../../components/github";
import { MirrorOverviewNote, useRepoMirror } from "../../components/mirror";
import { type MirrorBrief, leaderOf, mirroringSettings, writable } from "../../lib/mirror";
import { distinctFacts } from "../../lib/memory-facts";
import { githubApp } from "../../lib/github.server";
import { ButtonLink, CopyLine, SubmitButton, TimeAgo } from "../../components/ui";
import { Avatar } from "../../components/ui/avatar";
import { Card } from "../../components/ui/card";
import { ChangeSize, PersonLink } from "../../components/work";
import {
  type ActivityItem,
  type Need,
  type PipelineStage,
  PIPELINE,
  TIME,
  actorIds,
  ageBuckets,
  firstPassRate,
  groupActivity,
  nameActor,
  passRate,
  pipelineStage,
  PROJECT_FEED_EVENT_TYPES,
  projectFeed,
  queuedNumbers,
  rankNeeds,
  runHealth,
} from "../../lib/mission";
import { ECOSYSTEM_LABEL, installCommands } from "../../lib/packages";
import {
  PUBLISH_GUIDES,
  bare,
  kindLabel,
  linksToShow,
  latestTag,
  libraryPackages,
  packageName,
  packagePath,
  projectChanges,
  projectPlan,
  publishGuide,
} from "../../lib/project-kind";
import { AboutEditor, KindMenu, LinkList } from "../../components/project-about";
import { DocsHead, ElsewhereHead, type ExternalDeployment, OtherHead, WhereItRuns } from "../../components/project-head";
import { actions, agents, deployments, events as eventLog, identity, packages, projects, repos, work } from "../../lib/services.server";
import { madeByG1t } from "../../lib/opened-by";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";
import { accessTo, countsFor, projectFor, refusal, repoFor, requireWritableRepo } from "../../lib/access.server";
import { shotVersion } from "./production-screenshot";
import { DeploymentsPanel } from "../../components/deployments-panel";
import { reportedProduction } from "../../lib/deployments";
import { cardSources, externalTarget, externalVersion, productionImageUrl } from "../../lib/production-image";
import { cloneUrl, useAddresses } from "../../lib/addresses";
import { readBranches } from "../../lib/branches.server";
import { commitChecksFor } from "../../lib/commit-checks.server";
import { showCommits } from "../../lib/commit-people.server";
import { CommitAvatars, CommitNames } from "../../components/commit-person";
import { CommitChecksBadge } from "../../components/commit-checks";
import { repoPages } from "../../lib/repo-live";
import { useRepoLive } from "../../lib/use-repo-live";

const MAX_LANDED = 6;
/** Branches read for the Active branches list, and shown. */
const BRANCHES_READ = 10;
const BRANCHES_SHOWN = 5;
/** A library's packages shown on its overview; the rest are a link away. */
const PACKAGES_SHOWN = 3;
/** The default branch's latest commits listed. */
const COMMITS_SHOWN = 5;
/** How long Active branches may take before the section links to Branches instead. */
const BRANCHES_WAIT_MS = 3_500;
/**
 * The same for a crawler, which gets the page only once everything in it
 * has settled (entry.server.tsx): past this, it gets the link to Branches.
 */
const BRANCHES_WAIT_CRAWLER_MS = 700;

/**
 * The overview streams: the layout's header and tabs (one repository
 * lookup, one project) go out at once with a skeleton below them, and
 * everything here, seventeen calls across six services, follows in the
 * same response as it settles. Crawlers wait for all of it
 * (entry.server.tsx). Before, the first byte waited on the slowest of them.
 */
export function loader({ params, context, request }: Route.LoaderArgs) {
  const userAgent = request.headers.get("user-agent");
  return { overview: overviewData({ params, context }, Boolean(userAgent && isbot(userAgent))) };
}

async function overviewData({ params, context }: Pick<Route.LoaderArgs, "params" | "context">, crawler: boolean) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const ref = { workspace: params.owner, slug: params.repo };
  const now = Date.now();
  // A section whose service fails shows its own empty state; the page stays up.
  const soft = <T,>(promise: Promise<T> | null): Promise<T | null> =>
    promise ? promise.catch((error) => (console.warn("overview:", error), null)) : Promise.resolve(null);
  // People with a role of their own here see its running parts: deployments,
  // memory; everyone who can read it sees the rest. Not awaited: only
  // those sections wait on the repository lookup, which the layout makes in
  // this request too.
  const accessP = accessTo(context, params);
  const memberP = accessP.then((access) => access.insider);
  const forMembers = <T,>(start: () => Promise<T>): Promise<T | null> =>
    memberP.then((member) => (member ? soft(start()) : null));
  const repoP = soft(repoFor(context, params));
  const projectP = soft(projectFor(context, params));
  // A library or a tool shows its packages where an app shows production.
  // Deployments from anywhere (g1t.page, g1t Actions, the API), by environment, for anyone who can read it.
  const environmentsP = projectP.then((found) =>
    soft(deployments.environments(found?.ok && found.value.source.kind === "hosted" ? found.value.source.repo : path, viewer)),
  );
  const planP = projectP.then((project) => (project?.ok ? projectPlan(project.value) : null));
  const libraryRepoP = Promise.all([planP, repoP]).then(([plan, repo]) => (plan === "release" && repo?.ok ? repo.value : null));
  const packagesP = libraryRepoP.then((repo) => (repo ? soft(packages.list(params.owner, viewer, { repoId: repo.id })) : null));
  // Recent workflow runs, for Health when no pull request's checks have finished lately.
  const workflowRunsP = soft(actions.runs(path, viewer, { limit: 30 }));
  // Only the kinds the feed shows: the newest events are mostly session
  // steps and merge checks, which would otherwise crowd out everything.
  const eventsP = repoP.then((repo) =>
    repo?.ok ? soft(eventLog.list({ repoId: repo.value.id, types: [...PROJECT_FEED_EVENT_TYPES], limit: 150 })) : null,
  );
  const minePullsP = repoP.then((repo) =>
    repo?.ok && viewer
      ? soft(work.listActivePulls(viewer)).then((list) => (list ?? []).filter((item) => item.pull.repoId === repo.value.id))
      : null,
  );
  const openP = soft(work.listPulls(path, viewer, "open"));
  // Where its code came from on GitHub, for members.
  const githubP = repoP.then((repo) => (repo?.ok ? forMembers(() => githubApp.link(repo.value.id)) : null));
  const listP = forMembers(() => deployments.list(ref, viewer));
  // Active branches: the newest few besides the default, with how far each
  // has moved. Branches with an open pull request are read first.
  const branchesP = Promise.all([repoP, soft(repos.branches(path, viewer)), openP, listP]).then(
    async ([repo, branchList, pulls, deploys]): Promise<{ main: string; total: number; shown: ActiveBranch[] } | null> => {
      if (!repo?.ok || !branchList?.ok) return null;
      const main = repo.value.defaultBranch;
      if (branchList.value.every((branch) => branch.name === main)) return { main, total: 0, shown: [] };
      const read = await readBranches(
        path,
        viewer,
        {
          defaultBranch: main,
          branches: branchList.value,
          pulls: pulls?.ok ? pulls.value : [],
          previews: deploys?.ok ? deploys.value.live.filter((app) => app.kind === "preview") : [],
        },
        BRANCHES_READ,
      );
      return { main, total: read.total, shown: read.shown.slice(0, BRANCHES_SHOWN) };
    },
  );
  // Active branches walk history when a branch or the default branch has
  // moved: streamed, so the rest shows first. Bounded well inside the
  // response's stream timeout (entry.server.tsx): a promise still pending
  // when the stream ends never settles in the browser, and its skeleton
  // would stay. The walk finishes after the page if it must (waitUntil),
  // so repos keeps the answer and the next view has it. Crawlers, which
  // wait for the whole page, wait for it only briefly.
  waitUntil(branchesP.then(() => undefined, () => undefined));
  const branches = Promise.race([
    branchesP.catch(() => null),
    new Promise<"slow">((resolve) => setTimeout(() => resolve("slow"), crawler ? BRANCHES_WAIT_CRAWLER_MS : BRANCHES_WAIT_MS)),
  ]);
  const [{ insider: member, can }, project, settings, list, open, closed, log, counts, queue, issues, memories, recent, mine, packageList, tagList] = await Promise.all([
    accessP,
    projectP,
    forMembers(() => deployments.settings(ref, viewer)),
    listP,
    openP,
    soft(work.listPulls(path, viewer, "closed")),
    // With their people, in one identity call.
    soft(repos.log(path, viewer, null, COMMITS_SHOWN).then(async (found) => (found.ok ? { ok: true as const, value: await showCommits(found.value) } : found))),
    soft(countsFor(context, params)),
    soft(work.queue(path, viewer)),
    soft(work.listIssues(path, viewer, { state: "open" })),
    forMembers(() => agents.listMemories(viewer, params.owner, path)),
    eventsP,
    minePullsP,
    packagesP,
    // The latest release, for About.
    soft(repos.tags(path, viewer)),
  ]);
  const workflowRuns = await workflowRunsP;
  const ok = <T,>(result: { ok: true; value: T } | { ok: false } | null): T | null => (result?.ok ? result.value : null);

  const openPulls = ok(open) ?? [];
  const builds = ok(list)?.deployments ?? [];
  const landed = (ok(closed) ?? [])
    .filter((pull) => pull.status === "merged")
    .sort((a, b) => Date.parse(b.mergedAt ?? b.updatedAt) - Date.parse(a.mergedAt ?? a.updatedAt));
  const queued = queuedNumbers(ok(queue)?.active ?? []);
  const lifecycleOf = new Map((mine ?? []).map((item) => [item.pull.number, item.lifecycle]));

  // --- The pipeline -----------------------------------------------------------
  type Card = {
    number: number;
    title: string;
    agent: string;
    status: Pull["status"];
    checkStatus: Pull["checkStatus"];
    needsYou: boolean;
    at: string;
  };
  const columns: Record<PipelineStage, Card[]> = { working: [], checking: [], reviewing: [], queue: [], landed: [] };
  for (const pull of openPulls.slice(0, 40)) {
    columns[pipelineStage(pull, undefined, queued, lifecycleOf.get(pull.number))].push({
      number: pull.number,
      title: pull.title,
      agent: pull.agent,
      status: pull.status,
      checkStatus: pull.checkStatus,
      needsYou: lifecycleOf.get(pull.number)?.stage === "needs_you",
      at: pull.updatedAt,
    });
  }
  for (const pull of landed.filter((p) => now - Date.parse(p.mergedAt ?? p.updatedAt) < 3 * TIME.DAY).slice(0, 5)) {
    columns.landed.push({
      number: pull.number,
      title: pull.title,
      agent: pull.agent,
      status: pull.status,
      checkStatus: pull.checkStatus,
      needsYou: false,
      at: pull.mergedAt ?? pull.updatedAt,
    });
  }

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
  // --- Activity and health -------------------------------------------------------
  const eventList: G1tEvent[] = recent ?? [];
  const logged: ActivityItem[] = projectFeed(eventList, path);
  // The log names people by account id: their usernames, in one lookup.
  const ids = actorIds(logged.map((item) => item.actor));
  const names = ids.length > 0 ? await soft(identity.usernames(ids)) : {};
  const items = logged.map((item) => ({ ...item, actor: nameActor(item.actor, names) }));
  const checkEvents = eventList.flatMap((event) =>
    event.type === "checks.completed" ? [{ repo: "", number: event.data.number, at: Date.parse(event.time), passed: event.data.status === "passed" }] : [],
  );
  const memoryList = ok(memories)?.project ?? [];
  // Pinned first, then the newest; a fact remembered twice, once.
  const knows = distinctFacts([...memoryList.filter((m) => m.pinned), ...memoryList.filter((m) => !m.pinned).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))]).slice(0, 5);
  const openIssues = ok(issues);

  // --- Where it runs ------------------------------------------------------------
  const commitNow = ok(log)?.[0] ?? null;
  // Production deployed somewhere other than g1t.page (by g1t Actions, or
  // reported through the API): the slot an app deployed elsewhere shows.
  const environments = await environmentsP;
  const environmentList = environments?.ok ? environments.value : null;
  const deployment: ExternalDeployment | null = reportedProduction(environmentList?.environments ?? []);
  // An app that has not said where it runs, but reports production from
  // elsewhere, runs elsewhere.
  const found = ok(project);
  const projectValue = found && deployment && found.kind === "app" && found.runs == null ? { ...found, runs: "elsewhere" as const } : found;
  const isLibrary = projectValue != null && projectPlan(projectValue) === "release";
  const published = libraryPackages(ok(packageList) ?? []);

  // The checks on the latest commit and each active branch's head, in
  // one call once the branches are read: streamed in beside them.
  const checks = branches.then((found) =>
    commitChecksFor(path, viewer, [commitNow?.hash, ...(found && found !== "slow" ? found.shown : []).map((branch) => branch.commit?.hash)]),
  );
  const github = await githubP;
  return {
    member,
    can,
    github,
    project: projectValue,
    settings: ok(settings),
    builds: builds.slice(0, 30),
    live: ok(list)?.live ?? [],
    commit: ok(log)?.[0] ?? null,
    commits: (ok(log) ?? []).map((one) => ({ hash: one.hash, message: one.message.split("\n")[0] ?? "", author: one.author, coAuthors: one.coAuthors, at: one.authoredAt })),
    release: latestTag(ok(tagList) ?? []),
    // Production as reported from outside g1t, for an app deployed elsewhere.
    deployment,
    // Its screenshot's address on the site (production-elsewhere.ts), when it has one to show.
    elsewhereShot: elsewhereShot(projectValue, deployment, base),
    // Every environment's latest deployment, for the Deployments panel.
    environments: environmentList,
    // About's languages and contributors, filled in by the files' About work.
    languages: null as { name: string; share: number }[] | null,
    contributors: null as { username: string }[] | null,
    open: ok(counts) ?? { issues: openIssues?.length ?? 0, pulls: openPulls.length },
    pullsLoaded: open?.ok ?? false,
    columns,
    needs: rankNeeds(needs),
    landed: landed.slice(0, MAX_LANDED),
    groups: groupActivity(items).slice(0, 30),
    eventsLoaded: recent != null,
    health: {
      // A pull request's checks when any finished lately; otherwise the
      // project's workflow runs, for one that ships straight to its branch.
      ...(checkEvents.length > 0 || !workflowRuns?.ok
        ? { passRate: passRate(checkEvents.map((c) => c.passed)), firstPass: firstPassRate(checkEvents), checkRuns: checkEvents.length }
        : runHealth(workflowRuns.value)),
      ages: openIssues ? ageBuckets(openIssues.map((issue) => issue.createdAt), now) : null,
    },
    knows: knows as Memory[],
    memoryCount: memoryList.length,
    memoriesLoaded: memories?.ok ?? false,
    library: isLibrary
      ? { packages: published.slice(0, PACKAGES_SHOWN), total: published.length, loaded: packageList?.ok ?? false }
      : null,
    branches,
    checks,
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
  // Deploying is compute. Syncing with GitHub is under Settings → Mirroring.
  await requireWritableRepo(context, params);
  const refused = await refusal(context, params, "run");
  if (refused) return { error: refused };
  const started = await deployments.redeploy(user, { workspace: params.owner, slug: params.repo }, null);
  return started.ok ? { notice: "Production is building." } : { error: started.error.message };
}

type Loaded = Awaited<ReturnType<typeof overviewData>>;
type Card = Loaded["columns"]["working"][number];

const STAGE_TONE: Record<PipelineStage, string> = {
  working: "bg-accent",
  checking: "bg-info",
  reviewing: "bg-warn",
  queue: "bg-success-dim",
  landed: "bg-success",
};

function PipelineCard({ card, base, stage }: { card: Card; base: string; stage: PipelineStage }) {
  return (
    <li>
      <Link
        to={`${base}/pull/${card.number}`}
        prefetch="intent"
        className={`block rounded-lg border bg-bg/60 p-2.5 transition-colors hover:border-line-strong hover:bg-raised ${
          card.needsYou ? "border-warn/50" : "border-line"
        }`}
      >
        <span className="line-clamp-2 text-[0.8125rem] leading-snug font-medium">{card.title}</span>
        <span className="mt-1.5 flex items-center gap-1.5 text-[0.6875rem] text-muted">
          <Avatar name={card.agent} size={14} />
          <span className="font-mono text-faint">#{card.number}</span>
          <span className="grow" />
          {card.needsYou ? (
            <Hint label="Stopped: a person decides what happens next">
              <span className="inline-flex items-center gap-1 text-warn">
                <Hand size={11} /> you
                <span className="sr-only">: stopped, a person decides what happens next</span>
              </span>
            </Hint>
          ) : stage === "landed" ? (
            <TimeAgo at={card.at} />
          ) : (
            <CheckBadge status={card.checkStatus} />
          )}
        </span>
      </Link>
    </li>
  );
}

/** Open pull requests moving through Working → Checking → Reviewing → Queue → Landed. */
function Pipeline({ columns, base }: { columns: Loaded["columns"]; base: string }) {
  return (
    <div className="relative -mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
      {/* Each stage as tall as what is in it: an empty one stays short
          instead of stretching to the busiest. */}
      <ol className="grid min-w-176 grid-cols-5 items-start gap-2">
        {PIPELINE.map(({ stage, label }, index) => {
          const cards = columns[stage];
          return (
            <Card asChild key={stage} className="flex min-w-0 flex-col p-2">
              <li>
                <p className="flex items-center gap-2 px-1 pt-0.5 pb-2 text-xs font-medium text-muted">
                  <span className={`size-1.5 rounded-full ${STAGE_TONE[stage]} ${cards.length && stage !== "landed" ? "animate-pulse" : ""}`} />
                  {label}
                  <span className="tabular-nums text-faint">{cards.length}</span>
                  {index < PIPELINE.length - 1 && <ArrowRight size={11} className="ml-auto text-line-strong" />}
                </p>
                {cards.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line/70 px-2 py-3 text-center text-[0.6875rem] text-faint">Empty</p>
                ) : (
                  <ul className="space-y-1.5">
                    {cards.slice(0, 6).map((card) => (
                      <PipelineCard key={card.number} card={card} base={base} stage={stage} />
                    ))}
                    {cards.length > 6 && (
                      <li className="px-1 text-[0.6875rem] text-muted">
                        <Link to={`${base}/pulls`} className="hover:text-fg">
                          {cards.length - 6} more
                        </Link>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            </Card>
          );
        })}
      </ol>
    </div>
  );
}

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

function Stat({ label, value, to }: { label: string; value: ReactNode; to?: string }) {
  const body = (
    <>
      <span className="block text-[0.6875rem] text-faint">{label}</span>
      <span className="mt-0.5 block truncate text-[0.8125rem] font-medium">{value}</span>
    </>
  );
  return to ? (
    <Link to={to} className="min-w-0 px-5 py-3 transition-colors hover:bg-raised/50">
      {body}
    </Link>
  ) : (
    <div className="min-w-0 px-5 py-3">{body}</div>
  );
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
  return (
    <Loading className="space-y-8" aria-label="Loading the overview">
      {/* Production: its screenshot beside where it is live, then the facts under them. */}
      <section aria-hidden="true" className="overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:p-6">
          <Skeleton className="aspect-[16/10] w-full shrink-0 rounded-lg sm:w-72" />
          <div className="min-w-0 grow">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-5 w-72 max-w-full" />
            <Skeleton className="mt-3 h-3 w-48 max-w-full" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="bg-surface px-5 py-4">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2.5 h-4 w-28" />
            </div>
          ))}
        </div>
      </section>
      {/* Right now: the work, column by column. */}
      <div aria-hidden="true" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Card key={index} className="p-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-14 rounded-lg" />
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-line bg-surface">
          <SkeletonRows rows={4} />
        </section>
        <section className="rounded-2xl border border-line bg-surface">
          <SkeletonRows rows={4} />
        </section>
      </div>
    </Loading>
  );
}

function OverviewFailed() {
  return (
    <p className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted">
      The overview could not be loaded just now. Reload the page to try again.
    </p>
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
  const { member, project, settings, builds, live, commit, open, columns, needs, landed, groups, health, knows, branches, library, checks } =
    loaderData;
  const base = `/${params.owner}/${params.repo}`;
  // What it is to its remotes, from the repository layout.
  const { repo: mirrorRepo, briefs: mirrorBriefs, admin: mirrorAdmin } = useRepoMirror();
  const production = live.find((app) => app.kind === "production") ?? null;
  // The project's own domain, once it is active, is where production is visited.
  const productionUrl = production ? (settings?.primaryDomain ? `https://${settings.primaryDomain}` : production.url) : null;
  const previews = live.filter((app) => app.kind === "preview");
  const latestProduction = builds.find((build) => build.kind === "production") ?? null;
  const plan = project ? projectPlan(project) : "production";
  const canChange = member && loaderData.can.manage_settings;
  // Its homepage and docs beside what it is, unless the card below already links there.
  const headUrl =
    plan === "production"
      ? (productionUrl ?? settings?.productionUrl)
      : plan === "elsewhere"
        ? (loaderData.deployment?.url ?? project?.productionUrl)
        : plan === "docs"
          ? (project?.links.docs ?? project?.productionUrl ?? project?.links.homepage)
          : plan === "other"
            ? (project?.links.homepage ?? project?.links.docs)
            : null;
  const stripLinks = project ? linksToShow({ ...project.links, custom: [] }, [headUrl]) : [];
  const addresses = useAddresses();
  // The production card's picture: an uploaded image, served from the
  // usercontent origin, and where someone who may change it adds one.
  const upload = project?.productionImage
    ? { url: productionImageUrl(project.productionImage.file, addresses.usercontent), preferred: project.productionImage.preferred }
    : null;
  const addImage = canChange ? `${base}/settings#production-image` : null;
  const elsewhereUrl = loaderData.deployment?.url ?? project?.productionUrl ?? null;
  const source = project?.source.kind === "hosted" ? project.source : null;
  const moving = columns.working.length + columns.checking.length > 0;
  useRefreshWhile(moving);
  // Pushes, checks, releases and deployments show as they happen.
  useRepoLive({ match: repoPages.files() });
  const ages = health.ages;
  const oldest = ages ? Math.max(1, ...ages.map((a) => a.count)) : 1;

  // A mirror that is not taken over is a read-only copy (lib/mirror.ts
  // `offers`): what it is, where it comes from and what it holds, and
  // nothing to start. Where it runs and Right now come back with a takeover.
  const readOnlyMirror = mirrorRepo?.mirror && !writable(mirrorRepo.mirror) ? mirrorRepo.mirror : null;
  if (readOnlyMirror) {
    return (
      <MirrorOverview
        loaderData={loaderData}
        base={base}
        mirror={readOnlyMirror}
        briefs={mirrorBriefs}
        admin={mirrorAdmin}
        source={source}
        canChange={canChange}
        addresses={addresses}
      />
    );
  }

  return (
    <div className="space-y-8">
      {loaderData.github?.mode === "import" ? (
        <GithubLinkStrip link={loaderData.github} />
      ) : (
        <MirrorOverviewNote
          base={base}
          mirror={mirrorRepo?.mirror}
          briefs={mirrorBriefs}
          admin={mirrorAdmin}
          syncedAt={loaderData.github?.syncedAt}
          lastError={loaderData.github?.lastError}
        />
      )}
      {/* What the project is, running, and where its code is. */}
      <section className="overflow-hidden rounded-2xl border border-line bg-surface">
        {project && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-2.5 text-xs sm:px-6">
            <KindMenu project={project} label={kindLabel(project)} canChange={canChange} />
            {stripLinks.map((link) => (
              <DeployLink key={link.key} href={link.url} className="inline-flex min-w-0 items-center gap-1.5 text-muted hover:text-fg">
                {link.type === "docs" ? <BookOpen size={12} className="shrink-0 text-faint" /> : <Globe size={12} className="shrink-0 text-faint" />}
                <span className="truncate">{link.type === "docs" ? `Docs · ${bare(link.url)}` : link.label}</span>
              </DeployLink>
            ))}
          </div>
        )}
        {plan === "elsewhere" && project ? (
          <ElsewhereHead
            project={project}
            base={base}
            canChange={canChange}
            canDeploy={member && loaderData.can.manage_integrations}
            deployment={loaderData.deployment}
            commit={commit}
            checks={commit ? <CommitChecksBadge checks={checks} sha={commit.hash} className="size-5" /> : undefined}
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
          <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:p-6">
            {/* Always a picture: the screenshot (members, like the deployments), the uploaded image, or the frame. */}
            <ProductionShot
              sources={cardSources(member && production ? `${base}/production.jpg?v=${shotVersion(production)}` : null, upload)}
              href={production ? (productionUrl ?? production.url) : null}
              label={production ? host(productionUrl ?? production.url) : settings?.productionUrl ? host(settings.productionUrl) : ""}
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
              {production ? (
                <>
                  <DeployLink
                    href={productionUrl ?? production.url}
                    className="mt-2 flex items-center gap-1.5 truncate font-mono text-lg font-medium hover:text-accent"
                  >
                    {host(productionUrl ?? production.url)}
                    <ArrowUpRight size={16} className="shrink-0 text-faint" />
                  </DeployLink>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    {latestProduction && <StatusDot status={latestProduction.status} label={latestProduction.status === "ready" ? "Live" : undefined} />}
                    <span className="inline-flex items-center gap-1 font-mono">
                      <GitCommitHorizontal size={13} className="text-faint" />
                      {production.commit.slice(0, 7)}
                    </span>
                    <span>
                      deployed <TimeAgo at={production.deployedAt} />
                    </span>
                    {settings?.primaryDomain && <span className="text-faint">also at {host(production.url)}</span>}                  </p>
                </>
              ) : settings?.enabled ? (
                <>
                  <p className="mt-2 font-mono text-lg text-muted">{host(settings.productionUrl)}</p>
                  <p className="mt-1.5 text-xs text-muted">
                    {latestProduction ? (
                      <StatusDot status={latestProduction.status} label={latestProduction.status === "failed" ? "The last build failed" : undefined} />
                    ) : (
                      "Not deployed yet. Push to the default branch, or deploy it now."
                    )}
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-2 text-lg font-medium">Deployments are off</p>
                  <p className="mt-1 max-w-lg text-sm text-muted">
                    Nothing builds or runs until you turn them on. Then {project?.name ?? params.repo} goes up on g1t.page:
                    production from the default branch, and a live preview for every pull request. It runs only while
                    someone visits.
                  </p>
                </>
              )}
            </div>
            {member && (
              <div className="flex shrink-0 items-center gap-2">
                {production && (
                  <ButtonLink to={productionUrl ?? production.url} variant="accent" reloadDocument target="_blank" rel="noopener noreferrer">
                    Visit
                    <ArrowUpRight size={14} />
                  </ButtonLink>
                )}
                {settings?.enabled ? (
                  loaderData.can.run && <Form method="post">
                    <Hint label="Build production again from the default branch">
                      <SubmitButton variant="outline" name="intent" value="redeploy" pending="Redeploying…">
                        <RotateCw size={14} />
                        Redeploy
                      </SubmitButton>
                    </Hint>
                  </Form>
                ) : loaderData.can.manage_integrations && (
                  <ButtonLink to={`${base}/settings/deployments`} variant="accent">
                    <Rocket size={14} />
                    Turn on deployments
                  </ButtonLink>
                )}
              </div>
            )}
            </div>
          </div>
        )}
        {actionData && (
          <p className={`border-t border-line px-6 py-2.5 text-sm ${"error" in actionData ? "text-danger" : "text-success"}`}>
            {"error" in actionData ? actionData.error : actionData.notice}
          </p>
        )}
        <div className="grid grid-cols-2 divide-line border-t border-line text-sm sm:grid-cols-4 sm:divide-x">
          <Stat
            label="Source"
            to={`${base}/code`}
            value={
              source ? (
                <span className="inline-flex items-center gap-1.5 font-mono">
                  {project?.private ? <Lock size={12} className="text-faint" /> : <Code2 size={12} className="text-faint" />}
                  {source.repo.name}
                  {source.rootDir ? `/${source.rootDir}` : ""}
                </span>
              ) : (
                "—"
              )
            }
          />
          <Stat
            label="Default branch"
            to={`${base}/commits`}
            value={
              <span className="inline-flex items-center gap-1.5 font-mono">
                <GitBranch size={12} className="text-faint" />
                {source?.defaultBranch ?? "main"}
              </span>
            }
          />
          <Stat
            label="Latest commit"
            value={
              commit ? (
                <span className="flex min-w-0 items-center gap-1">
                  <Hint label={commit.message.split("\n")[0]}>
                    <Link to={`${base}/commit/${commit.hash}`} className="min-w-0 truncate hover:text-accent">
                      <span className="font-mono">{commit.hash.slice(0, 7)}</span>{" "}
                      <span className="font-normal text-muted">
                        <TimeAgo at={commit.authoredAt} />
                      </span>
                    </Link>
                  </Hint>
                  {/* A button, so beside the link rather than in it. */}
                  <CommitChecksBadge checks={checks} sha={commit.hash} className="size-5" />
                </span>
              ) : (
                "No commits yet"
              )
            }
          />
          <Stat
            label={member && settings?.enabled && !library ? "Last deploy" : "Open"}
            to={member && settings?.enabled && !library ? `${base}/deployments` : `${base}/pulls`}
            value={
              member && settings?.enabled && !library ? (
                latestProduction ? (
                  <span className="inline-flex items-center gap-2">
                    <StatusDot status={latestProduction.status} />
                    <span className="font-normal text-muted">
                      <TimeAgo at={latestProduction.createdAt} />
                    </span>
                  </span>
                ) : (
                  "None yet"
                )
              ) : (
                `${open.pulls} pull requests · ${open.issues} issues`
              )
            }
          />
        </div>
        {commit && (
          <p className="truncate border-t border-line px-5 py-2.5 text-xs text-muted sm:px-6">
            <GitCommitHorizontal size={12} className="mr-1.5 inline text-faint" />
            {commit.message.split("\n")[0]}{" "}
            <span className="text-faint">
              · <CommitNames commit={commit} className="hover:text-fg" />
            </span>
          </p>
        )}
      </section>

      <Panel
        title="Right now"
        icon={<span className={`block size-2 rounded-full ${moving ? "animate-pulse bg-accent" : "bg-line-strong"}`} />}
        all={{ to: `${base}/pulls`, label: "Pull requests" }}
      >
        {!loaderData.pullsLoaded ? (
          <Unavailable what="Pull requests" />
        ) : Object.values(columns).every((c) => c.length === 0) ? (
          <Quiet
            action={
              member ? (
                <Link to={`${base}/issues/new`} className="inline-flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-bg hover:bg-fg-hover">
                  <Plus size={12} /> New issue
                </Link>
              ) : null
            }
          >
            Nothing is moving. Open an issue, or push a branch and open a pull request.
          </Quiet>
        ) : (
          <Pipeline columns={columns} base={base} />
        )}
      </Panel>

      <div className="grid gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-8">
          {needs.length > 0 && (
            <Panel title="Needs you" icon={<Hand size={14} className="text-warn" />} count={needs.length}>
              <NeedsList needs={needs} limit={5} />
            </Panel>
          )}

          <Suspense
            fallback={
              <Panel title="Active branches" icon={<GitBranch size={14} />}>
                <div aria-busy="true">
                  <SkeletonRows rows={3} rowClassName="h-12" />
                </div>
              </Panel>
            }
          >
            <Await
              resolve={branches}
              errorElement={
                <Panel title="Active branches" icon={<GitBranch size={14} />}>
                  <Unavailable what="Branches" />
                </Panel>
              }
            >
              {(branches) => (
                <Panel
                  title="Active branches"
                  icon={<GitBranch size={14} />}
                  count={branches && branches !== "slow" ? branches.total || null : null}
                  all={{ to: `${base}/branches`, label: "All branches" }}
                >
                  {branches === "slow" ? (
                    <Quiet>
                      Its branches are taking a while to compare.{" "}
                      <Link to={`${base}/branches`} className="text-accent hover:underline">
                        See them on Branches
                      </Link>
                      .
                    </Quiet>
                  ) : !branches ? (
                    <Unavailable what="Branches" />
                  ) : branches.shown.length === 0 ? (
                    <Quiet>
                      Only {branches.main} so far. Branches pushed here show with how far each has moved from {branches.main}, and
                      its pull request and preview.
                    </Quiet>
                  ) : (
                    <>
                      <ActiveBranches branches={branches.shown} base={base} main={branches.main} checks={checks} />
                      {branches.total > branches.shown.length && (
                        <p className="mt-2 px-1 text-xs text-faint">
                          The {branches.shown.length} most recently changed of {branches.total} branches.
                        </p>
                      )}
                    </>
                  )}
                </Panel>
              )}
            </Await>
          </Suspense>

          <Panel title="Recent changes" icon={<GitMerge size={14} />} all={{ to: `${base}/pulls?state=closed`, label: "All landed" }}>
            {landed.length === 0 ? (
              <Quiet>Nothing has landed yet. Merged pull requests show here with who made them and why.</Quiet>
            ) : (
              <Card asChild divided className="overflow-hidden">
                <ul>
                  {landed.map((pull) => {
                    const byAgent = pull.runtime === "hosted" || madeByG1t(pull);
                    return (
                      <li key={pull.id} className="flex items-start gap-3 px-4 py-3">
                        <GitMerge size={15} className="mt-0.5 shrink-0 text-merged" />
                        <span className="min-w-0 grow">
                          <Link to={`${base}/pull/${pull.number}`} prefetch="intent" className="block truncate text-sm font-medium hover:text-accent">
                            {pull.title}
                          </Link>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                            <span className="font-mono text-faint">#{pull.number}</span>
                            <span>·</span>
                            {/* The avatar is whoever the line names first: the
                                agent that made it, or the person who wrote it
                                with their own tools. */}
                            <span className="inline-flex items-center gap-1">
                              {pull.requestedBy ? (
                                <>
                                  <Avatar name={pull.author.username} size={13} />
                                  made by <PersonLink name={pull.author.username} className="hover:text-fg" /> for{" "}
                                  <PersonLink name={pull.requestedBy.username} className="hover:text-fg" />
                                </>
                              ) : byAgent ? (
                                <>
                                  <Avatar name={pull.agent} size={13} />
                                  made by {pull.agent}
                                </>
                              ) : (
                                <>
                                  <Avatar name={pull.author.username} size={13} />
                                  by <PersonLink name={pull.author.username} className="hover:text-fg" />
                                </>
                              )}
                            </span>
                            {pull.issue != null && (
                              <>
                                <span>· for</span>
                                <Link to={`${base}/issues/${pull.issue}`} className="hover:text-fg">
                                  #{pull.issue}
                                </Link>
                              </>
                            )}
                            {pull.mergedBy && (
                              <span>
                                · landed by <PersonLink name={pull.mergedBy} className="hover:text-fg" />
                              </span>
                            )}
                            <span>
                              · <TimeAgo at={pull.mergedAt ?? pull.updatedAt} />
                            </span>
                          </span>
                        </span>
                        <span className="hidden shrink-0 text-xs text-faint sm:block">
                          <ChangeSize files={pull.files} />
                        </span>
                        {byAgent && (
                          <Link to={`${base}/sessions/${pull.number}`} className="shrink-0 text-xs text-muted hover:text-fg">
                            Session
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </Panel>

          <LatestCommits commits={loaderData.commits} base={base} branch={source?.defaultBranch ?? "main"} />

          <Panel title="Activity" icon={<ActivityIcon size={14} />}>
            {loaderData.eventsLoaded ? (
              <ActivityFeed groups={groups} showRepo={false} limit={8} empty="Nothing has happened here yet." />
            ) : (
              <Unavailable what="Activity" />
            )}
          </Panel>

          {previews.length > 0 && (
            <Panel title="Previews" icon={<GitBranch size={14} />} count={previews.length} all={{ to: `${base}/deployments`, label: "Deployments" }}>
              <Card asChild divided className="overflow-hidden">
                <ul>
                  {previews.map((app) => (
                    <li key={app.url} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="min-w-0 grow">
                        <DeployLink href={app.url} className="block truncate font-mono text-[0.8125rem] hover:text-accent">
                          {host(app.url)}
                        </DeployLink>
                        <span className="text-xs text-muted">
                          {app.branch}
                          {app.number != null && (
                            <>
                              {" · "}
                              <Link to={`${base}/pull/${app.number}`} className="hover:underline">
                                #{app.number}
                              </Link>
                            </>
                          )}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-faint">
                        <TimeAgo at={app.deployedAt} />
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </Panel>
          )}
        </div>

        <aside className="space-y-4 text-sm">
          {/* Deployments panel (deployments-panel.tsx): each environment's latest deployment. */}
          <DeploymentsPanel base={base} summary={loaderData.environments} className="rounded-xl border border-line bg-surface p-5" />
          {project && <AboutCard project={project} canChange={canChange} base={base} loaderData={loaderData} />}

          {member && (
            <Card asChild className="p-5">
              <section>
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                    <Brain size={14} className="text-accent" />
                    What this project remembers
                  </h2>
                  <Link to={`${base}/memory`} className="text-xs text-muted hover:text-fg">
                    Memory
                  </Link>
                </div>
                {!loaderData.memoriesLoaded ? (
                  <p className="mt-3 text-xs text-muted">Memory could not be loaded just now.</p>
                ) : knows.length === 0 ? (
                  <p className="mt-3 text-xs leading-5 text-muted">
                    Nothing yet. People and coding agents note conventions, decisions and traps here, and agents read them with recall.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2.5">
                    {knows.map((memory) => (
                      <li key={memory.id} className="text-xs leading-5">
                        <p className="line-clamp-3 text-fg-soft">
                          {memory.pinned && <Pin size={11} className="mr-1 inline text-accent" />}
                          <InlineMarkdown text={memory.text} />
                        </p>
                        <p className="text-faint">
                          {memory.kind} · {memory.createdBy} · <TimeAgo at={memory.createdAt} />
                        </p>
                      </li>
                    ))}
                    {loaderData.memoryCount > knows.length && (
                      <li>
                        <Link to={`${base}/memory`} className="text-xs text-muted hover:text-fg">
                          {loaderData.memoryCount - knows.length} more
                        </Link>
                      </li>
                    )}
                  </ul>
                )}
              </section>
            </Card>
          )}

          <Card asChild className="p-5">
            <section>
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <HeartPulse size={14} className="text-faint" />
                Health
              </h2>
              <div className="mt-4 space-y-4 text-xs">
                <div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-muted">Checks passing</span>
                    <span className="font-medium tabular-nums">{percent(health.passRate)}</span>
                  </div>
                  <div className="mt-1.5">
                    <Meter value={health.passRate} tone={health.passRate != null && health.passRate < 0.7 ? "bg-warn" : "bg-success"} />
                  </div>
                  <p className="mt-1 text-faint">
                    {health.checkRuns
                      ? `${health.checkRuns} recent runs · ${percent(health.firstPass.rate)} pass on the first try`
                      : "No checks have run recently."}
                  </p>
                </div>
                {member && (plan === "production" || builds.length > 0) && (
                  <div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-muted">Deploys</span>
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

          {source && <CloneCard addresses={addresses} path={`${source.repo.namespace}/${source.repo.name}`} />}
        </aside>
      </div>
    </div>
  );
}

/** The newest commits on the default branch, with who made them. */
function LatestCommits({ commits, base, branch }: { commits: Loaded["commits"]; base: string; branch: string }) {
  if (commits.length === 0) return null;
  return (
    <Panel title={`Latest on ${branch}`} icon={<GitCommitHorizontal size={14} />} all={{ to: `${base}/commits`, label: "All commits" }}>
      <Card asChild divided className="overflow-hidden">
        <ul>
          {commits.map((one) => (
            <li key={one.hash} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <CommitAvatars commit={one} size={18} max={2} />
              <span className="min-w-0 grow">
                <Link to={`${base}/commit/${one.hash}`} className="block truncate hover:text-accent">
                  {one.message}
                </Link>
                <span className="text-xs text-muted">
                  <CommitNames commit={one} className="hover:text-fg" />
                </span>
              </span>
              <Link to={`${base}/commit/${one.hash}`} className="hidden shrink-0 font-mono text-xs text-faint hover:text-fg sm:block">
                {one.hash.slice(0, 7)}
              </Link>
              <span className="w-16 shrink-0 text-right text-xs text-faint">
                <TimeAgo at={one.at} />
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </Panel>
  );
}

/** What the project is: its description, links, kind, latest release, languages and contributors. */
function AboutCard({
  project,
  canChange,
  base,
  loaderData,
}: {
  project: NonNullable<Loaded["project"]>;
  canChange: boolean;
  base: string;
  loaderData: Pick<Loaded, "release" | "languages" | "contributors">;
}) {
  return (
    <Card asChild className="p-5">
      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">About</h2>
          {canChange && <AboutEditor project={project} />}
        </div>
        <p className={`mt-2.5 text-sm ${project.description ? "text-fg-soft" : "text-faint"}`}>{project.description ?? "No description."}</p>
        <LinkList links={project.links} className="mt-3" />
        <ul className="mt-4 space-y-2 text-xs text-muted">
          <li className="flex items-center gap-2">
            {project.kind === "library" || project.kind === "tool" ? (
              <PackageGlyph size={13} className="shrink-0 text-faint" />
            ) : project.kind === "docs" ? (
              <BookOpen size={13} className="shrink-0 text-faint" />
            ) : (
              <Rocket size={13} className="shrink-0 text-faint" />
            )}
            <Hint label={project.kindReason.detail}>
              <span>{kindLabel(project)}</span>
            </Hint>
          </li>
          {loaderData.release && (
            <li className="flex items-center gap-2">
              <Tag size={13} className="shrink-0 text-faint" />
              <Link to={`${base}/tags`} className="hover:text-fg">
                <span className="font-mono text-fg-soft">{loaderData.release.name}</span>
                {loaderData.release.at && (
                  <span className="text-faint">
                    {" · "}
                    <TimeAgo at={loaderData.release.at} />
                  </span>
                )}
              </Link>
            </li>
          )}
          {loaderData.languages && loaderData.languages.length > 0 && (
            <li className="flex items-center gap-2">
              <Code2 size={13} className="shrink-0 text-faint" />
              <span>
                {loaderData.languages
                  .slice(0, 3)
                  .map((language) => `${language.name} ${Math.round(language.share * 100)}%`)
                  .join(" · ")}
              </span>
            </li>
          )}
        </ul>
        {loaderData.contributors && loaderData.contributors.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1">
            {loaderData.contributors.slice(0, 12).map((person) => (
              <Hint key={person.username} label={person.username}>
                <Link to={`/${person.username}`}>
                  <Avatar name={person.username} size={22} />
                </Link>
              </Hint>
            ))}
          </div>
        )}
      </section>
    </Card>
  );
}

/** The clone command, with the address this g1t serves. */
function CloneCard({ addresses, path }: { addresses: ReturnType<typeof useAddresses>; path: string }) {
  return (
    <Card asChild className="p-5">
      <section>
        <h2 className="text-sm font-semibold">Clone</h2>
        <div className="mt-3">
          <CopyLine breakAtSlashes text={`git clone ${cloneUrl(addresses, path)}`} />
        </div>
      </section>
    </Card>
  );
}

/**
 * The overview of a mirror g1t does not lead (standing by, in CI failover
 * or handing back): the remote it copies and when it last did, the facts
 * of the copy, its latest commits, and About. Nothing here starts
 * anything: there is no place it runs and no Right now, since
 * work happens on the remote until someone takes over.
 */
function MirrorOverview({
  loaderData,
  base,
  mirror,
  briefs,
  admin,
  source,
  canChange,
  addresses,
}: {
  loaderData: Loaded;
  base: string;
  mirror: RepoMirror;
  briefs: readonly MirrorBrief[];
  admin: boolean;
  source: { repo: { namespace: string; name: string }; defaultBranch?: string | null } | null;
  canChange: boolean;
  addresses: ReturnType<typeof useAddresses>;
}) {
  const { project, commit, checks } = loaderData;
  const branch = source?.defaultBranch ?? "main";
  const synced = leaderOf(briefs)?.syncedAt ?? loaderData.github?.syncedAt ?? null;
  const remote = (
    <a href={mirror.url} target="_blank" rel="noreferrer" className="font-mono text-fg hover:text-accent">
      {mirror.remote}
    </a>
  );
  return (
    <div className="space-y-8">
      <MirrorOverviewNote
        base={base}
        mirror={mirror}
        briefs={briefs}
        admin={admin}
        syncedAt={loaderData.github?.syncedAt}
        lastError={loaderData.github?.lastError}
      />
      {/* The copy: where it comes from, and what it holds. */}
      <section className="overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
              <GitBranch size={13} className="text-accent" />
              {mirror.state === "handing_back" ? "Handing back to" : "Mirror of"}
            </p>
            <DeployLink href={mirror.url} className="mt-2 flex items-center gap-1.5 truncate font-mono text-lg font-medium hover:text-accent">
              {mirror.remote}
              <ArrowUpRight size={16} className="shrink-0 text-faint" />
            </DeployLink>
            <p className="mt-1.5 max-w-xl text-sm text-muted">
              {mirror.state === "handing_back" ? (
                <>What was done here is going back to {remote}, branch by branch. Read-only until it is done.</>
              ) : (
                <>
                  Every branch and tag of {remote} is copied here as it moves. Nothing runs or opens here on its own;
                  {mirror.state === "ci" && " its workflows run on g1t meanwhile;"} the work happens there until someone takes over.
                </>
              )}
            </p>
          </div>
          {admin && mirror.state !== "handing_back" && (
            <ButtonLink to={mirroringSettings(base)} variant="outline" className="shrink-0">
              Mirroring settings
            </ButtonLink>
          )}
        </div>
        <div className="grid grid-cols-2 divide-line border-t border-line text-sm sm:grid-cols-4 sm:divide-x">
          <Stat
            label="Source"
            value={
              <a href={mirror.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1.5 font-mono hover:text-accent">
                <Code2 size={12} className="shrink-0 text-faint" />
                <span className="truncate">{mirror.remote}</span>
              </a>
            }
          />
          <Stat
            label="Default branch"
            to={`${base}/commits`}
            value={
              <span className="inline-flex items-center gap-1.5 font-mono">
                <GitBranch size={12} className="text-faint" />
                {branch}
              </span>
            }
          />
          <Stat
            label="Latest commit"
            value={
              commit ? (
                <span className="flex min-w-0 items-center gap-1">
                  <Hint label={commit.message.split("\n")[0]}>
                    <Link to={`${base}/commit/${commit.hash}`} className="min-w-0 truncate hover:text-accent">
                      <span className="font-mono">{commit.hash.slice(0, 7)}</span>{" "}
                      <span className="font-normal text-muted">
                        <TimeAgo at={commit.authoredAt} />
                      </span>
                    </Link>
                  </Hint>
                  <CommitChecksBadge checks={checks} sha={commit.hash} className="size-5" />
                </span>
              ) : (
                "No commits yet"
              )
            }
          />
          <Stat
            label="Synced"
            value={
              synced ? (
                <span className="font-normal text-muted">
                  <TimeAgo at={synced} />
                </span>
              ) : (
                "Not yet"
              )
            }
          />
        </div>
        {commit && (
          <p className="truncate border-t border-line px-5 py-2.5 text-xs text-muted sm:px-6">
            <GitCommitHorizontal size={12} className="mr-1.5 inline text-faint" />
            {commit.message.split("\n")[0]}{" "}
            <span className="text-faint">
              · <CommitNames commit={commit} className="hover:text-fg" />
            </span>
          </p>
        )}
      </section>

      <div className="grid gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-8">
          <LatestCommits commits={loaderData.commits} base={base} branch={branch} />
        </div>
        <aside className="space-y-4 text-sm">
          {project && <AboutCard project={project} canChange={canChange} base={base} loaderData={loaderData} />}
          {source && <CloneCard addresses={addresses} path={`${source.repo.namespace}/${source.repo.name}`} />}
        </aside>
      </div>
    </div>
  );
}
