/**
 * Which model a gateway request names, and where it goes: one of the
 * workspace's own providers, or g1t's catalogue.
 *
 * - **The workspace's own providers come first.** Each connection lists the
 *   models it takes (`gatewayModels`: ids, or prefixes ending in `*`); the
 *   first connection, in the order they were made, whose list matches the
 *   model gets the request. A prefix ending in `/*` is a namespace the
 *   workspace chose, and is taken off before the request is sent.
 * - **Then g1t's catalogue**, by the provider's own id (`claude-sonnet-5-5`,
 *   `@cf/openai/gpt-oss-120b`) or with its provider in front
 *   (`anthropic/claude-sonnet-5-5`, `workers-ai/@cf/openai/gpt-oss-120b`).
 */

import type { GatewayModel, GatewayProvider } from "@g1t/contracts";

/** The kinds of request the gateway answers. */
export type Kind = "chat" | "embeddings";

/** The catalogue's providers, and the API each speaks. */
export const CATALOGUE_APIS: Record<string, "anthropic" | "openai"> = {
  anthropic: "anthropic",
  "workers-ai": "openai",
};

/** A catalogue model's id with its provider in front: `anthropic/claude-sonnet-5-5`. */
export function catalogueId(model: Pick<GatewayModel, "provider" | "model">): string {
  return `${model.provider}/${model.model}`;
}

/** The model a request names without a catalogue provider in front, when it has one. */
function unprefixed(requested: string): string | null {
  for (const provider of Object.keys(CATALOGUE_APIS)) {
    if (requested.startsWith(`${provider}/`)) return requested.slice(provider.length + 1);
  }
  return null;
}

/**
 * Whether a connection's pattern takes a model, and the model to send if
 * so: as named, or without the namespace a `/*` pattern stands for.
 */
export function matchPattern(pattern: string, model: string): string | null {
  if (pattern === "*") return model;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return model.startsWith(prefix) && model.length > prefix.length ? model.slice(prefix.length) : null;
  }
  if (pattern.endsWith("*")) return model.startsWith(pattern.slice(0, -1)) ? model : null;
  return pattern === model ? model : null;
}

/** Where a request goes. */
export type Route =
  | { to: "own"; provider: GatewayProvider; model: string }
  | { to: "g1t"; entry: GatewayModel; api: "anthropic" | "openai"; model: string }
  | { to: "none"; status: number; message: string };

/** The catalogue model a request names, if any. */
export function findOffered(requested: string, offered: GatewayModel[]): GatewayModel | null {
  const bare = unprefixed(requested);
  if (bare != null) {
    const provider = requested.slice(0, requested.length - bare.length - 1);
    return offered.find((row) => row.provider === provider && row.model === bare) ?? null;
  }
  return offered.find((row) => row.model === requested) ?? null;
}

/** The workspace's own provider a request goes to, if any, and the model it is sent as. */
export function findOwn(requested: string, providers: GatewayProvider[]): { provider: GatewayProvider; model: string } | null {
  const candidates = [requested];
  const bare = unprefixed(requested);
  if (bare) candidates.push(bare);
  for (const provider of providers) {
    for (const candidate of candidates) {
      for (const pattern of provider.patterns) {
        const model = matchPattern(pattern, candidate);
        if (model) return { provider, model };
      }
    }
  }
  return null;
}

/** Where a request for `requested` goes, or why it goes nowhere. */
export function routeModel(requested: unknown, kind: Kind, providers: GatewayProvider[], offered: GatewayModel[]): Route {
  if (typeof requested !== "string" || !requested.trim()) {
    return { to: "none", status: 400, message: "Name a model: `model` is required." };
  }
  const model = requested.trim();
  const own = findOwn(model, providers);
  if (own) {
    if (kind === "embeddings" && own.provider.api !== "openai") {
      return { to: "none", status: 400, message: `${model} goes to ${own.provider.name}, which speaks Anthropic's API and has no embeddings.` };
    }
    return { to: "own", ...own };
  }
  const entry = findOffered(model, offered);
  const api = entry ? CATALOGUE_APIS[entry.provider] : undefined;
  if (entry && api && (entry.kind ?? "chat") === kind) return { to: "g1t", entry, api, model: entry.model };
  if (entry && api) {
    const other = kind === "chat" ? "an embeddings model: send it to /openai/v1/embeddings" : "a chat model: send it to the chat or messages route";
    return { to: "none", status: 400, message: `${model} is ${other}.` };
  }
  const names = offered
    .filter((row) => (row.kind ?? "chat") === kind && CATALOGUE_APIS[row.provider])
    .map(catalogueId)
    .filter((id, i, all) => all.indexOf(id) === i);
  const own_ = providers.length
    ? " or a model one of the workspace's own providers under Integrations takes"
    : ", or connect the workspace's own provider under Integrations";
  return {
    to: "none",
    status: 404,
    message: `${model} is not offered on the AI Gateway. Name one of ${names.join(", ")}${own_}. See https://docs.g1t.sh/guides/ai-gateway/#models`,
  };
}

