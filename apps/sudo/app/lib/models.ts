/**
 * Agents & models, as the page reads its forms and states its figures:
 * prices per million tokens, each purpose's default, and what a change
 * does to the cost of a typical run. Billing checks every value again. No
 * Workers imports, so it can be tested under Node.
 */
import type { CatalogueModel, ModelDefault, ModelPrices, ResolvedModel } from "@g1t/contracts";

import type { Parsed } from "./forms.ts";

/** The longest reason billing keeps. */
export const MAX_REASON = 500;

/** A model purpose: what it is called and what it is for. */
export type PurposeInfo = { purpose: string; label: string; about: string };

/** The model purposes, in the order the page shows them. */
export const MODEL_PURPOSES: PurposeInfo[] = [
  { purpose: "tier_small", label: "Fast", about: "Auto's fast tier: catching up, answers, plans, small reviews." },
  { purpose: "tier_large", label: "Standard", about: "Auto's standard tier: making and revising changes, most reviews." },
  { purpose: "tier_frontier", label: "Most capable", about: "Auto's top tier: large reviews, architecture, work that failed twice." },
  { purpose: "background", label: "Background", about: "The harness's own small tasks in every run, such as titles and summaries." },
  {
    purpose: "gateway_first",
    label: "AI Gateway's first Claude",
    about: "Listed first by GET /openai/v1/models, the one people start with.",
  },
];

/** Each kind of agent job, as the page names it. */
export const JOBS: { kind: string; label: string }[] = [
  { kind: "implement", label: "Making a change" },
  { kind: "revise", label: "Revising a change" },
  { kind: "answer", label: "Answering a question" },
  { kind: "review", label: "Reviewing" },
  { kind: "update", label: "Catching up" },
  { kind: "plan", label: "Planning" },
];

export const TIER_LABELS: Record<string, string> = {
  small: "Fast",
  large: "Standard",
  frontier: "Most capable",
  change: "By the change's size",
};

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** What a purpose is called anywhere on the page or in a notice. */
export function purposeLabel(purpose: string): string {
  const model = MODEL_PURPOSES.find((p) => p.purpose === purpose);
  if (model) return model.label;
  const job = JOBS.find((j) => `job_${j.kind}` === purpose);
  return job ? job.label : purpose;
}

/** The catalogue models a purpose may be set to: available, priced Claude chat models. */
export function choicesFor(catalogue: CatalogueModel[]): CatalogueModel[] {
  return catalogue.filter((m) => m.status === "available" && m.priced && m.provider === "anthropic" && (m.kind ?? "chat") === "chat");
}

