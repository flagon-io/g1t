import type { ModelUpstream } from "@g1t/contracts";

/** g1t's own way to the models, for runs it pays for. */
export type HostedRouting = {
  /** A Cloudflare AI Gateway id; empty sends requests to Anthropic directly. */
  AI_GATEWAY_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Authenticates to the gateway, which holds g1t's key. */
  AI_GATEWAY_TOKEN?: string;
  /** g1t's key, when the gateway does not hold it. */
  ANTHROPIC_API_KEY?: string;
};

/** Headers the sandbox sends that never go further. */
const DROPPED = new Set([
  "x-api-key",
  "authorization",
  "host",
  "cf-aig-authorization",
  "cf-aig-metadata",
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
]);

/** The token a sandbox sends instead of a key, from either header. */
export function presentedToken(headers: Headers): string | null {
  const key = headers.get("x-api-key");
  if (key) return key.trim();
  const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1].trim() : null;
}

/**
 * Where one request goes and what it carries: the sandbox's request,
 * stripped of its token, with the credentials for the run's route.
 * `path` is what follows `/anthropic`, such as `/v1/messages?beta=true`.
 */
export function upstreamRequest(
  upstream: ModelUpstream,
  hosted: HostedRouting,
  path: string,
  incoming: Headers,
): { url: string; headers: Headers } {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (!DROPPED.has(name.toLowerCase())) headers.set(name, value);
  }
  if (upstream.route === "g1t") {
    if (!hosted.AI_GATEWAY_ID) {
      if (hosted.ANTHROPIC_API_KEY) headers.set("x-api-key", hosted.ANTHROPIC_API_KEY);
      return { url: `https://api.anthropic.com${path}`, headers };
    }
    // The gateway logs these with every request, so spend and failures can
    // be read per kind of work, workspace, repository and pull request.
    headers.set(
      "cf-aig-metadata",
      JSON.stringify({ task: upstream.task, workspace: upstream.workspace, repo: upstream.repo, pull: upstream.number }),
    );
    if (hosted.AI_GATEWAY_TOKEN) headers.set("cf-aig-authorization", `Bearer ${hosted.AI_GATEWAY_TOKEN}`);
    if (hosted.ANTHROPIC_API_KEY) headers.set("x-api-key", hosted.ANTHROPIC_API_KEY);
    return {
      url: `https://gateway.ai.cloudflare.com/v1/${hosted.CLOUDFLARE_ACCOUNT_ID}/${hosted.AI_GATEWAY_ID}/anthropic${path}`,
      headers,
    };
  }
  const key = upstream.apiKey;
  if (key) {
    if (upstream.authHeader === "authorization") headers.set("authorization", `Bearer ${key}`);
    else headers.set("x-api-key", key);
  }
  if (upstream.gatewayToken) headers.set("cf-aig-authorization", `Bearer ${upstream.gatewayToken}`);
  const base = (upstream.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return { url: `${base}${path}`, headers };
}
