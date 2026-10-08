/**
 * The model proxy: every model request a g1t sandbox makes comes through
 * here, at `https://models.g1t.sh/anthropic`.
 *
 * A sandbox holds a token for its one run, never a key. The proxy looks the
 * token up and forwards the request with the credentials for that run:
 * g1t's AI Gateway when g1t pays, or one of the workspace's own providers
 * when it does. A provider that speaks OpenAI's API gets the request
 * translated, and its answer translated back. So a sandbox that is tricked
 * into printing its environment gives away a token that stops working when
 * the run ends (the runner closes its session then, and lookups are kept
 * only seconds), and nothing of the workspace's.
 *
 * Responses stream through. What each answer used is read from a copy as
 * it passes and reported to billing afterwards, counted per run for usage
 * views.
 *
 * The same address is the AI Gateway for a workspace's own code: a request
 * with one of the workspace's access tokens (`g1t_…`) instead of a run's,
 * at `/anthropic` in Anthropic's format or `/openai/v1` in OpenAI's, goes
 * to `serve.ts`, and is logged and charged to the workspace.
 */
import {
  type GatewayModel,
  type GatewayProvider,
  type ModelUpstream,
  type ServiceBinding,
  type User,
  billingClient,
  identityClient,
  integrationsClient,
} from "@g1t/contracts";

import { openaiError } from "./chat";
import { type AnthropicRequest, StreamTranslator, errorFromChat, estimateTokens, fromChat, toChat } from "./openai";
import { isAnswer, tokenReport } from "./report";
import { type HostedRouting, presentedToken, upstreamRequest } from "./route";
import { type GatewayDeps, isOpenAiPath, serveGateway } from "./serve";
import { measure } from "./usage";

interface Env extends HostedRouting {
  INTEGRATIONS: ServiceBinding;
  BILLING: ServiceBinding;
  IDENTITY: ServiceBinding;
}

/**
 * How long a looked-up token is trusted before it is looked up again. Short,
 * because a run's token is closed the moment the run ends (and a connection
 * may be removed mid-run): the proxy refuses it again within this long.
 */
const REMEMBER_MS = 10_000;
const remembered = new Map<string, { upstream: ModelUpstream | null; until: number }>();

async function lookUp(env: Env, token: string): Promise<ModelUpstream | null> {
  const now = Date.now();
  const hit = remembered.get(token);
  if (hit && hit.until > now) return hit.upstream;
  const upstream = await integrationsClient(env.INTEGRATIONS).modelUpstream(token);
  if (remembered.size > 5_000) remembered.clear();
  remembered.set(token, { upstream, until: now + REMEMBER_MS });
  return upstream;
}

/** An error in the shape Anthropic's API uses, which the harness understands. */
function refuse(status: number, message: string): Response {
  return Response.json(
    { type: "error", error: { type: status === 401 ? "authentication_error" : "not_found_error", message } },
    { status },
  );
}

/**
 * Passes an answer through and, once it has all gone by, tells billing what
 * it used. Reporting happens after the answer, and a report that fails is
 * dropped: the answer never waits on it or breaks for it.
 */
function counted(answer: Response, upstream: ModelUpstream, env: Env, ctx: ExecutionContext): Response {
  const { response, tokens, model } = measure(answer);
  ctx.waitUntil(
    (async () => {
      const report = tokenReport(upstream, await model, await tokens);
      if (report) await billingClient(env.BILLING).recordTokens(report);
    })().catch(() => undefined),
  );
  return response;
}

