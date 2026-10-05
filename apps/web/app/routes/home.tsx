import {
  Activity as ActivityIcon,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Box,
  CircleDot,
  Coins,
  GitPullRequest,
  Hand,
  Lock,
  Plus,
  Radio,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import { env } from "cloudflare:workers";
import { type ReactNode, useEffect, useState } from "react";
import { Link, data, useRouteLoaderData } from "react-router";

import {
  type AgentRun,
  type AuthoredItem,
  type CheckStatus,
  type Deployment,
  type G1tEvent,
  type Issue,
  type Lifecycle,
  type LiveApp,
  type Pull,
  type PullStatus,
  type Repo,
  type RepoPath,
  type Stage,
  isActiveRun,
} from "@g1t/contracts";

import type { Route } from "./+types/home";
import { page } from "../lib/meta";
import { CHANGELOG, changelogHref } from "../lib/changelog";
import { WORKSPACE_COOKIE, chosenWorkspace } from "../lib/workspace-choice";
import { trialClosed } from "../lib/trial";
import {
  type ActivityItem,
  type Need,
  SEEN_COOKIE,
  TIME,
  agentHours,
  dailyBuckets,
  digestParts,
  eventItem,
  firstPassRate,
  formatSpan,
  greetingFor,
  groupActivity,
  hourIn,
  issueToMerge,
  median,
  nextSeen,
  rankNeeds,
  readCookie,
  stuckMinutes,
} from "../lib/mission";
import { Landing } from "../components/landing";
import type { ShellData } from "../components/shell";
import { STAGE_LABEL, StageDots } from "../components/lifecycle";
import { RunCard, formatCost, useLiveRefresh } from "../components/agents";
import { CheckBadge } from "../components/checks";
import { DEPLOY_STATUS, StatusDot, host } from "../components/deploy";
import { ActivityFeed, Meter, NeedsList, Panel, PulseTile, Quiet, Unavailable, percent } from "../components/mission";
import { Avatar, CopyLine, TimeAgo } from "../components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { IssueIcon, PullIcon } from "../components/work";
import {
  agents,
  billing,
  deployments,
  events as eventLog,
  identity,
  projects as projectsApi,
  repos as reposApi,
  work,
} from "../lib/services.server";
import { getViewer } from "../lib/session.server";

/** The viewer's time zone, set by the page itself, so the greeting fits their day. */
const TZ_COOKIE = "g1t_tz";
/** The most projects whose pull requests and events are read for the page. */
const MAX_PROJECTS = 10;
const EVENTS_PER_PROJECT = 80;

const dollars = (micros: number) => `$${(Math.max(0, micros) / 1_000_000).toFixed(2)}`;

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "g1t — Git for AI scale",
    description:
      "A git forge for thousands of agents working on the same code at once: every change isolated, every decision recorded, every change landed in order. Open source, built on Cloudflare.",
  });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  const out = new Headers();
  const timing = loaderHeaders.get("Server-Timing");
  if (timing) out.set("Server-Timing", timing);
  const cookie = loaderHeaders.get("Set-Cookie");
  if (cookie) out.set("Set-Cookie", cookie);
  return out;
}

/** A row of the viewer's pull requests, whichever list it comes from. */
type PullRow = {
  key: string;
  repo: RepoPath;
  number: number;
  title: string;
  status: PullStatus;
  agent: string | null;
  stage: Stage | null;
  detail: string | null;
  checkStatus: CheckStatus | null;
  updatedAt: string;
};

/** A row of the viewer's issues. */
type IssueRow = {
  key: string;
  repo: RepoPath;
  number: number;
  title: string;
  agent: string | null;
  queued: boolean;
  updatedAt: string;
};

type ProjectHealth = {
  slug: string;
  name: string;
  private: boolean;
  repo: RepoPath | null;
  deploys: boolean;
  production: LiveApp | null;
  latest: Deployment | null;
  openPulls: number | null;
  agents: number;
  passRate: number | null;
  checks: number;
};

const pullRow = (pull: Pull, repo: RepoPath, lifecycle: Lifecycle | null): PullRow => ({
  key: pull.id,
  repo,
  number: pull.number,
  title: pull.title,
  status: pull.status,
  agent: pull.agent,
  stage: lifecycle?.stage ?? null,
  detail: lifecycle?.detail ?? null,
  checkStatus: pull.checkStatus,
  updatedAt: pull.updatedAt,
});

const authoredPull = (item: AuthoredItem): PullRow => ({
  key: `${item.repo.namespace}/${item.repo.name}#${item.number}`,
  repo: item.repo,
  number: item.number,
  title: item.title,
  status: item.status ?? (item.draft ? "draft" : "open"),
  agent: null,
  stage: null,
  detail: null,
  checkStatus: null,
  updatedAt: item.updatedAt,
});

