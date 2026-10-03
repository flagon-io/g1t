/**
 * The model proxy: every model request a g1t sandbox makes comes through
 * here, at `https://models.g1t.sh/anthropic`.
 *
 * A sandbox holds a token for its one run, never a key. The proxy looks the
 * token up and forwards the request with the credentials for that run:
 * g1t's AI Gateway when g1t pays, or the workspace's own Anthropic key or
 * endpoint when the workspace does. So a sandbox that is tricked into
 * printing its environment gives away a token that stops working when the
 * run ends, and nothing of the workspace's.
 *
 * Responses stream through untouched.
 */
import { type ModelUpstream, type ServiceBinding, integrationsClient } from "@g1t/contracts";

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
    const { url: target, headers } = upstreamRequest(upstream, env, path, request.headers);
    return fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    });
  },
} satisfies ExportedHandler<Env>;