/** Sends an Anthropic request to a provider that speaks OpenAI's API. */
async function viaChat(upstream: ModelUpstream, path: string, request: Request): Promise<Response> {
  const body = (await request.json()) as AnthropicRequest;
  const model = upstream.model ?? body.model ?? "";
  if (path.startsWith("/v1/messages/count_tokens")) {
    return Response.json({ input_tokens: estimateTokens(body) });
  }
  if (!path.startsWith("/v1/messages")) return refuse(404, `${path} has no counterpart at this provider.`);

  const headers = new Headers({ "content-type": "application/json" });
  if (upstream.gatewayToken) headers.set("cf-aig-authorization", `Bearer ${upstream.gatewayToken}`);
  if (upstream.apiKey) {
    // `authorization` means a bearer token; any other header takes the key as it is.
    const header = upstream.authHeader ?? "authorization";
    headers.set(header, header === "authorization" ? `Bearer ${upstream.apiKey}` : upstream.apiKey);
  }
  const answer = await fetch(`${(upstream.baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(toChat(body, model, { official: upstream.official, provider: upstream.provider })),
  });
  if (!answer.ok) {
    return Response.json(errorFromChat(answer.status, await answer.text()), { status: answer.status });
  }
  if (!body.stream) return Response.json(fromChat((await answer.json()) as Record<string, unknown>, model));

  const translator = new StreamTranslator(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const translated = answer.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const out = translator.push(decoder.decode(chunk, { stream: true }));
        if (out) controller.enqueue(encoder.encode(out));
      },
      flush(controller) {
        const out = translator.push(decoder.decode()) + translator.finish();
        if (out) controller.enqueue(encoder.encode(out));
      },
    }),
  );
  return new Response(translated, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

// --- The AI Gateway ------------------------------------------------------------

/**
 * What gateway requests look up, remembered as briefly as a run's token
 * is: a deleted token, a key added under Integrations or credit just bought
 * takes effect within `REMEMBER_MS`. The catalogue changes rarely.
 */
const CATALOGUE_MS = 5 * 60_000;
const callers = new Map<string, { value: User | null; until: number }>();
const providers = new Map<string, { value: GatewayProvider[]; until: number }>();
const admitted = new Map<string, { value: string | null; until: number }>();
let catalogue: { models: GatewayModel[]; until: number } | null = null;

async function cached<T>(cache: Map<string, { value: T; until: number }>, key: string, read: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.value;
  const value = await read();
  if (cache.size > 5_000) cache.clear();
  cache.set(key, { value, until: now + REMEMBER_MS });
  return value;
}

async function offered(env: Env): Promise<GatewayModel[]> {
  if (catalogue && catalogue.until > Date.now()) return catalogue.models;
  const models = await billingClient(env.BILLING).gatewayModels();
  catalogue = { models, until: Date.now() + CATALOGUE_MS };
  return models;
}

/** What serving a gateway request reaches outside the proxy. */
function gatewayDeps(env: Env, ctx: ExecutionContext): GatewayDeps {
  return {
    hosted: env,
    caller: (token) => cached(callers, token, () => identityClient(env.IDENTITY).userForAccessToken(token)),
    providers: (workspace) => cached(providers, workspace, () => integrationsClient(env.INTEGRATIONS).gatewayProviders(workspace)),
    offered: () => offered(env),
    admit: (workspace) =>
      cached(admitted, workspace, async () => {
        const answer = await billingClient(env.BILLING).gatewayAdmit(workspace);
        return answer.ok ? null : answer.error.message;
      }),
    record: (record) => billingClient(env.BILLING).recordGateway(record),
    fetch: (url, init) => fetch(url, init),
    waitUntil: (promise) => ctx.waitUntil(promise),
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response("g1t's model proxy and AI Gateway. See https://docs.g1t.sh/guides/ai-gateway/\n");
    }
    const token = presentedToken(request.headers);
    // OpenAI's format is the AI Gateway's alone: runs speak Anthropic's.
    if (isOpenAiPath(url.pathname)) {
      if (!token?.startsWith("g1t_")) {
        return openaiError(401, "The AI Gateway takes a workspace's access token with the models:write scope, as the API key.");
      }
      return serveGateway(request, token, gatewayDeps(env, ctx));
    }
    if (!url.pathname.startsWith("/anthropic/")) return refuse(404, "Requests go to /anthropic/v1/… or /openai/v1/….");
    // A workspace's own access token: the AI Gateway.
    if (token?.startsWith("g1t_")) return serveGateway(request, token, gatewayDeps(env, ctx));
    if (!token?.startsWith("g1tm_")) return refuse(401, "This needs a g1t run's model token, or a workspace's access token for the AI Gateway.");
    const upstream = await lookUp(env, token);
    if (!upstream) return refuse(401, "This run's model token has expired, or its model connection was removed.");

    const path = url.pathname.slice("/anthropic".length) + url.search;
    // Both routes answer in Anthropic's shape, so one reading counts either.
    const answer = (response: Response) => (isAnswer(url.pathname.slice("/anthropic".length)) ? counted(response, upstream, env, ctx) : response);
    if (upstream.api === "openai") return answer(await viaChat(upstream, path, request));

    const { url: target, headers } = upstreamRequest(upstream, env, path, request.headers);
    // A route that names a model gets it for every request of the run,
    // including the harness's small background ones.
    let body: BodyInit | null = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    if (upstream.model && body && path.startsWith("/v1/messages")) {
      const parsed = (await request.json()) as Record<string, unknown>;
      body = JSON.stringify({ ...parsed, model: upstream.model });
      headers.delete("content-length");
    }
    return answer(await fetch(target, { method: request.method, headers, body }));
  },
} satisfies ExportedHandler<Env>;