export async function loader({ context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!viewer) {
    const repos = await reposApi.list(viewer, { memberOnly: false });
    return data({ signedIn: false as const, repos });
  }

  const now = Date.now();
  const weekAgo = now - 7 * TIME.DAY;
  const started = Date.now();
  const times: Record<string, number> = {};
  // Each call is timed, and one that fails leaves its section empty rather
  // than taking the page down.
  const soft = <T,>(name: string, promise: Promise<T>): Promise<T | null> =>
    promise.then(
      (value) => ((times[name] = Date.now() - started), value),
      (error) => {
        console.warn(`home: ${name} failed`, error);
        times[name] = Date.now() - started;
        return null;
      },
    );
  const okOr = <T,>(result: { ok: true; value: T } | { ok: false } | null): T | null => (result?.ok ? result.value : null);

  const cookies = request.headers.get("cookie");
  const seen = nextSeen(readCookie(cookies, SEEN_COOKIE), now);
  const tz = readCookie(cookies, TZ_COOKIE);
  const memberships = viewer.workspaces ?? [];
  // The workspace you chose, as the sidebar shows it (lib/workspace-choice.ts).
  const slug = chosenWorkspace(memberships, readCookie(cookies, WORKSPACE_COOKIE))?.slug ?? null;
  const mine = new Set(memberships.map((m) => m.slug.toLowerCase()));
  const username = viewer.username;

  const reposP = soft("repos", reposApi.list(viewer, { memberOnly: true }));
  // The workspace's projects' open pull requests and recent events, read
  // once each, all at once, as soon as the projects are known.
  const perRepoP = reposP.then((repos) =>
    Promise.all(
      (repos ?? [])
        .filter((repo) => mine.has(repo.namespace.toLowerCase()))
        .slice(0, MAX_PROJECTS)
        .map(async (repo) => {
          const path = { namespace: repo.namespace, name: repo.name };
          const [pulls, log] = await Promise.all([
            work.listPulls(path, viewer, "open").catch(() => null),
            eventLog.list({ repoId: repo.id, limit: EVENTS_PER_PROJECT }).catch(() => null),
          ]);
          return { repo, pulls: pulls?.ok ? pulls.value.slice(0, 60) : null, events: log };
        }),
    ),
  );

  const [repos, perRepo, active, assigned, models, profile, runs, overview, usage, authoredPulls, authoredIssues, projectList, memories] =
    await Promise.all([
      reposP,
      soft("projects", perRepoP),
      soft("pulls", work.listActivePulls(viewer)),
      soft("assigned", work.listAssignedIssues(viewer)),
      slug ? soft("models", env.RUNNER.modelAccess(slug)) : null,
      soft("profile", identity.profile(username)),
      slug ? soft("runs", agents.listRuns(viewer, { workspace: slug, limit: 150 })) : null,
      slug ? soft("deploys", deployments.overview(slug, viewer)) : null,
      slug ? soft("usage", billing.usage(slug, viewer, new Date(weekAgo - TIME.DAY).toISOString())) : null,
      soft("authoredPulls", work.byAuthor(username, viewer, { kind: "pull", state: "open", sort: "updated", limit: 10 })),
      soft("authoredIssues", work.byAuthor(username, viewer, { kind: "issue", state: "open", sort: "updated", limit: 10 })),
      slug ? soft("projectList", projectsApi.list(slug, viewer)) : null,
      slug ? soft("memories", agents.listMemories(viewer, slug, null)) : null,
    ]);

  const repoList = repos ?? [];
  // Each issue and pull request is shown under its repository. Most are in
  // the viewer's own, already listed; the rest are looked up once each.
  const known = new Map<string, Repo>(repoList.map((repo) => [repo.id, repo]));
  const missing = [
    ...new Set([...(assigned ?? []).map((issue) => issue.repoId), ...(active ?? []).map(({ pull }) => pull.repoId)]),
  ].filter((id) => !known.has(id));
  const looked = await Promise.all(missing.map((id) => reposApi.getById(id, viewer).catch(() => null)));
  for (const found of looked) if (found?.ok) known.set(found.value.id, found.value);
  const pathOf = (repo: Repo): RepoPath => ({ namespace: repo.namespace, name: repo.name });

  const activeList = (active ?? []).flatMap((item) => {
    const repo = known.get(item.pull.repoId);
    return repo ? [{ ...item, repo }] : [];
  });
  const runList = okOr(runs ?? null) ?? [];
  const liveRuns = runList.filter((run) => isActiveRun(run.status));
  const overviewList = okOr(overview ?? null);
  const projectsOk = okOr(projectList ?? null);

  // --- What the viewer's pull requests and issues are ----------------------
  const lower = username.toLowerCase();
  const openPulls = (perRepo ?? []).flatMap(({ repo, pulls }) => (pulls ?? []).map((pull) => ({ pull, repo })));
  const reviewRequested = openPulls.filter(
    ({ pull }) =>
      pull.status === "open" &&
      pull.author.username.toLowerCase() !== lower &&
      pull.reviewers.some((name) => name.toLowerCase() === lower),
  );
  const assignedPulls = openPulls.filter(({ pull }) => pull.assignees.some((name) => name.toLowerCase() === lower));
  const authoredRows =
    activeList.length > 0
      ? activeList.map(({ pull, lifecycle, repo }) => pullRow(pull, pathOf(repo), lifecycle))
      : (okOr(authoredPulls)?.items ?? []).map(authoredPull);
  const pullsTabs = {
    authored: authoredRows.slice(0, 8),
    review: reviewRequested.slice(0, 8).map(({ pull, repo }) => pullRow(pull, pathOf(repo), null)),
    assigned: assignedPulls.slice(0, 8).map(({ pull, repo }) => pullRow(pull, pathOf(repo), null)),
  };
  const issueRow = (issue: Issue, repo: RepoPath): IssueRow => ({
    key: issue.id,
    repo,
    number: issue.number,
    title: issue.title,
    agent: issue.agent,
    queued: issue.queued,
    updatedAt: issue.updatedAt,
  });
  const issuesTabs = {
    assigned: (assigned ?? []).flatMap((issue) => {
      const repo = known.get(issue.repoId);
      return repo ? [issueRow(issue, pathOf(repo))] : [];
    }).slice(0, 8),
    authored: (okOr(authoredIssues)?.items ?? []).slice(0, 8).map((item) => ({
      key: `${item.repo.namespace}/${item.repo.name}#${item.number}`,
      repo: item.repo,
      number: item.number,
      title: item.title,
      agent: null,
      queued: false,
      updatedAt: item.updatedAt,
    })),
  };

  // --- Needs you ------------------------------------------------------------
  const needs: Need[] = [];
  for (const entry of overviewList ?? []) {
    const latest = entry.latest;
    if (latest?.kind === "production" && latest.status === "failed" && slug) {
      needs.push({
        key: `deploy:${entry.slug}`,
        kind: "deploy",
        title: `Production build of ${entry.slug} failed`,
        detail: latest.error ?? "The last build of the default branch failed. Production still serves the build before it.",
        to: `/${slug}/${entry.slug}/deployments/${latest.id}`,
        action: "See the build",
        at: Date.parse(latest.finishedAt ?? latest.createdAt),
        where: `${slug}/${entry.slug}`,
      });
    }
  }
  for (const { pull, lifecycle, repo } of activeList) {
    const where = `${repo.namespace}/${repo.name}#${pull.number}`;
    const to = `/${repo.namespace}/${repo.name}/pull/${pull.number}`;
    if (lifecycle?.stage === "needs_you") {
      const conflict = /conflict/i.test(lifecycle.detail);
      needs.push({
        key: `pull:${pull.id}`,
        kind: conflict ? "conflict" : "stalled",
        title: pull.title,
        detail: lifecycle.detail,
        to,
        action: conflict ? "Resolve" : "Decide",
        at: Date.parse(pull.updatedAt),
        where,
      });
    } else if (lifecycle?.stage === "ready") {
      needs.push({ key: `pull:${pull.id}`, kind: "ready", title: pull.title, detail: "Checks passed and it was approved. It lands when you merge it.", to, action: "Merge", at: Date.parse(pull.updatedAt), where });
    } else if (!lifecycle && pull.status === "open" && pull.checkStatus === "failed") {
      needs.push({ key: `pull:${pull.id}`, kind: "checks", title: pull.title, detail: "Its acceptance checks failed on the latest push.", to, action: "See checks", at: Date.parse(pull.updatedAt), where });
    }
  }
  for (const { pull, repo } of reviewRequested) {
    needs.push({
      key: `review:${pull.id}`,
      kind: "review",
      title: pull.title,
      detail: `${pull.author.username} asked for your review.`,
      to: `/${repo.namespace}/${repo.name}/pull/${pull.number}`,
      action: "Review",
      at: Date.parse(pull.updatedAt),
      where: `${repo.namespace}/${repo.name}#${pull.number}`,
    });
  }
  let quietest: number | null = null;
  for (const run of liveRuns) {
    const minutes = stuckMinutes(run, now);
    if (minutes == null) continue;
    quietest = Math.max(quietest ?? 0, minutes);
    needs.push({
      key: `run:${run.id}`,
      kind: "stuck",
      title: run.title ?? `${run.agent}'s run`,
      detail: `${run.agent} has reported nothing for ${minutes} min${run.step ? `. Last: ${run.step}` : ""}.`,
      to: `/${run.repo.namespace}/${run.repo.name}/agents/runs/${run.id}`,
      action: "Look",
      at: Date.parse(run.updatedAt),
      where: `${run.repo.namespace}/${run.repo.name}${run.number != null ? `#${run.number}` : ""}`,
    });
  }

  // --- Activity -------------------------------------------------------------
  const items: ActivityItem[] = [];
  const allEvents: { repo: string; event: G1tEvent }[] = [];
  for (const { repo, events } of perRepo ?? []) {
    for (const event of events ?? []) {
      allEvents.push({ repo: repo.id, event });
      const item = eventItem(event, pathOf(repo));
      if (item) items.push(item);
    }
  }
  for (const entry of overviewList ?? []) {
    const latest = entry.latest;
    const served = latest?.status === "ready" || latest?.status === "replaced";
    if (!slug || latest?.kind !== "production" || (!served && latest.status !== "failed")) continue;
    items.push({
      id: `deploy:${latest.id}`,
      at: Date.parse(latest.finishedAt ?? latest.createdAt),
      repo: { namespace: slug, name: entry.slug },
      actor: latest.createdBy,
      verb: served ? "deployed" : "deploy_failed",
      number: null,
      to: `/${slug}/${entry.slug}/deployments/${latest.id}`,
    });
  }
  for (const memory of okOr(memories ?? null)?.workspace ?? []) {
    const repo = memory.repo ?? memory.source.repo;
    if (!repo || !slug) continue;
    items.push({
      id: `memory:${memory.id}`,
      at: Date.parse(memory.createdAt),
      repo,
      actor: memory.createdBy,
      verb: "learned",
      number: null,
      text: memory.text.length > 90 ? `${memory.text.slice(0, 88)}…` : memory.text,
      to: `/${slug}/-/memory`,
    });
  }
  const groups = groupActivity(items).slice(0, 60);

  // --- Since you were last here --------------------------------------------
  const since = seen.since ?? now - TIME.DAY;
  const after = (verb: ActivityItem["verb"]) => items.filter((item) => item.verb === verb && item.at > since).length;
  const digest = digestParts({
    landed: after("landed"),
    reviews: reviewRequested.length,
    opened: after("opened_issue"),
    deploys: after("deployed"),
    failedDeploys: after("deploy_failed"),
    stuck: quietest,
  });

  // --- Pulse ----------------------------------------------------------------
  const week = allEvents.filter(({ event }) => Date.parse(event.time) >= weekAgo);
  const mergedWeek = week.filter(({ event }) => event.type === "pull.merged");
  const spans = issueToMerge(
    allEvents.flatMap(({ repo, event }) => (event.type === "issue.opened" ? [{ repo, number: event.data.number, at: Date.parse(event.time) }] : [])),
    mergedWeek.flatMap(({ repo, event }) => (event.type === "pull.merged" ? [{ repo, issue: event.data.issue ?? null, at: Date.parse(event.time) }] : [])),
  );
  const checkEvents = allEvents.flatMap(({ repo, event }) =>
    event.type === "checks.completed" ? [{ repo, number: event.data.number, at: Date.parse(event.time), passed: event.data.status === "passed" }] : [],
  );
  const firstPass = firstPassRate(checkEvents.filter((c) => c.at >= weekAgo));
  const usageOk = okOr(usage ?? null);
  const costPoints = usageOk
    ? usageOk.byDay.map((slice) => ({ at: Date.parse(`${slice.key.split("/")[0]}T12:00:00Z`), value: slice.micros / 1_000_000 }))
    : runList.filter((run) => run.costUsd != null).map((run) => ({ at: Date.parse(run.createdAt), value: run.costUsd ?? 0 }));
  const costDays = dailyBuckets(costPoints, 7, now);
  const pulse = {
    merged: mergedWeek.length,
    mergedDays: dailyBuckets(mergedWeek.map(({ event }) => ({ at: Date.parse(event.time) })), 7, now),
    hours: agentHours(runList, weekAgo, now),
    hoursDays: dailyBuckets(
      runList
        .filter((run) => run.startedAt)
        .map((run) => ({ at: Date.parse(run.startedAt!), value: agentHours([run], weekAgo, now) })),
      7,
      now,
    ),
    cost: costDays.reduce((sum, v) => sum + v, 0),
    costDays,
    issueToMerge: median(spans),
    mergedWithIssue: spans.length,
    firstPass: firstPass.rate,
    firstPassOf: firstPass.of,
  };

  // --- Projects -------------------------------------------------------------
  const byRepoName = new Map((perRepo ?? []).map((entry) => [`${entry.repo.namespace}/${entry.repo.name}`.toLowerCase(), entry]));
  const projectsHealth: ProjectHealth[] = (projectsOk ?? []).slice(0, 12).map((project) => {
    const repo = project.source.kind === "hosted" ? project.source.repo : null;
    const key = repo ? `${repo.namespace}/${repo.name}`.toLowerCase() : "";
    const entry = byRepoName.get(key);
    const deploy = overviewList?.find((d) => d.slug === project.slug) ?? null;
    const checks = (entry?.events ?? []).flatMap((event) => (event.type === "checks.completed" ? [event.data.status === "passed"] : []));
    return {
      slug: project.slug,
      name: project.name,
      private: project.private,
      repo,
      deploys: deploy?.enabled ?? false,
      production: deploy?.production ?? null,
      latest: deploy?.latest ?? null,
      openPulls: entry?.pulls ? entry.pulls.length : null,
      agents: liveRuns.filter((run) => repo && `${run.repo.namespace}/${run.repo.name}`.toLowerCase() === key).length,
      passRate: checks.length ? checks.filter(Boolean).length / checks.length : null,
      checks: checks.length,
    };
  });

  const models_ = models ?? null;
  times.total = Date.now() - started;
  const serverTiming = Object.entries(times)
    .map(([name, ms]) => `${name};dur=${ms}`)
    .join(", ");
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return data(
    {
      signedIn: true as const,
      viewer,
      name: profile?.name?.trim() || username,
      greeting: greetingFor(hourIn(now, tz)),
      seenBefore: seen.since,
      repos: repoList,
      canRunAgents: models_ == null || models_.hosted || models_.own != null,
      trial: models_?.own == null ? (models_?.trial ?? null) : null,
      active: activeList.map(({ pull, lifecycle, repo }) => ({ pull, lifecycle, repo })),
      needs: rankNeeds(needs),
      live: liveRuns.slice(0, 12) as AgentRun[],
      liveTotal: liveRuns.length,
      runsLoaded: runs != null && runs.ok,
      pullsTabs,
      issuesTabs,
      perRepoLoaded: perRepo != null,
      groups,
      digest,
      pulse,
      projects: projectsHealth,
      projectsLoaded: projectsOk != null,
    },
    {
      headers: {
        "Server-Timing": serverTiming,
        "Set-Cookie": `${SEEN_COOKIE}=${seen.value}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
      },
    },
  );
}

type Loaded = Extract<Route.ComponentProps["loaderData"], { signedIn: true }>;

// --- Pieces ---------------------------------------------------------------------

const TONE = { fg: "text-fg", warn: "text-warn", danger: "text-danger", accent: "text-accent" };

function Digest({ parts, seenBefore }: { parts: Loaded["digest"]; seenBefore: number | null }) {
  const when = seenBefore ? (
    <>
      Since you were last here, <TimeAgo at={seenBefore} />
    </>
  ) : (
    "In the last day"
  );
  if (parts.length === 0) {
    return <p className="mt-1 text-sm text-muted">{when}: nothing new landed, and nothing is waiting on you.</p>;
  }
  return (
    <p className="mt-1 text-sm leading-6 text-muted">
      {when}:{" "}
      {parts.map((part, index) => (
        <span key={part.text}>
          {index > 0 && (index === parts.length - 1 ? " and " : ", ")}
          <a href={`#${part.anchor}`} className={`font-medium underline decoration-line-strong underline-offset-4 hover:decoration-current ${TONE[part.tone]}`}>
            {part.text}
          </a>
        </span>
      ))}
      .
    </p>
  );
}

