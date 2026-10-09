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

import { hostedOpen } from "../../runner/src/hosted.ts";
import { routingReader } from "../../runner/src/model-env.ts";
import { type Spent, type Tokens, budgetBlock, chargedMicros, costMicros, replyCapMicros, totalTokens } from "./budget.ts";
import { HISTORY_LIMIT, audienceFor, systemPrompt, turns } from "./prompt.ts";
import { allowedProviders, replyModel } from "./routing.ts";
import { type Row, definitionOf, periods, spendStatements } from "./store.ts";
import { type SurfaceMessage, surfaceFor } from "./surface.ts";

export type ReplyEnv = {
  DB: D1Database;
  CHAT: ServiceBinding;
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
/** A chat answer is short; this bounds the cost of one that is not. */
const MAX_OUTPUT_TOKENS = 2048;
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

type Answer = { text: string; tokens: Tokens };

/** One non-streamed answer from the model proxy, in Anthropic's Messages format. */
async function askModel(
  env: ReplyEnv,
  token: string,
  body: { model: string; system: string; messages: { role: string; content: string }[] },
): Promise<Answer> {
  // The binding, not the proxy's public address: a Worker fetching another
  // Worker's domain on the same zone can be refused or loop. The proxy reads
  // only the path and the token, so the host does not matter.
  const path = "/anthropic/v1/messages";
  const send = (url: string, init: RequestInit) => (env.MODELS ? env.MODELS.fetch(url, init) : fetch(url, init));
  const response = await send(env.MODELS ? `https://models${path}` : `${env.MODELS_URL!.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ ...body, max_tokens: MAX_OUTPUT_TOKENS }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => null)) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    error?: { message?: string };
  } | null;
  if (!response.ok || !json) throw new Error(`the model answered ${response.status}: ${json?.error?.message ?? "no answer"}`);
  const text = (json.content ?? [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!.trim())
    .join("\n\n")
    .trim();
  const usage = json.usage ?? {};
  return {
    text,
    tokens: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/** Who asked, from the message that woke the agent (or their latest one). */
function askerIn(history: SurfaceMessage[], delivery: AgentDelivery): SurfaceMessage["author"] | null {
  const woken = history.find((m) => m.id === delivery.message_id);
  if (woken) return woken.author;
  return [...history].reverse().find((m) => m.author.kind === "user" && m.author.id === delivery.asked_by)?.author ?? null;
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
export async function reply(env: ReplyEnv, delivery: AgentDelivery, now = new Date()): Promise<void> {
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
  const slug = delivery.workspace.toLowerCase();
  const billing = billingClient(env.BILLING);
  const integrations = integrationsClient(env.INTEGRATIONS);
  gate ??= new ComputeGate(env.BILLING);

  let session: ModelSession | null = null;
  let reservation: string | null = null;
  let settled = false;
  // What the answer used, once there is one: counted however the reply ends.
  let usage: Partial<Outcome> = {};

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
    ];
    await db.batch(statements);
  };

  /** Says once, in this conversation, why the agent cannot answer; a repeat within hours is kept back. */
  const notice = async (message: string, reason: string) => {
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
          ? "I can't reply yet: g1t's hosted models aren't open to this workspace, and it has no model provider of its own. An owner can connect one under Integrations."
          : "My settings let me use only this workspace's own model providers, and it has none. An owner can connect one under Integrations, or change my providers on my profile.";
      return await notice(why, "no_model");
    }

    // Read the conversation while showing that the agent is on it.
    const [, history] = await Promise.all([surface.typing(), surface.history(HISTORY_LIMIT)]);
    const conversation = turns(history, row.id);
    if (!conversation.length) return await finish({ status: "skipped", error: "nothing to answer" });
    const author = askerIn(history, delivery);
    const askerName = delivery.asker?.username ?? author?.name ?? null;
    // v1 reads only this conversation, which its whole audience can read.
    // Tools, when replies get them, filter every result by this.
    void audienceFor(delivery);

    // 3. A model session, routed by the workspace's model routes.
    const repo = billingRepo(slug, row.handle);
    const policy = await routingNow(env.AGENT_ROUTING, () => billing.modelDefaults());
    const provisional = replyModel(policy, { ...definition.routing, pinned: null });
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
      { chosen: session.tierChoice ?? null, named: ownModel ? session.model : null },
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

    // 6. The answer.
    const system = systemPrompt({
      agent: { ...definition, id: row.id },
      workspace: delivery.workspace,
      channel: { kind: delivery.channel_kind, name: delivery.channel_name },
      asker: { name: askerName ?? "someone", display_name: author?.display_name ?? null, access: delivery.asker ?? null },
      today: now,
    });
    const answer = await askModel(env, session.token, { model: model.model, system, messages: conversation });
    const cost = ownModel ? 0 : costMicros(answer.tokens, model.price);
    const priced = await priceTerms(env.BILLING);
    const charged = chargedMicros({
      costMicros: cost,
      hosted: !ownModel,
      marginPercent: priced.marginPercent,
      ratePerMillionMicros: ownModel ? priced.rateOwn : priced.rate,
      tokens: totalTokens(answer.tokens),
    });

    // 7. Bill it, whether or not the answer could be posted: the tokens were used.
    if (ticket) {
      await rpc(env.BILLING, "finish_run", { runId: ticket.runId, token: ticket.token, costUsd: cost / 1_000_000, turns: 1, tokens: answer.tokens }).catch(
        (error: unknown) => console.error("agents: finish_run failed", ticket.runId, String(error)),
      );
    }
    if (reservation) {
      settled = true;
      await gate.settle(reservation, cost);
    }
    usage = { model: model.modelName, tier: named ? null : model.tier, tokens: answer.tokens, cost, charged };
    if (!answer.text) {
      const posted = await surface.post(APOLOGY).catch(() => null);
      return await finish({ status: "failed", error: "the model gave no text", reply_id: posted, ...usage });
    }
    const posted = await surface.post(answer.text);
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
