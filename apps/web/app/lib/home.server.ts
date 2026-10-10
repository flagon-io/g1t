/**
 * Home's reads: each section's data from its own service, every call on
 * its own so one that fails leaves only its section saying so. The shaping
 * is in ./home.ts.
 */
import { env } from "cloudflare:workers";

import {
  type ActivityDigest,
  type AgentSession,
  type AgentsOverview,
  type ChatActivity,
  type Deployment,
  type InstallRequests,
  MAX_DIGEST_REPOS,
  type Memory,
  type ProjectDeploys,
  type Repo,
  type RepoPath,
  type User,
  type WorkflowRun,
  type WorkspaceAgent,
  notifyClient,
} from "@g1t/contracts";

import { type CodePull, type CodeWork, G1T_ACTOR, type RepoRef, type SessionWork, type Span, type Spend, pullKey, spanMonths, spendIn } from "./home";
import { monthSpan, spentMicros } from "./spend";
import { actions, agents, billing, chat, deployments, events, identity, repos, work, workspaceAgents } from "./services.server";

/** Pull requests read per project and list: `LIST_PAGE` in services/work. */
const PULL_PAGE = 100;
/** The most projects whose pull requests are read. */
const MAX_PROJECTS = 50;
/** The most projects whose builds are read for the span. */
const MAX_DEPLOY_PROJECTS = 20;
/** The most projects whose workflow runs are read for Running now: those pushed to most in the span. */
const MAX_WORKFLOW_PROJECTS = 10;
/** Runs read per project: enough to find the ones not finished. */
const WORKFLOW_RUNS = 20;
/** Revise runs and sessions read: the services' most in one list. */
const RUN_PAGE = 200;
const SESSION_PAGE = 200;
/** The most member keys named in one lookup. */
const MAX_NAMES = 200;
const DAY = 24 * 60 * 60 * 1000;

const warn = (what: string) => (error: unknown) => {
  console.warn(`home: ${what} failed`, error);
  return null;
};

/**
 * When the viewer was last on this workspace's Home, from notify, where it
 * is kept with them (the same on every device). Null when there is no
 * visit on record; undefined when notify did not answer.
 */
export async function loadLastVisit(viewer: User, slug: string): Promise<number | null | undefined> {
  if (!env.NOTIFY) return undefined;
  const visit = await notifyClient(env.NOTIFY).lastVisit(viewer, slug).catch(warn("last visit"));
  if (!visit) return undefined;
  return visit.seen_at ? Date.parse(visit.seen_at) : null;
}

/** Marks the viewer's visit at `at`, the time the page they looked at loaded. */
export async function markVisit(viewer: User, slug: string, at: number): Promise<boolean> {
  if (!env.NOTIFY) return false;
  const marked = await notifyClient(env.NOTIFY).markVisit(viewer, slug, new Date(at).toISOString()).catch(warn("mark visit"));
  return marked != null;
}

/**
 * The workspace's own repositories the viewer may read (no pull request
 * working copies), as every Code section reads them. Null when repos did
 * not answer.
 */
export async function loadRepos(viewer: User, slug: string): Promise<Repo[] | null> {
  const list = await repos.list(viewer, { namespace: slug }).catch(warn("repos"));
  return list ? list.filter((repo) => !repo.forkOf && repo.namespace.toLowerCase() === slug) : null;
}

/** The repositories by id, as the digest's lines and links need them. */
export function repoRefs(list: Repo[] | null): Record<string, RepoRef> {
  const refs: Record<string, RepoRef> = {};
  for (const repo of list ?? []) refs[repo.id] = { namespace: repo.namespace, name: repo.name, defaultBranch: repo.defaultBranch };
  return refs;
}

/**
 * The workspace's projects' pull requests, open and recently merged or
 * closed, any author's, with how many times each agent's was sent back to
 * revise. `complete` when every list reaches back to `reach`. Null when
 * Code did not answer.
 */
