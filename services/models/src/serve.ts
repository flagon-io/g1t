/**
 * Serving one AI Gateway request, in either format, to whichever provider
 * its model goes to: authenticate the token, route the model, admit it on
 * g1t's key, translate when the caller's format and the provider's API
 * differ, stream the answer back, and log (and on g1t's key charge) what
 * it used.
 *
 * Everything outside the worker comes in through `GatewayDeps`, so the
 * whole path runs in tests with no network.
 */

import type { GatewayModel, GatewayProvider, GatewayRecord, User } from "@g1t/contracts";

import { type Kind, listModels, routeModel } from "./catalogue.ts";
import { ChatStreamTranslator, Untranslatable, anthropicToChat, chatToAnthropic, openaiError } from "./chat.ts";
import {
  type Caller,
  type Format,
  ROUTES,
  type Target,
  anthropicError,
  anthropicErrorType,
  callerOf,
  errorMessage,
  gatewayOperation,
  gatewayRecord,
  hostedTarget,
  ownTarget,
  requestId,
  scrub,
  sessionOf,
  targetUrl,
  unpriced,
  unpricedChat,
} from "./gateway.ts";
import { type AnthropicRequest, StreamTranslator, estimateTokens, fromChat, toChat } from "./openai.ts";
import type { HostedRouting } from "./route.ts";
import { NO_TOKENS, type Tokens, measure } from "./usage.ts";

type Json = Record<string, unknown>;

/** What serving needs from outside: who a token is, the workspace's providers, billing, the network. */
export type GatewayDeps = {
  hosted: HostedRouting;
  caller(token: string): Promise<User | null>;
  providers(workspace: string): Promise<GatewayProvider[]>;
  offered(): Promise<GatewayModel[]>;
  /** Why a workspace may not use g1t's models now, or null. */
  admit(workspace: string): Promise<string | null>;
  record(record: GatewayRecord): Promise<unknown>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  waitUntil(promise: Promise<unknown>): void;
};

/** Headers of a provider's answer that reach the caller. */
const KEPT = ["content-type", "cache-control", "retry-after", "request-id", "x-request-id"];

function answerHeaders(upstream: Headers | null, id: string, contentType?: string): Headers {
  const headers = new Headers();
  for (const name of KEPT) {
    const value = upstream?.get(name);
    if (value) headers.set(name, value);
  }
  if (contentType) headers.set("content-type", contentType);
  headers.set("x-g1t-request-id", id);
  return headers;
}

/** An error in the caller's format. */
function failure(format: Format, status: number, message: string, id?: string): Response {
  const response = format === "openai" ? openaiError(status, message) : anthropicError(status, anthropicErrorType(status), message);
  if (id) response.headers.set("x-g1t-request-id", id);
  return response;
}

/** The error type a provider gave, when it is one of the caller's format's. */
function upstreamType(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown } };
    return typeof parsed.error?.type === "string" ? parsed.error.type : null;
  } catch {
    return null;
  }
}

/** Streams a body through a translator, a chunk at a time. */
function translated(body: ReadableStream<Uint8Array>, push: (text: string) => string, finish: () => string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const out = push(decoder.decode(chunk, { stream: true }));
        if (out) controller.enqueue(encoder.encode(out));
      },
      flush(controller) {
        const out = push(decoder.decode()) + finish();
        if (out) controller.enqueue(encoder.encode(out));
      },
    }),
  );
}

