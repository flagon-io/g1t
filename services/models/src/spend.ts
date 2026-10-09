/**
 * A run's model spend, held to its cost cap by the proxy itself.
 *
 * The harness stops the agent at the run's cap (`--max-budget-usd`), but
 * that is the sandbox's own word: an agent talked into calling the proxy
 * directly would never be stopped by it. So the proxy counts what each of
 * the run's answers cost and refuses its requests once the run has spent
 * its cap, with a 402 the harness shows as the error it is.
 *
 * The count lives in one Durable Object per run (`run-spend.ts`): a run's
 * requests land on many isolates, and an agent can send many at once, so a
 * per-isolate count would let each isolate spend the cap again. This file
 * is the counting and pricing alone, without the worker, for tests.
 */
import type { GatewayModel, ModelUpstream } from "@g1t/contracts";

import { anthropicError } from "./gateway.ts";
import { type Tokens, total } from "./usage.ts";

/** A model's prices per million tokens, in millionths of a dollar. */
export type Prices = Omit<GatewayModel, "model" | "name" | "provider" | "kind">;

/**
 * The cap of a run whose sandbox never set one (its guardrails and its plan
 * both said none, or setting it failed): the most any run may be allowed
 * to cost (`MAX_BUDGET_USD` in crates/contracts/src/guardrails.rs).
 */
export const BACKSTOP_CAP_MICROS = 100_000_000;

/**
 * The most of a run's answers in flight at once. The cap is checked as a
 * request starts and an answer's cost is known only when it ends, so the
 * answers already in flight when the run reaches its cap can take it past
 * by their cost; this bounds how many there can be. The harness runs a
 * handful at a time, subagents included.
 */
export const MAX_IN_FLIGHT = 16;

/**
 * How long an answer in flight is waited for before it no longer counts
 * against `MAX_IN_FLIGHT`: one whose cost was never settled (the proxy's
 * isolate went away mid-answer) must not hold a place for good.
 */
export const HOLD_MS = 15 * 60_000;

/** The output an answer is assumed to reach when its request names no `max_tokens`. */
const DEFAULT_MAX_TOKENS = 32_000;

/**
 * Prices for a model g1t has none for. On g1t's models, a model missing
 * from the catalogue is charged at a frontier model's list prices, so the
 * cap errs on the side of stopping early. On the workspace's own provider
 * (an endpoint whose model g1t does not list), at a standard model's, so
 * an inexpensive model is not stopped far short of its cap; the harness,
 * which knows no better, counts such a model much the same way.
 */
export const FRONTIER_PRICES: Prices = {
  inputMicros: 15_000_000,
  outputMicros: 75_000_000,
  cacheReadMicros: 1_500_000,
  cacheWriteMicros: 18_750_000,
  cacheWrite1hMicros: 30_000_000,
};
export const STANDARD_PRICES: Prices = {
  inputMicros: 3_000_000,
  outputMicros: 15_000_000,
  cacheReadMicros: 300_000,
  cacheWriteMicros: 3_750_000,
  cacheWrite1hMicros: 6_000_000,
};

/** The run's cap, in millionths of a dollar. */
export function capOf(upstream: Pick<ModelUpstream, "capMicros">): number {
  const cap = upstream.capMicros;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : BACKSTOP_CAP_MICROS;
}

/**
 * The prices an answer is charged at: its model's in g1t's catalogue (by
 * its id, or the catalogue id a dated id starts with), else the most
 * expensive chat model's on g1t's models, else the fallbacks above.
 */