export async function loadCodeWork(viewer: User, slug: string, reach: number, owned: Repo[] | null): Promise<CodeWork | null> {
  const runs = await agents.listRuns(viewer, { workspace: slug, kind: "revise", limit: RUN_PAGE }).catch(warn("revise runs"));
  if (!owned || !runs?.ok) return null;
  const chosen = owned.slice(0, MAX_PROJECTS);
  const byId = new Map<string, Repo>(chosen.map((repo) => [repo.id, repo]));
  const batch = chosen.length > 0 ? await work.pullsForRepos([...byId.keys()], viewer, PULL_PAGE).catch(warn("pull requests")) : [];
  if (!batch) return null;
  const pulls: CodePull[] = [];
  let complete = owned.length <= MAX_PROJECTS;
  for (const entry of batch) {
    const repo = byId.get(entry.repoId);
    if (!repo) continue;
    const path = { namespace: repo.namespace, name: repo.name };
    for (const pull of [...entry.open, ...entry.closed]) {
      pulls.push({
        repo: path,
        number: pull.number,
        title: pull.title,
        status: pull.status,
        mergedAt: pull.mergedAt,
        mergedBy: pull.mergedBy,
        createdAt: pull.createdAt,
        updatedAt: pull.updatedAt,
        author: { username: pull.author.username, kind: pull.author.kind },
      });
    }
    // A full page that does not reach back far enough may leave some out.
    for (const list of [entry.open, entry.closed]) {
      if (list.length >= PULL_PAGE) {
        const oldest = Math.min(...list.map((pull) => Date.parse(pull.mergedAt ?? pull.updatedAt)));
        if (oldest > reach) complete = false;
      }
    }
  }
  const revisions: Record<string, number> = {};
  for (const run of runs.value) {
    if (run.number == null) continue;
    const key = pullKey(run.repo, run.number);
    revisions[key] = (revisions[key] ?? 0) + 1;
  }
  if (runs.value.length >= RUN_PAGE && Date.parse(runs.value[runs.value.length - 1].createdAt) > reach) complete = false;
  return { pulls, revisions, complete };
}

/**
 * What happened in the span, counted by who did it: the events service's
 * digest of the workspace's repositories (the first MAX_DIGEST_REPOS of
 * them; none without Code access) and of its artifacts. Null when events
 * did not answer.
 */
export async function loadActivity(slug: string, span: Pick<Span, "from" | "now">, owned: Repo[] | null): Promise<ActivityDigest | null> {
  const digest = await events
    .activityDigest({
      repo_ids: (owned ?? []).slice(0, MAX_DIGEST_REPOS).map((repo) => repo.id),
      workspace: slug,
      from: new Date(span.from).toISOString(),
      until: new Date(span.now + 1).toISOString(),
    })
    .catch(warn("activity digest"));
  if (!digest) return null;
  // More repositories than the digest reads: it says so.
  return owned && owned.length > MAX_DIGEST_REPOS ? { ...digest, complete: false } : digest;
}

/** What was said in the span where the viewer can read, counted. Null when chat did not answer. */
export async function loadChatActivity(viewer: User, slug: string, span: Pick<Span, "from" | "now">): Promise<ChatActivity | null> {
  const activity = await chat
    .activity(slug, viewer, { from: new Date(span.from).toISOString(), until: new Date(span.now + 1).toISOString() })
    .catch(warn("chat activity"));
  return activity?.ok ? activity.value : null;
}

/** Every member key the digest and chat name. */
export function actorKeys(activity: ActivityDigest | null, chatActivity: ChatActivity | null): string[] {
  const keys = new Set<string>();
  for (const repo of activity?.repos ?? []) {
    for (const by of [...repo.pushes.by, ...repo.pushes.default_branch.by]) keys.add(by.actor);
    for (const list of [repo.pulls.opened, repo.pulls.merged, repo.pulls.closed, repo.issues.opened, repo.issues.closed, repo.reviews, repo.comments, repo.deployments.succeeded, repo.deployments.failed]) {
      for (const entry of list) keys.add(entry.actor);
    }
    for (const release of repo.releases) keys.add(release.actor);
    for (const pkg of repo.packages) keys.add(pkg.actor);
  }
  for (const entry of activity?.folios?.created ?? []) keys.add(entry.actor);
  for (const folio of activity?.folios?.edited ?? []) for (const author of folio.authors) keys.add(author);
  for (const author of chatActivity?.authors ?? []) keys.add(author.key);
  keys.delete("");
  return [...keys];
}

/**
 * The names behind member keys: people's usernames from identity (one
 * lookup for them all), agents' handles from the workspace's agents, g1t
 * as itself. A key identity does not know is left out, and shows as
 * "someone".
 */
export async function loadNames(keys: string[], agentsList: Pick<WorkspaceAgent, "id" | "handle">[] | null): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const userIds: string[] = [];
  const byAgentId = new Map((agentsList ?? []).map((agent) => [agent.id, agent.handle]));
  for (const key of keys.slice(0, MAX_NAMES)) {
    if (key === G1T_ACTOR) names[key] = "g1t";
    else if (key.startsWith("agent:")) {
      const handle = byAgentId.get(key.slice("agent:".length));
      if (handle) names[key] = handle;
    } else if (key.startsWith("user:")) userIds.push(key.slice("user:".length));
  }
  if (userIds.length > 0) {
    const found = await identity.usernames(userIds).catch(warn("usernames"));
    for (const [id, username] of Object.entries(found ?? {})) names[`user:${id}`] = username;
  }
  return names;
}

/**
 * The newest workflow runs of the projects pushed to most in the span (at
 * most MAX_WORKFLOW_PROJECTS), for the ones still going. A project whose
 * runs could not be read is left out; `complete` says whether every one was.
 */
