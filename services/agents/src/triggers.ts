/**
 * Routines that run when something happens
 * (docs.g1t.sh/guides/agent-routines/, "When something happens"): the
 * events service sends this service the events routines can run on
 * (`SUBSCRIBER_AGENTS`, crates/contracts subscribers.rs), and each matching
 * routine runs once for the one thing that happened.
 *
 * - **Which routines:** enabled ones in the event's workspace that run on
 *   its kind, and follow its repository (or every repository).
 * - **Whose access:** the routine's sponsor must be able to read the
 *   repository; otherwise the routine never hears of it, and nothing says
 *   it happened.
 * - **Once:** each routine runs once per pull request ready for review or
 *   merged, issue opened, deploy failed, and per commit whose checks fail.
 * - **Not too often:** at most `MAX_RUNS_PER_HOUR` runs per routine, so a
 *   burst of events can't run up its agent's budget; the rest are skipped.
 */
import { type G1tEvent, type User, identityClient, reposClient, workClient } from "@g1t/contracts";

import { type RoutineOccasion, type RoutineRow, eventsOf, runRoutine } from "./routines.ts";
import type { SessionEnv } from "./sessions.ts";
import type { Row } from "./store.ts";
import { type Happened, follows, happened } from "./happened.ts";

export { follows, happened } from "./happened.ts";

export const MAX_RUNS_PER_HOUR = 20;

/**
 * What happened, as the routine's session is told it, read as its sponsor:
 * a draft pull request is not ready for review, so it is nothing yet.
 */
async function occasionFor(env: SessionEnv, what: Happened, repo: { namespace: string; name: string }, sponsor: User): Promise<RoutineOccasion | null> {
  const full = `${repo.namespace}/${repo.name}`;
  const work = workClient(env.WORK);
  if (what.kind === "pull_ready" || what.kind === "pull_merged" || what.kind === "checks_failed") {
    const pull = await work.getPull(repo, what.number!, sponsor).catch(() => null);
    if (!pull?.ok) return null;
    if (what.kind === "pull_ready" && pull.value.pull.status !== "open") return null;
    const title = pull.value.pull.title;
    const href = `/${full}/pull/${what.number}`;
    const line =
      what.kind === "pull_ready"
        ? `pull request ${full}#${what.number} is ready for review: ${title}`
        : what.kind === "pull_merged"
          ? `pull request ${full}#${what.number} was merged: ${title}`
          : `checks failed on pull request ${full}#${what.number} (${title}) at ${String(what.data.commit ?? "").slice(0, 8)}`;
    return { what: line, href, repo_id: what.repoId };
  }
  if (what.kind === "issue_opened") {
    const title = typeof what.data.title === "string" ? what.data.title : `#${what.number}`;
    return { what: `issue ${full}#${what.number} was opened: ${title}`, href: `/${full}/issues/${what.number}`, repo_id: what.repoId };
  }
  const project = typeof what.data.project === "string" ? what.data.project : full;
  const kind = what.data.kind === "preview" ? "preview" : "production";
  const branch = typeof what.data.branch === "string" ? ` of ${what.data.branch}` : "";
  return { what: `a ${kind} deploy${branch} of ${project} failed`, href: null, repo_id: what.repoId };
}

/** Runs every routine an event is for. Never throws for one routine's sake. */
export async function onEvents(env: SessionEnv, events: G1tEvent[], now = new Date()): Promise<number> {
  const db = env.DB;
  let ran = 0;
  for (const event of events) {
    const what = happened(event);
    if (!what) continue;
    const routines = await db
      .prepare("SELECT * FROM agent_routines WHERE enabled = 1 AND events LIKE ? LIMIT 200")
      .bind(`%"${what.kind}"%`)
      .all<RoutineRow>();
    for (const routine of routines.results) {
      if (!eventsOf(routine).includes(what.kind)) continue;
      try {
        if (await runFor(env, routine, what, now)) ran++;
      } catch (error) {
        console.error("agents: a routine didn't run on an event", routine.id, event.type, String(error));
      }
    }
  }
  return ran;
}

async function runFor(env: SessionEnv, routine: RoutineRow, what: Happened, now: Date): Promise<boolean> {
  const db = env.DB;
  const [sponsor] = await identityClient(env.IDENTITY)
    .usersForAudience([routine.sponsor])
    .catch(() => [] as User[]);
  if (!sponsor) return false;
  // The repository, as the sponsor can read it, in the routine's own workspace.
  const [repo] = await reposClient(env.REPOS)
    .readable([what.repoId], sponsor)
    .catch(() => []);
  if (!repo || repo.namespace.toLowerCase() !== routine.workspace.toLowerCase()) return false;
  let repos: string[] = [];
  try {
    repos = JSON.parse(routine.repos || "[]") as string[];
  } catch {
    repos = [];
  }
  if (!follows(repos, `${repo.namespace}/${repo.name}`)) return false;
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM agent_routine_runs WHERE routine_id = ? AND created_at > ?").bind(routine.id, hourAgo).first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_RUNS_PER_HOUR) return false;
  const occasion = await occasionFor(env, what, repo, sponsor);
  if (!occasion) return false;
  // Once per thing that happened, however often it is told.
  const claimed = await db
    .prepare("INSERT INTO agent_routine_runs (routine_id, run_key, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING routine_id")
    .bind(routine.id, what.key, now.toISOString())
    .first();
  if (!claimed) return false;
  const agent = await db.prepare("SELECT * FROM agents WHERE id = ? AND archived_at IS NULL").bind(routine.agent_id).first<Row>();
  if (!agent) return false;
  const result = await runRoutine(env, routine, agent, routine.workspace, now, occasion);
  if (result.ok) {
    await db.prepare("UPDATE agent_routine_runs SET session_id = ? WHERE routine_id = ? AND run_key = ?").bind(result.session, routine.id, what.key).run();
  }
  return result.ok;
}
