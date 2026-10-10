/**
 * Home's reads: each section's data from its own service, every call on
 * its own so one that fails leaves only its section saying so. The shaping
 * is in ./home.ts.
 */
import { env } from "cloudflare:workers";

import { type AgentSession, type AgentsOverview, type Deployment, type InstallRequests, type Memory, type ProjectDeploys, type Repo, type User, notifyClient } from "@g1t/contracts";

import { type CodePull, type CodeWork, type SessionWork, type Span, type Spend, pullKey, spanMonths, spendIn } from "./home";
import { monthSpan, spentMicros } from "./spend";
import { agents, billing, deployments, repos, work, workspaceAgents } from "./services.server";

/** Pull requests read per project and list: `LIST_PAGE` in services/work. */
const PULL_PAGE = 100;
/** The most projects whose pull requests are read. */
const MAX_PROJECTS = 50;
/** The most projects whose builds are read for the span. */
const MAX_DEPLOY_PROJECTS = 20;
/** Revise runs and sessions read: the services' most in one list. */
const RUN_PAGE = 200;
const SESSION_PAGE = 200;
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
 * The workspace's projects' pull requests, open and recently merged or
 * closed, any author's, with how many times each agent's was sent back to
 * revise. `complete` when every list reaches back to `reach`. Null when
 * Code did not answer.
 */
export async function loadCodeWork(viewer: User, slug: string, reach: number): Promise<CodeWork | null> {
  const [list, runs] = await Promise.all([
    repos.list(viewer, { namespace: slug }).catch(warn("repos")),
    agents.listRuns(viewer, { workspace: slug, kind: "revise", limit: RUN_PAGE }).catch(warn("revise runs")),
  ]);
  if (!list || !runs?.ok) return null;
  const owned = list.filter((repo) => !repo.forkOf && repo.namespace.toLowerCase() === slug);
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