/** Serves an AI Gateway request; `token` is the workspace's access token it carried. */
export async function serveGateway(request: Request, token: string, deps: GatewayDeps): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const format: Format = url.pathname.startsWith("/openai/") ? "openai" : "anthropic";
  const who = callerOf(await deps.caller(token));
  if (!("caller" in who)) return failure(format, who.status, who.message);
  const caller: Caller = who.caller;
  const route = gatewayOperation(url.pathname, request.method);
  if (!route) return failure(format, 404, ROUTES[format]);
  const { op } = route;

  if (op === "models") {
    const [providers, offered] = await Promise.all([deps.providers(caller.workspace), deps.offered()]);
    return Response.json({ object: "list", data: listModels(providers, offered) });
  }

  let body: Json;
  try {
    body = (await request.json()) as Json;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
  } catch {
    return failure(format, 400, "The request body is not a JSON object.");
  }
  const requested = typeof body.model === "string" ? body.model.trim() : "";
  const streamed = body.stream === true;
  const id = requestId();
  const kind: Kind = op === "embeddings" ? "embeddings" : "chat";

  // Every request is logged once it is known whose it is. Counting tokens
  // is a question about a request, not one, and is not.
  const log = (input: { status: number; target?: Target | null; model?: string; tokens?: Tokens; error?: string | null }) => {
    if (op === "count_tokens") return Promise.resolve();
    const target = input.target ?? null;
    const record = gatewayRecord({
      id,
      caller,
      model: input.model ?? requested,
      tokens: input.tokens ?? NO_TOKENS,
      status: input.status,
      ownKey: target?.ownKey ?? false,
      streamed,
      durationMs: Date.now() - started,
      error: input.error ? scrub(input.error, target?.secrets ?? []) : null,
      format,
      provider: target?.provider ?? "",
      connection: target?.connection ?? null,
    });
    return deps
      .record(record)
      .then(() => undefined)
      .catch(() => undefined);
  };
  const refuse = (status: number, message: string, target?: Target | null) => {
    deps.waitUntil(log({ status, target, error: message }));
    return failure(format, status, message, id);
  };

  const [providers, offered] = await Promise.all([deps.providers(caller.workspace), deps.offered()]);
  const routed = routeModel(requested, kind, providers, offered);
  if (routed.to === "none") return refuse(routed.status, routed.message);

  let target: Target | null;
  if (routed.to === "g1t") {
    const why = format === "anthropic" ? unpriced(body) : unpricedChat(body);
    if (why) return refuse(400, why);
    const refusal = await deps.admit(caller.workspace);
    if (refusal) return refuse(402, refusal);
    target = hostedTarget(deps.hosted, routed.entry.provider, request.headers, caller, sessionOf(caller.tokenId, new Date()));
    if (!target) return refuse(503, `${routed.entry.name} is not available on this g1t: it has no way to ${routed.entry.provider}.`);
  } else {
    target = ownTarget(routed.provider, request.headers);
    if (!target.base) return refuse(400, `${routed.provider.name} has no address. Give it one under Integrations.`, target);
  }
  // On g1t's key the catalogue's id is what billing prices; on the
  // workspace's own, the model that answered.
  const pricedAs = routed.to === "g1t" ? routed.entry.model : routed.model;
  const shown = requested;

  // What goes upstream, in the provider's API.
  let upstreamBody: Json;
  if (format === "anthropic" && target.api === "anthropic") {
    upstreamBody = { ...body, model: routed.model };
  } else if (format === "anthropic") {
    if (op === "count_tokens") return Response.json({ input_tokens: estimateTokens(body as AnthropicRequest) });
    upstreamBody = toChat(body as AnthropicRequest, routed.model, target.dialect);
  } else if (target.api === "openai") {
    upstreamBody = { ...body, model: routed.model };
    // Usage at the end of a stream, to count it by; Mistral refuses the option.
    if (op === "chat" && streamed && target.provider !== "mistral") {
      upstreamBody.stream_options = { ...((body.stream_options as Json | undefined) ?? {}), include_usage: true };
    }
  } else {
    try {
      upstreamBody = chatToAnthropic(body, routed.model);
    } catch (error) {
      if (error instanceof Untranslatable) return refuse(400, error.message, target);
      throw error;
    }
  }
  const upstreamOp = target.api === "anthropic" ? (op === "count_tokens" ? "count_tokens" : "messages") : op === "embeddings" ? "embeddings" : "chat";

  let answer: Response;
  try {
    answer = await deps.fetch(targetUrl(target, upstreamOp), { method: "POST", headers: target.headers, body: JSON.stringify(upstreamBody) });
  } catch {
    return refuse(502, `${target.connection ?? "The model provider"} could not be reached.`, target);
  }

  if (!answer.ok) {
    const text = scrub(await answer.text(), target.secrets);
    let message = errorMessage(answer.status, text);
    if (target.ownKey && (answer.status === 401 || answer.status === 403)) {
      message = `${target.connection} refused the workspace's key (${answer.status}): ${message} Check it under Integrations.`;
    }
    deps.waitUntil(log({ status: answer.status, target, error: message }));
    // An error already in the caller's format keeps its type.
    const native = (format === "anthropic") === (target.api === "anthropic") ? upstreamType(text) : null;
    if (native && format === "anthropic") {
      return new Response(JSON.stringify({ type: "error", error: { type: native, message } }), {
        status: answer.status,
        headers: answerHeaders(answer.headers, id, "application/json"),
      });
    }
    const response = failure(format, answer.status, message, id);
    const retry = answer.headers.get("retry-after");
    if (retry) response.headers.set("retry-after", retry);
    return response;
  }

  if (op === "count_tokens") {
    return new Response(answer.body, { status: answer.status, headers: answerHeaders(answer.headers, id) });
  }

  // What it used, read from the provider's own answer as it passes.
  const measured = measure(answer, target.api === "anthropic" ? "anthropic" : "openai");
  const settle = target;
  deps.waitUntil(
    (async () => {
      const tokens = await measured.tokens;
      const answeredBy = await measured.model;
      await log({ status: answer.status, target: settle, model: routed.to === "g1t" ? pricedAs : (answeredBy ?? pricedAs), tokens });
    })().catch(() => undefined),
  );
  const passed = measured.response;
  const eventStream = (passed.headers.get("content-type") ?? "").includes("text/event-stream");

  // Same API both sides: the answer as it is.
  if ((format === "anthropic") === (target.api === "anthropic")) {
    return new Response(passed.body, { status: passed.status, headers: answerHeaders(passed.headers, id) });
  }
  const sse = "text/event-stream";
  if (format === "anthropic") {
    if (!eventStream) {
      const whole = (await passed.json()) as Json;
      return new Response(JSON.stringify(fromChat(whole, shown)), { headers: answerHeaders(passed.headers, id, "application/json") });
    }
    const translator = new StreamTranslator(shown);
    const stream = translated(passed.body!, (text) => translator.push(text), () => translator.finish());
    return new Response(stream, { headers: answerHeaders(null, id, sse) });
  }
  if (!eventStream) {
    const whole = (await passed.json()) as Json;
    return new Response(JSON.stringify(anthropicToChat(whole, shown)), { headers: answerHeaders(passed.headers, id, "application/json") });
  }
  const includeUsage = (body.stream_options as Json | undefined)?.include_usage === true;
  const translator = new ChatStreamTranslator(shown, includeUsage);
  const stream = translated(passed.body!, (text) => translator.push(text), () => translator.finish());
  return new Response(stream, { headers: answerHeaders(null, id, sse) });
}

/** Whether a path is one of the AI Gateway's OpenAI-format routes. */
export function isOpenAiPath(path: string): boolean {
  return path === "/openai" || path.startsWith("/openai/");
}
