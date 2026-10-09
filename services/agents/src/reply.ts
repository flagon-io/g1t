/**
 * One reply: an agent answering a message in chat, in this Worker, with no
 * sandbox (docs/WORKSPACE.md, "Two kinds of turn").
 *
 * A reply is quick and bounded: it reads the latest messages of the
 * conversation (never all of it), what the agent remembers for this place,
 * and its recent sessions here. When a request needs real work, the agent
 * spins off a session (sessions.ts) and says so; the session reports back.
 * A message in a session's card thread is not a reply at all: it steers
 * that session.
 *
 * A reply is metered exactly as a session step is (`metered`, meter.ts):
 * the agent's and the workspace's agent budgets, model routing, the
 * compute gate, a billing run, the model proxy, and the spend recorded.
 *
 * Whatever happens, the reply's row says so: replied, steered, blocked
 * (with one short notice in the conversation, not repeated), skipped or
 * failed (with one short apology).
 */
import { type AgentDelivery, type ServiceBinding, newId } from "@g1t/contracts";

import { CHAT_MAX_HOPS } from "../../../packages/contracts/src/chat.ts";
import type { Tokens } from "./budget.ts";
import { HISTORY_LIMIT, fixedHello, helloAsk, systemPrompt, turns } from "./prompt.ts";
import { type Specialist, capMentions, orchestratorInstructions, orchestratorTier, rosterLines } from "./orchestrator.ts";
import { type MeterEnv, metered } from "./meter.ts";
import { type RecallPlace, memorySection, recall } from "./memory.ts";
import { recallQuery, recallSection } from "./recall.ts";
import { REPLY_TIER, allowedProviders, replyModel } from "./routing.ts";
import { type SessionEnv, type SessionRow, actionPorts, sessionRow, startSession, steer } from "./sessions.ts";
import { type Row, definitionOf, periods, selectAgents, toAgent } from "./store.ts";
import { type SurfaceMessage, surfaceFor } from "./surface.ts";
import { Audience } from "./audience.ts";
import { audiencePorts, toolPorts } from "./ports.ts";
import { type ToolCall, type ToolPorts, ToolBox } from "./tools.ts";
import type { Surface } from "./surface.ts";
import type { Desk } from "./desk.ts";
import { type ModelMessage, type Send, NO_TOKENS, addTokens, runTurn } from "./turn.ts";
import type { AgentRouting as Policy } from "../../runner/src/model-env.ts";
import { dollars } from "./money.ts";

export { billingRepo } from "./meter.ts";

export type ReplyEnv = MeterEnv & {
  DB: D1Database;
  CHAT: ServiceBinding;
  /** People and their access, for the audience; members and teams for the roster. */
  IDENTITY: ServiceBinding;
  /** Code, for read tools. */
  REPOS: ServiceBinding;
  /** Issues and pull requests, for read tools and filing issues. */
  WORK: ServiceBinding;
  /** Code search, for read tools. */
  SEARCH: ServiceBinding;
  /** Notifications: a session waiting for more budget. */
  NOTIFY?: ServiceBinding;
  /** Every agent's desk: sessions are worked on their agent's. */
  DESKS: DurableObjectNamespace<Desk>;
};

/** A notice that the agent cannot reply is posted once per conversation in this long. */
const NOTICE_QUIET_MS = 6 * 60 * 60 * 1000;
/** Sessions one reply may start. */
const MAX_SPIN_OFFS = 2;

const APOLOGY = "Sorry, something went wrong on my side and I couldn't answer that. Try again in a moment.";

/** Who asked, from the message that woke the agent (or their latest one). */
function askerIn(history: SurfaceMessage[], delivery: AgentDelivery): SurfaceMessage["author"] | null {
  const woken = history.find((m) => m.id === delivery.message_id);
  if (woken) return woken.author;
  return [...history].reverse().find((m) => m.author.kind === "user" && m.author.id === delivery.asked_by)?.author ?? null;
}

