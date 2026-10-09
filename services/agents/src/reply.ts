/**
 * One reply: an agent answering a message in chat, in this Worker, with no
 * sandbox (docs/WORKSPACE.md, "Two kinds of turn").
 *
 * A reply goes through the same doors an agent run does, so there is one
 * way g1t meters and bills model work:
 *
 * 1. The agent's own monthly and daily caps (`budget.ts`).
 * 2. Whether it may use a model at all: g1t's hosted models are open as
 *    the runner decides (`hostedOpen`, `HOSTED_AGENT_WORKSPACES` and
 *    billing's status), or the workspace's own provider; the agent's
 *    `providers` narrows that.
 * 3. A model session from integrations (`openModelSession`, task `reply`),
 *    which picks g1t's gateway or the workspace's own provider by the
 *    workspace's model routes, as for a run.
 * 4. The compute gate's reservation (`ComputeGate.admit`, kind `agent`):
 *    the workspace's spend limit, AI credit, pauses and g1t's breaker.
 * 5. A billing run (`start_run`), so the reply is charged as Agent tokens:
 *    the model at the provider's price on g1t's models, plus the agent rate
 *    on every token; comped terms and discounts are billing's.
 * 6. The model call through the model proxy (the `MODELS` binding, or
 *    `MODELS_URL` without one), with the session's token, exactly as a
 *    sandbox makes it: the proxy holds the keys, caps the session, and
 *    reports its tokens to billing.
 * 7. `finish_run` with the reply's cost and tokens, and the reservation
 *    settled at cost.
 *
 * Whatever happens, the reply's row says so: replied, blocked (with one
 * short notice in the conversation, not repeated), skipped or failed (with
 * one short apology).
 */
import {
  type AgentDelivery,
  type ModelSession,
  type RunTicket,
  type ServiceBinding,
  ComputeGate,
  MODEL_ESTIMATE_MICROS,
  billingClient,
  integrationsClient,
  newId,
} from "@g1t/contracts";

import { CHAT_MAX_HOPS } from "../../../packages/contracts/src/chat.ts";
import { hostedOpen } from "../../runner/src/hosted.ts";
import { type AgentRouting as Policy, routingReader } from "../../runner/src/model-env.ts";
import { type Spent, type Tokens, budgetBlock, chargedMicros, costMicros, replyCapMicros, totalTokens } from "./budget.ts";
import { HISTORY_LIMIT, fixedHello, helloAsk, systemPrompt, turns } from "./prompt.ts";
import { BUILTIN_NO_MODEL, type Specialist, capMentions, orchestratorInstructions, orchestratorTier } from "./orchestrator.ts";
import { REPLY_TIER, allowedProviders, replyModel } from "./routing.ts";
import { type Row, definitionOf, periods, selectAgents, spendStatements, toAgent } from "./store.ts";
import { type SurfaceMessage, surfaceFor } from "./surface.ts";
import { Audience } from "./audience.ts";
import { audiencePorts, toolPorts } from "./ports.ts";
import { rosterLines } from "./orchestrator.ts";
import { type ToolCall, type ToolPorts, ToolBox } from "./tools.ts";
import type { Surface } from "./surface.ts";
import { type ModelAnswer, type ModelMessage, type Send, NO_TOKENS, addTokens, runTurn } from "./turn.ts";

export type ReplyEnv = {
  DB: D1Database;
  CHAT: ServiceBinding;
  /** People and their access, for the audience; members and teams for the roster. */
  IDENTITY: ServiceBinding;
  /** Code, for read tools. */
  REPOS: ServiceBinding;
  /** Issues and pull requests, for read tools. */
  WORK: ServiceBinding;
  /** Code search, for read tools. */
  SEARCH: ServiceBinding;
  BILLING: ServiceBinding;
  INTEGRATIONS: ServiceBinding;
  /** The model proxy, by service binding: how replies reach a model. */
  MODELS?: ServiceBinding;
  HOSTED_AGENT_WORKSPACES: string;
  AGENT_ROUTING: string;
  /** The model proxy by address, only where there is no `MODELS` binding (a self-hosted install pointing elsewhere). */
  MODELS_URL?: string;
};

/** The longest one model answer may take. */
const MODEL_TIMEOUT_MS = 90_000;
/** A notice that the agent cannot reply is posted once per conversation in this long. */
const NOTICE_QUIET_MS = 6 * 60 * 60 * 1000;

const APOLOGY = "Sorry, something went wrong on my side and I couldn't answer that. Try again in a moment.";

/** Staff's model defaults on top of `AGENT_ROUTING`, read at most once a minute, as in the runner. */
const routingNow = routingReader();
let gate: ComputeGate | null = null;

/**
 * Where a reply's spend shows in billing: the workspace, under the agent.
 * Billing keys runs and reservations by a repository; no repository is
 * named with an `@`, so the agent's line never mixes with a project's.
 */