/** A price per million tokens, in dollars, to show or to fill a field: `0.125`, `2`, `12.50`. */
export function perMillion(micros: number | null | undefined): string {
  if (micros == null) return "";
  const text = (Math.max(0, micros) / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const [whole, cents] = text.split(".");
  return cents && cents.length === 1 ? `${whole}.${cents}0` : text;
}

/**
 * Micros from a price per million tokens as typed: `0.125`, `$2`, `12.50`.
 * Up to six decimal places (a millionth of a dollar per million tokens);
 * an empty field is 0.
 */
export function parsePerMillion(input: string): number | null {
  const text = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (text === "") return 0;
  const match = /^(\d{1,4})(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
}

/** The price fields of the approval form, by the name each is posted as. */
export const PRICE_FIELDS: { name: string; key: keyof ModelPrices; label: string }[] = [
  { name: "input", key: "inputMicros", label: "Input" },
  { name: "output", key: "outputMicros", label: "Output" },
  { name: "cache_read", key: "cacheReadMicros", label: "Cache read" },
  { name: "cache_write", key: "cacheWriteMicros", label: "Cache write, 5 min" },
  { name: "cache_write_1h", key: "cacheWrite1hMicros", label: "Cache write, 1 h" },
];

export const OVER_FIELDS: { name: string; key: keyof ModelPrices; label: string }[] = [
  { name: "over_input", key: "overInputMicros", label: "Input" },
  { name: "over_output", key: "overOutputMicros", label: "Output" },
  { name: "over_cache_read", key: "overCacheReadMicros", label: "Cache read" },
  { name: "over_cache_write", key: "overCacheWriteMicros", label: "Cache write, 5 min" },
  { name: "over_cache_write_1h", key: "overCacheWrite1hMicros", label: "Cache write, 1 h" },
];

/** A model's prices as the catalogue has them, for the approval form. */
export function pricesOf(model: CatalogueModel): ModelPrices {
  return {
    inputMicros: model.inputMicros,
    outputMicros: model.outputMicros,
    cacheReadMicros: model.cacheReadMicros,
    cacheWriteMicros: model.cacheWriteMicros,
    cacheWrite1hMicros: model.cacheWrite1hMicros ?? 0,
    threshold: model.threshold ?? 0,
    overInputMicros: model.overInputMicros ?? 0,
    overOutputMicros: model.overOutputMicros ?? 0,
    overCacheReadMicros: model.overCacheReadMicros ?? 0,
    overCacheWriteMicros: model.overCacheWriteMicros ?? 0,
    overCacheWrite1hMicros: model.overCacheWrite1hMicros ?? 0,
  };
}

/** A reason as the forms take it: required, kept short. */
export function parseReason(raw: string): Parsed<string> {
  const reason = raw.trim();
  if (!reason) return { ok: false, error: "Say why, for whoever looks next." };
  if ([...reason].length > MAX_REASON) return { ok: false, error: `Keep the reason to ${MAX_REASON} characters.` };
  return { ok: true, value: reason };
}

export type Approval = { name: string; tierHint: string; prices: ModelPrices; reason: string };

/**
 * The approval form: the name people see, the tier it suits, its prices
 * per million tokens (and above a long-prompt threshold, if it has one),
 * and why. Input is required; a chat model needs an output price too.
 */
export function parseApproval(form: FormData, kind: string): Parsed<Approval> {
  const get = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const name = get("name").trim();
  if (!name) return { ok: false, error: "Give the name people see, such as Claude Haiku 6." };
  if (name.length > 120) return { ok: false, error: "Keep the name to 120 characters." };
  const tierHint = get("tier_hint").trim();
  if (tierHint && !["small", "large", "frontier"].includes(tierHint)) return { ok: false, error: "Choose a tier it suits, or none." };
  const prices = {} as ModelPrices;
  for (const field of [...PRICE_FIELDS, ...OVER_FIELDS]) {
    const micros = parsePerMillion(get(field.name));
    if (micros == null) return { ok: false, error: `${field.label}: a price in dollars per million tokens, such as 0.125.` };
    prices[field.key] = micros;
  }
  const threshold = get("threshold").trim().replace(/,/g, "");
  if (threshold && !/^\d{1,9}$/.test(threshold)) return { ok: false, error: "The long-prompt threshold is a number of tokens, such as 200000." };
  prices.threshold = threshold ? Number(threshold) : 0;
  if (prices.inputMicros === 0) return { ok: false, error: "Give the input price per million tokens." };
  if (kind === "chat" && prices.outputMicros === 0) return { ok: false, error: "Give the output price per million tokens." };
  // An hour-long write with no price of its own costs what a five-minute one does.
  if (prices.cacheWrite1hMicros === 0) prices.cacheWrite1hMicros = prices.cacheWriteMicros;
  const over = prices.overInputMicros + prices.overOutputMicros + prices.overCacheReadMicros + prices.overCacheWriteMicros;
  if (prices.threshold === 0 && over > 0) return { ok: false, error: "Long-prompt prices need the prompt length they start above." };
  if (prices.threshold > 0 && prices.overInputMicros === 0) return { ok: false, error: "With a long-prompt threshold, give the prices above it." };
  if (prices.threshold > 0 && prices.overCacheWrite1hMicros === 0) prices.overCacheWrite1hMicros = prices.overCacheWriteMicros;
  const reason = parseReason(get("reason"));
  if (!reason.ok) return reason;
  return { ok: true, value: { name, tierHint, prices, reason: reason.value } };
}

/** A default as the forms post it: a model, or a job's tier and effort. */
export type DefaultChange = { purpose: string; model: string | null; tier: string | null; effort: string | null; reason: string };

/**
 * One default's form: a model purpose takes one of `choices`; a job takes
 * a tier (`change` only for reviews) and an effort, or none for the
 * harness's own.
 */
export function parseDefault(form: FormData, choices: CatalogueModel[]): Parsed<DefaultChange> {
  const get = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const purpose = get("purpose");
  const reason = parseReason(get("reason"));
  if (MODEL_PURPOSES.some((p) => p.purpose === purpose)) {
    const model = get("model");
    if (!choices.some((m) => m.model === model)) return { ok: false, error: "Choose an available Claude model." };
    if (!reason.ok) return reason;
    return { ok: true, value: { purpose, model, tier: null, effort: null, reason: reason.value } };
  }
  const job = JOBS.find((j) => `job_${j.kind}` === purpose);
  if (!job) return { ok: false, error: "That is not something a default is chosen for." };
  const tier = get("tier");
  const tiers = job.kind === "review" ? ["small", "large", "frontier", "change"] : ["small", "large", "frontier"];
  if (!tiers.includes(tier)) return { ok: false, error: `Choose ${job.kind === "review" ? "a tier, or by the change's size" : "a tier"}.` };
  const effort = get("effort");
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) return { ok: false, error: "Effort is low, medium, high, xhigh or max, or the harness's own." };
  if (!reason.ok) return reason;
  return { ok: true, value: { purpose, model: null, tier, effort: effort || null, reason: reason.value } };
}

/** How a default reads: a model's name, or `Fast, high effort`. */
export function describeDefault(value: { model: string | null; tier: string | null; effort: string | null }, catalogue: CatalogueModel[]): string {
  if (value.model) return catalogue.find((m) => m.model === value.model)?.name ?? value.model;
  const tier = TIER_LABELS[value.tier ?? ""] ?? value.tier ?? "none";
  return value.effort ? `${tier}, ${value.effort} effort` : `${tier}, the harness's own effort`;
}

/** What a change to a default does to a typical run's cost, in a sentence; null for a job. */
export function impact(before: ResolvedModel | undefined, after: CatalogueModel | undefined, catalogue: CatalogueModel[]): string | null {
  if (!after) return null;
  const was = before?.model ? catalogue.find((m) => m.model === before.model!.model) : undefined;
  const now = after.typicalRunMicros;
  const money = (micros: number) => (micros < 1_000_000 ? `$${(micros / 1_000_000).toFixed(3)}` : `$${(micros / 1_000_000).toFixed(2)}`);
  if (!was || was.typicalRunMicros <= 0) return `A typical run would cost about ${money(now)} on ${after.name}.`;
  if (was.model === after.model) return `No change: ${after.name} already runs it, at about ${money(now)} a typical run.`;
  const ratio = now / was.typicalRunMicros;
  const change = Math.round((ratio - 1) * 100);
  const direction =
    ratio >= 2
      ? `${Number(ratio.toFixed(1))} times`
      : change === 0
        ? "the same as"
        : change > 0
          ? `${change}% more than`
          : `${-change}% less than`;
  return `A typical run: about ${money(now)} on ${after.name}, ${direction} ${money(was.typicalRunMicros)} on ${was.name}.`;
}

/** The current default for each purpose, by purpose. */
export function defaultsByPurpose(defaults: ModelDefault[]): Map<string, ModelDefault> {
  return new Map(defaults.map((d) => [d.purpose, d]));
}

/** A context window or output limit: `1M`, `200k`, or a dash when not known. */
export function tokens(n: number): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