/**
 * An agent's colleagues: every agent of the workspace but itself that is
 * not archived (docs/WORKSPACE.md, "Agents know each other").
 */
async function team(db: D1Database, workspaceId: string, selfId: string, now: Date): Promise<Specialist[]> {
  const rows = await db
    .prepare(`${selectAgents("a.workspace_id = ?3 AND a.archived_at IS NULL AND a.id <> ?4")} ORDER BY a.builtin DESC, a.handle LIMIT 50`)
    .bind(...periods(now), workspaceId, selfId)
    .all<Row>();
  return rows.results.map((row) => {
    const agent = toAgent(row, now);
    return {
      handle: agent.handle,
      display_name: agent.display_name,
      role: agent.role,
      title: agent.title,
      team: agent.team,
      department: agent.department,
      responsibilities: agent.responsibilities,
      status: agent.status,
      spent_month_micros: agent.spent_month_micros,
      monthly_micros: agent.budget.monthly_micros,
    };
  });
}

/** The agent's latest sessions in this conversation, one line each. */
async function sessionsHere(db: D1Database, agentId: string, channelId: string): Promise<string | null> {
  const rows = await db
    .prepare(
      "SELECT id, title, status, summary, created_at FROM agent_sessions WHERE agent_id = ? AND channel_id = ? AND parent_id IS NULL ORDER BY created_at DESC LIMIT 5",
    )
    .bind(agentId, channelId)
    .all<{ id: string; title: string; status: string; summary: string | null; created_at: string }>();
  if (!rows.results.length) return null;
  return rows.results
    .map((s) => `- "${s.title}" (${s.status}, ${s.created_at.slice(0, 10)})${s.summary ? `: ${s.summary.replace(/\s+/g, " ").slice(0, 300)}` : ""}`)
    .join("\n");
}

/**
 * Consulting a colleague (docs/WORKSPACE.md, "Agents know each other"):
 * the colleague answers in a nested turn that posts nothing, with the same
 * audience (so it can read no more than the conversation may), the same
 * asker, one hop further, its own routing limits, on the same model
 * session, billed to this reply. A compact card in the thread says who
 * asked whom. Consults don't nest: the colleague can't consult in turn.
 */
