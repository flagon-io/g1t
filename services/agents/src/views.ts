/**
 * What Agents mode reads and changes beyond definitions: sessions, memory,
 * routines, spend, activity, versions and the workspace's agent policy.
 * Called by the RPC methods in index.ts once they know who is asking and
 * that they may see the workspace.
 *
 * Privacy follows the conversations work came from. A session, a reply or
 * a memory from a conversation the viewer is not in shows that it happened
 * and what it cost, never what it was about, owners included: owners
 * control money and agents, not other people's conversations.
 */
import {
  type AgentActivity,
  type AgentMemory,
  type AgentPolicy,
  type AgentRoutine,
  type AgentSession,
  type AgentSessionDetail,
  type AgentSpendBreakdown,
  type AgentVersion,
  type AgentsOverview,
  type AgentMemoryScope,
  type NewRoutine,
  type Result,
  type SessionEvent,
  type SpendSlice,
  type User,
  type WorkspaceAgent,
  chatClient,
  fail,
  newId,
  ok,
} from "@g1t/contracts";

import { monthKey } from "./budget.ts";
import { type MemoryRow, type MemoryViewer, changeableBy, cleanFact, toMemory, visibleTo } from "./memory.ts";
import { DEFAULT_POLICY, checkPolicy, readPolicy } from "./policy.ts";
import { type RoutineRow, MAX_ROUTINES, checkRoutine, newRoutineId, nextRun, runRoutine, toRoutine } from "./routines.ts";
import { type SessionEnv, type SessionRow, LIVE, approve, sessionRow, steer, stop, toSession } from "./sessions.ts";
import { type Row, periods, selectAgents, toAgent } from "./store.ts";

export type ViewContext = {
  env: SessionEnv;
  db: D1Database;
  slug: string;
  workspaceId: string;
  viewer: User;
  /** Whether the viewer owns the workspace (or is its token). */
  owner: boolean;
};

type AgentFace = { handle: string; display_name: string; avatar_seed: string; team: string | null; department: string };

/** The workspace's agents by id, archived ones too, for names on sessions and spend. */
async function faces(ctx: ViewContext): Promise<Map<string, AgentFace>> {
  const rows = await ctx.db
    .prepare("SELECT id, handle, display_name, avatar_seed, team, department FROM agents WHERE workspace_id = ?")
    .bind(ctx.workspaceId)
    .all<{ id: string } & AgentFace>();
  return new Map(rows.results.map((r) => [r.id, { ...r, avatar_seed: r.avatar_seed || r.handle }]));
}

/**
 * Which of these conversations the viewer is in (or can read: a public
 * channel). Asked of chat once per conversation, at most 60.
 */
async function readable(ctx: ViewContext, channelIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (ctx.viewer.kind === "workspace") return out;
  const chat = chatClient(ctx.env.CHAT);
  const ids = [...new Set(channelIds)].slice(0, 60);
  await Promise.all(
    ids.map(async (id) => {
      const audience = await chat.audience(ctx.slug, id).catch(() => null);
      if (audience?.ok && (audience.value.kind === "public" || audience.value.member_user_ids.includes(ctx.viewer.id))) out.add(id);
    }),
  );
  return out;
}

async function sessionsOut(ctx: ViewContext, rows: SessionRow[], agents?: Map<string, AgentFace>): Promise<AgentSession[]> {
  const names = agents ?? (await faces(ctx));
  const can = await readable(ctx, rows.map((r) => r.channel_id));
  return rows.map((row) => toSession(row, names.get(row.agent_id) ?? null, can.has(row.channel_id)));
}

async function agentByHandle(ctx: ViewContext, handle: string): Promise<Row | null> {
  return ctx.db
    .prepare("SELECT * FROM agents WHERE workspace_id = ? AND handle = ? AND archived_at IS NULL")
    .bind(ctx.workspaceId, String(handle ?? "").trim().replace(/^@/, "").toLowerCase())
    .first<Row>();
}

// ── Sessions ──────────────────────────────────────────────────────────────