export async function loadWorkflowRuns(
  viewer: User,
  activity: ActivityDigest | null,
  owned: Repo[] | null,
): Promise<{ projects: { repo: RepoPath; runs: WorkflowRun[] }[]; complete: boolean }> {
  const byId = new Map((owned ?? []).map((repo) => [repo.id, repo]));
  const active = [...(activity?.repos ?? [])]
    .filter((repo) => repo.pushes.count > 0 && byId.has(repo.repo_id))
    .sort((a, b) => b.pushes.count - a.pushes.count || a.repo_id.localeCompare(b.repo_id))
    .slice(0, MAX_WORKFLOW_PROJECTS);
  const lists = await Promise.all(
    active.map((digest) => {
      const repo = byId.get(digest.repo_id)!;
      const path = { namespace: repo.namespace, name: repo.name };
      return actions
        .runs(path, viewer, { limit: WORKFLOW_RUNS })
        .then((result) => (result.ok ? { repo: path, runs: result.value } : null))
        .catch(warn(`workflow runs of ${repo.name}`));
    }),
  );
  const projects = lists.filter((entry) => entry != null);
  return { projects, complete: projects.length === active.length };
}

/** The workspace's newest sessions; `complete` when the list reaches back before `from`. */
export async function loadSessions(viewer: User, slug: string, from: number): Promise<SessionWork | null> {
  const listed = await workspaceAgents.sessions(slug, viewer, { limit: SESSION_PAGE }).catch(warn("sessions"));
  if (!listed?.ok) return null;
  const sessions: AgentSession[] = listed.value;
  const oldest = sessions.at(-1);
  const complete = sessions.length < SESSION_PAGE || (oldest != null && Date.parse(oldest.created_at) < from);
  return { sessions, complete };
}

/** The agents overview: sessions waiting on the viewer, live ones, and the workspace's budget alert. */
export async function loadAgentsOverview(viewer: User, slug: string): Promise<AgentsOverview | null> {
  const overview = await workspaceAgents.overview(slug, viewer).catch(warn("agents overview"));
  return overview?.ok ? overview.value : null;
}

/** Install requests as the viewer sees them; only an owner's (`can_resolve`) are anyone else's. */
export async function loadInstallRequests(viewer: User, slug: string): Promise<InstallRequests | null> {
  const requests = await workspaceAgents.installRequests(slug, viewer).catch(warn("install requests"));
  return requests?.ok ? requests.value : null;
}

/** The workspace's memory, for the decisions recorded in it. */
export async function loadMemories(viewer: User, slug: string): Promise<Memory[] | null> {
  const memories = await agents.listMemories(viewer, slug, null).catch(warn("memories"));
  return memories?.ok ? memories.value.workspace : null;
}

/**
 * Every project's builds at a glance, and the builds of the projects that
 * deploy, for the span: the projects whose newest build is older than the
 * span are not read again.
 */
export async function loadDeploys(
  viewer: User,
  slug: string,
  from: number,
): Promise<{ overview: ProjectDeploys[]; projects: { slug: string; deployments: Deployment[] }[]; complete: boolean } | null> {
  const overview = await deployments.overview(slug, viewer).catch(warn("deploys overview"));
  if (!overview?.ok) return null;
  const recent = overview.value.filter((project) => project.latest && Date.parse(project.latest.finishedAt ?? project.latest.createdAt) >= from);
  const read = recent.slice(0, MAX_DEPLOY_PROJECTS);
  const lists = await Promise.all(
    read.map((project) =>
      deployments
        .list({ workspace: slug, slug: project.slug }, viewer)
        .then((result) => (result.ok ? { slug: project.slug, deployments: result.value.deployments } : null))
        .catch(warn(`deploys of ${project.slug}`)),
    ),
  );
  const projects = lists.filter((entry) => entry != null);
  return { overview: overview.value, projects, complete: projects.length === recent.length };
}

/**
 * The span's spend from the statements of the months it touches, and the
 * month so far from the usage report the top bar, Spend and Usage read
 * (`spend.ts` `monthSpan`, `spentMicros`), so Home's figure is theirs. Null
 * when billing did not answer; the month alone null when only it did not.
 */
export async function loadSpend(viewer: User, slug: string, span: Pick<Span, "from" | "now">): Promise<Spend | null> {
  const months = spanMonths(span);
  const [statements, month] = await Promise.all([
    Promise.all(months.map((month) => billing.statement(slug, viewer, month, "day").catch(warn(`statement ${month}`)))),
    billing
      .usageReport(slug, viewer, monthSpan(new Date(span.now)))
      .then((result) => (result.ok ? spentMicros(result.value) : null))
      .catch(warn("month usage")),
  ]);
  if (statements.some((statement) => !statement?.ok)) return null;
  return spendIn(
    statements.map((statement) => (statement as Extract<typeof statement, { ok: true }>).value),
    span,
    month,
  );
}

/** How far back Code is read: 7 days before the span, for the comparison. */
export function reachFor(span: Pick<Span, "from">): number {
  return span.from - 7 * DAY;
}
