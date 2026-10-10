/**
 * Sessions (docs.g1t.sh/guides/agent-sessions/): the work an agent spins off
 * from a conversation, a routine's run, or its part in another session.
 *
 * A conversation with an agent is never one long context. Replies read the
 * last few messages, what the agent remembers, and its recent sessions in
 * that conversation. Real work happens in a session:
 *
 * - **Bounded.** A session has a goal, its own working context of turns
 *   (compacted as it grows: the goal, a summary of earlier steps, and the
 *   latest turns), a step limit and a spend cap.
 * - **Visible.** It posts a live card where it was asked, updates the card
 *   in place as it works, posts progress in the card's thread, and reports
 *   back in the conversation when done. Its page has the full transcript.
 * - **Steerable.** A reply in the card's thread, or from its page, reaches
 *   it at its next step, or wakes it again once it is done.
 * - **A tree.** It can hand parts to its subagents or bring colleagues in;
 *   each is a child session whose result comes back to it. Everything in
 *   the tree is paid by the agent at the root, within the root's cap.
 * - **Stoppable.** Anyone who can see it can stop it and everything under it.
 *
 * Each step runs on the agent's desk (desk.ts) through `metered` (meter.ts),
 * so a step is billed, capped and recorded exactly as a reply is.
 */
import {
  type AgentLook,
  type AgentRef,
  type AgentSession,
  type AgentSessionKind,
  type AgentSessionStatus,
  type AskerAccess,
  type MessageCard,
  type ModelTier,
  type ServiceBinding,
  type SessionEvent,
  type SessionOutput,
  type SubagentDef,
  type User,
  chatClient,
  identityClient,
  agentRef,
  newId,
  workClient,
} from "@g1t/contracts";

import { readLook } from "../../../packages/contracts/src/agent-look.ts";
import { CHAT_MAX_HOPS } from "../../../packages/contracts/src/chat.ts";
import { Audience } from "./audience.ts";
import { type MeterEnv, metered } from "./meter.ts";
import { type RecallPlace, MAX_FACTS, cleanFact, memorySection, recall, scopeFor } from "./memory.ts";
import { readPolicy } from "./policy.ts";
import { type PortsEnv, audiencePorts, loadTeams, teamsOfAgents, toolPorts } from "./ports.ts";
import { systemPrompt } from "./prompt.ts";
import { loadShelf, skillsSection, teamSlugs } from "./skills.ts";
import { readVersion } from "./skill-library.ts";
import { conversationFrom } from "./surface.ts";
import { type Row, definitionOf, periods } from "./store.ts";
import { abilitiesFor, abilitiesSection, abilityPorts, pendingRequests, saidText } from "./abilities.ts";
import { type ActionPorts, type ToolCall, ToolBox } from "./tools.ts";
import { type ModelMessage, SESSION_LIMITS, runTurn } from "./turn.ts";
import { effortOf, effortPlan, higherEffort, isLevel } from "./routing.ts";
import { recallQuery, recallSection } from "./recall.ts";
import { rosterLines } from "./orchestrator.ts";
import { teamsSection } from "./teammates.ts";
import { dollars } from "./money.ts";
import { postDraft } from "./cards.ts";
import { sessionActions } from "./card-views.ts";
import type { Desk } from "./desk.ts";

export type SessionEnv = MeterEnv &
  PortsEnv & {
    CHAT: ServiceBinding;
    IDENTITY: ServiceBinding;
    WORK: ServiceBinding;
    NOTIFY?: ServiceBinding;
    /** The workspace's connections, for abilities outside g1t (abilities.ts). */
    INTEGRATIONS: ServiceBinding;
    /** The audit log, for refusals. */
    EVENTS: ServiceBinding;
    DESKS: DurableObjectNamespace<Desk>;
  };

/**
 * Steps one session takes at most before it must report, at medium effort;
 * its agent's effort setting moves it (routing.ts `SESSION_STEPS`).
 */
export const MAX_STEPS = 8;
/** Children one session may have running at once. */
export const MAX_CHILDREN = 4;
/** How deep a tree of sessions may go. */
export const MAX_DEPTH = 3;
/** Past this many characters of working context, it is compacted. */
const CONTEXT_LIMIT = 120_000;
/** Turns kept whole when compacting. */
const KEEP_TURNS = 6;
/** The longest report posted in chat. */
const MAX_REPORT = 12_000;

export const LIVE: AgentSessionStatus[] = ["queued", "working", "waiting", "needs_approval"];
const OVER: AgentSessionStatus[] = ["done", "failed", "stopped"];

export type SessionRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  subagent: string | null;
  kind: string;
  parent_id: string | null;
  root_id: string;
  payer_agent_id: string;
  title: string;
  goal: string;
  status: string;
  status_note: string | null;
  summary: string | null;
  workspace: string;
  channel_id: string;
  channel_kind: string;
  channel_name: string | null;
  thread_root: string | null;
  message_id: string | null;
  card_message_id: string | null;
  asked_by: string | null;
  asked_by_username: string | null;
  asker: string | null;
  routine_id: string | null;
  chain: string;
  hops: number;
  context: string;
  inbox: string;
  steps: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  charged_micros: number;
  cap_micros: number | null;
  model: string | null;
  /** The effort level it ran at (the highest, when Auto raised it). Null on sessions from before. */
  effort?: string | null;
  tier?: string | null;
  outputs: string;
  step_started_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

/** One turn of a session's working context: plain text, never tool blocks. */
type Turn = { role: "user" | "assistant"; content: string };
/** Something that arrived for a session while it worked. */
type Inbound = { kind: "steer" | "child"; by: string; body: string };

function json<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const iso = () => new Date().toISOString();

/** A session as the contract shows it; `visible` false hides what it was about. */
export function toSession(row: SessionRow, agent: { handle: string; display_name: string; avatar_seed: string; look?: AgentLook | null } | null, visible: boolean): AgentSession {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    agent_handle: agent?.handle ?? "agent",
    agent_name: agent?.display_name ?? "An agent",
    agent_avatar_seed: agent?.avatar_seed ?? agent?.handle ?? row.agent_id,
    agent_look: agent?.look ?? null,
    subagent: row.subagent,
    kind: row.kind as AgentSessionKind,
    parent_id: row.parent_id,
    root_id: row.root_id,
    payer_agent_id: row.payer_agent_id,
    title: visible ? row.title : "A private session",
    goal: visible ? row.goal : "",
    status: row.status as AgentSessionStatus,
    status_note: visible ? row.status_note : null,
    summary: visible ? row.summary : null,
    channel_id: row.channel_id,
    channel_kind: row.channel_kind === "dm" ? "dm" : "channel",
    channel_name: visible ? row.channel_name : null,
    card_message_id: visible ? row.card_message_id : null,
    asked_by: row.asked_by,
    asked_by_username: visible ? row.asked_by_username : null,
    routine_id: row.routine_id,
    steps: row.steps,
    tool_calls: row.tool_calls,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    charged_micros: row.charged_micros,
    cost_micros: row.cost_micros,
    cap_micros: row.cap_micros,
    model: row.model,
    effort: isLevel(row.effort) ? row.effort : null,
    outputs: visible ? json<SessionOutput[]>(row.outputs, []) : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    visible,
  };
}

