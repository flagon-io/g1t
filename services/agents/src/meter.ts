/**
 * Metered model work: the one door every reply and every session step goes
 * through, so g1t meters and bills an agent's model work one way
 * (docs/WORKSPACE.md, "Budgets").
 *
 * 1. The paying agent's own monthly and daily caps (`budget.ts`), and the
 *    workspace's budget for all its agents together (`policy.ts`).
 * 2. Whether the agent may use a model at all: g1t's hosted models are open
 *    as the runner decides (`hostedOpen`, `HOSTED_AGENT_WORKSPACES` and
 *    billing's status), or the workspace's own provider; the agent's
 *    `providers` narrows that.
 * 3. A model session from integrations (`openModelSession`), routed by the
 *    workspace's model routes, as for a run.
 * 4. The compute gate's reservation (`ComputeGate.admit`, kind `agent`):
 *    the workspace's spend limit, AI credit, pauses and g1t's breaker.
 * 5. A billing run (`start_run`), so the work is charged as Agent tokens on
 *    the workspace's bill, under the paying agent.
 * 6. The work itself, through the model proxy with the session's token.
 * 7. `finish_run` with its cost and tokens, the reservation settled at
 *    cost, and the charge added to the paying agent's and the workspace's
 *    agent spend.
 *
 * Who does the work and who pays can differ: a colleague brought into a
 * session, or a subagent, works on the budget of the agent at the root of
 * the session's tree, so a chain never escapes the budget that started it.
 */
import { type ModelSession, type ModelTier, type RunTicket, ComputeGate, MODEL_ESTIMATE_MICROS, billingClient, integrationsClient } from "@g1t/contracts";

import { hostedOpen } from "../../runner/src/hosted.ts";
import { type AgentRouting as Policy, routingReader } from "../../runner/src/model-env.ts";
import { type Spent, type Tokens, budgetBlock, chargedMicros, replyCapMicros, totalTokens } from "./budget.ts";
import { BUILTIN_NO_MODEL } from "./orchestrator.ts";
import { type PolicyRow, policyBlock, readPolicy, workspaceSpendStatements } from "./policy.ts";
import { type ReplyModel, allowedProviders, replyModel } from "./routing.ts";
import { type Row, definitionOf, periods, spendStatements } from "./store.ts";
import type { ModelAnswer, Send } from "./turn.ts";
import type { ServiceBinding } from "@g1t/contracts";

export type MeterEnv = {
  DB: D1Database;
  BILLING: ServiceBinding;
  INTEGRATIONS: ServiceBinding;
  MODELS?: ServiceBinding;
  MODELS_URL?: string;
  HOSTED_AGENT_WORKSPACES: string;
  AGENT_ROUTING: string;
};

/** The longest one model answer may take. */
const MODEL_TIMEOUT_MS = 120_000;

/** Staff's model defaults on top of `AGENT_ROUTING`, read at most once a minute, as in the runner. */
const routingNow = routingReader();
let gate: ComputeGate | null = null;

/**
 * Where an agent's spend shows in billing: the workspace, under the agent
 * that pays. Billing keys runs and reservations by a repository; no
 * repository is named with an `@`, so the agent's line never mixes with a
 * project's.
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

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * How work asks the model: one Messages API request through the model
 * proxy, with the model session's token, non-streamed.
 */