function consulting(input: {
  db: D1Database;
  row: Row;
  delivery: DeskWork;
  send: Send;
  policy: Policy;
  ownModel: boolean;
  sessionModel: string | null;
  own: string | null;
  ports: (consult: ToolPorts["consult"]) => ToolPorts;
  hops: number;
  now: Date;
  surface: Surface;
  asker: { name: string; display_name: string | null; access: NonNullable<AgentDelivery["asker"]> | null };
  spent: { tokens: Tokens; cost: number };
}): { ask: ToolPorts["consult"]; attach(box: ToolBox): void } {
  let parent: ToolBox | null = null;
  const noNesting: ToolPorts["consult"] = async () => ({ ok: false, message: "Consults don't nest: answer with what you have." });
  const ask: ToolPorts["consult"] = async (handle, question) => {
    const { row, delivery } = input;
    const colleague = await input.db
      .prepare("SELECT * FROM agents WHERE workspace_id = ? AND handle = ? AND archived_at IS NULL")
      .bind(row.workspace_id, handle)
      .first<Row>();
    if (!colleague || colleague.id === row.id) return { ok: false, message: `There is no other agent called @${handle} here.` };
    // No ping-pong: never back to the agent that sent this work.
    if ((delivery.chain ?? []).at(-1) === colleague.id) return { ok: false, message: `@${handle} sent you this work; answer with what you have.` };
    if (input.hops + 1 > CHAT_MAX_HOPS) return { ok: false, message: "This request has been passed along too many times; answer with what you have." };
    const definition = definitionOf(colleague);
    const allowed = allowedProviders(definition.routing, input.own);
    if (input.ownModel ? !allowed.own : !allowed.hosted) return { ok: false, message: `@${handle} can't use the model this conversation runs on.` };
    const model = replyModel(
      input.policy,
      { ...definition.routing, pinned: input.ownModel ? definition.routing.pinned : null },
      { named: input.ownModel ? input.sessionModel : null },
    );
    const tools = parent
      ? parent.forColleague(input.ports(noNesting), { agentId: colleague.id, notConsult: [colleague.handle, row.handle], hops: input.hops + 1, maxHops: input.hops + 1 })
      : null;
    const system = systemPrompt({
      agent: { ...definition, id: colleague.id },
      workspace: delivery.workspace,
      channel: { kind: delivery.channel_kind, name: delivery.channel_name },
      asker: input.asker,
      today: input.now,
      tools: tools ? { code: tools.definitions().some((tool) => tool.name === "read_file") } : null,
      consultedBy: row.handle,
    });
    const result = await runTurn(input.send, {
      model: model.model,
      system,
      messages: [{ role: "user", content: `@${row.handle} (agent) asks you: ${question}` }],
      tools,
      price: input.ownModel ? null : model.price,
    });
    input.spent.tokens = addTokens(input.spent.tokens, result.tokens);
    input.spent.cost += input.ownModel ? 0 : result.cost;
    const answer = result.text || "(no answer)";
    const exchange = `Q: ${question}\nA: ${answer}`;
    // The exchange, collapsed, in the thread. No @ in its text: it wakes nobody.
    await input.surface
      .post(`${row.display_name} asked ${colleague.display_name}`, {
        kind: "consult",
        title: `${row.display_name} asked ${colleague.display_name}`,
        detail: exchange.length > 1000 ? `${exchange.slice(0, 1000)}…` : exchange,
        state: null,
        href: null,
      })
      .catch((error: unknown) => console.error("agents: a consult card was not posted", String(error)));
    return { ok: true, colleague: colleague.handle, answer };
  };
  return {
    ask,
    attach(box) {
      parent = box;
    },
  };
}

type Outcome = {
  status: "replied" | "steered" | "blocked" | "skipped" | "failed";
  error?: string | null;
  reply_id?: string | null;
  model?: string | null;
  tier?: string | null;
  tokens?: Tokens;
  cost?: number;
  charged?: number;
};

/**
 * What a desk is handed: a message to answer, or (`hello`) the agent's
 * first message to the person who made it, in the DM that just opened.
 */
export type DeskWork = AgentDelivery & { hello?: boolean };

/** How a limit's refusal reads in chat, in the agent's voice. */
function noticeFor(reason: string, message: string): string {
  if (reason.startsWith("budget_") || reason === "workspace_agent_budget" || message.startsWith("My settings") || message.startsWith("I ")) return message;
  if (reason === "no_model") return `I can't reply yet: ${message}`;
  return `I can't reply right now: ${message}`;
}

/** The session a message in this thread is for: a reply under one of this agent's session cards. */
async function steeredSession(db: D1Database, agentId: string, threadRoot: string | null): Promise<SessionRow | null> {
  if (!threadRoot) return null;
  const found = await db.prepare("SELECT id FROM agent_sessions WHERE agent_id = ? AND card_message_id = ?").bind(agentId, threadRoot).first<{ id: string }>();
  return found ? sessionRow(db, found.id) : null;
}

/**
 * Answers `delivery` as its agent. Never throws: every way it ends is
 * recorded on the reply's row. A message handed over twice is answered
 * once.
 */
