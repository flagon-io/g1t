/**
 * Routines (docs.g1t.sh/guides/agent-routines/): work an agent does on a
 * schedule, such as Sam's Monday digest of support themes or Bruno's
 * morning look at failed deploys. Each run is a session in the routine's
 * channel, paid from the agent's budget, with the access of the person who
 * set it up (its sponsor), never more: if the sponsor leaves the workspace
 * or can no longer read the channel, the routine pauses and says why.
 *
 * The schedule is in UTC, every hour, day, weekday or week, at a minute
 * (and hour, and day). `nextRun` is pure, so it is tested on its own.
 */
import { type AgentRoutine, type RoutineEvent, type RoutineSchedule, askerAccess, chatClient, identityClient, newId } from "@g1t/contracts";

import { type SessionEnv, startSession } from "./sessions.ts";
import { checkSchedule, describeSchedule, nextRun } from "./schedule.ts";
import { EVENT_KEYS, describeEvents } from "./suggest.ts";

export { checkRoutine, checkSchedule, describeSchedule, nextRun } from "./schedule.ts";
import type { Row } from "./store.ts";

/** Routines one agent may keep. */
export const MAX_ROUTINES = 25;

export type RoutineRow = {
  id: string;
  agent_id: string;
  workspace_id: string;
  /** The workspace's slug, for posting and billing. */
  workspace: string;
  name: string;
  instructions: string;
  schedule: string | null;
  events: string;
  repos: string;
  channel_id: string;
  channel_name: string | null;
  sponsor: string;
  sponsor_username: string | null;
  enabled: number;
  paused_note: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_session_id: string | null;
  runs: number;
  created_at: string;
  updated_at: string;
};

function list<T>(raw: string | null): T[] {
  try {
    const value = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

export function scheduleOf(row: Pick<RoutineRow, "schedule">): RoutineSchedule | null {
  if (!row.schedule) return null;
  try {
    const checked = checkSchedule(JSON.parse(row.schedule));
    return checked.ok ? checked.value : null;
  } catch {
    return null;
  }
}

export function eventsOf(row: Pick<RoutineRow, "events">): RoutineEvent[] {
  return list<RoutineEvent>(row.events).filter((e) => EVENT_KEYS.includes(e));
}

export function toRoutine(row: RoutineRow): AgentRoutine {
  const schedule = scheduleOf(row);
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    instructions: row.instructions,
    schedule,
    events: eventsOf(row),
    repos: list<string>(row.repos),
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    sponsor: row.sponsor,
    sponsor_username: row.sponsor_username,
    enabled: !!row.enabled,
    paused_note: row.paused_note,
    next_run_at: row.enabled ? row.next_run_at : null,
    last_run_at: row.last_run_at,
    last_session_id: row.last_session_id,
    runs: row.runs,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Pauses a routine and says why, on its page. */
async function pause(db: D1Database, id: string, note: string): Promise<void> {
  await db.prepare("UPDATE agent_routines SET enabled = 0, paused_note = ?, updated_at = ? WHERE id = ?").bind(note, new Date().toISOString(), id).run();
}

/**
 * Runs one routine now, as a session: checks its sponsor may still read its
 * channel and that the agent is still in it, then starts the session and
 * moves its next run on. Returns the session's id, or why it couldn't.
 */
export type RoutineOccasion = {
  /** What happened, in a line, and where: "Pull request acme/web#12 is ready for review: Fix CSV export". */
  what: string;
  /** Where to read more, relative to the site. */
  href: string | null;
  /** The repository it happened in, by id, which the sponsor must be able to read. */
  repo_id: string;
};

export async function runRoutine(
  env: SessionEnv,
  routine: RoutineRow,
  agent: Row,
  workspace: string,
  now = new Date(),
  occasion: RoutineOccasion | null = null,
): Promise<{ ok: true; session: string } | { ok: false; message: string }> {
  const db = env.DB;
  const [sponsor] = await identityClient(env.IDENTITY)
    .usersForAudience([routine.sponsor])
    .catch(() => []);
  const membership = sponsor?.workspaces?.find((m) => m.slug.toLowerCase() === workspace.toLowerCase());
  if (!sponsor || !membership) {
    await pause(db, routine.id, "Paused: the person who set it up is no longer in the workspace. Anyone who can manage the agent can take it over by saving it.");
    return { ok: false, message: "Its sponsor is no longer in the workspace." };
  }
  const audience = await chatClient(env.CHAT).audience(workspace, routine.channel_id);
  if (!audience.ok) {
    await pause(db, routine.id, "Paused: its channel is gone, or the agent is no longer in it.");
    return { ok: false, message: "Its channel can't be read." };
  }
  if (audience.value.kind !== "public" && !audience.value.member_user_ids.includes(sponsor.id)) {
    await pause(db, routine.id, `Paused: @${sponsor.username} is no longer in its channel.`);
    return { ok: false, message: "Its sponsor is no longer in its channel." };
  }
  const schedule = scheduleOf(routine);
  // A scheduled run moves the clock on first, so a slow start never runs it twice; an event's run leaves it.
  const next = occasion ? routine.next_run_at : schedule ? nextRun(schedule, now).toISOString() : null;
  await db
    .prepare("UPDATE agent_routines SET next_run_at = ?, last_run_at = ?, runs = runs + 1, updated_at = ? WHERE id = ?")
    .bind(next, now.toISOString(), now.toISOString(), routine.id)
    .run();
  const when = [schedule ? describeSchedule(schedule) : null, describeEvents(eventsOf(routine)) || null].filter(Boolean).join("; ");
  const session = await startSession(env, {
    agent,
    kind: "routine",
    title: occasion ? `${routine.name}: ${occasion.what}`.slice(0, 120) : routine.name,
    goal: [
      `This is your routine "${routine.name}" (${when || "run by hand"}), set up by @${sponsor.username}. Post its report for #${routine.channel_name ?? "the channel"}.`,
      occasion ? `It runs now because: ${occasion.what}${occasion.href ? ` (${occasion.href})` : ""}. Work on that one thing.` : "",
      routine.instructions,
    ]
      .filter(Boolean)
      .join("\n\n"),
    workspace,
    channel_id: routine.channel_id,
    channel_kind: audience.value.kind === "dm" ? "dm" : "channel",
    channel_name: routine.channel_name,
    thread_root: null,
    message_id: null,
    asked_by: sponsor.id,
    asked_by_username: sponsor.username,
    asker: askerAccess(sponsor, workspace),
    routine_id: routine.id,
    chain: [],
    hops: 0,
  });
  await db.prepare("UPDATE agent_routines SET last_session_id = ? WHERE id = ?").bind(session.id, routine.id).run();
  return { ok: true, session: session.id };
}

/** Every routine due now, run. For the cron trigger, every few minutes. */
export async function runDue(env: SessionEnv, now = new Date()): Promise<number> {
  const db = env.DB;
  const due = await db
    .prepare("SELECT * FROM agent_routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 25")
    .bind(now.toISOString())
    .all<RoutineRow>();
  let ran = 0;
  for (const routine of due.results) {
    const agent = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(routine.agent_id).first<Row>();
    if (!agent || agent.archived_at) {
      await pause(db, routine.id, "Paused: its agent was archived.");
      continue;
    }
    const slug = routine.workspace;
    if (!slug) continue;
    const result = await runRoutine(env, routine, agent, slug, now).catch((error: unknown) => ({ ok: false as const, message: String(error) }));
    if (result.ok) ran++;
    else console.error("agents: a routine did not run", routine.id, result.message);
  }
  return ran;
}

export function newRoutineId(): string {
  return newId("rtn");
}