/** A session's card, as its conversation shows it. */
export function cardFor(
  row: Pick<SessionRow, "id" | "title" | "status" | "steps" | "tool_calls" | "charged_micros" | "status_note"> & Partial<Pick<SessionRow, "cap_micros" | "summary" | "goal">>,
  slug: string,
  handle: string,
  children = 0,
): MessageCard {
  const state: Record<string, string> = {
    queued: "Queued",
    working: "Working",
    waiting: children === 1 ? "Waiting on a helper" : "Waiting on helpers",
    needs_approval: "Needs approval",
    done: "Done",
    failed: "Failed",
    stopped: "Stopped",
  };
  const parts = [
    row.steps ? `Step ${row.steps}` : null,
    row.tool_calls ? `${row.tool_calls} tool${row.tool_calls === 1 ? "" : "s"}` : null,
    row.charged_micros ? dollars(row.charged_micros) : null,
  ].filter(Boolean);
  const note = row.status === "needs_approval" || row.status === "failed" || row.status === "stopped" ? row.status_note : null;
  const href = `/${slug}/-/agents/${handle}/sessions/${row.id}`;
  return {
    kind: "session",
    title: row.title,
    detail: [parts.join(" · ") || "Starting", note].filter(Boolean).join(" — ").slice(0, 480),
    state: state[row.status] ?? row.status,
    href,
    ...(row.status === "done" && row.summary ? { body: row.summary.length > 600 ? `${row.summary.slice(0, 600)}…` : row.summary } : {}),
    fields: [
      ...(row.cap_micros ? [{ label: "Spent", value: `${dollars(row.charged_micros)} of ${dollars(row.cap_micros)}` }] : []),
      ...(children ? [{ label: "Helpers", value: `${children} working` }] : []),
    ],
    actions: sessionActions(row.status, row.cap_micros ?? null, row.charged_micros, href),
    owner: "agents",
    ref: row.id,
  };
}

/** Appends to a session's transcript. */
export function eventStatement(db: D1Database, id: string, kind: SessionEvent["kind"], by: string | null, body: string, tool: string | null = null, outcome: string | null = null): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO agent_session_events (session_id, seq, kind, by_name, body, tool, outcome, created_at)
       SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?7 FROM agent_session_events WHERE session_id = ?1`,
    )
    .bind(id, kind, by, body.slice(0, 20_000), tool, outcome, iso());
}

/**
 * The working context, kept bounded: the goal, then a summary of what is
 * cut, then the latest turns whole. What is cut stays in the transcript.
 */
export function compact(turns: Turn[], limit = CONTEXT_LIMIT, keep = KEEP_TURNS): Turn[] {
  const size = (list: Turn[]) => list.reduce((n, t) => n + t.content.length, 0);
  if (size(turns) <= limit || turns.length <= keep + 1) return turns;
  const [goal, ...rest] = turns;
  let tail = rest.slice(-keep);
  // The kept part starts with someone else's turn, as the model needs.
  while (tail.length && tail[0].role === "assistant") tail = tail.slice(1);
  const cut = rest.slice(0, rest.length - tail.length);
  const notes = cut
    .filter((t) => t.role === "assistant")
    .map((t, i) => `- Step ${i + 1}: ${t.content.replace(/\s+/g, " ").slice(0, 600)}`)
    .join("\n");
  const earlier: Turn = { role: "user", content: `${goal.content}\n\n(Earlier in this session, now summarised:\n${notes || "- nothing to note"})` };
  return [earlier, ...tail];
}

/** Turns as the Messages API takes them: alternating, someone else's first. */
function alternate(turns: Turn[]): ModelMessage[] {
  const out: Turn[] = [];
  for (const turn of turns) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role) last.content += `\n\n${turn.content}`;
    else out.push({ ...turn });
  }
  while (out.length && out[0].role === "assistant") out.shift();
  if (out.length && out[out.length - 1].role === "assistant") out.push({ role: "user", content: "(Go on with the session.)" });
  return out;
}

async function agentRow(db: D1Database, id: string): Promise<Row | null> {
  return db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<Row>();
}

export async function sessionRow(db: D1Database, id: string): Promise<SessionRow | null> {
  return db.prepare("SELECT * FROM agent_sessions WHERE id = ?").bind(id).first<SessionRow>();
}

/** Hands a session to its agent's desk to work its next step. */
export async function wake(env: Pick<SessionEnv, "DESKS">, agentId: string, sessionId: string): Promise<void> {
  await env.DESKS.get(env.DESKS.idFromName(agentId)).session(sessionId, agentId);
}

export type NewSession = {
  agent: Row;
  kind: AgentSessionKind;
  subagent?: SubagentDef | null;
  parent?: SessionRow | null;
  title: string;
  goal: string;
  workspace: string;
  channel_id: string;
  channel_kind: "channel" | "dm";
  channel_name: string | null;
  thread_root: string | null;
  message_id: string | null;
  asked_by: string | null;
  asked_by_username: string | null;
  asker: AskerAccess | null;
  routine_id?: string | null;
  chain: string[];
  hops: number;
};

/**
 * Starts a session: its row, its card where it was asked (a child's card
 * goes in its parent's thread), and its first step on the desk. A child's
 * cap is what its root has left; a root's is the agent's per-task cap or
 * the workspace's default for sessions, whichever is lower.
 */
export async function startSession(env: SessionEnv, input: NewSession): Promise<SessionRow> {
  const db = env.DB;
  const now = iso();
  const id = newId("asn");
  const parent = input.parent ?? null;
  const root = parent ? ((await sessionRow(db, parent.root_id)) ?? parent) : null;
  let cap: number | null;
  if (root) {
    const tree = await db.prepare("SELECT COALESCE(SUM(charged_micros), 0) AS spent FROM agent_sessions WHERE root_id = ?").bind(root.id).first<{ spent: number }>();
    cap = root.cap_micros != null ? Math.max(1, root.cap_micros - (tree?.spent ?? 0)) : null;
  } else {
    const policy = await readPolicy(db, input.agent.workspace_id, periods(new Date())[0]);
    const task = definitionOf(input.agent).budget.task_micros;
    cap = Math.min(policy.default_session_micros, task && task > 0 ? task : Number.POSITIVE_INFINITY);
  }
  const subagent = input.subagent ?? null;
  const goal = [
    input.goal,
    subagent ? `\n(You are working as ${input.agent.display_name}'s subagent "${subagent.name}": ${subagent.description}\n\n${subagent.instructions})` : "",
  ].join("");
  const context: Turn[] = [{ role: "user", content: `Your session: ${input.title}\n\n${goal}` }];
  await db.batch([
    db
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, agent_id, subagent, kind, parent_id, root_id, payer_agent_id, title, goal, status,
           workspace, channel_id, channel_kind, channel_name, thread_root, message_id, asked_by, asked_by_username, asker, routine_id,
           chain, hops, context, cap_micros, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.agent.workspace_id,
        input.agent.id,
        subagent?.name ?? null,
        input.kind,
        parent?.id ?? null,
        root?.id ?? id,
        root?.payer_agent_id ?? input.agent.id,
        input.title.slice(0, 120),
        input.goal.slice(0, 8000),
        input.workspace.toLowerCase(),
        input.channel_id,
        input.channel_kind,
        input.channel_name,
        input.thread_root,
        input.message_id,
        input.asked_by,
        input.asked_by_username,
        input.asker ? JSON.stringify(input.asker) : null,
        input.routine_id ?? null,
        JSON.stringify(input.chain),
        input.hops,
        JSON.stringify(context),
        cap === Number.POSITIVE_INFINITY ? null : cap,
        now,
        now,
      ),
    eventStatement(db, id, "goal", input.asked_by_username, `${input.title}\n\n${input.goal}`),
  ]);
  let row = (await sessionRow(db, id))!;
  if (parent) {
    await addOutput(db, parent.id, { kind: "session", id, agent_handle: subagent ? `${input.agent.handle}/${subagent.name}` : input.agent.handle, title: row.title });
    await db.batch([eventStatement(db, parent.id, "child", input.agent.handle, `${subagent ? `Subagent ${subagent.name}` : `@${input.agent.handle}`} started: ${row.title}`)]);
  } else {
    // A root session's card, where it was asked.
    const posted = await chatClient(env.CHAT)
      .postAsAgent(row.workspace, row.channel_id, row.agent_id, {
        body: "",
        card: cardFor(row, row.workspace, input.agent.handle),
        thread_root: row.thread_root,
        hops: row.hops,
        asked_by: row.asked_by,
        asker: input.asker,
        chain: input.chain,
      })
      .catch(() => null);
    if (posted?.ok) {
      await db.prepare("UPDATE agent_sessions SET card_message_id = ? WHERE id = ?").bind(posted.value.id, id).run();
      row = { ...row, card_message_id: posted.value.id };
    }
  }
  await wake(env, row.agent_id, id);
  return row;
}

