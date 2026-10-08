/**
 * The AI Gateway: a workspace's own model requests, at the same address as
 * its sandboxes' (`models.g1t.sh`), in either format:
 *
 * - `/anthropic/v1/messages` (and `/count_tokens`): Anthropic's Messages API.
 * - `/openai/v1/chat/completions`, `/openai/v1/embeddings` and
 *   `/openai/v1/models`: OpenAI's.
 *
 * A request carries one of the workspace's access tokens (`g1t_…`) with
 * the `models:write` scope, as `x-api-key` or `Authorization: Bearer`, so
 * either format's SDKs and tools need only a base URL and a key. The model
 * it names decides where it goes (`catalogue.ts`): one of the workspace's
 * own providers under Integrations, where it costs nothing, or g1t's
 * catalogue (Claude on Anthropic, open models on Workers AI), admitted by
 * billing first (spend limit, AI credit) and charged at the model's price
 * afterwards. Either format reaches either kind of provider: the proxy
 * translates (`openai.ts`, `chat.ts`). Every request is logged, with its
 * tokens, never its prompt or answer.
 *
 * What is here is the part that decides; `serve.ts` sends.
 */
import type { GatewayProvider, GatewayRecord, User } from "@g1t/contracts";

import type { Dialect } from "./openai.ts";
import type { HostedRouting } from "./route.ts";
import { passedHeaders } from "./route.ts";
import type { Tokens } from "./usage.ts";

/** Anthropic's error types, by the statuses the gateway answers with. */
export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error";