/** Dollars per million tokens, from millionths. */
const dollars = (micros: number | undefined) => Math.round(Math.max(0, micros ?? 0)) / 1_000_000;

/** One model, as `GET /openai/v1/models` lists it. */
export type ListedModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name: string;
  kind: Kind;
  /** `g1t` when g1t's account serves it and the workspace is charged; `workspace` on its own provider. */
  billed_to: "g1t" | "workspace";
  connection: string | null;
  /** g1t's price per million tokens, in dollars; null on the workspace's own provider. */
  pricing: {
    currency: "usd";
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    cache_write_1h: number;
    long_prompt: { above_tokens: number; input: number; output: number; cache_read: number; cache_write: number; cache_write_1h: number } | null;
  } | null;
};

/**
 * The models a workspace can use, as OpenAI lists models: its own
 * providers' first (by the ids they take), then g1t's catalogue with its
 * prices, each model once, cheapest Claude first as the catalogue orders
 * them.
 */
export function listModels(providers: GatewayProvider[], offered: GatewayModel[]): ListedModel[] {
  const listed: ListedModel[] = [];
  const seen = new Set<string>();
  const add = (model: ListedModel) => {
    if (seen.has(model.id)) return;
    seen.add(model.id);
    listed.push(model);
  };
  for (const provider of providers) {
    for (const pattern of provider.patterns) {
      if (!pattern.includes("*")) {
        add(own(pattern, provider));
        continue;
      }
      const prefix = pattern.endsWith("/*") ? pattern.slice(0, -1) : "";
      for (const model of provider.models) {
        const id = `${prefix}${model}`;
        if (matchPattern(pattern, id)) add(own(id, provider));
      }
    }
  }
  const names = new Set<string>();
  for (const row of offered) {
    if (!CATALOGUE_APIS[row.provider]) continue;
    // A dated id for a model already listed is the same model.
    const key = `${row.provider}:${row.name}`;
    if (names.has(key)) continue;
    names.add(key);
    // A catalogue model one of the workspace's providers takes goes there.
    const mine = findOwn(catalogueId(row), providers);
    if (mine) {
      add({ ...own(catalogueId(row), mine.provider), name: row.name, kind: row.kind ?? "chat" });
      continue;
    }
    add({
      id: catalogueId(row),
      object: "model",
      created: 0,
      owned_by: row.provider,
      name: row.name,
      kind: row.kind ?? "chat",
      billed_to: "g1t",
      connection: null,
      pricing: {
        currency: "usd",
        input: dollars(row.inputMicros),
        output: dollars(row.outputMicros),
        cache_read: dollars(row.cacheReadMicros),
        cache_write: dollars(row.cacheWriteMicros),
        cache_write_1h: dollars(row.cacheWrite1hMicros || row.cacheWriteMicros),
        long_prompt: row.threshold
          ? {
              above_tokens: row.threshold,
              input: dollars(row.overInputMicros),
              output: dollars(row.overOutputMicros),
              cache_read: dollars(row.overCacheReadMicros),
              cache_write: dollars(row.overCacheWriteMicros),
              cache_write_1h: dollars(row.overCacheWrite1hMicros || row.overCacheWriteMicros),
            }
          : null,
      },
    });
  }
  return listed;
}

function own(id: string, provider: GatewayProvider): ListedModel {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: provider.provider,
    name: id,
    kind: "chat",
    billed_to: "workspace",
    connection: provider.name,
    pricing: null,
  };
}
