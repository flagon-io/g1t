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
 * Each run is held to its cost cap here too, not only by the harness in the
 * sandbox: every answer's cost is added to the run's count (a Durable
 * Object per run, `run-spend.ts`), and once the run has spent its cap its
 * requests are refused with a 402 (`spend.ts`).
 *
 * The same address is the AI Gateway for a workspace's own code: a request
 * with one of the workspace's access tokens (`g1t_…`) instead of a run's,
 * at `/anthropic` in Anthropic's format or `/openai/v1` in OpenAI's, goes
 * to `serve.ts`, and is logged and charged to the workspace.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  type DiscoveryResult,
  type GatewayModel,
  type ModelDiscoveryApi,
  type GatewayProvider,
  type ModelUpstream,
  type ServiceBinding,
  type User,
  billingClient,
  identityClient,
  integrationsClient,
} from "@g1t/contracts";

import { openaiError } from "./chat";
import { discover } from "./discover";
import { anthropicErrorType } from "./gateway";
import { type AnthropicRequest, StreamTranslator, errorFromChat, estimateTokens, fromChat, toChat } from "./openai";
import { isAnswer, runMayCall, tokenReport } from "./report";
import { type HostedRouting, presentedToken, upstreamRequest } from "./route";
import type { RunSpend } from "./run-spend";
import { type GatewayDeps, isOpenAiPath, serveGateway } from "./serve";
import { capOf, capReached, ceilingMicros, chargeFor, pricesFor, tooBusy } from "./spend";
import { measure } from "./usage";

export { RunSpend } from "./run-spend";

interface Env extends HostedRouting {
  INTEGRATIONS: ServiceBinding;
  BILLING: ServiceBinding;
  IDENTITY: ServiceBinding;
  /** Each run's model spend, one object per model session. */
  RUN_SPEND: DurableObjectNamespace<RunSpend>;
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
  return Response.json({ type: "error", error: { type: anthropicErrorType(status), message } }, { status });
}

/** The run's spend count, by its session's id. */
function runSpend(env: Env, upstream: ModelUpstream): DurableObjectStub<RunSpend> {
  return env.RUN_SPEND.get(env.RUN_SPEND.idFromName(upstream.session || `${upstream.workspace}/${upstream.repo}#${upstream.number}`));
}

/** One answer's place in its run's count, settled once the answer has gone by. */
type Held = { spend: DurableObjectStub<RunSpend>; ticket: string; requested: Partial<AnthropicRequest> | null; bodyLength: number };

/**
 * Passes an answer through and, once it has all gone by, adds its cost to
 * the run's count and tells billing what it used. Both happen after the
 * answer, and a report that fails is dropped: the answer never waits on
 * it or breaks for it.
 */
function counted(answer: Response, upstream: ModelUpstream, env: Env, ctx: ExecutionContext, held: Held): Response {
  const { response, tokens, model } = measure(answer);
  ctx.waitUntil(
    (async () => {
      const used = await tokens;
      const answeredBy = await model;
      const settle = (async () => {
        const prices = pricesFor(upstream.model ?? answeredBy ?? held.requested?.model, upstream.route, await offered(env).catch(() => []));
        const charge = chargeFor(prices, used, answer.ok, ceilingMicros(prices, held.bodyLength, held.requested?.max_tokens));
        await held.spend.settle(held.ticket, charge);
      })().catch((error: unknown) => console.error("models: a run's spend was not counted", upstream.session, String(error)));
      const report = tokenReport(upstream, answeredBy, used);
      const reported = report ? billingClient(env.BILLING).recordTokens(report).catch(() => undefined) : Promise.resolve();
      await Promise.all([settle, reported]);
    })().catch(() => undefined),
  );
  return response;
}

/** The fields of a request body the proxy reads, or null when it is not a JSON object. */
function parsedBody(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Sends an Anthropic request to a provider that speaks OpenAI's API. */
async function viaChat(upstream: ModelUpstream, path: string, body: AnthropicRequest | null): Promise<Response> {
  if (!path.startsWith("/v1/messages")) return refuse(404, `${path} has no counterpart at this provider.`);
  if (!body) return refuse(400, "The request body is not a JSON object.");
  const model = upstream.model ?? body.model ?? "";
  if (path.startsWith("/v1/messages/count_tokens")) {
    return Response.json({ input_tokens: estimateTokens(body) });
  }

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

// --- Discovery -----------------------------------------------------------------

/** Lists every provider's models and records what changed with billing (discover.ts). */
function checkModels(env: Env, by: string): Promise<DiscoveryResult[]> {
  const billing = billingClient(env.BILLING);
  return discover(env, (url, init) => fetch(url, init), (provider, models, who, error) => billing.recordDiscovery(provider, models, who, error), by);
}

/**
 * "Check for new models" in sudo, which binds this entrypoint. Only a
 * service binding reaches it: nothing at models.g1t.sh does.
 */
export class Discovery extends WorkerEntrypoint<Env> implements ModelDiscoveryApi {
  async check(by: string): Promise<DiscoveryResult[]> {
    return checkModels(this.env, typeof by === "string" ? by : "");
  }
}

export default {
  /** Once a day: the providers' model lists, against the catalogue. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      checkModels(env, "schedule")
        .then((results) => {
          for (const result of results) {
            console.log(`models: ${result.provider} listed ${result.listed}, new ${result.added.length}, gone ${result.deprecated.length}${result.error ? `, failed: ${result.error}` : ""}`);
          }
        })
        .catch((error) => console.error("models: checking the providers' lists failed", error)),
    );
  },

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

    const route = url.pathname.slice("/anthropic".length);
    const path = route + url.search;
    if (!runMayCall(route, request.method)) return refuse(404, `A run's model token reaches only /anthropic/v1/messages and /anthropic/v1/models, not ${route}.`);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const text = hasBody ? await request.text() : null;
    const parsed = text === null ? null : parsedBody(text);

    // A model's answer costs the run: it must be under its cap to start
    // one, and the answer's cost is added to its count once it has gone by.
    let held: Held | null = null;
    if (isAnswer(route) && hasBody) {
      const spend = runSpend(env, upstream);
      const cap = capOf(upstream);
      let admitted;
      try {
        admitted = await spend.admit(cap);
      } catch (error) {
        console.error("models: a run's spend could not be checked", upstream.session, String(error));
        return refuse(503, "g1t could not check this run's spending just now. Try again.");
      }
      if (!admitted.ok) return admitted.reason === "cap" ? capReached(cap, admitted.spent) : tooBusy();
      held = { spend, ticket: admitted.ticket, requested: parsed as Partial<AnthropicRequest> | null, bodyLength: text?.length ?? 0 };
    }
    // Both routes answer in Anthropic's shape, so one reading counts either.
    const answer = (response: Response) => (held ? counted(response, upstream, env, ctx, held) : response);
    try {
      if (upstream.api === "openai") return answer(await viaChat(upstream, path, parsed as AnthropicRequest | null));

      const { url: target, headers } = upstreamRequest(upstream, env, path, request.headers);
      // A route that names a model gets it for every request of the run,
      // including the harness's small background ones.
      let body: string | null = text;
      if (upstream.model && parsed && path.startsWith("/v1/messages")) {
        body = JSON.stringify({ ...parsed, model: upstream.model });
        headers.delete("content-length");
      }
      return answer(await fetch(target, { method: request.method, headers, body }));
    } catch (error) {
      // No answer: it cost nothing, and gives its place back.
      if (held) ctx.waitUntil(held.spend.settle(held.ticket, 0).catch(() => undefined));
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