/** An error in the shape Anthropic's API and SDKs use. */
export function anthropicError(status: number, type: ErrorType, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

/** Anthropic's error type for a status. */
export function anthropicErrorType(status: number): ErrorType {
  if (status === 401) return "authentication_error";
  if (status === 402) return "billing_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

/** Who a gateway request is for, from its token. */
export type Caller = { workspace: string; tokenId: string; tokenName: string | null };

/** The scope a token needs to send requests. */
export const GATEWAY_SCOPE = "models:write";

/**
 * Who a token stands for, or why it cannot use the gateway: it is unknown
 * or expired, it is not a workspace's own token, or it lacks
 * `models:write`. A token with full access has every scope.
 */
export function callerOf(viewer: User | null): { caller: Caller } | { status: number; type: ErrorType; message: string } {
  if (!viewer) {
    return { status: 401, type: "authentication_error", message: "This access token is not valid, or it has expired or been deleted." };
  }
  if (viewer.kind !== "workspace" || !viewer.token) {
    return {
      status: 403,
      type: "permission_error",
      message: "The AI Gateway takes a workspace's access token, which its usage is charged to. An owner can make one under the workspace's Settings, Access tokens, with the models:write scope.",
    };
  }
  const scopes = viewer.token.scopes;
  if (scopes && !scopes.includes(GATEWAY_SCOPE)) {
    return { status: 403, type: "permission_error", message: `This access token needs the ${GATEWAY_SCOPE} scope to use the AI Gateway.` };
  }
  return { caller: { workspace: viewer.username.toLowerCase(), tokenId: viewer.token.token_id, tokenName: viewer.token.name ?? null } };
}

/** The request formats, by their path. */
export type Format = "anthropic" | "openai";

/** What a request asks. */
export type Operation = "messages" | "count_tokens" | "chat" | "embeddings" | "models";

/** Which of the gateway's routes a path (after `/anthropic`) is, or null. */
export function gatewayRoute(path: string): "messages" | "count_tokens" | null {
  const bare = path.split("?")[0]!.replace(/\/+$/, "");
  if (bare === "/v1/messages") return "messages";
  if (bare === "/v1/messages/count_tokens") return "count_tokens";
  return null;
}

/**
 * The format and operation of a request by its whole path and method, or
 * null for one the gateway does not answer.
 */
export function gatewayOperation(path: string, method: string): { format: Format; op: Operation } | null {
  const bare = path.split("?")[0]!.replace(/\/+$/, "");
  if (bare.startsWith("/anthropic/")) {
    const op = method === "POST" ? gatewayRoute(bare.slice("/anthropic".length)) : null;
    return op ? { format: "anthropic", op } : null;
  }
  if (bare === "/openai/v1/chat/completions" && method === "POST") return { format: "openai", op: "chat" };
  if (bare === "/openai/v1/embeddings" && method === "POST") return { format: "openai", op: "embeddings" };
  if (bare === "/openai/v1/models" && method === "GET") return { format: "openai", op: "models" };
  return null;
}

/** What the gateway answers, per format, for a request to a route it does not have. */
export const ROUTES: Record<Format, string> = {
  anthropic: "The AI Gateway answers POST /anthropic/v1/messages and POST /anthropic/v1/messages/count_tokens in Anthropic's format.",
  openai: "The AI Gateway answers POST /openai/v1/chat/completions, POST /openai/v1/embeddings and GET /openai/v1/models in OpenAI's format.",
};

/**
 * Tool types that run on the caller's side, so cost only their tokens. A
 * tool with no type is the caller's own.
 */
const CLIENT_TOOLS = ["custom", "bash_", "text_editor_", "computer_", "memory_"];

const OWN = "Use it with the workspace's own Anthropic key, under Integrations.";

/**
 * Why an Anthropic-format request to g1t's models asks for something
 * charged other than by its tokens at the model's price, which the gateway
 * cannot charge for yet, or null. On the workspace's own key the provider
 * bills it, so anything goes there.
 */
export function unpriced(body: Record<string, unknown>): string | null {
  if (body.speed != null && body.speed !== "standard") {
    return `Fast mode is not offered on the AI Gateway on g1t's models yet. ${OWN}`;
  }
  if (body.inference_geo != null && body.inference_geo !== "global") {
    return `Only global inference is offered on the AI Gateway on g1t's models yet: leave out inference_geo. ${OWN}`;
  }
  if (body.fallbacks != null) {
    return `Server-side fallbacks are not offered on the AI Gateway on g1t's models yet: leave out fallbacks. ${OWN}`;
  }
  if (body.container != null) {
    return `Containers and skills are not offered on the AI Gateway on g1t's models yet. ${OWN}`;
  }
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  for (const tool of tools) {
    const type = (tool as { type?: unknown } | null)?.type;
    if (type == null || (typeof type === "string" && CLIENT_TOOLS.some((prefix) => type === prefix || type.startsWith(prefix)))) continue;
    return `Server tools such as web search and code execution (${String(type)}) are not offered on the AI Gateway on g1t's models yet. ${OWN}`;
  }
  return null;
}

/**
 * The same for an OpenAI-format request to g1t's models: web search and
 * tools other than functions are billed other than by tokens.
 */
export function unpricedChat(body: Record<string, unknown>): string | null {
  const own = "Use it with the workspace's own provider, under Integrations.";
  if (body.web_search_options != null) {
    return `Web search is not offered on the AI Gateway on g1t's models yet: leave out web_search_options. ${own}`;
  }
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  for (const tool of tools) {
    const type = (tool as { type?: unknown } | null)?.type;
    if (type === "function") continue;
    return `Only function tools are offered on the AI Gateway on g1t's models (not ${String(type)}). ${own}`;
  }
  return null;
}

/** A request's id: `gw_` and 24 random hex digits. */
export function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `gw_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The session a request is logged under at Cloudflare's AI Gateway: one per
 * token per UTC hour, so the gateway's own logs can be read back by token
 * and hour.
 */
export function sessionOf(tokenId: string, now: Date): string {
  const hour = now.toISOString().slice(0, 13).replace(/[-T]/g, "");
  return `gw_${tokenId}_${hour}`;
}

/**
 * Where a request to g1t's Claude models goes and what it carries: the
 * caller's request, without its token, to g1t's AI Gateway with g1t's
 * credentials and tags for the workspace, token and session.
 */
export function hostedRequest(
  hosted: HostedRouting,
  path: string,
  incoming: Headers,
  caller: Caller,
  session: string,
): { url: string; headers: Headers } {
  const target = hostedTarget(hosted, "anthropic", incoming, caller, session);
  return { url: `${target!.base}${path}`, headers: target!.headers };
}

/** Where a request goes, how, and who answers it. */
export type Target = {
  api: "anthropic" | "openai";
  /** For Anthropic's API, without `/v1`; for OpenAI's, with it. */
  base: string;
  headers: Headers;
  /** Who serves it, as the log names it: `anthropic`, `workers-ai`, or the connection's provider. */
  provider: string;
  dialect: Dialect;
  ownKey: boolean;
  /** On the workspace's own provider: the connection's name. */
  connection: string | null;
  /** What must never reach the caller or the log: the keys this request carries. */
  secrets: string[];
};

/** The address of one operation at a target. */
export function targetUrl(target: Target, op: Operation): string {
  if (target.api === "anthropic") return `${target.base}/v1/messages${op === "count_tokens" ? "/count_tokens" : ""}`;
  return `${target.base}/${op === "embeddings" ? "embeddings" : "chat/completions"}`;
}

/**
 * g1t's own way to a catalogue provider's models, through its Cloudflare AI
 * Gateway, tagged for the workspace, token and session. Null when this g1t
 * has no way to that provider (Workers AI with no token).
 */
export function hostedTarget(
  hosted: HostedRouting,
  provider: string,
  incoming: Headers,
  caller: Caller,
  session: string,
): Target | null {
  const headers = passedHeaders(incoming);
  const metadata = JSON.stringify({ task: "gateway", workspace: caller.workspace, token: caller.tokenId, session });
  const secrets = [hosted.AI_GATEWAY_TOKEN, hosted.ANTHROPIC_API_KEY, hosted.WORKERS_AI_TOKEN].filter((s): s is string => !!s);
  const common = { ownKey: false, connection: null, secrets, provider };
  if (provider === "workers-ai") {
    const token = hosted.WORKERS_AI_TOKEN || hosted.AI_GATEWAY_TOKEN;
    if (!token || !hosted.CLOUDFLARE_ACCOUNT_ID) return null;
    headers.set("authorization", `Bearer ${token}`);
    headers.set("content-type", "application/json");
    if (!hosted.AI_GATEWAY_ID) {
      return { ...common, api: "openai", dialect: { official: false, provider }, headers, base: `https://api.cloudflare.com/client/v4/accounts/${hosted.CLOUDFLARE_ACCOUNT_ID}/ai/v1` };
    }
    headers.set("cf-aig-metadata", metadata);
    if (hosted.AI_GATEWAY_TOKEN) headers.set("cf-aig-authorization", `Bearer ${hosted.AI_GATEWAY_TOKEN}`);
    return {
      ...common,
      api: "openai",
      dialect: { official: false, provider },
      headers,
      base: `https://gateway.ai.cloudflare.com/v1/${hosted.CLOUDFLARE_ACCOUNT_ID}/${hosted.AI_GATEWAY_ID}/workers-ai/v1`,
    };
  }
  if (provider !== "anthropic") return null;
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  headers.set("content-type", "application/json");
  const anthropic = { ...common, api: "anthropic" as const, dialect: { official: false, provider }, headers };
  if (!hosted.AI_GATEWAY_ID) {
    if (hosted.ANTHROPIC_API_KEY) headers.set("x-api-key", hosted.ANTHROPIC_API_KEY);
    return { ...anthropic, base: "https://api.anthropic.com" };
  }
  headers.set("cf-aig-metadata", metadata);
  if (hosted.AI_GATEWAY_TOKEN) headers.set("cf-aig-authorization", `Bearer ${hosted.AI_GATEWAY_TOKEN}`);
  if (hosted.ANTHROPIC_API_KEY) headers.set("x-api-key", hosted.ANTHROPIC_API_KEY);
  return { ...anthropic, base: `https://gateway.ai.cloudflare.com/v1/${hosted.CLOUDFLARE_ACCOUNT_ID}/${hosted.AI_GATEWAY_ID}/anthropic` };
}