async function addOutput(db: D1Database, id: string, output: SessionOutput): Promise<void> {
  const row = await db.prepare("SELECT outputs FROM agent_sessions WHERE id = ?").bind(id).first<{ outputs: string }>();
  const list = json<SessionOutput[]>(row?.outputs, []);
  list.push(output);
  await db.prepare("UPDATE agent_sessions SET outputs = ? WHERE id = ?").bind(JSON.stringify(list.slice(-50)), id).run();
}

/** The root session of a tree, whose card and agent speak for it in chat. */
async function speaker(db: D1Database, row: SessionRow): Promise<{ root: SessionRow; agent: Row | null }> {
  const root = row.root_id === row.id ? row : ((await sessionRow(db, row.root_id)) ?? row);
  return { root, agent: await agentRow(db, root.agent_id) };
}

/** Brings the root's card up to date with the tree. Never throws. */
export async function refreshCard(env: SessionEnv, row: SessionRow): Promise<void> {
  try {
    const db = env.DB;
    const { root, agent } = await speaker(db, row);
    if (!root.card_message_id || !agent) return;
    const fresh = (await sessionRow(db, root.id)) ?? root;
    const tree = await db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(charged_micros), 0) AS spent, COALESCE(SUM(tool_calls), 0) AS tools, SUM(CASE WHEN status IN ('queued','working','waiting') AND id <> root_id THEN 1 ELSE 0 END) AS live FROM agent_sessions WHERE root_id = ?")
      .bind(root.id)
      .first<{ n: number; spent: number; tools: number; live: number }>();
    const shown = { ...fresh, charged_micros: tree?.spent ?? fresh.charged_micros, tool_calls: tree?.tools ?? fresh.tool_calls };
    await chatClient(env.CHAT).updateAsAgent(fresh.workspace, fresh.channel_id, fresh.agent_id, root.card_message_id, { card: cardFor(shown, fresh.workspace, agent.handle, tree?.live ?? 0) });
  } catch (error) {
    console.error("agents: a session card was not updated", row.id, String(error));
  }
}

/** Posts in the root card's thread, as the root's agent; a child's note names who it is from. */
async function postInThread(env: SessionEnv, row: SessionRow, by: Row, text: string): Promise<boolean> {
  const db = env.DB;
  const { root } = await speaker(db, row);
  if (!root.card_message_id) return false;
  const prefix = root.id === row.id ? "" : `**${row.subagent ? `${by.display_name} · ${row.subagent}` : by.display_name}:** `;
  const posted = await chatClient(env.CHAT)
    .postAsAgent(root.workspace, root.channel_id, root.agent_id, {
      body: `${prefix}${text}`.slice(0, 8000),
      thread_root: root.card_message_id,
      hops: root.hops,
      asked_by: root.asked_by,
      asker: json<AskerAccess | null>(root.asker, null),
      chain: json<string[]>(root.chain, []),
    })
    .catch(() => null);
  return !!posted?.ok;
}

/** Posts a card (a draft issue) in the root card's thread, as the root's agent; its id. */
async function postCardInThread(env: SessionEnv, row: SessionRow, by: Row, card: MessageCard): Promise<string | null> {
  const { root } = await speaker(env.DB, row);
  const posted = await chatClient(env.CHAT)
    .postAsAgent(root.workspace, root.channel_id, root.agent_id, {
      body: root.id === row.id ? "" : `**${by.display_name}** drafted this:`,
      card,
      thread_root: root.card_message_id ?? root.thread_root,
      hops: root.hops,
      asked_by: root.asked_by,
      asker: json<AskerAccess | null>(root.asker, null),
      chain: json<string[]>(root.chain, []),
    })
    .catch(() => null);
  return posted?.ok ? posted.value.id : null;
}