export function pricesFor(model: unknown, route: ModelUpstream["route"], offered: GatewayModel[]): Prices {
  const id = (typeof model === "string" ? model : "").trim().toLowerCase().replace(/^[a-z0-9-]+\//, "");
  if (id) {
    const exact = offered.find((entry) => entry.model.toLowerCase() === id);
    if (exact) return exact;
    const prefixed = offered
      .filter((entry) => id.startsWith(`${entry.model.toLowerCase()}-`))
      .sort((a, b) => b.model.length - a.model.length)[0];
    if (prefixed) return prefixed;
  }
  if (route !== "g1t") return STANDARD_PRICES;
  const chat = offered.filter((entry) => (entry.kind ?? "chat") === "chat");
  const dearest = chat.sort((a, b) => b.outputMicros - a.outputMicros)[0];
  return dearest && dearest.outputMicros >= FRONTIER_PRICES.outputMicros ? dearest : FRONTIER_PRICES;
}

/**
 * What tokens cost at a model's prices per million, rounded up to a whole
 * millionth of a dollar: billing's own sum (`cost_micros` in
 * services/billing/src/gateway.rs). A prompt longer than the model's
 * threshold puts the whole request at the over-threshold prices.
 */
export function costMicros(prices: Prices, tokens: Tokens): number {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const over = (prices.threshold ?? 0) > 0 && prompt > (prices.threshold ?? 0);
  const pick = (base: number | undefined, above: number | undefined) => Math.max(0, (over ? above : base) ?? 0);
  const hour = Math.min(tokens.cacheWrite1h ?? 0, tokens.cacheWrite);
  const fiveMinutes = pick(prices.cacheWriteMicros, prices.overCacheWriteMicros);
  const hourPrice = pick(prices.cacheWrite1hMicros, prices.overCacheWrite1hMicros) || fiveMinutes;
  const millionths =
    tokens.input * pick(prices.inputMicros, prices.overInputMicros) +
    tokens.output * pick(prices.outputMicros, prices.overOutputMicros) +
    tokens.cacheRead * pick(prices.cacheReadMicros, prices.overCacheReadMicros) +
    (tokens.cacheWrite - hour) * fiveMinutes +
    hour * hourPrice;
  return Math.ceil(millionths / 1_000_000);
}

/**
 * The most a request could cost: its whole body as input (about four
 * characters a token) and its `max_tokens` as output. What an answer that
 * could not be read is charged.
 */
export function ceilingMicros(prices: Prices, bodyLength: number, maxTokens: unknown): number {
  const output = typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS;
  return costMicros(prices, { input: Math.ceil(bodyLength / 4), output, cacheRead: 0, cacheWrite: 0 });
}

/**
 * What one answer is charged against the run's cap: nothing for a refused
 * request; its tokens' cost; or, for an answer whose usage could not be
 * read (cut off, or unreadable), the most it could have cost, so a reading
 * that fails never makes an answer free.
 */
export function chargeFor(prices: Prices, tokens: Tokens, ok: boolean, ceiling: number): number {
  if (!ok) return 0;
  return total(tokens) === 0 ? ceiling : costMicros(prices, tokens);
}

export type Admission = { ok: true; ticket: string; spent: number } | { ok: false; reason: "cap" | "busy"; spent: number };

/**
 * One run's count: what it has spent, and its answers in flight. Every
 * method runs to its end without waiting, so a Durable Object's requests
 * see each other's changes in order.
 */
export class SpendTally {
  spent: number;
  private readonly open = new Map<string, number>();
  private issued = 0;

  constructor(spent = 0) {
    this.spent = Number.isFinite(spent) && spent > 0 ? spent : 0;
  }

  /** Whether another answer may start: the run is under its cap and not too busy. */
  admit(cap: number, now: number): Admission {
    for (const [ticket, since] of this.open) if (now - since > HOLD_MS) this.open.delete(ticket);
    if (this.spent >= cap) return { ok: false, reason: "cap", spent: this.spent };
    if (this.open.size >= MAX_IN_FLIGHT) return { ok: false, reason: "busy", spent: this.spent };
    const ticket = `t${++this.issued}`;
    this.open.set(ticket, now);
    return { ok: true, ticket, spent: this.spent };
  }

  /** An answer has ended, costing `micros`. Returns what the run has spent. */
  settle(ticket: string, micros: number): number {
    this.open.delete(ticket);
    if (Number.isFinite(micros) && micros > 0) this.spent += Math.ceil(micros);
    return this.spent;
  }

  get inFlight(): number {
    return this.open.size;
  }
}

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/**
 * The refusal of a run past its cap: Anthropic's error shape, which the
 * harness shows as it is, with `code` for anything that reads it.
 */
export function capReached(cap: number, spent: number): Response {
  const message = `This run reached its cost cap of ${dollars(cap)} (it has spent ${dollars(spent)} on models), so g1t refuses its model requests from here. Raise the cap in the project's guardrails or the workspace's billing, then start the work again.`;
  return Response.json({ type: "error", error: { type: "billing_error", code: "run_cap_reached", message } }, { status: 402 });
}

/** The refusal of a request while the run has too many answers in flight; the harness retries it. */
export function tooBusy(): Response {
  const response = anthropicError(429, "rate_limit_error", `This run has ${MAX_IN_FLIGHT} model requests in flight. Wait for one to finish.`);
  response.headers.set("retry-after", "2");
  return response;
}