export function billingRepo(workspace: string, handle: string): { namespace: string; name: string } {
  return { namespace: workspace.toLowerCase(), name: `@${handle}` };
}

async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
  return (await response.json()) as T;
}

type PriceTerms = { marginPercent: number; rate: number; rateOwn: number };
let terms: { value: PriceTerms; until: number } | null = null;

/** The model margin and the agent rates from billing's price book, kept ten minutes. */
async function priceTerms(billing: ServiceBinding): Promise<PriceTerms> {
  if (terms && terms.until > Date.now()) return terms.value;
  type Book = { prices?: { meter: string; priceMicros?: number; price_micros?: number }[]; modelMarginPercent?: number; model_margin_percent?: number };
  const book = await rpc<Book>(billing, "prices", {}).catch(() => null);
  const price = (meter: string) => {
    const found = book?.prices?.find((p) => p.meter === meter);
    return found?.priceMicros ?? found?.price_micros ?? 0;
  };
  const value = {
    marginPercent: book?.modelMarginPercent ?? book?.model_margin_percent ?? 0,
    rate: price("agent_tokens"),
    rateOwn: price("agent_tokens_own"),
  };
  // A failed read is tried again in a minute, not kept.
  terms = { value, until: Date.now() + (book ? 10 * 60_000 : 60_000) };
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * How a reply asks the model: one Messages API request through the model
 * proxy, with the model session's token, non-streamed.
 */
function sendFor(env: ReplyEnv, token: string): Send {
  // The binding, not the proxy's public address: a Worker fetching another
  // Worker's domain on the same zone can be refused or loop. The proxy reads
  // only the path and the token, so the host does not matter.
  const path = "/anthropic/v1/messages";
  const fetcher = (url: string, init: RequestInit) => (env.MODELS ? env.MODELS.fetch(url, init) : fetch(url, init));
  return async (body) => {
    const response = await fetcher(env.MODELS ? `https://models${path}` : `${env.MODELS_URL!.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    const json = (await response.json().catch(() => null)) as (ModelAnswer & { error?: { message?: string } }) | null;
    if (!response.ok || !json) throw new Error(`the model answered ${response.status}: ${json?.error?.message ?? "no answer"}`);
    return json;
  };
}

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
  status: "replied" | "blocked" | "skipped" | "failed";
  error?: string | null;
  reply_id?: string | null;
  model?: string | null;
  tier?: string | null;
  tokens?: Tokens;
  cost?: number;
  charged?: number;
};

/**
 * Answers `delivery` as its agent. Never throws: every way it ends is
 * recorded on the reply's row. A message handed over twice is answered
 * once.
 */
/**
 * What a desk is handed: a message to answer, or (`hello`) the agent's
 * first message to the person who made it, in the DM that just opened.
 */
export type DeskWork = AgentDelivery & { hello?: boolean };

export async function reply(env: ReplyEnv, delivery: DeskWork, now = new Date()): Promise<void> {
  const db = env.DB;
  const row = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(delivery.agent_id).first<Row>();
  if (!row || row.archived_at || row.workspace_id !== delivery.workspace_id) return;
  const id = newId("arp", now.getTime());
  const claimed = await db
    .prepare(
      `INSERT INTO agent_replies (id, agent_id, workspace_id, channel_id, message_id, asked_by, agent_version, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'working', ?)
       ON CONFLICT (agent_id, message_id) DO NOTHING RETURNING id`,
    )
    .bind(id, row.id, row.workspace_id, delivery.channel_id, delivery.message_id, delivery.asked_by, row.version, now.toISOString())
    .first<{ id: string }>();
  if (!claimed) return;

  const surface = surfaceFor(env.CHAT, delivery);
  // 👀 as soon as the desk has it, while everything else goes on.
  const acknowledging = surface.acknowledge();
  const slug = delivery.workspace.toLowerCase();
  const billing = billingClient(env.BILLING);
  const integrations = integrationsClient(env.INTEGRATIONS);
  gate ??= new ComputeGate(env.BILLING);

  let session: ModelSession | null = null;
  let reservation: string | null = null;
  let settled = false;
  // What the answer used, once there is one: counted however the reply ends.
  let usage: Partial<Outcome> = {};
  // What the read tools did, for the audit table, and who the audience was.
  let toolCalls: ToolCall[] = [];
  let audienceHash: string | null = null;
  // What colleagues consulted along the way used: billed to this reply.
  const consulted = { tokens: NO_TOKENS, cost: 0 };

  const finish = async (outcome: Outcome) => {
    const charged = outcome.charged ?? 0;
    const statements = [
      db
        .prepare(
          `UPDATE agent_replies SET status = ?, error = ?, reply_id = ?, model = ?, tier = ?, input_tokens = ?, output_tokens = ?,
             cost_micros = ?, charged_micros = ?, finished_at = ? WHERE id = ?`,
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
          charged,
          new Date().toISOString(),
          id,
        ),
      ...(charged > 0 ? spendStatements(db, row.id, charged, now) : []),
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
    await surface.settle(outcome.status === "replied" ? "done" : "withdrawn");
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
    if (!env.MODELS && !env.MODELS_URL) return await notice("I can't reply here: this installation has no model proxy set up.", "no_models_url");
    const definition = definitionOf(row);
    const [month, day] = periods(now);
    const spentRows = await db
      .prepare("SELECT period, micros FROM agent_spend WHERE agent_id = ? AND period IN (?, ?)")
      .bind(row.id, month, day)
      .all<{ period: string; micros: number }>();
    const spent: Spent = {
      month: spentRows.results.find((r) => r.period === month)?.micros ?? 0,
      day: spentRows.results.find((r) => r.period === day)?.micros ?? 0,
    };

    // 1. The agent's own caps.
    const blocked = budgetBlock(definition.budget, spent, now);
    if (blocked) return await notice(blocked.message, `budget_${blocked.cap}`);

    // 2. Whether it may use a model at all.
    const [own, status] = await Promise.all([
      integrations.modelProvider(slug).catch(() => null),
      billing.status().catch(() => ({ enabled: false, live: false })),
    ]);
    const allowed = allowedProviders(definition.routing, own?.id ?? null);
    const mayHosted = hostedOpen(slug, env.HOSTED_AGENT_WORKSPACES, status) && allowed.hosted;
    if (!mayHosted && !allowed.own) {
      const why = own
        ? "My settings don't let me use any model this workspace has. An owner can change my providers on my profile."
        : allowed.hosted
          ? row.builtin
            ? BUILTIN_NO_MODEL
            : "I can't reply yet: g1t's hosted models aren't open to this workspace, and it has no model provider of its own. An owner can connect one under Integrations."
          : "My settings let me use only this workspace's own model providers, and it has none. An owner can connect one under Integrations, or change my providers on my profile.";
      return await notice(why, "no_model");
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

    // 3. A model session, routed by the workspace's model routes.
    const repo = billingRepo(slug, row.handle);
    const policy = await routingNow(env.AGENT_ROUTING, () => billing.modelDefaults());
    const provisional = replyModel(policy, { ...definition.routing, pinned: null }, { start });
    const opened = await integrations.openModelSession({
      workspace: slug,
      repo,
      number: 0,
      task: "reply",
      hostedOpen: mayHosted,
      tier: provisional.tier,
      requestedBy: askerName,
    });
    if (!opened.ok) return await notice(`I can't reply right now: ${opened.error.message}`, "model_route");
    session = opened.value;
    const ownModel = session.billedTo === "workspace";
    if (ownModel ? !allowed.own : !mayHosted) {
      return await notice(
        "This workspace routes replies to a model my settings don't allow. An owner can change my providers on my profile, or the workspace's model routes under Integrations.",
        "provider_not_allowed",
      );
    }
    // A pinned model is for the workspace's own endpoints; on g1t's models the tier decides.
    const model = replyModel(
      policy,
      { ...definition.routing, pinned: ownModel ? definition.routing.pinned : null },
      { chosen: session.tierChoice ?? null, named: ownModel ? session.model : null, start },
    );

    // 4. The workspace's own limits, through the compute gate.
    const ent = await gate.entitlements(slug);
    const admission = await gate.admit(
      { workspace: slug, repo, public: false, kind: "agent", estimateMicros: ownModel ? 0 : MODEL_ESTIMATE_MICROS.reply, hostedModel: !ownModel },
      ent,
    );
    if (!admission.ok) return await notice(`I can't reply right now: ${admission.message}`, `workspace_${admission.code}`);
    reservation = admission.reservation?.id ?? null;

    // 5. The run the reply is billed as.
    const named = ownModel && session.model ? session.model : null;
    const started = await billing.startRun({
      workspace: slug,
      repo,
      number: 0,
      task: "reply",
      model: ownModel ? `${model.modelName} (${session.providerName ?? "own provider"})` : model.modelName,
      billedTo: ownModel ? "workspace" : "g1t",
      session: session.id,
      tier: named ? null : model.tier,
    });
    if (!started.ok) return await notice(`I can't reply right now: ${started.error.message}`, "billing");
    const ticket: RunTicket | null = started.value;
    const cap = replyCapMicros(definition.budget, spent, ent && ent.runCapMicros > 0 ? ent.runCapMicros : null);
    if (cap) await integrations.capModelSessions([await sha256Hex(session.token)], cap).catch(() => 0);

    // 6. The answer, with read tools within the audience (a hello reads nothing).
    const send = sendFor(env, session.token);
    const hops = Math.max(0, Math.floor(delivery.hops || 0));
    const chain = delivery.chain ?? [];
    const sender = chain.length ? await db.prepare("SELECT handle FROM agents WHERE id = ?").bind(chain[chain.length - 1]).first<{ handle: string }>() : null;
    let toolbox: ToolBox | null = null;
    if (!delivery.hello) {
      try {
        const audience = await Audience.build(slug, delivery.asked_by, audiencePorts(env, slug, delivery.channel_id));
        const ports = (consult: ToolPorts["consult"]) => toolPorts(env, slug, row.workspace_id, delivery.channel_id, consult);
        // A colleague's answer for this agent: a nested turn that posts nothing.
        audienceHash = audience.hash;
        const consult = consulting({
          db,
          row,
          delivery,
          send,
          policy,
          ownModel,
          sessionModel: session.model,
          own: own?.id ?? null,
          ports,
          hops,
          now,
          surface,
          asker: { name: askerName ?? "someone", display_name: author?.display_name ?? null, access: delivery.asker ?? null },
          spent: consulted,
        });
        toolbox = new ToolBox(audience, ports(consult.ask), {
          agentId: row.id,
          notConsult: [row.handle, ...(sender ? [sender.handle] : [])],
          hops,
          maxHops: CHAT_MAX_HOPS,
        });
        consult.attach(toolbox);
      } catch (error) {
        // Without an audience nothing may be read: the reply goes on with this conversation only.
        console.error("agents: no audience for a reply, so no tools", row.id, String(error));
      }
    }
    const system = systemPrompt({
      agent: {
        ...definition,
        id: row.id,
        // @g1t's job is fixed; what the workspace wrote is added to it.
        instructions: row.builtin ? orchestratorInstructions(specialists.filter((a) => a.handle !== "g1t"), definition.instructions) : definition.instructions,
      },
      workspace: delivery.workspace,
      channel: { kind: delivery.channel_kind, name: delivery.channel_name },
      asker: { name: askerName ?? "someone", display_name: author?.display_name ?? null, access: delivery.asker ?? null },
      today: now,
      tools: toolbox ? { code: toolbox.definitions().some((tool) => tool.name === "read_file") } : null,
      // @g1t's team is in its job; everyone else is told who their colleagues are.
      colleagues: row.builtin ? null : rosterLines(specialists),
    });
    toolCalls = toolbox?.calls ?? [];
    const answer = await runTurn(send, { model: model.model, system, messages: conversation as ModelMessage[], tools: toolbox, price: ownModel ? null : model.price });
    // Colleagues consulted along the way were billed to this reply.
    const tokens = addTokens(answer.tokens, consulted.tokens);
    const cost = (ownModel ? 0 : answer.cost) + consulted.cost;
    const priced = await priceTerms(env.BILLING);
    const charged = chargedMicros({
      costMicros: cost,
      hosted: !ownModel,
      marginPercent: priced.marginPercent,
      ratePerMillionMicros: ownModel ? priced.rateOwn : priced.rate,
      tokens: totalTokens(tokens),
    });

    // 7. Bill it, whether or not the answer could be posted: the tokens were used.
    if (ticket) {
      await rpc(env.BILLING, "finish_run", { runId: ticket.runId, token: ticket.token, costUsd: cost / 1_000_000, turns: answer.rounds, tokens }).catch(
        (error: unknown) => console.error("agents: finish_run failed", ticket.runId, String(error)),
      );
    }
    if (reservation) {
      settled = true;
      await gate.settle(reservation, cost);
    }
    usage = { model: model.modelName, tier: named ? null : model.tier, tokens, cost, charged };
    if (!answer.text) {
      const posted = await surface.post(APOLOGY).catch(() => null);
      return await finish({ status: "failed", error: "the model gave no text", reply_id: posted, ...usage });
    }
    // At most two specialists woken by one of @g1t's messages: a rail, not only a rule in its prompt.
    const text = row.builtin ? capMentions(answer.text, specialists.map((agent) => agent.handle)) : answer.text;
    const posted = await surface.post(text);
    await finish({ status: "replied", reply_id: posted, ...usage });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("agents: a reply failed", row.id, delivery.message_id, message);
    const posted = await surface.post(APOLOGY).catch(() => null);
    await finish({ status: "failed", error: message, reply_id: posted, ...usage }).catch((failure: unknown) =>
      console.error("agents: a failed reply was not recorded", id, String(failure)),
    );
  } finally {
    // What was held is given back however the reply ended, and its model
    // session's token stops working.
    if (reservation && !settled) await gate.settle(reservation, 0);
    if (session) await integrations.closeModelSessions([await sha256Hex(session.token)]).catch(() => 0);
  }
}