/** Sets a session's status, records why, and brings its card along. */
async function setStatus(env: SessionEnv, row: SessionRow, status: AgentSessionStatus, note: string | null, extra: Record<string, string | number | null> = {}): Promise<SessionRow> {
  const db = env.DB;
  const names = Object.keys(extra);
  const finished = OVER.includes(status) ? iso() : null;
  await db
    .prepare(
      `UPDATE agent_sessions SET status = ?, status_note = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)${names.map((n) => `, ${n} = ?`).join("")} WHERE id = ?`,
    )
    .bind(status, note, iso(), finished, ...names.map((n) => extra[n]), row.id)
    .run();
  const fresh = (await sessionRow(db, row.id))!;
  await refreshCard(env, fresh);
  return fresh;
}

/** The person who asked, resolved, for acting on their behalf. */
async function askerUser(env: SessionEnv, row: SessionRow): Promise<User | null> {
  if (!row.asked_by) return null;
  const [user] = await identityClient(env.IDENTITY)
    .usersForAudience([row.asked_by])
    .catch(() => [] as User[]);
  return user ?? null;
}

/**
 * What an agent may do here: remember and forget within where it is,
 * file issues as the person who asked, and (in a session) post updates,
 * use subagents and bring colleagues in. Shared by replies and sessions.
 */
export function actionPorts(
  env: SessionEnv,
  input: {
    agent: Row;
    place: RecallPlace;
    source: { kind: "message" | "session"; ref: string; label: string; channel_id: string };
    asker: { id: string | null; username: string | null };
    workspace: string;
    session?: SessionRow | null;
    /** From a reply: starts a session for the conversation. */
    spinOff?: (title: string, goal: string) => Promise<{ ok: boolean; message: string }>;
    /** Posts a card where this work reports (a draft issue); its message id, or null. */
    postCard: (card: MessageCard) => Promise<string | null>;
  },
): ActionPorts {
  const db = env.DB;
  const { agent, place } = input;
  const session = input.session ?? null;
  const ports: ActionPorts = {
    async remember(body, wanted, onlyForAsker) {
      const fact = cleanFact(body);
      if (!fact) return { ok: false, message: "Say what to remember." };
      const count = await db.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE agent_id = ?").bind(agent.id).first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_FACTS) return { ok: false, message: "Your memory is full. Forget something out of date first." };
      const privately = !!onlyForAsker && !!input.asker.id;
      const { scope, ref } = scopeFor(place, wanted, privately ? input.asker.id : null);
      const id = newId("mem");
      const now = iso();
      const label = scope === "person" ? input.asker.username : scope === "channel" ? input.source.label : null;
      await db
        .prepare(
          `INSERT INTO agent_memories (id, agent_id, workspace_id, scope, scope_ref, scope_label, body, source_kind, source_ref, source_label, source_channel_id, created_by, created_by_kind, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?)`,
        )
        .bind(id, agent.id, agent.workspace_id, scope, ref, label, fact, input.source.kind, input.source.ref, input.source.label, input.source.channel_id, agent.handle, now, now)
        .run();
      if (session) await addOutput(db, session.id, { kind: "memory", id, body: fact });
      const where = scope === "workspace" ? "for the whole workspace" : scope === "person" ? "for this person" : "for this conversation";
      const narrowed = privately
        ? " (only for them: you read an artifact not everyone in the workspace can)"
        : wanted && wanted !== scope
          ? ` (${wanted} wasn't allowed from here)`
          : "";
      return { ok: true, message: `Remembered ${where}${narrowed}: ${fact}` };
    },
    async forget(id) {
      const row = await db.prepare("SELECT scope, scope_ref FROM agent_memories WHERE id = ? AND agent_id = ?").bind(id, agent.id).first<{ scope: string; scope_ref: string }>();
      // Only what could be recalled here can be forgotten from here.
      const here = row && (row.scope === "workspace" ? place.kind === "public" : row.scope === "channel" ? row.scope_ref === place.channel_id : place.kind === "dm" && place.people.length === 1 && place.people[0] === row.scope_ref);
      if (!row || !here) return { ok: false, message: "There is no such note you can forget here." };
      await db.prepare("DELETE FROM agent_memories WHERE id = ?").bind(id).run();
      return { ok: true, message: "Forgotten." };
    },
    async comment(repo, asker, number, body) {
      const made = await workClient(env.WORK).workspaceAgentComment({ namespace: repo.namespace, name: repo.name }, number, refOf(agent), asker, body);
      if (!made.ok) return { ok: false, message: `It couldn't be posted: ${made.error.message}` };
      return { ok: true, message: `Commented on ${repo.namespace}/${repo.name}#${number}.` };
    },
    async review(repo, asker, number, verdict, body) {
      const made = await workClient(env.WORK).workspaceAgentReview({ namespace: repo.namespace, name: repo.name }, number, refOf(agent), asker, verdict, body);
      if (!made.ok) return { ok: false, message: `The review couldn't be posted: ${made.error.message}` };
      const what = verdict === "approve" ? "Approved" : verdict === "request_changes" ? "Requested changes on" : "Reviewed";
      return { ok: true, message: `${what} ${repo.namespace}/${repo.name}#${number} (advisory). Link it in your report: /${repo.namespace}/${repo.name}/pull/${number}` };
    },
    async draftIssue(repo, issue) {
      const draft = await postDraft(
        env,
        {
          agent_id: agent.id,
          workspace_id: agent.workspace_id,
          workspace: input.workspace,
          channel_id: input.source.channel_id,
          session_id: session?.id ?? null,
          repo_id: repo.id,
          repo: `${repo.namespace}/${repo.name}`,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          asked_by: input.asker.id,
        },
        input.postCard,
      );
      if (!draft) return { ok: false, message: "The draft couldn't be posted; give it in your answer instead." };
      return { ok: true, message: "The draft is in the conversation as a card with File issue and Discard. Tell them in a sentence; don't repeat it." };
    },
  };
  if (input.spinOff) ports.startSession = input.spinOff;
  if (session) {
    ports.postUpdate = async (text) => {
      const posted = await postInThread(env, session, agent, text);
      if (posted) await db.batch([eventStatement(db, session.id, "update", agent.handle, text)]);
      return posted ? { ok: true, message: "Posted." } : { ok: false, message: "It couldn't be posted; carry on." };
    };
    const child = async (target: Row, subagent: SubagentDef | null, brief: string) => {
      const depth = await treeDepth(db, session);
      if (depth >= MAX_DEPTH) return { ok: false, message: "This work is already deep enough; do this part yourself." };
      const live = await db
        .prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE parent_id = ? AND status IN ('queued','working','waiting','needs_approval')")
        .bind(session.id)
        .first<{ n: number }>();
      if ((live?.n ?? 0) >= MAX_CHILDREN) return { ok: false, message: `You already have ${MAX_CHILDREN} helpers working; wait for them.` };
      const title = brief.split("\n")[0].slice(0, 100) || "Helping";
      await startSession(env, {
        agent: target,
        kind: subagent ? "subagent" : "helper",
        subagent,
        parent: session,
        title,
        goal: `${agent.display_name} (@${agent.handle}) asked for your help with part of the session "${session.title}".\n\n${brief}\n\nWhen you're done, answer with your result for ${agent.display_name}: findings, links, and anything left open.`,
        workspace: session.workspace,
        channel_id: session.channel_id,
        channel_kind: session.channel_kind === "dm" ? "dm" : "channel",
        channel_name: session.channel_name,
        thread_root: session.thread_root,
        message_id: session.message_id,
        asked_by: session.asked_by,
        asked_by_username: session.asked_by_username,
        asker: json<AskerAccess | null>(session.asker, null),
        chain: [...json<string[]>(session.chain, []), agent.id],
        hops: session.hops + 1,
      });
      return { ok: true, message: `${subagent ? `Your subagent ${subagent.name}` : `@${target.handle}`} is on it. End this step with what you're waiting for; their result comes back to you before your next step.` };
    };
    ports.useSubagent = async (name, brief) => {
      const subagent = definitionOf(agent).subagents.find((s) => s.name === name);
      if (!subagent) return { ok: false, message: `You have no subagent called ${name}.` };
      return child(agent, subagent, brief);
    };
    ports.bringIn = async (handle, brief) => {
      const colleague = await db
        .prepare("SELECT * FROM agents WHERE workspace_id = ? AND handle = ? AND archived_at IS NULL AND scope = 'workspace'")
        .bind(agent.workspace_id, handle)
        .first<Row>();
      if (!colleague || colleague.id === agent.id) return { ok: false, message: `There is no other agent called @${handle} here.` };
      if (json<string[]>(session.chain, []).includes(colleague.id)) return { ok: false, message: `@${handle} is already part of this work.` };
      if (session.hops + 1 > CHAT_MAX_HOPS) return { ok: false, message: "This work has been passed along too many times; do it yourself." };
      return child(colleague, null, brief);
    };
  }
  return ports;
}

