/**
 * Discovery: which models g1t's providers offer now, so new ones reach the
 * catalogue without anyone typing an id.
 *
 * Once a day (the cron in wrangler.jsonc) and when staff press "Check for
 * new models" in sudo (the `Discovery` entrypoint in index.ts), this lists:
 *
 * - **Anthropic**, with `GET /v1/models` through g1t's AI Gateway (the
 *   same path and credentials g1t's runs use), or straight to Anthropic
 *   with g1t's key where there is no gateway.
 * - **Workers AI**, with Cloudflare's model search
 *   (`GET /accounts/{account}/ai/models/search`), with `WORKERS_AI_TOKEN`
 *   (Workers AI Read) or else `AI_GATEWAY_TOKEN`.
 *
 * Listing models is free: nothing here calls a model. Each provider's list
 * goes to billing's `record_discovery`, which owns the catalogue: it adds
 * new ids as `new`, marks ones no longer listed `deprecated`, and emails
 * staff. A provider that cannot be listed is recorded as a failed check
 * and changes nothing.
 */
import type { DiscoveryResult, ProviderModel } from "@g1t/contracts";

import type { HostedRouting } from "./route.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The version of Anthropic's API the list is read with. */
export const ANTHROPIC_VERSION = "2023-06-01";
/** The most pages read from either provider: far more models than either offers. */
const MAX_PAGES = 20;
const WORKERS_AI_PAGE = 100;

/** Where Anthropic's list is read, with what; null when g1t has no way to reach Anthropic. */
export function anthropicRequest(env: HostedRouting, afterId: string | null): { url: string; headers: Headers } | null {
  const headers = new Headers({ "anthropic-version": ANTHROPIC_VERSION });
  const query = `?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`;
  if (env.ANTHROPIC_API_KEY) headers.set("x-api-key", env.ANTHROPIC_API_KEY);
  if (env.AI_GATEWAY_ID && env.CLOUDFLARE_ACCOUNT_ID && (env.AI_GATEWAY_TOKEN || env.ANTHROPIC_API_KEY)) {
    if (env.AI_GATEWAY_TOKEN) headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`);
    // Told apart from runs in the gateway's logs.
    headers.set("cf-aig-metadata", JSON.stringify({ task: "discovery" }));
    return { url: `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic/v1/models${query}`, headers };
  }
  if (!env.ANTHROPIC_API_KEY) return null;
  return { url: `https://api.anthropic.com/v1/models${query}`, headers };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const supported = (node: unknown): boolean => isObject(node) && node.supported === true;
const count = (value: unknown): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * What an Anthropic model can do, from the capability tree its list
 * gives: `effort`, `thinking`, `vision`, and `tools` (every Claude model
 * takes tools). Unknown without the tree.
 */
export function anthropicCapabilities(tree: unknown): string[] {
  if (!isObject(tree)) return [];
  const out: string[] = [];
  if (supported(tree.effort)) out.push("effort");
  if (supported(tree.thinking)) out.push("thinking");
  out.push("tools");
  if (supported(tree.image_input)) out.push("vision");
  return out;
}

/** One model from Anthropic's list, or null when it has no id. */
export function fromAnthropic(item: unknown): ProviderModel | null {
  if (!isObject(item) || typeof item.id !== "string" || !item.id.trim()) return null;
  return {
    id: item.id.trim(),
    name: typeof item.display_name === "string" ? item.display_name : "",
    kind: "chat",
    contextWindow: count(item.max_input_tokens),
    maxOutput: count(item.max_tokens),
    capabilities: anthropicCapabilities(item.capabilities),
    price: null,
  };
}

/** Every model Anthropic lists for g1t's key, page by page. Throws with what went wrong. */
export async function listAnthropic(env: HostedRouting, fetcher: Fetch): Promise<ProviderModel[]> {
  const models: ProviderModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const request = anthropicRequest(env, after);
    if (!request) throw new Error("No way to reach Anthropic: set AI_GATEWAY_TOKEN (or ANTHROPIC_API_KEY) on the models service.");
    const answer = await fetcher(request.url, { headers: request.headers });
    if (!answer.ok) throw new Error(`Anthropic's model list answered ${answer.status}: ${(await answer.text()).slice(0, 300)}`);
    const body = (await answer.json()) as Json;
    const data = Array.isArray(body.data) ? body.data : [];
    for (const item of data) {
      const model = fromAnthropic(item);
      if (model) models.push(model);
    }
    const last = typeof body.last_id === "string" ? body.last_id : null;
    if (body.has_more !== true || !last || data.length === 0) return models;
    after = last;
  }
  return models;
}

/** A Workers AI model's kind, from its task. */
export function workersAiKind(task: unknown): string {
  const name = isObject(task) && typeof task.name === "string" ? task.name.toLowerCase() : "";
  if (name === "text generation") return "chat";
  if (name === "text embeddings") return "embeddings";
  return name ? name.replace(/\s+/g, "-") : "other";
}

/** Dollars per million tokens to millionths, from Workers AI's price property. */
function listedPrice(value: unknown): ProviderModel["price"] {
  if (!Array.isArray(value)) return null;
  let input = 0;
  let output = 0;
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const unit = typeof entry.unit === "string" ? entry.unit.toLowerCase() : "";
    const price = typeof entry.price === "number" ? entry.price : Number(entry.price);
    if (!Number.isFinite(price) || price <= 0 || !unit.includes("per m")) continue;
    if (unit.includes("input")) input = Math.round(price * 1_000_000);
    else if (unit.includes("output")) output = Math.round(price * 1_000_000);
  }
  return input > 0 ? { inputMicros: input, outputMicros: output } : null;
}