export async function listSessions(ctx: ViewContext, filter: { handle?: string | null; status?: "live" | "done" | null; limit?: number | null }): Promise<Result<AgentSession[]>> {
  const limit = Math.min(200, Math.max(1, Math.floor(Number(filter.limit) || 50)));
  const where = ["workspace_id = ?"];
  const binds: (string | number)[] = [ctx.workspaceId];
  if (filter.handle) {
    const agent = await agentByHandle(ctx, filter.handle);
    if (!agent) return fail("not_found", `There is no agent called @${filter.handle}.`);
    where.push("agent_id = ?");
    binds.push(agent.id);
  }
  if (filter.status === "live") where.push(`status IN (${LIVE.map(() => "?").join(", ")})`), binds.push(...LIVE);
  if (filter.status === "done") where.push(`status NOT IN (${LIVE.map(() => "?").join(", ")})`), binds.push(...LIVE);
  const rows = await ctx.db
    .prepare(`SELECT * FROM agent_sessions WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<SessionRow>();
  return ok(await sessionsOut(ctx, rows.results));
}

export async function sessionDetail(ctx: ViewContext, id: string): Promise<Result<AgentSessionDetail>> {
  const row = await sessionRow(ctx.db, String(id ?? ""));
  if (!row || row.workspace_id !== ctx.workspaceId) return fail("not_found", "There is no such session.");
  const agents = await faces(ctx);
  const treeRows = await ctx.db.prepare("SELECT * FROM agent_sessions WHERE root_id = ? ORDER BY created_at LIMIT 100").bind(row.root_id).all<SessionRow>();
  const [session] = await sessionsOut(ctx, [row], agents);
  const tree = await sessionsOut(ctx, treeRows.results, agents);
  let events: SessionEvent[] = [];
  if (session.visible) {
    const rows = await ctx.db
      .prepare("SELECT seq, kind, by_name, body, tool, outcome, created_at FROM agent_session_events WHERE session_id = ? ORDER BY seq LIMIT 1000")
      .bind(row.id)
      .all<{ seq: number; kind: SessionEvent["kind"]; by_name: string | null; body: string; tool: string | null; outcome: string | null; created_at: string }>();
    events = rows.results.map((e) => ({ seq: e.seq, kind: e.kind, by: e.by_name, body: e.body, tool: e.tool, outcome: e.outcome, created_at: e.created_at }));
  }
  const live = LIVE.includes(row.status as (typeof LIVE)[number]);
  return ok({
    session,
    events,
    tree,
    can_stop: session.visible && live,
    can_steer: session.visible,
    can_approve: row.status === "needs_approval" && (ctx.owner || (session.visible && row.asked_by === ctx.viewer.id && ctx.owner)),
  });
}

async function visibleSession(ctx: ViewContext, id: string): Promise<Result<SessionRow>> {
  const row = await sessionRow(ctx.db, String(id ?? ""));
  if (!row || row.workspace_id !== ctx.workspaceId) return fail("not_found", "There is no such session.");
  const can = await readable(ctx, [row.channel_id]);
  if (!can.has(row.channel_id)) return fail("not_found", "There is no such session.");
  return ok(row);
}

export async function stopSession(ctx: ViewContext, id: string): Promise<Result<AgentSession>> {
  const found = await visibleSession(ctx, id);
  if (!found.ok) return found;
  if (!LIVE.includes(found.value.status as (typeof LIVE)[number])) return fail("invalid", "That session is already over.");
  const row = await stop(ctx.env, found.value, ctx.viewer.username);
  return ok((await sessionsOut(ctx, [row]))[0]);
}

export async function steerSession(ctx: ViewContext, id: string, body: string): Promise<Result<AgentSession>> {
  const found = await visibleSession(ctx, id);
  if (!found.ok) return found;
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) return fail("invalid", "Say something to the session.");
  const row = await steer(ctx.env, found.value, ctx.viewer.username, text.slice(0, 4000));
  return ok((await sessionsOut(ctx, [row]))[0]);
}

/** Owners raise a session's cap; it must end up above what it has spent. */
export async function approveSession(ctx: ViewContext, id: string, capMicros: number): Promise<Result<AgentSession>> {
  if (!ctx.owner) return fail("forbidden", "Only the workspace's owners can approve more spend.");
  const row = await sessionRow(ctx.db, String(id ?? ""));
  if (!row || row.workspace_id !== ctx.workspaceId) return fail("not_found", "There is no such session.");
  if (row.status !== "needs_approval") return fail("invalid", "That session isn't waiting for approval.");
  const cap = Math.floor(Number(capMicros));
  if (!Number.isFinite(cap) || cap <= row.charged_micros || cap > 1_000_000_000) return fail("invalid", "The new cap must be above what it has spent.");
  const fresh = await approve(ctx.env, row, ctx.viewer.username, cap);
  return ok((await sessionsOut(ctx, [fresh]))[0]);
}

// ── Memory ────────────────────────────────────────────────────────────────

async function memoryViewer(ctx: ViewContext, rows: MemoryRow[]): Promise<MemoryViewer> {
  const channels = await readable(ctx, rows.filter((r) => r.scope === "channel").map((r) => r.scope_ref));
  return { id: ctx.viewer.id, owner: ctx.owner, inChannel: (id) => channels.has(id) };
}

export async function memories(ctx: ViewContext, handle: string): Promise<Result<AgentMemory[]>> {
  const agent = await agentByHandle(ctx, handle);
  if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
  const rows = await ctx.db.prepare("SELECT * FROM agent_memories WHERE agent_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT 500").bind(agent.id).all<MemoryRow>();
  const viewer = await memoryViewer(ctx, rows.results);
  return ok(rows.results.filter((row) => visibleTo(row, viewer)).map(toMemory));
}

/**
 * A fact a person gives an agent. Workspace facts are the owners'; a
 * channel fact needs the person to be in that channel; a person fact is
 * always their own.
 */
export async function remember(ctx: ViewContext, handle: string, input: { body: string; scope: AgentMemoryScope; scope_ref?: string | null }): Promise<Result<AgentMemory>> {
  const agent = await agentByHandle(ctx, handle);
  if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
  const body = cleanFact(input?.body);
  if (!body) return fail("invalid", "Say what it should remember.");
  let scope: AgentMemoryScope = input?.scope === "workspace" || input?.scope === "channel" ? input.scope : "person";
  let ref = "";
  let label: string | null = null;
  if (scope === "workspace" && !ctx.owner) return fail("forbidden", "Only owners give an agent facts for the whole workspace.");
  if (scope === "channel") {
    ref = String(input.scope_ref ?? "");
    const can = await readable(ctx, [ref]);
    if (!can.has(ref)) return fail("forbidden", "You can only give it facts for conversations you're in.");
    const audience = await chatClient(ctx.env.CHAT).audience(ctx.slug, ref).catch(() => null);
    label = audience?.ok && "name" in audience.value ? ((audience.value as { name?: string | null }).name ?? null) : null;
  }
  if (scope === "person") {
    scope = "person";
    ref = ctx.viewer.id;
    label = ctx.viewer.username;
  }
  const id = newId("mem");
  const now = new Date().toISOString();
  await ctx.db
    .prepare(
      `INSERT INTO agent_memories (id, agent_id, workspace_id, scope, scope_ref, scope_label, body, source_kind, source_ref, source_label, created_by, created_by_kind, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'person', ?, ?, ?, 'user', 1, ?, ?)`,
    )
    .bind(id, agent.id, ctx.workspaceId, scope, ref, label, body, ctx.viewer.username, `@${ctx.viewer.username}`, ctx.viewer.username, now, now)
    .run();
  const row = await ctx.db.prepare("SELECT * FROM agent_memories WHERE id = ?").bind(id).first<MemoryRow>();
  return ok(toMemory(row!));
}

async function changeable(ctx: ViewContext, handle: string, id: string): Promise<Result<MemoryRow>> {
  const agent = await agentByHandle(ctx, handle);
  if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
  const row = await ctx.db.prepare("SELECT * FROM agent_memories WHERE id = ? AND agent_id = ?").bind(String(id ?? ""), agent.id).first<MemoryRow>();
  if (!row) return fail("not_found", "There is no such memory.");
  const viewer = await memoryViewer(ctx, [row]);
  if (!visibleTo(row, viewer)) return fail("not_found", "There is no such memory.");
  if (!changeableBy(row, viewer)) return fail("forbidden", "Only owners change what an agent knows for the whole workspace.");
  return ok(row);
}

export async function updateMemory(ctx: ViewContext, handle: string, id: string, changes: { body?: string; pinned?: boolean }): Promise<Result<AgentMemory>> {
  const found = await changeable(ctx, handle, id);
  if (!found.ok) return found;
  const body = changes?.body === undefined ? found.value.body : cleanFact(changes.body);
  if (!body) return fail("invalid", "A memory can't be empty; forget it instead.");
  const pinned = changes?.pinned === undefined ? found.value.pinned : changes.pinned ? 1 : 0;
  const now = new Date().toISOString();
  const edited = body !== found.value.body;
  await ctx.db
    .prepare(
      `UPDATE agent_memories SET body = ?, pinned = ?, updated_at = ?${edited ? ", source_kind = 'person', source_ref = ?, source_label = ?" : ""} WHERE id = ?`,
    )
    .bind(...(edited ? [body, pinned, now, ctx.viewer.username, `@${ctx.viewer.username} (corrected)`, found.value.id] : [body, pinned, now, found.value.id]))
    .run();
  const row = await ctx.db.prepare("SELECT * FROM agent_memories WHERE id = ?").bind(found.value.id).first<MemoryRow>();
  return ok(toMemory(row!));
}

export async function forget(ctx: ViewContext, handle: string, id: string): Promise<Result<null>> {
  const found = await changeable(ctx, handle, id);
  if (!found.ok) return found;
  await ctx.db.prepare("DELETE FROM agent_memories WHERE id = ?").bind(found.value.id).run();
  return ok(null);
}

// ── Routines ──────────────────────────────────────────────────────────────

export async function routines(ctx: ViewContext, handle: string): Promise<Result<AgentRoutine[]>> {
  const agent = await agentByHandle(ctx, handle);
  if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
  const rows = await ctx.db.prepare("SELECT * FROM agent_routines WHERE agent_id = ? ORDER BY created_at").bind(agent.id).all<RoutineRow>();
  return ok(rows.results.map(toRoutine));
}

/**
 * Owners keep an agent's routines. The person who saves one becomes its
 * sponsor: it runs with their access, in a channel they and the agent are in.
 */
export async function saveRoutine(ctx: ViewContext, handle: string, input: NewRoutine, id: string | null): Promise<Result<AgentRoutine>> {
  if (!ctx.owner) return fail("forbidden", "Only the workspace's owners set up routines.");
  if (ctx.viewer.kind === "workspace") return fail("invalid", "A routine runs with a person's access: set it up signed in as yourself.");
  const agent = await agentByHandle(ctx, handle);
  if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
  const checked = checkRoutine(input);
  if (!checked.ok) return fail("invalid", checked.message);
  const r = checked.value;
  const audience = await chatClient(ctx.env.CHAT).audience(ctx.slug, r.channel_id).catch(() => null);
  if (!audience?.ok || (audience.value.kind !== "public" && !audience.value.member_user_ids.includes(ctx.viewer.id))) {
    return fail("invalid", "Choose a channel you're in.");
  }
  const channels = await chatClient(ctx.env.CHAT).sidebar(ctx.slug, ctx.viewer).catch(() => null);
  const channelName = channels?.ok ? (channelNameIn(channels.value, r.channel_id) ?? null) : null;
  const now = new Date();
  const next = r.enabled !== false ? nextRun(r.schedule, now).toISOString() : null;
  if (id) {
    const existing = await ctx.db.prepare("SELECT id FROM agent_routines WHERE id = ? AND agent_id = ?").bind(id, agent.id).first();
    if (!existing) return fail("not_found", "There is no such routine.");
    await ctx.db
      .prepare(
        `UPDATE agent_routines SET name = ?, instructions = ?, schedule = ?, channel_id = ?, channel_name = ?, sponsor = ?, sponsor_username = ?,
           enabled = ?, paused_note = NULL, next_run_at = ?, workspace = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(r.name, r.instructions, JSON.stringify(r.schedule), r.channel_id, channelName, ctx.viewer.id, ctx.viewer.username, r.enabled !== false ? 1 : 0, next, ctx.slug, now.toISOString(), id)
      .run();
  } else {
    const count = await ctx.db.prepare("SELECT COUNT(*) AS n FROM agent_routines WHERE agent_id = ?").bind(agent.id).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_ROUTINES) return fail("invalid", `An agent keeps at most ${MAX_ROUTINES} routines.`);
    id = newRoutineId();
    await ctx.db
      .prepare(
        `INSERT INTO agent_routines (id, agent_id, workspace_id, workspace, name, instructions, schedule, channel_id, channel_name, sponsor, sponsor_username, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, agent.id, ctx.workspaceId, ctx.slug, r.name, r.instructions, JSON.stringify(r.schedule), r.channel_id, channelName, ctx.viewer.id, ctx.viewer.username, r.enabled !== false ? 1 : 0, next, now.toISOString(), now.toISOString())
      .run();
  }
  const row = await ctx.db.prepare("SELECT * FROM agent_routines WHERE id = ?").bind(id).first<RoutineRow>();
  return ok(toRoutine(row!));
}

function channelNameIn(sidebar: unknown, id: string): string | null {
  const seen: unknown[] = [sidebar];
  while (seen.length) {
    const value = seen.pop();
    if (Array.isArray(value)) seen.push(...value);
    else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (v.id === id && typeof v.name === "string") return v.name;
      seen.push(...Object.values(v));
    }
  }
  return null;
}

export async function deleteRoutine(ctx: ViewContext, handle: string, id: string): Promise<Result<null>> {
  if (!ctx.owner) return fail("forbidden", "Only the workspace's owners change routines.");
  const agent = await agentByHandle(ctx, handle);
  if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
  await ctx.db.prepare("DELETE FROM agent_routines WHERE id = ? AND agent_id = ?").bind(String(id ?? ""), agent.id).run();
  return ok(null);
}

export async function runRoutineNow(ctx: ViewContext, handle: string, id: string): Promise<Result<AgentSession>> {
  if (!ctx.owner) return fail("forbidden", "Only the workspace's owners run routines by hand.");
  const agent = await agentByHandle(ctx, handle);
  if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
  const routine = await ctx.db.prepare("SELECT * FROM agent_routines WHERE id = ? AND agent_id = ?").bind(String(id ?? ""), agent.id).first<RoutineRow>();
  if (!routine) return fail("not_found", "There is no such routine.");
  const ran = await runRoutine(ctx.env, routine, agent, ctx.slug);
  if (!ran.ok) return fail("invalid", ran.message);
  const row = await sessionRow(ctx.db, ran.session);
  return ok((await sessionsOut(ctx, [row!]))[0]);
}

// ── Spend ─────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = { reply: "Chat replies", chat: "Sessions", routine: "Routines", helper: "Helping colleagues", subagent: "Subagents" };

function slices(rows: { key: string | null; micros: number; n: number }[], label: (key: string) => string): SpendSlice[] {
  return rows
    .filter((r) => r.micros > 0 || r.n > 0)
    .map((r) => ({ key: r.key ?? "", label: label(r.key ?? ""), micros: r.micros, count: r.n }))
    .sort((a, b) => b.micros - a.micros);
}

/**
 * Where the month went, for one agent (what it was paid for: its replies and
 * every session it paid for, colleagues' help included) or for every agent.
 */
export async function spend(ctx: ViewContext, handle: string | null): Promise<Result<AgentSpendBreakdown>> {
  const now = new Date();
  const month = monthKey(now);
  const from = `${month}-01T00:00:00.000Z`;
  let agentId: string | null = null;
  if (handle) {
    const agent = await agentByHandle(ctx, handle);
    if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
    agentId = agent.id;
  }
  const db = ctx.db;
  const rFilter = agentId ? "agent_id = ?2" : "workspace_id = ?2";
  const sFilter = agentId ? "payer_agent_id = ?2" : "workspace_id = ?2";
  const scope = agentId ?? ctx.workspaceId;
  const union = `SELECT 'reply' AS kind, agent_id AS agent, asked_by_username AS person, model, charged_micros AS micros, substr(created_at, 1, 10) AS day FROM agent_replies WHERE ${rFilter} AND created_at >= ?1
     UNION ALL SELECT kind, payer_agent_id AS agent, asked_by_username AS person, model, charged_micros AS micros, substr(created_at, 1, 10) AS day FROM agent_sessions WHERE ${sFilter} AND created_at >= ?1 AND parent_id IS NULL
     UNION ALL SELECT kind, payer_agent_id AS agent, asked_by_username AS person, model, 0 AS micros, substr(created_at, 1, 10) AS day FROM agent_sessions WHERE ${sFilter} AND created_at >= ?1 AND parent_id IS NOT NULL`;
  // A child's spend is already counted on its root (sessions.ts), so children add counts, not money.
  const group = (column: string) =>
    db.prepare(`SELECT ${column} AS key, COALESCE(SUM(micros), 0) AS micros, COUNT(*) AS n FROM (${union}) GROUP BY ${column}`).bind(from, scope).all<{ key: string | null; micros: number; n: number }>();
  const [byKind, byModel, byPerson, byAgent, byDay, top, agents] = await Promise.all([
    group("kind"),
    group("model"),
    group("person"),
    group("agent"),
    group("day"),
    db.prepare(`SELECT * FROM agent_sessions WHERE ${sFilter} AND created_at >= ?1 AND parent_id IS NULL ORDER BY charged_micros DESC LIMIT 8`).bind(from, scope).all<SessionRow>(),
    faces(ctx),
  ]);
  const byTeamMap = new Map<string, SpendSlice>();
  for (const row of byAgent.results) {
    const face = agents.get(row.key ?? "");
    const team = face?.team || face?.department || "No team";
    const slice = byTeamMap.get(team) ?? { key: team, label: team, micros: 0, count: 0 };
    slice.micros += row.micros;
    slice.count += row.n;
    byTeamMap.set(team, slice);
  }
  const total = byKind.results.reduce((n, r) => n + r.micros, 0);
  return ok({
    period: month,
    total_micros: total,
    by_kind: slices(byKind.results, (k) => KIND_LABELS[k] ?? k),
    by_model: slices(byModel.results, (k) => k || "No model"),
    by_person: slices(byPerson.results, (k) => (k ? `@${k}` : "Routines and agents")),
    by_agent: slices(byAgent.results, (k) => {
      const face = agents.get(k);
      return face ? `${face.display_name} (@${face.handle})` : "An archived agent";
    }),
    by_team: [...byTeamMap.values()].sort((a, b) => b.micros - a.micros),
    top_sessions: await sessionsOut(ctx, top.results, agents),
    days: byDay.results.map((r) => ({ day: r.key ?? "", micros: r.micros })).sort((a, b) => a.day.localeCompare(b.day)),
  });
}

// ── Activity and versions ────────────────────────────────────────────────

export async function activity(ctx: ViewContext, handle: string): Promise<Result<AgentActivity[]>> {
  const agent = await agentByHandle(ctx, handle);
  if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
  const [replies, sessions] = await Promise.all([
    ctx.db
      .prepare(
        "SELECT id, status, channel_id, channel_name, asked_by_username, model, tool_count, charged_micros, created_at, reply_id FROM agent_replies WHERE agent_id = ? ORDER BY created_at DESC LIMIT 60",
      )
      .bind(agent.id)
      .all<{ id: string; status: string; channel_id: string; channel_name: string | null; asked_by_username: string | null; model: string | null; tool_count: number | null; charged_micros: number; created_at: string; reply_id: string | null }>(),
    ctx.db.prepare("SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 40").bind(agent.id).all<SessionRow>(),
  ]);
  const can = await readable(ctx, [...replies.results.map((r) => r.channel_id), ...sessions.results.map((s) => s.channel_id)]);
  const items: AgentActivity[] = [
    ...replies.results.map((r) => {
      const visible = can.has(r.channel_id);
      return {
        id: r.id,
        kind: "reply" as const,
        status: r.status,
        channel_id: r.channel_id,
        channel_name: visible ? r.channel_name : null,
        title: null,
        asked_by_username: visible ? r.asked_by_username : null,
        model: r.model,
        tools: r.tool_count ?? 0,
        charged_micros: r.charged_micros,
        created_at: r.created_at,
        visible,
        ref: visible ? r.reply_id : null,
      };
    }),
    ...sessions.results.map((s) => {
      const visible = can.has(s.channel_id);
      return {
        id: s.id,
        kind: "session" as const,
        status: s.status,
        channel_id: s.channel_id,
        channel_name: visible ? s.channel_name : null,
        title: visible ? s.title : null,
        asked_by_username: visible ? s.asked_by_username : null,
        model: s.model,
        tools: s.tool_calls,
        charged_micros: s.charged_micros,
        created_at: s.created_at,
        visible,
        ref: s.id,
      };
    }),
  ];
  return ok(items.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 80));
}

export async function versions(ctx: ViewContext, handle: string): Promise<Result<AgentVersion[]>> {
  const agent = await agentByHandle(ctx, handle);
  if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
  const rows = await ctx.db
    .prepare("SELECT version, definition, changed_by, created_at FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 50")
    .bind(agent.id)
    .all<{ version: number; definition: string; changed_by: string; created_at: string }>();
  return ok(
    rows.results.map((r) => {
      let definition = {};
      try {
        definition = JSON.parse(r.definition);
      } catch {
        // An unreadable old version shows as empty.
      }
      return { version: r.version, changed_by: r.changed_by, created_at: r.created_at, definition };
    }),
  );
}

// ── Policy and overview ──────────────────────────────────────────────────

export async function policy(ctx: ViewContext): Promise<Result<AgentPolicy>> {
  const row = await readPolicy(ctx.db, ctx.workspaceId, monthKey(new Date()));
  return ok({ monthly_micros: row.monthly_micros, default_agent_monthly_micros: row.default_agent_monthly_micros, default_session_micros: row.default_session_micros });
}

export async function setPolicy(ctx: ViewContext, changes: Partial<AgentPolicy>): Promise<Result<AgentPolicy>> {
  if (!ctx.owner) return fail("forbidden", "Only the workspace's owners set its agents' budget.");
  const current = await policy(ctx);
  const checked = checkPolicy(current.ok ? current.value : DEFAULT_POLICY, changes ?? {});
  if (!checked.ok) return fail("invalid", checked.message);
  const p = checked.value;
  await ctx.db
    .prepare(
      `INSERT INTO agent_policies (workspace_id, monthly_micros, default_agent_monthly_micros, default_session_micros, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (workspace_id) DO UPDATE SET monthly_micros = ?2, default_agent_monthly_micros = ?3, default_session_micros = ?4, updated_by = ?5, updated_at = ?6`,
    )
    .bind(ctx.workspaceId, p.monthly_micros, p.default_agent_monthly_micros, p.default_session_micros, ctx.viewer.username, new Date().toISOString())
    .run();
  return ok(p);
}

export async function overview(ctx: ViewContext): Promise<Result<AgentsOverview>> {
  const now = new Date();
  const db = ctx.db;
  const [rows, policyRow, live, recent, upcoming, breakdown, agentFaces] = await Promise.all([
    db.prepare(`${selectAgents("a.workspace_id = ?3 AND a.archived_at IS NULL")} ORDER BY a.builtin DESC, a.handle`).bind(...periods(now), ctx.workspaceId).all<Row>(),
    readPolicy(db, ctx.workspaceId, monthKey(now)),
    db
      .prepare(`SELECT * FROM agent_sessions WHERE workspace_id = ? AND status IN (${LIVE.map(() => "?").join(", ")}) ORDER BY created_at DESC LIMIT 60`)
      .bind(ctx.workspaceId, ...LIVE)
      .all<SessionRow>(),
    db
      .prepare(`SELECT * FROM agent_sessions WHERE workspace_id = ? AND parent_id IS NULL AND status IN ('done','failed','stopped') ORDER BY finished_at DESC LIMIT 12`)
      .bind(ctx.workspaceId)
      .all<SessionRow>(),
    db.prepare("SELECT * FROM agent_routines WHERE workspace_id = ? AND enabled = 1 AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 6").bind(ctx.workspaceId).all<RoutineRow>(),
    spend(ctx, null),
    faces(ctx),
  ]);
  const agents: WorkspaceAgent[] = rows.results.map((row) => toAgent(row, now));
  const liveSessions = await sessionsOut(ctx, live.results, agentFaces);
  const liveByAgent: Record<string, number> = {};
  for (const s of live.results) liveByAgent[s.agent_id] = (liveByAgent[s.agent_id] ?? 0) + 1;
  const level = policyRow.monthly_micros ? [100, 90, 75].find((l) => (policyRow.spent * 100) / policyRow.monthly_micros! >= l) ?? null : null;
  return ok({
    policy: { monthly_micros: policyRow.monthly_micros, default_agent_monthly_micros: policyRow.default_agent_monthly_micros, default_session_micros: policyRow.default_session_micros },
    spent_month_micros: policyRow.spent,
    alert: level,
    agents,
    live_by_agent: liveByAgent,
    live: liveSessions.filter((s) => s.visible && !s.parent_id).slice(0, 20),
    waiting_on_you: ctx.owner ? liveSessions.filter((s) => s.status === "needs_approval") : liveSessions.filter((s) => s.status === "needs_approval" && s.visible && s.asked_by === ctx.viewer.id),
    recent: (await sessionsOut(ctx, recent.results, agentFaces)).filter((s) => s.visible).slice(0, 8),
    upcoming: upcoming.results.map((r) => {
      const face = agentFaces.get(r.agent_id);
      return { ...toRoutine(r), agent_handle: face?.handle ?? "agent", agent_name: face?.display_name ?? "An agent" };
    }),
    spend: breakdown.ok ? breakdown.value : { period: monthKey(now), total_micros: 0, by_kind: [], by_model: [], by_person: [], by_agent: [], by_team: [], top_sessions: [], days: [] },
    can_manage: ctx.owner,
  });
}