/** How work names an agent on issues and pull requests. */
function refOf(agent: Row): AgentRef {
  return agentRef({ id: agent.id, handle: agent.handle, display_name: agent.display_name, avatar_seed: agent.avatar_seed || agent.handle, look: readLook(agent.look ?? null) });
}

async function treeDepth(db: D1Database, row: SessionRow): Promise<number> {
  let depth = 0;
  let at: SessionRow | null = row;
  while (at?.parent_id && depth < 10) {
    depth++;
    at = await sessionRow(db, at.parent_id);
  }
  return depth;
}

/** The section of the system prompt that says what a session is and how to finish. */
function sessionSection(row: SessionRow, asker: string, steps = MAX_STEPS): string {
  const report =
    row.kind === "helper" || row.kind === "subagent"
      ? "Your final answer goes back to the agent who asked for your help, not into chat."
      : row.kind === "routine"
        ? `Your final answer is posted in ${row.channel_kind === "dm" ? "the direct message" : `#${row.channel_name ?? "the channel"}`} as this routine's report.`
        : `Your final answer is posted for ${asker} in the conversation where they asked.`;
  return [
    "## This session",
    "",
    `You are working a session: "${row.title}". It is bounded: work through it with your tools, step by step, and finish within ${steps} steps.`,
    `- ${report} Make it the report: what you found or did, with links (issues, files, threads), and anything left open.`,
    "- Use post_update for real milestones or a question for the people following, not for every step.",
    "- When part of the work belongs to a subagent or a colleague, hand it over with use_subagent or bring_in and end your step saying what you're waiting for; their results come back to you.",
    "- Never claim to have done or checked something you didn't. If you can't do something from here, say so in the report.",
  ].join("\n");
}

/**
 * Works one step of a session, on its agent's desk. Reads what arrived
 * (steering, helpers' results), runs one metered model turn with the
 * session's tools, and decides what comes next: done, waiting on helpers,
 * another step, or stopped at a limit. Never throws.
 */
