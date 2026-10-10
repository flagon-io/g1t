/**
 * Today's reads: each section's data from its own service, every call on
 * its own so one that fails leaves only its section saying so. The shaping
 * is in ./today.ts.
 */
import type { AgentSession, Repo, User } from "@g1t/contracts";

import { type CodePull, type CodeWork, type SessionWork, type Spend, dayIn, pullKey, spendToday } from "./today";
import { agents, billing, repos, work, workspaceAgents } from "./services.server";

/** Pull requests read per project and list: `LIST_PAGE` in services/work. */
const PULL_PAGE = 100;
/** The most projects whose pull requests are read. */
const MAX_PROJECTS = 50;
/** Revise runs and sessions read: the services' most in one list. */
const RUN_PAGE = 200;
const SESSION_PAGE = 200;
const DAY = 24 * 60 * 60 * 1000;

const warn = (what: string) => (error: unknown) => {
  console.warn(`today: ${what} failed`, error);
  return null;
};

/**
 * The agents' pull requests in the workspace's projects, open and recently
 * merged or closed, with how many times each was sent back to revise.
 * Null when Code did not answer.
 */
export async function loadCodeWork(viewer: User, slug: string, now: number): Promise<CodeWork | null> {
  const [list, runs] = await Promise.all([
    repos.list(viewer, { namespace: slug }).catch(warn("repos")),
    agents.listRuns(viewer, { workspace: slug, kind: "revise", limit: RUN_PAGE }).catch(warn("revise runs")),
  ]);
  if (!list || !runs?.ok) return null;
  const chosen = list.filter((repo) => !repo.forkOf && repo.namespace.toLowerCase() === slug).slice(0, MAX_PROJECTS);
  const byId = new Map<string, Repo>(chosen.map((repo) => [repo.id, repo]));
  const batch = chosen.length > 0 ? await work.pullsForRepos([...byId.keys()], viewer, PULL_PAGE).catch(warn("pull requests")) : [];
  if (!batch) return null;
  const pulls: CodePull[] = [];
  const since = now - 8 * DAY;
  let complete = list.filter((repo) => !repo.forkOf && repo.namespace.toLowerCase() === slug).length <= MAX_PROJECTS;
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
        createdAt: pull.createdAt,
        updatedAt: pull.updatedAt,
        author: { username: pull.author.username, kind: pull.author.kind },
      });
    }
    // A full page that does not reach back eight days may leave some out.
    for (const list of [entry.open, entry.closed]) {
      if (list.length >= PULL_PAGE) {
        const oldest = Math.min(...list.map((pull) => Date.parse(pull.mergedAt ?? pull.updatedAt)));
        if (oldest > since) complete = false;
      }
    }
  }
  const revisions: Record<string, number> = {};
  for (const run of runs.value) {
    if (run.number == null) continue;
    const key = pullKey(run.repo, run.number);
    revisions[key] = (revisions[key] ?? 0) + 1;
  }
  if (runs.value.length >= RUN_PAGE && Date.parse(runs.value[runs.value.length - 1].createdAt) > since) complete = false;
  return { pulls, revisions, complete };
}

/** The workspace's newest sessions; `complete` when the list reaches back before today. */
export async function loadSessions(viewer: User, slug: string, now: number, timeZone: string | null): Promise<SessionWork | null> {
  const listed = await workspaceAgents.sessions(slug, viewer, { limit: SESSION_PAGE }).catch(warn("sessions"));
  if (!listed?.ok) return null;
  const sessions: AgentSession[] = listed.value;
  const oldest = sessions.at(-1);
  const complete = sessions.length < SESSION_PAGE || (oldest != null && dayIn(Date.parse(oldest.created_at), timeZone) !== dayIn(now, timeZone));
  return { sessions, complete };
}

/** Sessions stopped at their cap that the viewer may approve more for, and whether they may manage agents. */
export async function loadCapped(viewer: User, slug: string): Promise<{ capped: AgentSession[]; canManage: boolean } | null> {
  const overview = await workspaceAgents.overview(slug, viewer).catch(warn("agents overview"));
  if (!overview?.ok) return null;
  return { capped: overview.value.waiting_on_you, canManage: overview.value.can_manage };
}

/** Today's spend from this month's statement. Null when billing did not answer. */
export async function loadSpend(viewer: User, slug: string, now: number): Promise<Spend | null> {
  const statement = await billing.statement(slug, viewer, null, "day").catch(warn("statement"));
  return statement?.ok ? spendToday(statement.value, now) : null;
}
