/**
 * The AI Gateway: a workspace's own model requests, in Anthropic's Messages
 * format, at the same address as its sandboxes' (`models.g1t.sh/anthropic`).
 *
 * A request carries one of the workspace's access tokens (`g1t_…`) with
 * the `models:write` scope, as `x-api-key` or `Authorization: Bearer`, so
 * an Anthropic SDK or Claude Code needs only a base URL and a key. When the
 * workspace has its own Anthropic key under Integrations, requests go there
 * and cost nothing; otherwise they go to g1t's models through its AI
 * Gateway, are admitted by billing first (spend limit, AI credit), and are
 * charged at the model's price afterwards. Every request is logged, with
 * its tokens, never its prompt or answer.
 *
 * What is here is the part that decides; `index.ts` sends.
 */
import type { GatewayModel, GatewayRecord, User } from "@g1t/contracts";

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
  | "api_error";

/** An error in the shape Anthropic's API and SDKs use. */
export function anthropicError(status: number, type: ErrorType, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
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

/** Which of the gateway's routes a path (after `/anthropic`) is, or null. */
export function gatewayRoute(path: string): "messages" | "count_tokens" | null {
  const bare = path.split("?")[0]!.replace(/\/+$/, "");
  if (bare === "/v1/messages") return "messages";
  if (bare === "/v1/messages/count_tokens") return "count_tokens";
  return null;
}

/** Why a model is not offered on g1t's key, or null when it is. */
export function unoffered(model: unknown, offered: GatewayModel[]): string | null {
  if (typeof model !== "string" || !model.trim()) return "Name a model: `model` is required.";
  if (offered.some((row) => row.model === model)) return null;
  const names = offered.map((row) => row.model).filter((id, i, all) => all.indexOf(id) === i);
  return `${model} is not offered on the AI Gateway. It offers ${names.join(", ")}. See https://docs.g1t.sh/guides/ai-gateway/#models`;
}

/**
 * Tool types that run on the caller's side, so cost only their tokens. A
 * tool with no type is the caller's own.
 */
const CLIENT_TOOLS = ["custom", "bash_", "text_editor_", "computer_", "memory_"];

/**
 * Why a request to g1t's models asks for something charged other than by
 * its tokens at the model's price, which the gateway cannot charge for
 * yet, or null. On the workspace's own key the provider bills it, so
 * anything goes there.
 */
export function unpriced(body: Record<string, unknown>): string | null {
  const own = "Use it with the workspace's own Anthropic key, under Integrations.";
  if (body.speed != null && body.speed !== "standard") {
    return `Fast mode is not offered on the AI Gateway on g1t's models yet. ${own}`;
  }
  if (body.inference_geo != null && body.inference_geo !== "global") {
    return `Only global inference is offered on the AI Gateway on g1t's models yet: leave out inference_geo. ${own}`;
  }
  if (body.fallbacks != null) {
    return `Server-side fallbacks are not offered on the AI Gateway on g1t's models yet: leave out fallbacks. ${own}`;
  }
  if (body.container != null) {
    return `Containers and skills are not offered on the AI Gateway on g1t's models yet. ${own}`;
  }
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  for (const tool of tools) {
    const type = (tool as { type?: unknown } | null)?.type;
    if (type == null || (typeof type === "string" && CLIENT_TOOLS.some((prefix) => type === prefix || type.startsWith(prefix)))) continue;
    return `Server tools such as web search and code execution (${String(type)}) are not offered on the AI Gateway on g1t's models yet. ${own}`;
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
 * Where a request to g1t's models goes and what it carries: the caller's
 * request, without its token, to g1t's AI Gateway with g1t's credentials
 * and tags for the workspace, token and session.
 */
export function hostedRequest(
  hosted: HostedRouting,
  path: string,
  incoming: Headers,
  caller: Caller,
  session: string,
): { url: string; headers: Headers } {
  const headers = passedHeaders(incoming);
  if (!hosted.AI_GATEWAY_ID) {
    if (hosted.ANTHROPIC_API_KEY) headers.set("x-api-key", hosted.ANTHROPIC_API_KEY);
    return { url: `https://api.anthropic.com${path}`, headers };
  }
  headers.set("cf-aig-metadata", JSON.stringify({ task: "gateway", workspace: caller.workspace, token: caller.tokenId, session }));
  if (hosted.AI_GATEWAY_TOKEN) headers.set("cf-aig-authorization", `Bearer ${hosted.AI_GATEWAY_TOKEN}`);
  if (hosted.ANTHROPIC_API_KEY) headers.set("x-api-key", hosted.ANTHROPIC_API_KEY);
  return {
    url: `https://gateway.ai.cloudflare.com/v1/${hosted.CLOUDFLARE_ACCOUNT_ID}/${hosted.AI_GATEWAY_ID}/anthropic${path}`,
    headers,
  };
}

/** The message of an Anthropic-shaped error body, or the status. */
export function errorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message.slice(0, 500);
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
    status: input.status,
    ownKey: input.ownKey,
    streamed: input.streamed,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    error: input.error ?? null,
  };
}
