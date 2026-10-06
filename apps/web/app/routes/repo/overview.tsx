import {
  Activity as ActivityIcon,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Brain,
  Code2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Hand,
  HeartPulse,
  Loader2,
  Lock,
  Network,
  Pin,
  Rocket,
  RotateCw,
} from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { Await, Form, Link, useNavigation } from "react-router";

import { type AgentRun, type G1tEvent, type Memory, type Pull, RUN_KIND_LABEL, isActiveRun } from "@g1t/contracts";

import type { Route } from "./+types/overview";
import { host, StatusDot } from "../../components/deploy";
import { CheckBadge } from "../../components/checks";
import { Elapsed, formatCost, useLiveRefresh } from "../../components/agents";
import { ActivityFeed, DeployStrip, Meter, NeedsList, Panel, Quiet, Unavailable, percent } from "../../components/mission";
import { type ActiveBranch, ActiveBranches } from "../../components/branches";
import { ProductionChecklist } from "../../components/checklist";
import { Skeleton, SkeletonRows } from "../../components/ui/skeleton";
import { ProductionShot } from "../../components/production-shot";
import { GithubLinkStrip } from "../../components/github";
import { githubApp } from "../../lib/github.server";
import { Avatar, Button, ButtonLink, CopyLine, TimeAgo } from "../../components/ui";
import { ChangeSize } from "../../components/work";
import {
  type ActivityItem,
  type Need,
  type PipelineStage,
  PIPELINE,
  TIME,
  ageBuckets,
  eventItem,
  firstPassRate,
  groupActivity,
  passRate,
  pipelineStage,
  queuedNumbers,
  rankNeeds,
  stuckMinutes,
} from "../../lib/mission";
import { drift } from "../../lib/branches";
import { agentWasAssigned, hasInstructions, productionChecklist } from "../../lib/checklist";
import { agents, deployments, events as eventLog, projects, repos, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";
import { accessTo, countsFor, refusal, repoFor } from "../../lib/access.server";

const MAX_LANDED = 6;
/** Branches read for the Active branches list, and shown. */
const BRANCHES_READ = 10;
const BRANCHES_SHOWN = 5;
/** How far back each branch's history, and the default branch's, is read to count ahead and behind. */
const BRANCH_DEPTH = 40;
const MAIN_DEPTH = 120;

/**
 * The overview streams: the layout's header and tabs (one repository
 * lookup, one project) go out at once with a skeleton below them, and
 * everything here, seventeen calls across six services, follows in the
 * same response as it settles. Crawlers wait for all of it
 * (entry.server.tsx). Before, the first byte waited on the slowest of them.
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
  // People with a role of their own here see its running parts: deployments,
  // memory, setup; everyone who can read it sees the rest. Not awaited: only
  // those sections wait on the repository lookup, which the layout makes in
  // this request too.
  const accessP = accessTo(context, params);
  const memberP = accessP.then((access) => access.insider);
  const forMembers = <T,>(start: () => Promise<T>): Promise<T | null> =>
    memberP.then((member) => (member ? soft(start()) : null));
  const repoP = soft(repoFor(context, params));
  const eventsP = repoP.then((repo) => (repo?.ok ? soft(eventLog.list({ repoId: repo.value.id, limit: 150 })) : null));
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
      const pullList = pulls?.ok ? pulls.value : [];
      const pullOn = new Map(pullList.filter((pull) => pull.branch).map((pull) => [pull.branch as string, pull]));
      const others = branchList.value.filter((branch) => branch.name !== main);
      if (others.length === 0) return { main, total: 0, shown: [] };
      const read = [...others.filter((b) => pullOn.has(b.name)), ...others.filter((b) => !pullOn.has(b.name))].slice(0, BRANCHES_READ);
      // By commit hash, not name: history from a commit never changes, so
      // repos keeps it (services/repos/src/store.rs) and only new heads cost
      // a walk.
      const mainHead = branchList.value.find((branch) => branch.name === main)?.hash ?? main;
      const [mainLog, ...logs] = await Promise.all([
        soft(repos.log(path, viewer, mainHead, MAIN_DEPTH)),
        ...read.map((branch) => soft(repos.log(path, viewer, branch.hash || branch.name, BRANCH_DEPTH))),
      ]);
      const mainHashes = mainLog?.ok ? mainLog.value.map((c) => c.hash) : [];
      const previews = deploys?.ok ? deploys.value.live.filter((app) => app.kind === "preview") : [];
      const shown = read
        .map((branch, index): ActiveBranch => {
          const history = logs[index]?.ok ? logs[index].value : [];
          const head = history[0];
          const moved = drift(history.map((c) => c.hash), mainHashes, BRANCH_DEPTH);
          const pull = pullOn.get(branch.name);
          return {
            name: branch.name,
            commit: head ? { hash: head.hash, message: head.message.split("\n")[0], author: head.author.name, at: head.authoredAt } : null,
            ...moved,
            pull: pull ? { number: pull.number, title: pull.title, checkStatus: pull.checkStatus, draft: pull.status === "draft" } : null,
            preview: previews.find((app) => app.branch === branch.name || (pull != null && app.number === pull.number))?.url ?? null,
          };
        })
        .sort((a, b) => Date.parse(b.commit?.at ?? "0") - Date.parse(a.commit?.at ?? "0"))
        .slice(0, BRANCHES_SHOWN);
      return { main, total: others.length, shown };
    },
  );
  // Active branches read several logs each: streamed, so the rest shows first.
  const branches = branchesP.catch(() => null);
  const [{ insider: member, can }, project, settings, list, open, closed, log, counts, deps, runs, queue, issues, memories, recent, mine, domains, root] = await Promise.all([
    accessP,
    soft(projects.get(params.owner, params.repo, viewer)),
    forMembers(() => deployments.settings(ref, viewer)),
    listP,
    openP,
    soft(work.listPulls(path, viewer, "closed")),
    soft(repos.log(path, viewer, null, 1)),
    soft(countsFor(context, params)),
    soft(projects.dependencies(params.owner, params.repo, viewer)),
    soft(agents.listRuns(viewer, { repo: path, limit: 60 })),
    soft(work.queue(path, viewer)),
    soft(work.listIssues(path, viewer, { state: "open" })),
    forMembers(() => agents.listMemories(viewer, params.owner, path)),
    eventsP,
    minePullsP,
    // For the checklist, which only members see.
    forMembers(() => deployments.domains(ref, viewer)),
    forMembers(() => repos.tree(path, viewer, null, "")),
  ]);
  const ok = <T,>(result: { ok: true; value: T } | { ok: false } | null): T | null => (result?.ok ? result.value : null);

  const openPulls = ok(open) ?? [];
  const runList = ok(runs) ?? [];
  const live = runList.filter((run) => isActiveRun(run.status));
  const builds = ok(list)?.deployments ?? [];
  const landed = (ok(closed) ?? [])
    .filter((pull) => pull.status === "merged")
    .sort((a, b) => Date.parse(b.mergedAt ?? b.updatedAt) - Date.parse(a.mergedAt ?? a.updatedAt));
  const queued = queuedNumbers(ok(queue)?.active ?? []);
  const runOn = new Map<number, AgentRun>();
  for (const run of live) if (run.number != null && !runOn.has(run.number)) runOn.set(run.number, run);
  const lifecycleOf = new Map((mine ?? []).map((item) => [item.pull.number, item.lifecycle]));

  // --- The pipeline -----------------------------------------------------------
  type Card = {
    number: number;
    title: string;
    agent: string;
    status: Pull["status"];
    checkStatus: Pull["checkStatus"];
    step: string | null;
    runKind: string | null;
    runStarted: string | null;
    needsYou: boolean;
    at: string;
  };
  const columns: Record<PipelineStage, Card[]> = { working: [], checking: [], reviewing: [], queue: [], landed: [] };
  for (const pull of openPulls.slice(0, 40)) {
    const run = runOn.get(pull.number);
    columns[pipelineStage(pull, run, queued, lifecycleOf.get(pull.number))].push({
      number: pull.number,
      title: pull.title,
      agent: pull.agent,
      status: pull.status,
      checkStatus: pull.checkStatus,
      step: run?.step ?? null,
      runKind: run ? RUN_KIND_LABEL[run.kind] : null,
      runStarted: run ? (run.startedAt ?? run.createdAt) : null,
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
      step: null,
      runKind: null,
      runStarted: null,
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
    if (me && pull.status === "open" && pull.author.username.toLowerCase() !== me && pull.reviewers.some((name) => name.toLowerCase() === me)) {
      needs.push({ key: `review:${pull.number}`, kind: "review", title: pull.title, detail: `${pull.author.username} asked for your review.`, to, action: "Review", at: Date.parse(pull.updatedAt), where });
    }
    if (member && pull.status === "open" && pull.checkStatus === "failed" && !runOn.has(pull.number) && !lifecycle) {
      needs.push({ key: `checks:${pull.number}`, kind: "checks", title: pull.title, detail: "It failed in the merge queue and no agent is fixing it.", to, action: "See checks", at: Date.parse(pull.updatedAt), where });
    }
  }
  for (const run of live) {
    const minutes = stuckMinutes(run, now);
    if (minutes == null) continue;
    needs.push({
      key: `run:${run.id}`,
      kind: "stuck",
      title: run.title ?? `${run.agent}'s run`,
      detail: `${run.agent} has reported nothing for ${minutes} min${run.step ? `. Last: ${run.step}` : ""}.`,
      to: `${base}/agents/runs/${run.id}`,
      action: "Look",
      at: Date.parse(run.updatedAt),
      where: run.number != null ? `#${run.number}` : null,
    });
  }

  // --- Activity and health -------------------------------------------------------
  const eventList: G1tEvent[] = recent ?? [];
  const items = eventList
    .map((event) => eventItem(event, path))
    .filter((item): item is ActivityItem => item != null);
  const checkEvents = eventList.flatMap((event) =>
    event.type === "checks.completed" ? [{ repo: "", number: event.data.number, at: Date.parse(event.time), passed: event.data.status === "passed" }] : [],
  );
  const memoryList = ok(memories)?.project ?? [];
  const knows = [...memoryList.filter((m) => m.pinned), ...memoryList.filter((m) => !m.pinned).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))].slice(0, 5);
  const openIssues = ok(issues);

  // --- Getting to production ----------------------------------------------------
  const wentLive = (status: string) => status === "ready" || status === "replaced" || status === "down";
  const liveApps = ok(list)?.live ?? [];
  const commitNow = ok(log)?.[0] ?? null;
  const projectValue = ok(project);
  const checklist = member
    ? productionChecklist({
        base,
        hasCode: commitNow != null || projectValue?.source.kind === "mirror",
        deploysEnabled: ok(settings)?.enabled ?? false,
        productionDeployed:
          liveApps.some((app) => app.kind === "production") ||
          builds.some((build) => build.kind === "production" && wentLive(build.status)),
        domains: ok(domains)?.domains.length ?? null,
        previewOpened:
          liveApps.some((app) => app.kind === "preview") || builds.some((build) => build.kind === "preview" && wentLive(build.status)),
        instructions: commitNow == null ? false : root?.ok ? hasInstructions(root.value.entries.map((entry) => entry.name)) : null,
        agentAssigned: agentWasAssigned({
          runAgents: runList.map((run) => run.agent),
          pullAgents: [...openPulls, ...(ok(closed) ?? [])].map((pull) => pull.agent),
          issues: openIssues ?? [],
        }),
      })
    : null;

  const github = await githubP;
  return {
    member,
    can,
    github,
    project: ok(project),
    settings: ok(settings),
    builds: builds.slice(0, 30),
    live: ok(list)?.live ?? [],
    commit: ok(log)?.[0] ?? null,
    open: ok(counts) ?? { issues: openIssues?.length ?? 0, pulls: openPulls.length },
    dependencies: ok(deps),
    agentsLive: live.slice(0, 6),
    runsLoaded: runs?.ok ?? false,
    pullsLoaded: open?.ok ?? false,
    columns,
    needs: rankNeeds(needs),
    landed: landed.slice(0, MAX_LANDED),
    groups: groupActivity(items).slice(0, 30),
    eventsLoaded: recent != null,
    health: {
      passRate: passRate(checkEvents.map((c) => c.passed)),
      firstPass: firstPassRate(checkEvents),
      checkRuns: checkEvents.length,
      ages: openIssues ? ageBuckets(openIssues.map((issue) => issue.createdAt), now) : null,
    },
    knows: knows as Memory[],
    memoryCount: memoryList.length,
    memoriesLoaded: memories?.ok ?? false,
    checklist,
    branches,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData().catch(() => null);
  const intent = form?.get("intent");
  // Syncing from GitHub is pushing; stopping it is an integration; deploying is compute.
  const refused = await refusal(context, params, intent === "github-sync" ? "push" : intent === "github-stop" ? "manage_integrations" : "run");
  if (refused) return { error: refused };
  if (intent === "github-sync" || intent === "github-stop") {
    const repo = await repos.get({ namespace: params.owner, name: params.repo }, user);
    if (!repo.ok) return { error: repo.error.message };
    const done =
      intent === "github-sync" ? await githubApp.sync(user, repo.value.id) : await githubApp.unlinkRepo(user, repo.value.id);
    return done.ok
      ? { notice: intent === "github-sync" ? "Synced with GitHub." : "It is no longer kept in step with GitHub." }
      : { error: done.error.message };
  }
  const started = await deployments.redeploy(user, { workspace: params.owner, slug: params.repo }, null);
  return started.ok ? { notice: "Production is building." } : { error: started.error.message };
}

type Loaded = Awaited<ReturnType<typeof overviewData>>;
type Card = Loaded["columns"]["working"][number];

const STAGE_TONE: Record<PipelineStage, string> = {
  working: "bg-merged",
  checking: "bg-info",
  reviewing: "bg-warn",
  queue: "bg-accent-dim",
  landed: "bg-accent",
};

function PipelineCard({ card, base, stage }: { card: Card; base: string; stage: PipelineStage }) {
  return (
    <li>
      <Link
        to={`${base}/pull/${card.number}`}
        prefetch="intent"
        className={`block rounded-lg border bg-bg/60 p-2.5 transition-colors hover:border-line-strong hover:bg-raised ${
          card.needsYou ? "border-warn/50" : card.step ? "border-merged/30" : "border-line"
        }`}
      >
        <span className="line-clamp-2 text-[0.8125rem] leading-snug font-medium">{card.title}</span>
        <span className="mt-1.5 flex items-center gap-1.5 text-[0.6875rem] text-muted">
          <Avatar name={card.agent} size={14} />
          <span className="font-mono text-faint">#{card.number}</span>
          <span className="grow" />
          {card.needsYou ? (
            <span className="inline-flex items-center gap-1 text-warn" title="Stopped: a person decides what happens next">
              <Hand size={11} /> you
            </span>
          ) : stage === "landed" ? (
            <TimeAgo at={card.at} />
          ) : card.runStarted ? (
            <span className="inline-flex items-center gap-1 text-merged">
              <Loader2 size={11} className="animate-spin" />
              <Elapsed from={card.runStarted} />
            </span>
          ) : (
            <CheckBadge status={card.checkStatus} />
          )}
        </span>
        {card.step && (
          <span className="mt-1.5 block truncate font-mono text-[0.6875rem] text-fg/70" title={card.step}>
            {card.runKind}: {card.step}
          </span>
        )}
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
            <li key={stage} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-2">
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
          );
        })}
      </ol>
    </div>
  );
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
        {(overview) => <Overview loaderData={overview} actionData={actionData} params={params} />}
      </Await>
    </Suspense>
  );
}

/** The overview's sections as they will sit, while they stream in. */
function OverviewSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading the overview">
      <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-5 w-64 max-w-full" />
        <Skeleton className="mt-3 h-3 w-48 max-w-full" />
      </section>
      <section className="rounded-2xl border border-line bg-surface p-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-24 rounded-xl" />
          ))}
        </div>
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-line bg-surface">
          <SkeletonRows rows={4} />
        </section>
        <section className="rounded-2xl border border-line bg-surface">
          <SkeletonRows rows={4} />
        </section>
      </div>
    </div>
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
  const { member, project, settings, builds, live, commit, open, dependencies, agentsLive, columns, needs, landed, groups, health, knows, checklist, branches } =
    loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const production = live.find((app) => app.kind === "production") ?? null;
  // The project's own domain, once it is active, is where production is visited.
  const productionUrl = production ? (settings?.primaryDomain ? `https://${settings.primaryDomain}` : production.url) : null;
  const previews = live.filter((app) => app.kind === "preview");
  const latestProduction = builds.find((build) => build.kind === "production") ?? null;
  const busy = useNavigation().state === "submitting";
  const source = project?.source.kind === "hosted" ? project.source : null;
  const moving = agentsLive.length > 0 || columns.working.length + columns.checking.length > 0;
  useLiveRefresh(moving);
  const ages = health.ages;
  const oldest = ages ? Math.max(1, ...ages.map((a) => a.count)) : 1;

  return (
    <div className="space-y-8">
      {loaderData.github && <GithubLinkStrip link={loaderData.github} />}
      {/* What the project is, running, and where its code is. */}
      <section className="overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:p-6">
          {member && (production || settings?.enabled) && (
            <ProductionShot
              src={production ? `${base}/production.jpg?v=${production.commit}` : null}
              href={production ? (productionUrl ?? production.url) : null}
              label={host(production ? (productionUrl ?? production.url) : (settings?.productionUrl ?? ""))}
              className="w-full shrink-0 sm:w-60 lg:w-72"
            />
          )}
          <div className="flex min-w-0 grow flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
              <Rocket size={13} className="text-accent" />
              Production
            </p>
            {production ? (
              <>
                <a
                  href={productionUrl ?? production.url}
                  className="mt-2 flex items-center gap-1.5 truncate font-mono text-lg font-medium hover:text-accent"
                >
                  {host(productionUrl ?? production.url)}
                  <ArrowUpRight size={16} className="shrink-0 text-faint" />
                </a>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {latestProduction && <StatusDot status={latestProduction.status} label={latestProduction.status === "ready" ? "Live" : undefined} />}
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
                <ButtonLink to={productionUrl ?? production.url} variant="accent" reloadDocument>
                  Visit
                  <ArrowUpRight size={14} />
                </ButtonLink>
              )}
              {settings?.enabled ? (
                loaderData.can.run && <Form method="post">
                  <Button type="submit" variant="quiet" disabled={busy} title="Build production again from the default branch">
                    <RotateCw size={14} />
                    Redeploy
                  </Button>
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
        {actionData && (
          <p className={`border-t border-line px-6 py-2.5 text-sm ${"error" in actionData ? "text-danger" : "text-accent"}`}>
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
            to={commit ? `${base}/commit/${commit.hash}` : undefined}
            value={
              commit ? (
                <span title={commit.message.split("\n")[0]}>
                  <span className="font-mono">{commit.hash.slice(0, 7)}</span>{" "}
                  <span className="font-normal text-muted">
                    <TimeAgo at={commit.authoredAt} />
                  </span>
                </span>
              ) : (
                "No commits yet"
              )
            }
          />
          <Stat
            label={member && settings?.enabled ? "Last deploy" : "Open"}
            to={member && settings?.enabled ? `${base}/deployments` : `${base}/pulls`}
            value={
              member && settings?.enabled ? (
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
            {commit.message.split("\n")[0]} <span className="text-faint">· {commit.author.name}</span>
          </p>
        )}
      </section>

      {checklist && <ProductionChecklist base={base} items={checklist} />}

      <Panel
        title="Right now"
        icon={<span className={`block size-2 rounded-full ${agentsLive.length > 0 ? "animate-pulse bg-merged" : "bg-line-strong"}`} />}
        count={agentsLive.length}
        all={{ to: `${base}/agents`, label: "Agents" }}
      >
        {agentsLive.length > 0 && (
          <ul className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {agentsLive.map((run) => (
              <li key={run.id} className="min-w-0 rounded-xl border border-merged/30 bg-surface px-3.5 py-3">
                <div className="flex items-center gap-2 text-sm">
                  <Avatar name={run.agent} size={18} />
                  <span className="font-medium">{run.agent}</span>
                  <span className="text-xs text-muted">{RUN_KIND_LABEL[run.kind].toLowerCase()}</span>
                  <span className="grow" />
                  <span className="text-xs text-muted">
                    <Elapsed from={run.startedAt ?? run.createdAt} />
                  </span>
                </div>
                <Link
                  to={run.number != null ? `${base}/pull/${run.number}` : `${base}/agents/runs/${run.id}`}
                  className="mt-1 block truncate text-[0.8125rem] hover:text-accent"
                >
                  {run.title ?? "A run"} {run.number != null && <span className="text-faint">#{run.number}</span>}
                </Link>
                {run.step && (
                  <p className="mt-1 truncate font-mono text-[0.6875rem] text-fg/70" title={run.step}>
                    <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-merged align-middle" />
                    {run.step}
                  </p>
                )}
                <p className="mt-1.5 flex items-center gap-3 text-[0.6875rem] text-faint">
                  {formatCost(run.costUsd) && <span>{formatCost(run.costUsd)} so far</span>}
                  <Link to={`${base}/agents/runs/${run.id}`} className="hover:text-fg">
                    {run.stepCount} steps
                  </Link>
                  {run.number != null && (
                    <Link to={`${base}/sessions/${run.number}`} className="hover:text-fg">
                      Session
                    </Link>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
        {!loaderData.pullsLoaded ? (
          <Unavailable what="Pull requests" />
        ) : Object.values(columns).every((c) => c.length === 0) ? (
          <Quiet
            action={
              member ? (
                <Link to={`${base}/issues/new`} className="inline-flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-bg hover:bg-white">
                  <Bot size={12} /> Open an issue for an agent
                </Link>
              ) : null
            }
          >
            Nothing is moving. Open an issue and hand it to g1t-agent, or push a branch and open a pull request.
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
            <Await resolve={branches}>
              {(branches) => (
                <Panel title="Active branches" icon={<GitBranch size={14} />} count={branches?.total || null}>
                  {!branches ? (
                    <Unavailable what="Branches" />
                  ) : branches.shown.length === 0 ? (
                    <Quiet>
                      Only {branches.main} so far. Branches pushed here show with how far each has moved from {branches.main}, and
                      its pull request and preview.
                    </Quiet>
                  ) : (
                    <>
                      <ActiveBranches branches={branches.shown} base={base} main={branches.main} />
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
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {landed.map((pull) => {
                  const byAgent = pull.runtime === "hosted" || pull.agent === "g1t-agent";
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
                          <span className="inline-flex items-center gap-1">
                            <Avatar name={pull.agent} size={13} />
                            {byAgent ? `made by ${pull.agent}` : `by ${pull.author.username}`}
                          </span>
                          {pull.issue != null && (
                            <>
                              <span>· for</span>
                              <Link to={`${base}/issues/${pull.issue}`} className="hover:text-fg">
                                #{pull.issue}
                              </Link>
                            </>
                          )}
                          {pull.mergedBy && <span>· landed by {pull.mergedBy}</span>}
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
            )}
          </Panel>

          <Panel title="Activity" icon={<ActivityIcon size={14} />}>
            {loaderData.eventsLoaded ? (
              <ActivityFeed groups={groups} showRepo={false} limit={8} empty="Nothing has happened here yet." />
            ) : (
              <Unavailable what="Activity" />
            )}
          </Panel>

          {previews.length > 0 && (
            <Panel title="Previews" icon={<GitBranch size={14} />} count={previews.length} all={{ to: `${base}/deployments`, label: "Deployments" }}>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {previews.map((app) => (
                  <li key={app.url} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0 grow">
                      <a href={app.url} className="block truncate font-mono text-[0.8125rem] hover:text-accent">
                        {host(app.url)}
                      </a>
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
            </Panel>
          )}
        </div>

        <aside className="space-y-4 text-sm">
          {member && (
            <section className="rounded-xl border border-line bg-surface p-5">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Brain size={14} className="text-merged" />
                  What agents know here
                </h2>
                <Link to={`${base}/memory`} className="text-xs text-muted hover:text-fg">
                  Memory
                </Link>
              </div>
              {!loaderData.memoriesLoaded ? (
                <p className="mt-3 text-xs text-muted">Memory could not be loaded just now.</p>
              ) : knows.length === 0 ? (
                <p className="mt-3 text-xs leading-5 text-muted">
                  Nothing yet. Agents note conventions, decisions and traps as they work, and every agent starting here reads them.
                </p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {knows.map((memory) => (
                    <li key={memory.id} className="text-xs leading-5">
                      <p className="line-clamp-3 text-fg-soft">
                        {memory.pinned && <Pin size={11} className="mr-1 inline text-accent" />}
                        {memory.text}
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
          )}

          <section className="rounded-xl border border-line bg-surface p-5">
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
                  <Meter value={health.passRate} tone={health.passRate != null && health.passRate < 0.7 ? "bg-warn" : "bg-accent"} />
                </div>
                <p className="mt-1 text-faint">
                  {health.checkRuns
                    ? `${health.checkRuns} recent runs · ${percent(health.firstPass.rate)} pass on the first try`
                    : "No checks have run recently."}
                </p>
              </div>
              {member && (
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

          <section className="rounded-xl border border-line bg-surface p-5">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <Network size={14} className="text-faint" />
                Dependencies
              </h2>
              {member && (
                <Link to={`${base}/settings/dependencies`} className="text-xs text-muted hover:text-fg">
                  Manage
                </Link>
              )}
            </div>
            {!dependencies ? (
              <p className="mt-3 text-xs text-muted">Dependencies could not be loaded just now.</p>
            ) : dependencies.dependsOn.length === 0 && dependencies.usedBy.length === 0 ? (
              <p className="mt-3 text-xs leading-5 text-muted">
                Uses no other project, and none uses it. Declare one, and builds get its address and agents know what depends on
                what.
              </p>
            ) : (
              <div className="mt-3 space-y-3 text-xs">
                {dependencies.dependsOn.length > 0 && (
                  <div>
                    <p className="flex items-center gap-1 text-muted">
                      <ArrowUpRight size={12} /> Uses
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {dependencies.dependsOn.map((d) => (
                        <li key={d.slug} className="flex items-center justify-between gap-2">
                          <Link to={`/${params.owner}/${d.slug}`} className="font-medium hover:underline">
                            {d.name}
                          </Link>
                          {d.as && <code className="font-mono text-faint">{d.as}</code>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {dependencies.usedBy.length > 0 && (
                  <div>
                    <p className="flex items-center gap-1 text-muted">
                      <ArrowDownLeft size={12} /> Used by
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {dependencies.usedBy.map((d) => (
                        <li key={d.slug}>
                          <Link to={`/${params.owner}/${d.slug}`} className="font-medium hover:underline">
                            {d.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>

          {source && (
            <section className="rounded-xl border border-line bg-surface p-5">
              <h2 className="text-sm font-semibold">Clone</h2>
              <div className="mt-3">
                <CopyLine text={`git clone https://g1t.sh/${source.repo.namespace}/${source.repo.name}.git`} />
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