export async function advance(env: SessionEnv, id: string): Promise<void> {
  const db = env.DB;
  let row = await sessionRow(db, id);
  if (!row || OVER.includes(row.status as AgentSessionStatus) || row.status === "needs_approval") return;
  const agent = await agentRow(db, row.agent_id);
  const payer = await agentRow(db, row.payer_agent_id);
  if (!agent || !payer || agent.archived_at) {
    await setStatus(env, row, "failed", "Its agent was archived.");
    return finished(env, row.id);
  }
  // Waiting on helpers: only once every child is over.
  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE parent_id = ? AND status IN ('queued','working','waiting','needs_approval')")
    .bind(row.id)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) > 0) {
    if (row.status !== "waiting") await setStatus(env, row, "waiting", null);
    return;
  }
  // Its effort setting: the tier a step starts on, how hard the model
  // reasons, and how many steps it may take. Auto works harder on a
  // session someone had to steer.
  const steered = json<Inbound[]>(row.inbox, []).some((item) => item.kind === "steer") || row.effort === "high" || row.effort === "max";
  const setting = effortOf(definitionOf(agent).routing);
  const plan = effortPlan(setting, "large", { raised: setting === "auto" && steered });
  if (row.steps >= plan.steps && json<Inbound[]>(row.inbox, []).length === 0) {
    await setStatus(env, row, "done", null, { summary: row.summary ?? "Stopped at the step limit." });
    return finished(env, row.id);
  }
  // The session's cap, counting its whole tree for a root.
  if (row.cap_micros != null && row.charged_micros >= row.cap_micros) {
    await setStatus(env, row, "needs_approval", `Reached its cap of ${dollars(row.cap_micros)}.`);
    await notifyApproval(env, row, agent);
    return;
  }

  // What arrived meanwhile becomes the next turn.
  const inbox = json<Inbound[]>(row.inbox, []);
  let context = json<Turn[]>(row.context, []);
  if (inbox.length) {
    const lines = inbox.map((item) => (item.kind === "steer" ? `@${item.by} says: ${item.body}` : `Result from ${item.by}:\n${item.body}`));
    context.push({ role: "user", content: lines.join("\n\n") });
  } else if (row.steps > 0) {
    context.push({ role: "user", content: "(Go on with the session.)" });
  }
  context = compact(context);
  const startedAt = iso();
  await db
    .prepare("UPDATE agent_sessions SET status = 'working', status_note = NULL, inbox = '[]', context = ?, step_started_at = ?, updated_at = ? WHERE id = ? AND status <> 'stopped'")
    .bind(JSON.stringify(context), startedAt, startedAt, row.id)
    .run();
  row = (await sessionRow(db, id))!;
  if (row.status === "stopped") return;
  await refreshCard(env, row);

  const slug = row.workspace;
  const definition = definitionOf(agent);
  const subagent = row.subagent ? definition.subagents.find((s) => s.name === row!.subagent) ?? null : null;
  const events: D1PreparedStatement[] = [];
  const calls: ToolCall[] = [];
  const startTier: ModelTier = plan.start;
  const asker = { id: row.asked_by, username: row.asked_by_username };
  const current = row;
  // Its teams, from their pages: told every step, and their budgets apply.
  const teamsHere = await loadTeams(env, slug, agent.workspace_id, { id: agent.id }).catch(() => null);

  const outcome = await metered(
    env,
    {
      row: agent,
      payer,
      slug,
      task: "session",
      start: startTier,
      effort: plan.level,
      askerName: row.asked_by_username,
      person: row.asked_by_username,
      leftMicros: row.cap_micros != null ? row.cap_micros - row.charged_micros : null,
      limits: subagent ? subagent.routing : null,
      teams: teamsHere,
    },
    async (model) => {
      // The audience: who reads what this session posts. Without one it reads nothing but its own context.
      let toolbox: ToolBox | null = null;
      let place: RecallPlace = { channel_id: current.channel_id, kind: current.channel_kind === "dm" ? "dm" : "private", people: current.asked_by ? [current.asked_by] : [] };
      try {
        if (current.asked_by) {
          const audience = await Audience.build(slug, current.asked_by, audiencePorts(env, slug, current.channel_id));
          place = { channel_id: current.channel_id, kind: audience.kind, people: audience.shared ? (current.asked_by ? [current.asked_by] : []) : audience.members.map((m) => m.id) };
          const noConsult: ToolPorts["consult"] = async () => ({ ok: false, message: "In a session, bring a colleague in with bring_in instead." });
          const sourceLabel = current.channel_kind === "dm" ? "a direct message" : `#${current.channel_name ?? "a channel"}`;
          toolbox = new ToolBox(
            audience,
            toolPorts(env, slug, agent.workspace_id, current.channel_id, noConsult, agent.id),
            {
              agentId: agent.id,
              notConsult: [agent.handle],
              hops: current.hops,
              maxHops: CHAT_MAX_HOPS,
              session: true,
              onCall: (call) => {
                calls.push(call);
                events.push(eventStatement(db, current.id, "tool", agent.handle, call.args, call.tool, call.outcome));
              },
            },
            [],
            actionPorts(env, {
              agent,
              place,
              source: { kind: "session", ref: current.id, label: `the session "${current.title}" in ${sourceLabel}`, channel_id: current.channel_id },
              asker,
              workspace: slug,
              session: current,
              postCard: (card) => postCardInThread(env, current, agent, card),
            }),
          );
        }
      } catch (error) {
        console.error("agents: no audience for a session step, so no tools", current.id, String(error));
      }
      // Its abilities outside g1t (abilities.ts), for the person it acts for: offered and enforced by the tool box.
      let abilitiesText: string | null = null;
      if (toolbox && current.asked_by) {
        const askerUser = await identityClient(env.IDENTITY)
          .usersForAudience([current.asked_by])
          .then((users) => users[0] ?? null)
          .catch(() => null);
        const sections = askerUser ? await abilitiesFor(env, { agent, definition, workspace: slug, asker: askerUser }).catch(() => null) : null;
        if (sections) {
          toolbox.useAbilities(
            sections,
            abilityPorts(env, {
              agent,
              workspace: slug,
              channel_id: current.channel_id,
              session: { id: current.id, title: current.title },
              asker,
              postCard: (card) => postCardInThread(env, current, agent, card),
            }),
            saidText([current.goal, ...inbox.filter((item) => item.kind === "steer").map((item) => item.body)]),
            definition.abilities.mcp_servers,
          );
          abilitiesText = abilitiesSection(sections);
        }
      }
      // What the workspace's artifacts say about the work: its goal, and whatever arrived for this step.
      const asked = [current.goal, ...inbox.map((item) => item.body)].reverse();
      const [facts, passages, shelf] = await Promise.all([
        recall(db, agent.id, place).catch(() => []),
        toolbox ? toolbox.recall(recallQuery(asked, 800), definition.reading ?? []) : Promise.resolve([]),
        // Its skills: named in the prompt, read with use_skill (skills.ts).
        toolbox ? loadShelf(db, agent.workspace_id, { id: agent.id, skills_off: definition.skills_off }, teamSlugs(teamsHere)) : Promise.resolve([]),
      ]);
      toolbox?.useShelf(shelf, (skillId, version) => readVersion(db, skillId, version));
      const [team, onTeams, here] = await Promise.all([
        db
          .prepare("SELECT id, handle, display_name, role, title, responsibilities FROM agents WHERE workspace_id = ? AND archived_at IS NULL AND id <> ? AND scope = 'workspace' ORDER BY builtin DESC, handle LIMIT 50")
          .bind(agent.workspace_id, agent.id)
          .all<{ id: string; handle: string; display_name: string; role: string; title: string; responsibilities: string }>(),
        teamsOfAgents(env, slug),
        // Who reads what this session posts: said every step, as in a reply. A helper may not be a member: then not said.
        chatClient(env.CHAT)
          .conversationForAgent(slug, current.channel_id, agent.id, current.asked_by)
          .then((found) => (found.ok ? conversationFrom(found.value) : null))
          .catch(() => null),
      ]);
      const roster = rosterLines(
        team.results.map((a) => ({
          handle: a.handle,
          display_name: a.display_name,
          role: a.role,
          title: a.title,
          teams: onTeams.get(a.id) ?? [],
          responsibilities: json<string[]>(a.responsibilities, []),
          status: "idle",
          spent_month_micros: 0,
          monthly_micros: null,
        })),
      );
      const access = json<AskerAccess | null>(current.asker, null);
      const system = [
        systemPrompt({
          agent: { ...definition, id: agent.id, teams: teamsHere?.teams.map((t) => t.name) ?? [] },
          workspace: slug,
          channel: { kind: current.channel_kind === "dm" ? "dm" : "channel", name: current.channel_name },
          asker: { name: current.asked_by_username ?? "someone", display_name: null, access },
          today: new Date(),
          tools: toolbox ? { code: toolbox.definitions().some((tool) => tool.name === "read_file") } : null,
          colleagues: roster,
          teams: teamsSection(agent.id, teamsHere, new Date()),
          session: true,
          conversation: here,
          skills: skillsSection(shelf, toolbox?.definitions().map((tool) => tool.name) ?? []),
          abilities: abilitiesText,
        }),
        sessionSection(current, current.asked_by_username ? `@${current.asked_by_username}` : "the person who asked", plan.steps),
        memorySection(facts),
        recallSection(passages),
      ]
        .filter(Boolean)
        .join("\n\n");
      const result = await runTurn(model.send, {
        model: model.model.model,
        system,
        messages: alternate(context),
        tools: toolbox,
        price: model.ownModel ? null : model.model.price,
        effort: model.effort,
        maxRounds: SESSION_LIMITS.rounds,
        inputBudget: SESSION_LIMITS.input,
        maxOutput: SESSION_LIMITS.output,
        onText: (text) => events.push(eventStatement(db, current.id, "text", agent.handle, text)),
        stopped: async () => (await db.prepare("SELECT status FROM agent_sessions WHERE id = ?").bind(current.id).first<{ status: string }>())?.status === "stopped",
      });
      return { ...result, cost: model.ownModel ? 0 : result.cost };
    },
  ).catch((error: unknown) => ({ ok: false as const, reason: "error", message: error instanceof Error ? error.message : String(error) }));

  if (events.length) await db.batch(events).catch((error: unknown) => console.error("agents: transcript not written", id, String(error)));
  row = (await sessionRow(db, id))!;

  if (!outcome.ok) {
    if (outcome.reason === "error") {
      console.error("agents: a session step failed", id, outcome.message);
      await db.batch([eventStatement(db, id, "note", null, `This step failed: ${outcome.message}`)]);
      await setStatus(env, row, "failed", "Something went wrong on g1t's side.");
    } else {
      await db.batch([eventStatement(db, id, "note", null, outcome.message)]);
      await setStatus(env, row, "stopped", outcome.message);
    }
    return finished(env, id);
  }

  const answer = outcome.value;
  const tokens = outcome.tokens;
  context.push({ role: "assistant", content: answer.text || "(no text)" });
  await db
    .prepare(
      `UPDATE agent_sessions SET steps = steps + 1, tool_calls = tool_calls + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
         cost_micros = cost_micros + ?, charged_micros = charged_micros + ?, model = ?, effort = ?, tier = ?, context = ?, step_started_at = NULL, updated_at = ? WHERE id = ?`,
    )
    .bind(
      calls.length,
      tokens.input + tokens.cacheRead + tokens.cacheWrite,
      tokens.output,
      outcome.cost,
      outcome.charged,
      outcome.model,
      higherEffort(isLevel(row.effort) ? row.effort : null, plan.level),
      outcome.tier,
      JSON.stringify(context),
      iso(),
      id,
    )
    .run();
  // A root's spend counts its tree for the cap: children add theirs to it too.
  if (row.root_id !== row.id) {
    await db.prepare("UPDATE agent_sessions SET charged_micros = charged_micros + ? WHERE id = ?").bind(outcome.charged, row.root_id).run();
  }
  row = (await sessionRow(db, id))!;
  if (row.status === "stopped" || answer.stopped) return finished(env, id);

  // A call waiting on an Ask-first card: the session waits with it, and goes on when the card is answered (cards.ts).
  const asked = await pendingRequests(db, id).catch(() => []);
  if (asked.length) {
    if (answer.text) await db.batch([eventStatement(db, id, "text", agent.handle, answer.text)]);
    await setStatus(env, row, "needs_approval", `Waiting for an OK: ${asked.map((r) => r.summary).join("; ").slice(0, 200)}.`);
    return;
  }
  const children = await db
    .prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE parent_id = ? AND status IN ('queued','working','waiting','needs_approval')")
    .bind(id)
    .first<{ n: number }>();
  if ((children?.n ?? 0) > 0) {
    if (answer.text) await db.batch([eventStatement(db, id, "text", agent.handle, answer.text)]);
    await setStatus(env, row, "waiting", null);
    return;
  }
  // Something arrived during the step: another step reads it.
  if (json<Inbound[]>(row.inbox, []).length && row.steps < plan.steps + 2) {
    if (answer.text) await db.batch([eventStatement(db, id, "text", agent.handle, answer.text)]);
    await wake(env, row.agent_id, id);
    return;
  }
  const report = answer.text.trim() || "I finished without anything to report.";
  await db.batch([eventStatement(db, id, "result", agent.handle, report)]);
  row = await setStatus(env, row, "done", null, { summary: report.slice(0, MAX_REPORT) });
  await finished(env, id);
}