export async function reply(env: ReplyEnv, delivery: DeskWork, now = new Date()): Promise<void> {
  const db = env.DB;
  const row = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(delivery.agent_id).first<Row>();
  if (!row || row.archived_at || row.workspace_id !== delivery.workspace_id) return;
  const id = newId("arp", now.getTime());
  const claimed = await db
    .prepare(
      `INSERT INTO agent_replies (id, agent_id, workspace_id, channel_id, message_id, asked_by, asked_by_username, channel_name, agent_version, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?)
       ON CONFLICT (agent_id, message_id) DO NOTHING RETURNING id`,
    )
    .bind(id, row.id, row.workspace_id, delivery.channel_id, delivery.message_id, delivery.asked_by, delivery.asker?.username ?? null, delivery.channel_name, row.version, now.toISOString())
    .first<{ id: string }>();
  if (!claimed) return;

  const surface = surfaceFor(env.CHAT, delivery);
  // 👀 as soon as the desk has it, while everything else goes on.
  const acknowledging = surface.acknowledge();
  const slug = delivery.workspace.toLowerCase();

  // What the answer used, once there is one: counted however the reply ends.
  let usage: Partial<Outcome> = {};
  // What the tools did, for the audit table, and who the audience was.
  let toolCalls: ToolCall[] = [];
  let audienceHash: string | null = null;

  const finish = async (outcome: Outcome) => {
    const statements = [
      db
        .prepare(
          `UPDATE agent_replies SET status = ?, error = ?, reply_id = ?, model = ?, tier = ?, input_tokens = ?, output_tokens = ?,
             cost_micros = ?, charged_micros = ?, tool_count = ?, finished_at = ? WHERE id = ?`,
        )
        .bind(
          outcome.status,
          outcome.error?.slice(0, 1000) ?? null,
          outcome.reply_id ?? null,
          outcome.model ?? null,
          outcome.tier ?? null,
          (outcome.tokens?.input ?? 0) + (outcome.tokens?.cacheRead ?? 0) + (outcome.tokens?.cacheWrite ?? 0),
          outcome.tokens?.output ?? 0,
          outcome.cost ?? 0,
          outcome.charged ?? 0,
          toolCalls.length,
          new Date().toISOString(),
          id,
        ),
      // Every tool call: what was asked, for whom, and whether it was read or withheld.
      ...toolCalls.map((call, n) =>
        db
          .prepare(
            `INSERT INTO agent_tool_calls (id, reply_id, agent_id, workspace_id, asked_by, tool, args, audience_hash, outcome, bytes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(`${id}_${n}`, id, row.id, row.workspace_id, delivery.asked_by, call.tool, call.args, audienceHash ?? "", call.outcome, call.bytes, now.toISOString()),
      ),
    ];
    await db.batch(statements);
    // ✅ when it answered; 👀 taken back after a notice, an apology or nothing.
    await acknowledging;
    await surface.settle(outcome.status === "replied" || outcome.status === "steered" ? "done" : "withdrawn");
  };

  /** Says once, in this conversation, why the agent cannot answer; a repeat within hours is kept back. */
  const notice = async (message: string, reason: string) => {
    // An agent's first words are never an excuse: without a model, a fixed hello.
    if (delivery.hello) {
      const posted = await surface.post(fixedHello(row, delivery.asker?.username ?? null)).catch(() => null);
      return await finish({ status: "blocked", error: reason, reply_id: posted });
    }
    const since = new Date(now.getTime() - NOTICE_QUIET_MS).toISOString();
    const recent = await db
      .prepare(
        `SELECT 1 FROM agent_replies WHERE agent_id = ? AND channel_id = ? AND status = 'blocked' AND error = ?
           AND reply_id IS NOT NULL AND created_at > ? AND id <> ? LIMIT 1`,
      )
      .bind(row.id, delivery.channel_id, reason, since, id)
      .first();
    const posted = recent ? null : await surface.post(message).catch(() => null);
    await finish({ status: "blocked", error: reason, reply_id: posted });
  };

  try {
    // A reply under one of its session cards steers that session; nothing is answered here.
    const steered = delivery.hello ? null : await steeredSession(db, row.id, delivery.thread_root);
    if (steered) {
      const history = await surface.history(HISTORY_LIMIT).catch(() => [] as SurfaceMessage[]);
      const message = history.find((m) => m.id === delivery.message_id);
      if (message?.body.trim()) {
        await steer(env as unknown as SessionEnv, steered, message.author.name, message.body);
        return await finish({ status: "steered" });
      }
    }

    // Read the conversation while showing that the agent is on it.
    // A hello has no conversation yet: it is asked to introduce itself.
    const [, history] = await Promise.all([surface.typing(), delivery.hello ? Promise.resolve([]) : surface.history(HISTORY_LIMIT)]);
    const conversation = delivery.hello ? [{ role: "user" as const, content: helloAsk(delivery.asker?.username ?? null) }] : turns(history, row.id);
    if (!conversation.length) return await finish({ status: "skipped", error: "nothing to answer" });
    const author = askerIn(history, delivery);
    const askerName = delivery.asker?.username ?? author?.name ?? null;
    // Every agent knows its colleagues; @g1t also steps up a tier to decide
    // who gets the work in a long thread.
    const specialists = await team(db, row.workspace_id, row.id, now);
    const start = row.builtin ? orchestratorTier(history.length, specialists.filter((a) => a.handle !== "g1t").length) : REPLY_TIER;
    const definition = definitionOf(row);
    const hops = Math.max(0, Math.floor(delivery.hops || 0));
    const chain = delivery.chain ?? [];
    const sender = chain.length ? await db.prepare("SELECT handle FROM agents WHERE id = ?").bind(chain[chain.length - 1]).first<{ handle: string }>() : null;
    const asker = { name: askerName ?? "someone", display_name: author?.display_name ?? null, access: delivery.asker ?? null };
    let posted: string | null = null;
    let spinOffs = 0;

    const done = await metered(env, { row, payer: row, slug, task: "reply", start, askerName }, async (model) => {
      // What colleagues consulted along the way used: billed to this reply.
      const consulted = { tokens: NO_TOKENS, cost: 0 };
      let toolbox: ToolBox | null = null;
      let place: RecallPlace = { channel_id: delivery.channel_id, kind: delivery.channel_kind === "dm" ? "dm" : "private", people: [delivery.asked_by] };
      if (!delivery.hello) {
        try {
          const audience = await Audience.build(slug, delivery.asked_by, audiencePorts(env, slug, delivery.channel_id));
          place = { channel_id: delivery.channel_id, kind: audience.kind, people: audience.shared ? [delivery.asked_by] : audience.members.map((m) => m.id) };
          const ports = (consult: ToolPorts["consult"]) => toolPorts(env, slug, row.workspace_id, delivery.channel_id, consult, row.id);
          audienceHash = audience.hash;
          const consult = consulting({
            db,
            row,
            delivery,
            send: model.send,
            policy: model.policy,
            ownModel: model.ownModel,
            sessionModel: model.sessionModel,
            own: model.own,
            ports,
            hops,
            now,
            surface,
            asker,
            spent: consulted,
          });
          const where = delivery.channel_kind === "dm" ? "a direct message" : `#${delivery.channel_name ?? "a channel"}`;
          const actions = actionPorts(env as unknown as SessionEnv, {
            agent: row,
            place,
            source: { kind: "message", ref: delivery.message_id, label: askerName ? `@${askerName} in ${where}` : where, channel_id: delivery.channel_id },
            asker: { id: delivery.asked_by, username: askerName },
            workspace: slug,
            postCard: (card) => surface.post("", card).catch(() => null),
            // Real work becomes a session, with its card in this conversation.
            spinOff: async (title, goal) => {
              if (spinOffs >= MAX_SPIN_OFFS) return { ok: false, message: "You've started enough sessions from this message." };
              spinOffs++;
              const session = await startSession(env as unknown as SessionEnv, {
                agent: row,
                kind: "chat",
                title,
                goal: `${askerName ? `@${askerName}` : "Someone"} asked in ${where}:\n\n${goal}`,
                workspace: slug,
                channel_id: delivery.channel_id,
                channel_kind: delivery.channel_kind,
                channel_name: delivery.channel_name,
                thread_root: delivery.thread_root,
                message_id: delivery.message_id,
                asked_by: delivery.asked_by,
                asked_by_username: askerName,
                asker: delivery.asker ?? null,
                chain: [...chain],
                hops,
              });
              const cap = session.cap_micros ? ` with a cap of ${dollars(session.cap_micros)}` : "";
              return { ok: true, message: `Started the session "${session.title}"${cap}. Its card is in the conversation and it reports back there. Tell them in a sentence; don't do the work here.` };
            },
          });
          toolbox = new ToolBox(
            audience,
            ports(consult.ask),
            { agentId: row.id, notConsult: [row.handle, ...(sender ? [sender.handle] : [])], hops, maxHops: CHAT_MAX_HOPS },
            [],
            actions,
          );
          consult.attach(toolbox);
        } catch (error) {
          // Without an audience nothing may be read: the reply goes on with this conversation only.
          console.error("agents: no audience for a reply, so no tools", row.id, String(error));
        }
      }
      // What people said last, for recalling what Docs say about it.
      const said = [...history].reverse().filter((m) => m.author.kind === "user").slice(0, 3).map((m) => m.body);
      const [facts, recent, passages] = delivery.hello
        ? [[], null, []]
        : await Promise.all([
            recall(db, row.id, place).catch(() => []),
            sessionsHere(db, row.id, delivery.channel_id).catch(() => null),
            toolbox ? toolbox.recall(recallQuery(said), definition.reading ?? []) : Promise.resolve([]),
          ]);
      const system = [
        systemPrompt({
          agent: {
            ...definition,
            id: row.id,
            // @g1t's job is fixed; what the workspace wrote is added to it.
            instructions: row.builtin ? orchestratorInstructions(specialists.filter((a) => a.handle !== "g1t"), definition.instructions) : definition.instructions,
          },
          workspace: delivery.workspace,
          channel: { kind: delivery.channel_kind, name: delivery.channel_name },
          asker,
          today: now,
          tools: toolbox ? { code: toolbox.definitions().some((tool) => tool.name === "read_file") } : null,
          // @g1t's team is in its job; everyone else is told who their colleagues are.
          colleagues: row.builtin ? null : rosterLines(specialists),
          recentSessions: recent,
        }),
        memorySection(facts),
        recallSection(passages),
      ]
        .filter(Boolean)
        .join("\n\n");
      toolCalls = toolbox?.calls ?? [];
      const answer = await runTurn(model.send, { model: model.model.model, system, messages: conversation as ModelMessage[], tools: toolbox, price: model.ownModel ? null : model.model.price });
      // Post as soon as there is an answer; the bill is settled after.
      if (answer.text) {
        // At most two specialists woken by one of @g1t's messages: a rail, not only a rule in its prompt.
        const text = row.builtin ? capMentions(answer.text, specialists.map((agent) => agent.handle)) : answer.text;
        posted = await surface.post(text);
      }
      return {
        text: answer.text,
        tokens: addTokens(answer.tokens, consulted.tokens),
        cost: (model.ownModel ? 0 : answer.cost) + consulted.cost,
        rounds: answer.rounds,
      };
    });

    if (!done.ok) return await notice(noticeFor(done.reason, done.message), done.reason);
    usage = { model: done.model, tier: done.tier, tokens: done.tokens, cost: done.cost, charged: done.charged };
    if (!done.value.text) {
      const apology = await surface.post(APOLOGY).catch(() => null);
      return await finish({ status: "failed", error: "the model gave no text", reply_id: apology, ...usage });
    }
    await finish({ status: "replied", reply_id: posted, ...usage });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("agents: a reply failed", row.id, delivery.message_id, message);
    const posted = await surface.post(APOLOGY).catch(() => null);
    await finish({ status: "failed", error: message, reply_id: posted, ...usage }).catch((failure: unknown) =>
      console.error("agents: a failed reply was not recorded", id, String(failure)),
    );
  }
}