/** One model from Workers AI's search, or null when it has no `@cf/…` name. */
export function fromWorkersAi(item: unknown): ProviderModel | null {
  if (!isObject(item) || typeof item.name !== "string" || !item.name.startsWith("@")) return null;
  const properties = new Map<string, unknown>();
  for (const property of Array.isArray(item.properties) ? item.properties : []) {
    if (isObject(property) && typeof property.property_id === "string") properties.set(property.property_id, property.value);
  }
  const kind = workersAiKind(item.task);
  const capabilities: string[] = [];
  if (properties.get("function_calling") === "true" || properties.get("function_calling") === true) capabilities.push("tools");
  if (kind === "embeddings") capabilities.push("embeddings");
  return {
    id: item.name,
    name: item.name.split("/").pop() ?? item.name,
    kind,
    contextWindow: count(properties.get("context_window")),
    maxOutput: 0,
    capabilities,
    price: listedPrice(properties.get("price")),
  };
}

/** Every model Workers AI offers on g1t's account. Throws with what went wrong. */
export async function listWorkersAi(env: HostedRouting, fetcher: Fetch): Promise<ProviderModel[]> {
  const token = env.WORKERS_AI_TOKEN || env.AI_GATEWAY_TOKEN;
  if (!token || !env.CLOUDFLARE_ACCOUNT_ID) throw new Error("No Cloudflare token with Workers AI Read: set WORKERS_AI_TOKEN on the models service.");
  const models: ProviderModel[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?per_page=${WORKERS_AI_PAGE}&page=${page}`;
    const answer = await fetcher(url, { headers: { authorization: `Bearer ${token}` } });
    if (!answer.ok) throw new Error(`Workers AI's model search answered ${answer.status}: ${(await answer.text()).slice(0, 300)}`);
    const body = (await answer.json()) as Json;
    const result = Array.isArray(body.result) ? body.result : [];
    for (const item of result) {
      const model = fromWorkersAi(item);
      if (model) models.push(model);
    }
    if (result.length < WORKERS_AI_PAGE) return models;
  }
  return models;
}

/** The providers listed, each with how. */
export const PROVIDERS: { provider: string; list: (env: HostedRouting, fetcher: Fetch) => Promise<ProviderModel[]> }[] = [
  { provider: "anthropic", list: listAnthropic },
  { provider: "workers-ai", list: listWorkersAi },
];

/** Where each provider's list goes: billing's `record_discovery`. */
export type Recorder = (provider: string, models: ProviderModel[], by: string, error: string | null) => Promise<DiscoveryResult>;

/**
 * Lists every provider and records each list with billing, one at a time.
 * A provider that cannot be listed is recorded as a failed check (nothing
 * in the catalogue changes); the others still are.
 */
export async function discover(env: HostedRouting, fetcher: Fetch, record: Recorder, by: string): Promise<DiscoveryResult[]> {
  const who = by.trim().slice(0, 200) || "schedule";
  const results: DiscoveryResult[] = [];
  for (const { provider, list } of PROVIDERS) {
    let models: ProviderModel[] = [];
    let error: string | null = null;
    try {
      models = await list(env, fetcher);
      if (models.length === 0) error = "The list was empty.";
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    // Never a key in what is recorded.
    for (const secret of [env.AI_GATEWAY_TOKEN, env.ANTHROPIC_API_KEY, env.WORKERS_AI_TOKEN]) {
      if (secret && error) error = error.split(secret).join("[secret]");
    }
    results.push(await record(provider, error ? [] : models, who, error));
  }
  return results;
}