/**
 * After a session is over: a root reports in its conversation; a child
 * hands its result to its parent and wakes it once its siblings are done.
 */
async function finished(env: SessionEnv, id: string): Promise<void> {
  const db = env.DB;
  const row = await sessionRow(db, id);
  if (!row) return;
  // Everything under a stopped or failed session stops too.
  if (row.status === "stopped" || row.status === "failed") await stopChildren(env, row.id, "Its parent session ended.");
  const agent = await agentRow(db, row.agent_id);
  if (row.parent_id) {
    const parent = await sessionRow(db, row.parent_id);
    if (!parent || OVER.includes(parent.status as AgentSessionStatus)) return;
    const who = row.subagent ? `your subagent ${row.subagent}` : `@${agent?.handle ?? "a colleague"}`;
    const body = row.status === "done" ? (row.summary ?? "(no result)") : `They couldn't finish (${row.status}): ${row.status_note ?? "no reason given"}.`;
    await pushInbox(db, parent.id, { kind: "child", by: who, body: body.slice(0, 8000) });
    await db.batch([eventStatement(db, parent.id, "child", agent?.handle ?? null, `${who} ${row.status === "done" ? "finished" : row.status}: ${row.title}`)]);
    await wake(env, parent.agent_id, parent.id);
    return;
  }
  // A root's report, where it was asked: the request's thread, or the conversation.
  if (row.status === "done" && row.summary && agent) {
    const mention = row.kind === "chat" && row.asked_by_username ? `@${row.asked_by_username} ` : "";
    await chatClient(env.CHAT)
      .postAsAgent(row.workspace, row.channel_id, row.agent_id, {
        body: `${mention}${row.summary}`.slice(0, MAX_REPORT),
        thread_root: row.thread_root,
        hops: row.hops,
        asked_by: row.asked_by,
        asker: json<AskerAccess | null>(row.asker, null),
        chain: json<string[]>(row.chain, []),
      })
      .catch((error: unknown) => console.error("agents: a session's report was not posted", row.id, String(error)));
  } else if ((row.status === "stopped" || row.status === "failed") && agent && row.status_note) {
    await postInThread(env, row, agent, `${row.status === "failed" ? "This session failed" : "This session stopped"}: ${row.status_note}`);
  }
  await refreshCard(env, row);
}