function PullList({ rows, empty }: { rows: Loaded["pullsTabs"]["authored"]; empty: ReactNode }) {
  if (rows.length === 0) return <Quiet>{empty}</Quiet>;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {rows.map((row) => (
        <li key={row.key}>
          <Link
            prefetch="intent"
            to={`/${row.repo.namespace}/${row.repo.name}/pull/${row.number}`}
            className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-raised"
          >
            <PullIcon status={row.status} />
            <span className="min-w-0 grow">
              <span className="block truncate text-sm font-medium">{row.title}</span>
              <span className="block truncate font-mono text-xs text-muted">
                {row.repo.name}#{row.number}
                {row.agent && ` · ${row.agent}`}
              </span>
            </span>
            {row.stage ? (
              <span className="hidden shrink-0 items-center gap-2 text-xs text-muted sm:flex">
                <StageDots stage={row.stage} />
                <span className={row.stage === "needs_you" ? "text-warn" : ""}>{STAGE_LABEL[row.stage]}</span>
              </span>
            ) : (
              <span className="hidden shrink-0 sm:block">
                <CheckBadge status={row.checkStatus} />
              </span>
            )}
            <span className="w-14 shrink-0 text-right text-xs text-faint">
              <TimeAgo at={row.updatedAt} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function IssueList({ rows, empty }: { rows: Loaded["issuesTabs"]["assigned"]; empty: ReactNode }) {
  if (rows.length === 0) return <Quiet>{empty}</Quiet>;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {rows.map((row) => (
        <li key={row.key}>
          <Link
            prefetch="intent"
            to={`/${row.repo.namespace}/${row.repo.name}/issues/${row.number}`}
            className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-raised"
          >
            <IssueIcon issue={{ state: "open", reason: null }} />
            <span className="min-w-0 grow">
              <span className="block truncate text-sm font-medium">{row.title}</span>
              <span className="block truncate font-mono text-xs text-muted">
                {row.repo.name}#{row.number}
              </span>
            </span>
            {row.agent ? (
              <span className="hidden shrink-0 items-center gap-1 text-xs text-merged sm:flex">
                <Bot size={12} /> {row.agent} at work
              </span>
            ) : row.queued ? (
              <span className="hidden shrink-0 text-xs text-muted sm:block">Queued for an agent</span>
            ) : null}
            <span className="w-14 shrink-0 text-right text-xs text-faint">
              <TimeAgo at={row.updatedAt} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ProjectCard({ project, workspace }: { project: Loaded["projects"][number]; workspace: string }) {
  const base = `/${workspace}/${project.slug}`;
  const latest = project.latest;
  return (
    <li className="flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
          {project.private ? <Lock size={13} /> : <Box size={13} />}
        </span>
        <Link to={base} prefetch="intent" className="min-w-0 grow truncate font-medium hover:text-accent">
          {project.name}
        </Link>
        {project.agents > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-merged/40 bg-merged/10 px-2 py-0.5 text-[0.6875rem] text-merged">
            <span className="size-1.5 animate-pulse rounded-full bg-merged" />
            {project.agents} at work
          </span>
        )}
      </div>
      <div className="mt-3 min-h-10 text-xs">
        {project.production ? (
          <>
            <a href={project.production.url} className="flex items-center gap-1 truncate font-mono text-fg-soft hover:text-accent">
              {host(project.production.url)}
              <ArrowUpRight size={12} className="shrink-0 text-faint" />
            </a>
            <p className="mt-1 flex items-center gap-2 text-muted">
              {latest && <StatusDot status={latest.status} />}
              <span>
                deployed <TimeAgo at={project.production.deployedAt} />
              </span>
            </p>
          </>
        ) : project.deploys ? (
          <p className="text-muted">
            {latest ? <StatusDot status={latest.status} label={`${DEPLOY_STATUS[latest.status].label}, not live yet`} /> : "Deploys on the next push to the default branch."}
          </p>
        ) : (
          <p className="text-faint">
            Not deployed.{" "}
            <Link to={`${base}/settings/deployments`} className="text-muted hover:text-fg">
              Put it on g1t.page
            </Link>
          </p>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-xs">
        <div>
          <dt className="text-faint">Open PRs</dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            <Link to={`${base}/pulls`} className="hover:text-accent">
              {project.openPulls ?? "—"}
            </Link>
          </dd>
        </div>
        <div>
          <dt className="text-faint">Agents</dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            <Link to={`${base}/agents`} className="hover:text-accent">
              {project.agents}
            </Link>
          </dd>
        </div>
        <div title={project.checks ? `${project.checks} recent check runs` : "No recent check runs"}>
          <dt className="text-faint">Checks</dt>
          <dd className="mt-0.5 font-medium tabular-nums">{percent(project.passRate)}</dd>
          <dd className="mt-1">
            <Meter value={project.passRate} tone={project.passRate != null && project.passRate < 0.7 ? "bg-warn" : "bg-accent"} />
          </dd>
        </div>
      </dl>
    </li>
  );
}

type Step = { done: boolean; title: string; about: string; to: string | null; action: string };

/**
 * The first things to do, ticked off as they are done, until work has been
 * handed to agents.
 */
function GetStarted({ steps }: { steps: Step[] }) {
  const left = steps.filter((step) => !step.done).length;
  return (
    <section className="rounded-2xl bg-surface p-5 ring-1 ring-line">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold tracking-tight">Get started</h2>
        <span className="text-xs text-muted">
          {steps.length - left} of {steps.length} done
        </span>
      </div>
      <ol className="mt-4 space-y-2">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={`flex items-start gap-3 rounded-xl px-3 py-2.5 ${step.done ? "" : "bg-bg/50 ring-1 ring-line"}`}
          >
            <span
              className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-medium ${
                step.done ? "bg-accent text-bg" : "text-muted ring-1 ring-line-strong"
              }`}
            >
              {step.done ? "✓" : index + 1}
            </span>
            <span className="min-w-0 grow">
              <span className={`block text-sm font-medium ${step.done ? "text-muted line-through decoration-faint" : ""}`}>
                {step.title}
              </span>
              {!step.done && <span className="mt-0.5 block text-xs leading-5 text-muted">{step.about}</span>}
            </span>
            {!step.done && step.to && (
              <Link
                to={step.to}
                className="shrink-0 rounded-md bg-fg px-2.5 py-1 text-xs font-medium text-bg transition-colors hover:bg-white"
              >
                {step.action}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The workspace being looked at: what it holds and what is moving in it. */
function WorkspaceCard({
  slug,
  name,
  avatar,
  role,
  projects,
  needs,
  live,
}: {
  slug: string;
  name: string;
  avatar?: string | null;
  role: string;
  projects: number;
  needs: number;
  live: number;
}) {
  const stats = [
    { value: projects, label: "projects" },
    { value: live, label: "agents at work" },
    { value: needs, label: "need you" },
  ];
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center gap-3">
        <Avatar name={slug} image={avatar} size={32} square />
        <div className="min-w-0">
          <Link to={`/${slug}`} title={name} className="block truncate font-medium hover:underline">
            {name}
          </Link>
          <p className="truncate text-xs text-muted">
            <span className="font-mono">g1t.sh/{slug}</span> · <span className="capitalize">{role}</span>
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-lg bg-bg/60 px-2.5 py-2 ring-1 ring-line">
            <dt className="sr-only">{stat.label}</dt>
            <dd className="text-lg font-semibold tabular-nums tracking-tight">{stat.value}</dd>
            <dd className="text-[0.6875rem] leading-tight text-muted">{stat.label}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link to={`/${slug}/-/people`} className="inline-flex items-center gap-1.5 text-muted hover:text-fg">
          <Users size={13} />
          Members
        </Link>
        <Link
          to={role === "owner" ? `/${slug}/-/settings` : `/${slug}/-/people`}
          className="inline-flex items-center gap-1.5 text-muted hover:text-fg"
        >
          <Settings size={13} />
          Settings
        </Link>
        <Link to={`/${slug}/-/agents`} className="inline-flex items-center gap-1.5 text-muted hover:text-fg">
          <Radio size={13} />
          Fleet
        </Link>
      </div>
    </div>
  );
}

function UsageCard({ shell, weekCost }: { shell: ShellData; weekCost: number }) {
  const slug = shell.workspace?.slug;
  const used = shell.monthUsageMicros ?? 0;
  const limit = shell.limit;
  const ceiling = limit && !limit.comped ? limit.ceilingMicros : null;
  const share = ceiling ? Math.min(1, limit!.exposureMicros / ceiling) : null;
  const month = new Date().toLocaleDateString("en-US", { month: "long" });
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Coins size={14} className="text-faint" />
          Usage in {month}
        </h2>
        {slug && (
          <Link to={`/${slug}/-/usage`} className="text-xs text-muted hover:text-fg">
            Details
          </Link>
        )}
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{dollars(used)}</p>
      <p className="text-xs text-muted">
        {shell.free ? "At cost. g1t charges nothing while it is being built out." : "Charged so far this month."}
        {weekCost > 0 && ` ${formatCost(weekCost)} of it in the last 7 days.`}
      </p>
      {ceiling != null && (
        <div className="mt-3">
          <Meter value={share} tone={limit!.state === "ok" ? "bg-accent" : limit!.state === "warning" ? "bg-warn" : "bg-danger"} />
          <p className="mt-1.5 text-[0.6875rem] text-faint">
            {dollars(limit!.exposureMicros)} of the {dollars(ceiling)} limit
          </p>
        </div>
      )}
    </div>
  );
}

function WhatsNew({ workspace }: { workspace: string | null }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <Sparkles size={14} className="text-accent" />
        What's new on g1t
      </h2>
      <ul className="mt-3 space-y-3">
        {CHANGELOG.slice(0, 5).map((entry) => {
          const href = changelogHref(entry, workspace);
          const title = <span className="text-sm font-medium">{entry.title}</span>;
          return (
            <li key={entry.title}>
              {href ? (
                <Link to={href} className="hover:text-accent">
                  {title}
                </Link>
              ) : (
                title
              )}
              <p className="mt-0.5 text-xs leading-5 text-muted">{entry.about}</p>
            </li>
          );
        })}
      </ul>
      <a href="https://docs.g1t.sh/" className="mt-4 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        Read the docs <ArrowRight size={12} />
      </a>
    </div>
  );
}

// --- The page -------------------------------------------------------------------

export default function Home({ loaderData }: Route.ComponentProps) {
  const shell = useRouteLoaderData("root")?.shell as ShellData | null | undefined;
  const loaded = loaderData.signedIn ? loaderData : null;
  // Agents are at work, so the page changes without anyone touching it.
  const changing =
    (loaded?.liveTotal ?? 0) > 0 ||
    (loaded?.active ?? []).some((item) => item.lifecycle && item.lifecycle.stage !== "needs_you" && item.lifecycle.stage !== "ready");
  useLiveRefresh(changing);
  const [greeting, setGreeting] = useState(loaded?.greeting ?? "");
  const [pullsTab, setPullsTab] = useState(() => (loaded && loaded.pullsTabs.review.length > 0 ? "review" : "authored"));
  useEffect(() => {
    // The greeting follows the viewer's own clock, and the server learns
    // their zone for next time.
    setGreeting(greetingFor(new Date().getHours()));
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (zone) document.cookie = `${TZ_COOKIE}=${encodeURIComponent(zone)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    } catch {
      // Nothing to remember.
    }
  }, []);

  if (!loaded) return <Landing repos={loaderData.repos} />;
  const { viewer, repos, active, needs: serverNeeds, live, liveTotal, pullsTabs, issuesTabs, groups, pulse, projects, canRunAgents, trial } = loaded;

  const workspace = shell?.workspace?.slug ?? viewer.workspaces?.[0]?.slug ?? null;
  // The usage limit, as the sidebar knows it, heads the list when it bites.
  const limitNeed: Need[] =
    shell?.limit && !shell.limit.comped && shell.limit.state !== "ok" && workspace
      ? [
          {
            key: "limit",
            kind: "limit",
            title: shell.limit.state === "stopped" ? "Agents are stopped: the usage limit was reached" : "Usage is nearing its limit",
            detail:
              shell.limit.state === "stopped"
                ? "No new agent starts until the limit is raised or a card is added."
                : `${dollars(shell.limit.exposureMicros)} of ${dollars(shell.limit.ceilingMicros ?? 0)} used. Add a card so work keeps going.`,
            to: `/${workspace}/-/billing`,
            action: "Billing",
            at: Date.now(),
            where: null,
          },
        ]
      : [];
  const needs = rankNeeds([...limitNeed, ...serverNeeds]);

  const first = repos[0];
  const handedOff = active.length > 0 || (shell?.monthUsageMicros ?? 0) > 0;
  const steps: Step[] = [
    {
      done: Boolean(workspace),
      title: "Create a workspace",
      about: "Projects, people and agent credit live in one.",
      to: "/workspaces/new",
      action: "Create",
    },
    {
      done: repos.length > 0,
      title: "Add a project",
      about: "Create a repository, or import one by its address. Push to it with git as usual.",
      to: workspace ? `/new?workspace=${workspace}` : "/new",
      action: "Add",
    },
    trial?.open
      ? {
          done: true,
          title: "Try g1t's agents free",
          about: trial.granted
            ? `This workspace has ${dollars(trial.limitMicros - trial.usedMicros)} of its ${dollars(trial.limitMicros)} trial credit left, for g1t's models and sandboxes.`
            : `This workspace gets ${dollars(trial.limitMicros)} of trial credit, for g1t's models and sandboxes, the first time its agents work.`,
          to: workspace ? `/${workspace}/-/integrations` : null,
          action: "Connect",
        }
      : canRunAgents
        ? {
            done: Boolean(shell?.free) || shell?.limit == null || shell.limit.comped || shell.limit.state === "ok",
            title: "Keep work running",
            about: "Usage is charged after it runs. Add a card under Billing, so g1t charges it as you near your limit instead of stopping work.",
            to: workspace ? `/${workspace}/-/billing` : null,
            action: "Billing",
          }
        : {
            done: false,
            title: "Connect a model",
            about: `${
              trialClosed(trial, workspace ?? "This workspace") ? `${trialClosed(trial, workspace ?? "This workspace")} ` : ""
            }Agents need a model to think with. Connect your Anthropic or OpenAI key, or any compatible endpoint.`,
            to: workspace ? `/${workspace}/-/integrations` : null,
            action: "Connect",
          },
    {
      done: handedOff,
      title: "Hand off an outcome",
      about: "Describe what you want done above, or write an outcome on a project's Plans page and let a planner split it into issues.",
      to: first ? `/${first.namespace}/${first.name}/plans` : null,
      action: "Write one",
    },
  ];
  const starting = steps.some((step) => !step.done);
  const counts = (n: number) => (n > 0 ? <span className="ml-1 tabular-nums text-faint">{n}</span> : null);

  return (
    <main className="mx-auto grid max-w-7xl gap-x-10 gap-y-10 px-4 py-8 sm:py-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0 space-y-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]" suppressHydrationWarning>
            {greeting}, {loaded.name}
          </h1>
          <Digest parts={loaded.digest} seenBefore={loaded.seenBefore} />
        </header>

        {starting && <GetStarted steps={steps} />}

        <Panel id="needs-you" title="Needs you" icon={<Hand size={14} className="text-warn" />} count={needs.length}>
          {needs.length === 0 ? (
            <Quiet>Nothing is waiting on you. Reviews, stopped work and failed deploys show up here first.</Quiet>
          ) : (
            <NeedsList needs={needs} />
          )}
        </Panel>

        <Panel
          id="live"
          title="Live now"
          icon={<span className={`block size-2 rounded-full ${liveTotal > 0 ? "animate-pulse bg-merged" : "bg-line-strong"}`} />}
          count={liveTotal}
          all={workspace ? { to: `/${workspace}/-/agents`, label: "Fleet" } : null}
        >
          {!loaded.runsLoaded && workspace ? (
            <Unavailable what="Agent runs" />
          ) : live.length === 0 ? (
            <Quiet>No agent is at work right now. Assign an issue to g1t-agent and one starts on it in seconds.</Quiet>
          ) : (
            <ul className="space-y-3">
              {live.map((run) => (
                <RunCard key={run.id} run={run} member showRepo />
              ))}
              {liveTotal > live.length && workspace && (
                <li className="text-xs text-muted">
                  <Link to={`/${workspace}/-/agents`} className="hover:text-fg">
                    {liveTotal - live.length} more at work in the fleet
                  </Link>
                </li>
              )}
            </ul>
          )}
        </Panel>

        <Panel
          title="This week"
          icon={<ActivityIcon size={14} />}
          all={workspace ? { to: `/${workspace}/-/usage`, label: "Usage" } : null}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <PulseTile
              label="Changes landed"
              value={String(pulse.merged)}
              hint="last 7 days"
              values={pulse.mergedDays}
              format={(v) => `${v} landed`}
            />
            <PulseTile
              label="Agent hours"
              value={pulse.hours < 10 ? pulse.hours.toFixed(1) : String(Math.round(pulse.hours))}
              hint="time agents spent working"
              values={pulse.hoursDays}
              format={(v) => `${v.toFixed(1)} h`}
              to={workspace ? `/${workspace}/-/agents` : undefined}
            />
            <PulseTile
              label="Agent cost"
              value={formatCost(pulse.cost) ?? "$0.00"}
              hint="model and sandbox"
              values={pulse.costDays}
              format={(v) => formatCost(v) ?? "$0.00"}
              to={workspace ? `/${workspace}/-/usage` : undefined}
            />
            <PulseTile
              label="Issue to landed"
              value={formatSpan(pulse.issueToMerge)}
              hint={pulse.mergedWithIssue ? `median of ${pulse.mergedWithIssue}` : "no issue landed yet"}
            />
            <PulseTile
              label="Checks pass first time"
              value={percent(pulse.firstPass)}
              hint={pulse.firstPassOf ? `of ${pulse.firstPassOf} pull requests` : "no checks ran yet"}
            />
          </div>
        </Panel>

        <div className="grid gap-10 xl:grid-cols-2">
          <Tabs value={pullsTab} onValueChange={setPullsTab}>
            <Panel
              id="your-pulls"
              title="Your pull requests"
              icon={<GitPullRequest size={14} />}
              all={{ to: `/u/${viewer.username}?tab=pulls` }}
            >
              <TabsList>
                <TabsTrigger value="authored">Opened{counts(pullsTabs.authored.length)}</TabsTrigger>
                <TabsTrigger value="review">Review requested{counts(pullsTabs.review.length)}</TabsTrigger>
                <TabsTrigger value="assigned">Assigned{counts(pullsTabs.assigned.length)}</TabsTrigger>
              </TabsList>
              <TabsContent value="authored">
                <PullList rows={pullsTabs.authored} empty="None open. Pull requests you or your agents start show here with where each stands." />
              </TabsContent>
              <TabsContent value="review">
                {loaded.perRepoLoaded ? (
                  <PullList rows={pullsTabs.review} empty="No one is waiting on your review." />
                ) : (
                  <Unavailable what="Review requests" />
                )}
              </TabsContent>
              <TabsContent value="assigned">
                <PullList rows={pullsTabs.assigned} empty="No open pull request is assigned to you." />
              </TabsContent>
            </Panel>
          </Tabs>

          <Tabs defaultValue="assigned">
            <Panel title="Your issues" icon={<CircleDot size={14} />} all={{ to: `/u/${viewer.username}?tab=issues` }}>
              <TabsList>
                <TabsTrigger value="assigned">Assigned{counts(issuesTabs.assigned.length)}</TabsTrigger>
                <TabsTrigger value="authored">Opened{counts(issuesTabs.authored.length)}</TabsTrigger>
              </TabsList>
              <TabsContent value="assigned">
                <IssueList rows={issuesTabs.assigned} empty="Nothing is assigned to you." />
              </TabsContent>
              <TabsContent value="authored">
                <IssueList rows={issuesTabs.authored} empty="You have no open issues." />
              </TabsContent>
            </Panel>
          </Tabs>
        </div>

        <Panel id="activity" title="Activity" icon={<ActivityIcon size={14} />}>
          {!loaded.perRepoLoaded ? (
            <Unavailable what="Activity" />
          ) : (
            <ActivityFeed groups={groups} empty="Nothing has moved yet. Merges, deploys, checks, reviews and what agents learn show up here." />
          )}
        </Panel>

        {workspace && (
          <Panel
            id="projects"
            title="Projects"
            icon={<Box size={14} />}
            count={projects.length}
            all={{ to: `/${workspace}`, label: "Workspace" }}
            extra={
              <Link to={`/new?workspace=${workspace}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                <Plus size={12} /> New
              </Link>
            }
          >
            {!loaded.projectsLoaded ? (
              <Unavailable what="Projects" />
            ) : projects.length === 0 ? (
              <Quiet>No projects yet. Create a repository or import one, and it gets a project of its own.</Quiet>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {projects.map((project) => (
                  <ProjectCard key={project.slug} project={project} workspace={workspace} />
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>

      <aside className="space-y-4">
        {shell?.workspace && (
          <WorkspaceCard
            slug={shell.workspace.slug.toLowerCase()}
            name={shell.workspace.name || shell.workspace.slug}
            avatar={shell.workspace.avatar}
            role={shell.workspace.role}
            projects={shell.repos.length}
            needs={needs.length}
            live={liveTotal}
          />
        )}
        {shell?.workspace && <UsageCard shell={shell} weekCost={pulse.cost} />}
        <WhatsNew workspace={workspace} />
        <div className="rounded-xl border border-line bg-surface p-5">
          <h2 className="text-sm font-semibold">Connect your own agent</h2>
          <p className="mt-1.5 text-xs leading-5 text-muted">
            Add g1t to Claude Code, then run /mcp in it to sign in through your browser.
          </p>
          <div className="mt-3">
            <CopyLine prompt text="claude mcp add --transport http g1t https://mcp.g1t.sh" />
          </div>
          <Link
            to="https://docs.g1t.sh/guides/bring-your-own-agent/"
            className="mt-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
          >
            How it works <ArrowRight size={12} />
          </Link>
        </div>
      </aside>
    </main>
  );
}
