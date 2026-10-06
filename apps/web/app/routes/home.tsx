import { env } from "cloudflare:workers";
import { Suspense, lazy } from "react";
import { data } from "react-router";

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
  REPO_ROLE_LABELS,
  isActiveRun,
} from "@g1t/contracts";

import type { Route } from "./+types/home";
import { page } from "../lib/meta";
import { WORKSPACE_COOKIE, chosenWorkspace } from "../lib/workspace-choice";
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

/** The viewer's time zone, which mission control sets, so the greeting fits their day. */
const TZ_COOKIE = "g1t_tz";
/** The most projects whose pull requests and events are read for the page. */
const MAX_PROJECTS = 10;
const EVENTS_PER_PROJECT = 80;

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "g1t — where people and agents ship software together",
    description:
      "The open-source git platform for people and agents: issues, pull requests and review, agents you assign like teammates, a merge queue that keeps main green, and deployments to the edge. Priced at cost plus 20%, never per seat.",
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
    // The signed-out home page is about signing up; it lists no repositories.
    return data({ signedIn: false as const });
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

  const [repos, perRepo, active, assigned, models, profile, runs, overview, usage, authoredPulls, authoredIssues, projectList, memories, invitations] =
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
      // Repositories someone has invited the viewer to.
      soft("invitations", identity.myRepoInvitations(viewer)),
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
  for (const invitation of invitations ?? []) {
    if (invitation.status !== "pending") continue;
    needs.push({
      key: `invitation:${invitation.id}`,
      kind: "invitation",
      title: `${invitation.invited_by ?? "Someone"} invited you to ${invitation.repo}`,
      detail: `With the ${REPO_ROLE_LABELS[invitation.role]} role. The invitation expires ${new Date(invitation.expires_at).toISOString().slice(0, 10)}.`,
      to: `/${invitation.repo}/invitations`,
      action: "Respond",
      at: Date.parse(invitation.created_at),
      where: invitation.repo,
    });
  }
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

export type Loaded = Extract<Route.ComponentProps["loaderData"], { signedIn: true }>;

/** Mission control, loaded only for someone signed in (components/mission-control.tsx). */
const MissionControl = lazy(() => import("../components/mission-control"));

export default function Home({ loaderData }: Route.ComponentProps) {
  if (!loaderData.signedIn) return <Landing />;
  return (
    <Suspense fallback={null}>
      <MissionControl loaderData={loaderData} />
    </Suspense>
  );
}