function sendFor(env: MeterEnv, token: string): Send {
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

/** What the work is given: how to ask the model, and on what. */
export type Model = {
  send: Send;
  model: ReplyModel;
  /** The workspace's own provider pays for the model (g1t charges only the agent rate). */
  ownModel: boolean;
  policy: Policy;
  /** The model the workspace's route names, on its own provider. */
  sessionModel: string | null;
  /** The workspace's own model connection, if any. */
  own: string | null;
};

/** What the work used: its own tokens and cost, and any it spent for others (consults). */
export type WorkUsage = { tokens: Tokens; cost: number; rounds: number };

export type MeterInput = {
  /** The agent doing the work. */
  row: Row;
  /** The agent whose budget pays; the same agent unless this is part of another's session. */
  payer: Row;
  /** The workspace's slug. */
  slug: string;
  task: "reply" | "session";
  /** The tier the work starts on, before the agent's limits. */
  start: ModelTier;
  /** Who asked, by username, for billing's record. */
  askerName: string | null;
  /** What is left of a session's cap, so one step never overruns it. */
  leftMicros?: number | null;
  /** Agent tier limits narrower than the agent's own (a subagent's). */
  limits?: { floor: ModelTier | null; ceiling: ModelTier | null } | null;
};

export type MeterBlock = { ok: false; reason: string; message: string };
export type MeterDone<T> = { ok: true; value: T; model: string; tier: ModelTier | null; tokens: Tokens; cost: number; charged: number };

/**
 * Runs `work` as metered model work for `input.row`, paid by
 * `input.payer`: checks every limit, opens and closes the model session,
 * bills it, and records the spend. A limit that says no comes back as a
 * block with what to tell people, before anything was spent. Whatever
 * `work` throws is thrown on, after what was held is given back.
 */
export async function metered<T extends WorkUsage>(env: MeterEnv, input: MeterInput, work: (model: Model) => Promise<T>, now = new Date()): Promise<MeterBlock | MeterDone<T>> {
  const db = env.DB;
  const { row, payer, slug } = input;
  if (!env.MODELS && !env.MODELS_URL) return { ok: false, reason: "no_models_url", message: "This installation has no model proxy set up." };
  const billing = billingClient(env.BILLING);
  const integrations = integrationsClient(env.INTEGRATIONS);
  gate ??= new ComputeGate(env.BILLING);

  // 1. The paying agent's caps, and the workspace's budget for every agent.
  const payerDefinition = definitionOf(payer);
  const [month, day] = periods(now);
  const [spentRows, policy] = await Promise.all([
    db
      .prepare("SELECT period, micros FROM agent_spend WHERE agent_id = ? AND period IN (?, ?)")
      .bind(payer.id, month, day)
      .all<{ period: string; micros: number }>(),
    readPolicy(db, row.workspace_id, month),
  ]);
  const spent: Spent = {
    month: spentRows.results.find((r) => r.period === month)?.micros ?? 0,
    day: spentRows.results.find((r) => r.period === day)?.micros ?? 0,
  };
  const blocked = budgetBlock(payerDefinition.budget, spent, now);
  if (blocked) {
    const message = payer.id === row.id ? blocked.message : `@${payer.handle}, who this work is for, is out of budget.`;
    return { ok: false, reason: `budget_${blocked.cap}`, message };
  }
  const pool = policyBlock(policy);
  if (pool) return { ok: false, reason: "workspace_agent_budget", message: pool };

  // 2. Whether it may use a model at all.
  const definition = definitionOf(row);
  const [own, status] = await Promise.all([
    integrations.modelProvider(slug).catch(() => null),
    billing.status().catch(() => ({ enabled: false, live: false })),
  ]);
  const allowed = allowedProviders(definition.routing, own?.id ?? null);
  const mayHosted = hostedOpen(slug, env.HOSTED_AGENT_WORKSPACES, status) && allowed.hosted;
  if (!mayHosted && !allowed.own) {
    const message = own
      ? "My settings don't let me use any model this workspace has. An owner can change my providers on my profile."
      : allowed.hosted
        ? row.builtin
          ? BUILTIN_NO_MODEL
          : "g1t's hosted models aren't open to this workspace, and it has no model provider of its own. An owner can connect one under Integrations."
        : "My settings let me use only this workspace's own model providers, and it has none. An owner can connect one under Integrations, or change my providers on my profile.";
    return { ok: false, reason: "no_model", message };
  }

  // 3. A model session, routed by the workspace's model routes, billed under the payer.
  const repo = billingRepo(slug, payer.handle);
  const routing = await routingNow(env.AGENT_ROUTING, () => billing.modelDefaults());
  const limits = { ...definition.routing, ...(input.limits ?? {}) };
  const provisional = replyModel(routing, { ...limits, pinned: null }, { start: input.start });
  const opened = await integrations.openModelSession({
    workspace: slug,
    repo,
    number: 0,
    task: input.task,
    hostedOpen: mayHosted,
    tier: provisional.tier,
    requestedBy: input.askerName,
  });
  if (!opened.ok) return { ok: false, reason: "model_route", message: opened.error.message };
  const session: ModelSession = opened.value;
  let reservation: string | null = null;
  let settled = false;
  try {
    const ownModel = session.billedTo === "workspace";
    if (ownModel ? !allowed.own : !mayHosted) {
      return {
        ok: false,
        reason: "provider_not_allowed",
        message:
          "This workspace routes agents to a model my settings don't allow. An owner can change my providers on my profile, or the workspace's model routes under Integrations.",
      };
    }
    // A pinned model is for the workspace's own endpoints; on g1t's models the tier decides.
    const model = replyModel(
      routing,
      { ...limits, pinned: ownModel ? definition.routing.pinned : null },
      { chosen: session.tierChoice ?? null, named: ownModel ? session.model : null, start: input.start },
    );

    // 4. The workspace's own limits, through the compute gate.
    const ent = await gate.entitlements(slug);
    const estimate = ownModel ? 0 : input.task === "reply" ? MODEL_ESTIMATE_MICROS.reply : MODEL_ESTIMATE_MICROS.reply * 4;
    const admission = await gate.admit({ workspace: slug, repo, public: false, kind: "agent", estimateMicros: estimate, hostedModel: !ownModel }, ent);
    if (!admission.ok) return { ok: false, reason: `workspace_${admission.code}`, message: admission.message };
    reservation = admission.reservation?.id ?? null;

    // 5. The run it is billed as.
    const named = ownModel && session.model ? session.model : null;
    const started = await billing.startRun({
      workspace: slug,
      repo,
      number: 0,
      task: input.task,
      model: ownModel ? `${model.modelName} (${session.providerName ?? "own provider"})` : model.modelName,
      billedTo: ownModel ? "workspace" : "g1t",
      session: session.id,
      tier: named ? null : model.tier,
    });
    if (!started.ok) return { ok: false, reason: "billing", message: started.error.message };
    const ticket: RunTicket | null = started.value;
    const caps = [replyCapMicros(payerDefinition.budget, spent, ent && ent.runCapMicros > 0 ? ent.runCapMicros : null)];
    if (input.leftMicros != null) caps.push(Math.max(1, Math.floor(input.leftMicros)));
    const left = policy.monthly_micros ? policy.monthly_micros - policy.spent : null;
    if (left != null) caps.push(Math.max(1, left));
    const cap = caps.filter((c): c is number => c != null);
    if (cap.length) await integrations.capModelSessions([await sha256Hex(session.token)], Math.min(...cap)).catch(() => 0);

    // 6. The work.
    const result = await work({ send: sendFor(env, session.token), model, ownModel, policy: routing, sessionModel: session.model, own: own?.id ?? null });
    const priced = await priceTerms(env.BILLING);
    const charged = chargedMicros({
      costMicros: result.cost,
      hosted: !ownModel,
      marginPercent: priced.marginPercent,
      ratePerMillionMicros: ownModel ? priced.rateOwn : priced.rate,
      tokens: totalTokens(result.tokens),
    });

    // 7. Bill it, settle, and count it against the payer and the workspace.
    if (ticket) {
      await rpc(env.BILLING, "finish_run", { runId: ticket.runId, token: ticket.token, costUsd: result.cost / 1_000_000, turns: result.rounds, tokens: result.tokens }).catch(
        (error: unknown) => console.error("agents: finish_run failed", ticket.runId, String(error)),
      );
    }
    if (reservation) {
      settled = true;
      await gate.settle(reservation, result.cost);
    }
    if (charged > 0) {
      await db.batch([...spendStatements(db, payer.id, charged, now, input.task), ...workspaceSpendStatements(db, row.workspace_id, charged, now)]);
    }
    return { ok: true, value: result, model: model.modelName, tier: named ? null : model.tier, tokens: result.tokens, cost: result.cost, charged };
  } finally {
    // What was held is given back however the work ended, and the model
    // session's token stops working.
    if (reservation && !settled) await gate.settle(reservation, 0);
    await integrations.closeModelSessions([await sha256Hex(session.token)]).catch(() => 0);
  }
}

export type { PolicyRow };