export async function pushInbox(db: D1Database, id: string, item: Inbound): Promise<void> {
  const row = await db.prepare("SELECT inbox FROM agent_sessions WHERE id = ?").bind(id).first<{ inbox: string }>();
  const list = json<Inbound[]>(row?.inbox, []);
  list.push(item);
  await db.prepare("UPDATE agent_sessions SET inbox = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(list.slice(-20)), iso(), id).run();
}

/** Stops every live session under `id`. */
async function stopChildren(env: SessionEnv, id: string, note: string): Promise<void> {
  const db = env.DB;
  const children = await db
    .prepare("SELECT * FROM agent_sessions WHERE parent_id = ? AND status IN ('queued','working','waiting','needs_approval')")
    .bind(id)
    .all<SessionRow>();
  for (const child of children.results) {
    await db.prepare("UPDATE agent_sessions SET status = 'stopped', status_note = ?, finished_at = ?, updated_at = ? WHERE id = ?").bind(note, iso(), iso(), child.id).run();
    await stopChildren(env, child.id, note);
  }
}

/** Stops a session and everything under it, by a person. */
export async function stop(env: SessionEnv, row: SessionRow, by: string): Promise<SessionRow> {
  const fresh = await setStatus(env, row, "stopped", `Stopped by @${by}.`);
  await env.DB.batch([eventStatement(env.DB, row.id, "note", null, `Stopped by @${by}.`)]);
  await stopChildren(env, row.id, `Stopped by @${by}.`);
  if (row.parent_id) await finished(env, row.id);
  else await refreshCard(env, fresh);
  return fresh;
}

/** A person's message to a session: read at its next step; a finished root goes on again. */
export async function steer(env: SessionEnv, row: SessionRow, by: string, body: string): Promise<SessionRow> {
  const db = env.DB;
  await pushInbox(db, row.id, { kind: "steer", by, body: body.slice(0, 4000) });
  await db.batch([eventStatement(db, row.id, "steer", by, body)]);
  if (row.status === "working" || row.status === "waiting" || row.status === "queued") {
    if (row.status !== "working") await wake(env, row.agent_id, row.id);
    return (await sessionRow(db, row.id))!;
  }
  // Over (or at its cap): it picks up again with its context, a fresh set of steps.
  if (row.status === "needs_approval") return (await sessionRow(db, row.id))!;
  await db.prepare("UPDATE agent_sessions SET status = 'queued', status_note = NULL, steps = MIN(steps, ?), finished_at = NULL, updated_at = ? WHERE id = ?").bind(Math.max(0, MAX_STEPS - 3), iso(), row.id).run();
  const fresh = (await sessionRow(db, row.id))!;
  await refreshCard(env, fresh);
  await wake(env, row.agent_id, row.id);
  return fresh;
}

/** Raises a session's cap past what it has spent and lets it go on. */
export async function approve(env: SessionEnv, row: SessionRow, by: string, capMicros: number): Promise<SessionRow> {
  const db = env.DB;
  await db.prepare("UPDATE agent_sessions SET cap_micros = ?, status = 'queued', status_note = NULL, updated_at = ? WHERE id = ?").bind(Math.floor(capMicros), iso(), row.id).run();
  await db.batch([eventStatement(db, row.id, "note", null, `@${by} raised its cap to ${dollars(capMicros)}.`)]);
  const fresh = (await sessionRow(db, row.id))!;
  await refreshCard(env, fresh);
  await wake(env, row.agent_id, row.id);
  return fresh;
}

/**
 * After an Ask-first card was answered (cards.ts): the session that asked
 * reads the answer at its next step and goes on, if it was waiting for it.
 * A reply (no session) hears nothing more: the card says what happened.
 */
export async function resumeAfterDecision(env: SessionEnv, request: { session_id: string | null; decided_by?: string | null }, body: string): Promise<void> {
  if (!request.session_id) return;
  const db = env.DB;
  const row = await sessionRow(db, request.session_id);
  if (!row || OVER.includes(row.status as AgentSessionStatus)) return;
  await pushInbox(db, row.id, { kind: "child", by: "the Ask-first card", body: body.slice(0, 8000) });
  await db.batch([eventStatement(db, row.id, "note", null, body.slice(0, 2000))]);
  const waiting = await db.prepare("SELECT COUNT(*) AS n FROM agent_ability_requests WHERE session_id = ? AND status = 'pending'").bind(row.id).first<{ n: number }>();
  if (row.status === "needs_approval" && (waiting?.n ?? 0) === 0) {
    await db.prepare("UPDATE agent_sessions SET status = 'queued', status_note = NULL, updated_at = ? WHERE id = ?").bind(iso(), row.id).run();
    const fresh = (await sessionRow(db, row.id))!;
    await refreshCard(env, fresh);
  }
  await wake(env, row.agent_id, row.id);
}

/** Tells whoever asked, and the agent's maker, that a session waits for more budget. */
async function notifyApproval(env: SessionEnv, row: SessionRow, agent: Row): Promise<void> {
  if (!env.NOTIFY) return;
  // The card's own buttons ride along, so it can be approved from the notification.
  const { root } = await speaker(env.DB, row);
  const href = `/${row.workspace}/-/agents/${agent.handle}/sessions/${row.id}`;
  const card = root.card_message_id
    ? { channel_id: root.channel_id, message_id: root.card_message_id, actions: sessionActions("needs_approval", row.cap_micros, row.charged_micros, href) }
    : null;
  const targets = new Set<string>();
  if (row.asked_by_username) targets.add(row.asked_by_username);
  if (agent.created_by) targets.add(agent.created_by);
  for (const username of targets) {
    await env.NOTIFY.fetch("https://service/rpc/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { username },
        notification: {
          id: `approval:${row.id}:${row.cap_micros ?? 0}`,
          kind: "approval",
          workspace: row.workspace,
          title: `${agent.display_name} needs more budget`,
          body: `"${row.title}" reached its cap of ${dollars(row.cap_micros ?? 0)}.`,
          href,
          actor: { kind: "agent", id: agent.id, name: agent.display_name, avatar_seed: agent.avatar_seed || agent.handle, look: readLook(agent.look ?? null) },
          // While that conversation is open the card is there already: no toast.
          channel_id: root.channel_id,
          card,
          created_at: iso(),
        },
      }),
    }).catch(() => undefined);
  }
}

/** Sessions stuck mid-step (their desk died): picked up again. */
export async function sweep(env: SessionEnv): Promise<number> {
  const before = new Date(Date.now() - 20 * 60_000).toISOString();
  const stuck = await env.DB.prepare(
    "SELECT id, agent_id FROM agent_sessions WHERE (status = 'working' AND step_started_at < ?) OR (status = 'queued' AND updated_at < ?) LIMIT 50",
  )
    .bind(before, before)
    .all<{ id: string; agent_id: string }>();
  for (const s of stuck.results) await wake(env, s.agent_id, s.id).catch(() => undefined);
  return stuck.results.length;
}

type ToolPorts = import("./tools.ts").ToolPorts;