/** The workspace's own provider, with its key: never g1t's gateway. */
export function ownTarget(provider: GatewayProvider, incoming: Headers): Target {
  const headers = passedHeaders(incoming);
  headers.set("content-type", "application/json");
  const key = provider.apiKey;
  if (key) {
    const header = provider.authHeader || (provider.api === "anthropic" ? "x-api-key" : "authorization");
    headers.set(header, header === "authorization" ? `Bearer ${key}` : key);
  }
  if (provider.gatewayToken) headers.set("cf-aig-authorization", `Bearer ${provider.gatewayToken}`);
  if (provider.api === "anthropic" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  const fallback = provider.api === "anthropic" ? "https://api.anthropic.com" : "";
  return {
    api: provider.api,
    base: (provider.baseUrl || fallback).replace(/\/+$/, ""),
    headers,
    provider: provider.provider,
    dialect: { official: provider.official, provider: provider.provider },
    ownKey: true,
    connection: provider.name,
    secrets: [provider.apiKey, provider.gatewayToken].filter((s): s is string => !!s),
  };
}

/**
 * A text with every secret it might carry taken out, as a provider's error
 * can quote the key it refused.
 */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
    // A key quoted with its end cut off is still most of the key.
    const head = secret.slice(0, Math.max(8, Math.floor(secret.length * 0.75)));
    out = out.split(head).join("[redacted]");
  }
  return out;
}

/** The message of a provider's error body, either format's shape, or the status. */
export function errorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string } | { error?: { message?: unknown } }[];
    const error = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
    if (typeof error === "string") return error.slice(0, 500);
    if (typeof error?.message === "string") return error.message.slice(0, 500);
  } catch {
    // Not JSON: the status says enough.
  }
  return `The model provider answered ${status}.`;
}

/** What billing is told about one request. */
export function gatewayRecord(input: {
  id: string;
  caller: Caller;
  model: string;
  tokens: Tokens;
  status: number;
  ownKey: boolean;
  streamed: boolean;
  durationMs: number;
  error?: string | null;
  format?: Format;
  provider?: string;
  connection?: string | null;
}): GatewayRecord {
  return {
    id: input.id,
    workspace: input.caller.workspace,
    tokenId: input.caller.tokenId,
    tokenName: input.caller.tokenName,
    model: input.model.slice(0, 200) || "unknown",
    input: input.tokens.input,
    output: input.tokens.output,
    cacheRead: input.tokens.cacheRead,
    cacheWrite: input.tokens.cacheWrite,
    cacheWriteHour: input.tokens.cacheWrite1h ?? 0,
    status: input.status,
    ownKey: input.ownKey,
    format: input.format ?? "anthropic",
    provider: input.provider ?? "",
    connection: input.connection ?? null,
    streamed: input.streamed,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    error: input.error ?? null,
  };
}
