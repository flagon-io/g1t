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
 * the run ends, and nothing of the workspace's.
 *
 * Responses stream through.
 */
import { type ModelUpstream, type ServiceBinding, integrationsClient } from "@g1t/contracts";

import { type AnthropicRequest, StreamTranslator, errorFromChat, estimateTokens, fromChat, toChat } from "./openai";
import { type HostedRouting, presentedToken, upstreamRequest } from "./route";

interface Env extends HostedRouting {
  INTEGRATIONS: ServiceBinding;
}

/** How long a looked-up token is trusted before it is looked up again. */
const REMEMBER_MS = 60_000;
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
    if (upstream.authHeader === "x-api-key") headers.set("x-api-key", upstream.apiKey);
    else headers.set("authorization", `Bearer ${upstream.apiKey}`);
  }
  const answer = await fetch(`${(upstream.baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(toChat(body, model, { official: upstream.official })),
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response("g1t's model proxy, for g1t's sandboxes. See https://docs.g1t.sh/guides/models/\n");
    }
    if (!url.pathname.startsWith("/anthropic/")) return refuse(404, "Requests go to /anthropic/v1/….");
    const token = presentedToken(request.headers);
    if (!token?.startsWith("g1tm_")) return refuse(401, "This needs a g1t run's model token.");
    const upstream = await lookUp(env, token);
    if (!upstream) return refuse(401, "This run's model token has expired, or its model connection was removed.");

    const path = url.pathname.slice("/anthropic".length) + url.search;
    if (upstream.api === "openai") return viaChat(upstream, path, request);

    const { url: target, headers } = upstreamRequest(upstream, env, path, request.headers);
    // A route that names a model gets it for every request of the run,
    // including the harness's small background ones.
    let body: BodyInit | null = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    if (upstream.model && body && path.startsWith("/v1/messages")) {
      const parsed = (await request.json()) as Record<string, unknown>;
      body = JSON.stringify({ ...parsed, model: upstream.model });
      headers.delete("content-length");
    }
    return fetch(target, { method: request.method, headers, body });
  },
} satisfies ExportedHandler<Env>;
