/**
 * Rate limits on g1t's public surfaces: Workers Rate Limiting bindings
 * (`ratelimits` in each wrangler.jsonc), asked once per request with a key:
 * the client's address, or a hash of its session or token, never the
 * secret itself.
 *
 * Every binding is listed in `RATE_LIMITS` with its namespace id and limit,
 * and apps/web's tests check each wrangler.jsonc against it, so this table
 * is the one place to read or change them. CONTRIBUTING.md, "Rate
 * limits", says how; the docs' rate limits page
 * (docs.g1t.sh/reference/rate-limits/) shows the public ones.
 *
 * A limit fails open: no binding (self-hosted, `wrangler dev` without one)
 * or a binding that throws lets the request through. A limit guards
 * against floods; it is never a reason for g1t to stop answering.
 */

/** A Workers Rate Limiting binding, as the runtime hands it over. */
export type RateLimitBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };

/** What asking a limit said. `unavailable` lets the request through. */
export type LimitVerdict = "allowed" | "limited" | "unavailable";

/**
 * Every limit's window, in seconds. Workers Rate Limiting counts over 10
 * or 60 seconds; every g1t limit uses 60, and a client past one is told to
 * wait that long.
 */
export const LIMIT_PERIOD_SECONDS = 60;

export type RateLimitSpec = {
  /** The Worker whose wrangler.jsonc declares it. */
  worker: string;
  /** Unique per Cloudflare account; allocated in blocks per Worker (CONTRIBUTING.md, "Rate limits"). */
  namespaceId: number;
  /** Requests per `LIMIT_PERIOD_SECONDS` per key. */
  limit: number;
  /** What a key is. */
  per: string;
};

/**
 * Every rate limit binding, by name. Generous for people, tight for floods:
 * a person browsing makes a few requests a second at most, a clone is three
 * git requests, and nothing a person does needs dozens of archives a minute.
 * Namespace ids go in blocks of a hundred per Worker: 41xx packages,
 * 42xx web, 43xx repos, 44xx api, 45xx og, 46xx status.
 */
export const RATE_LIMITS = {
  // services/packages (src/limits.rs): registry pulls and token requests.
  ANONYMOUS_LIMIT: { worker: "services/packages", namespaceId: 4101, limit: 300, per: "address" },
  SIGNED_LIMIT: { worker: "services/packages", namespaceId: 4102, limit: 5000, per: "person, workspace or agent" },
  // apps/web (workers/app.ts): the front door.
  WEB_ANONYMOUS_LIMIT: { worker: "apps/web", namespaceId: 4201, limit: 600, per: "address, signed-out pages" },
  WEB_HEAVY_LIMIT: { worker: "apps/web", namespaceId: 4202, limit: 30, per: "address, signed-out archives, run pages, logs and search" },
  WEB_SESSION_LIMIT: { worker: "apps/web", namespaceId: 4203, limit: 1200, per: "session, signed-in requests" },
  WEB_ADDRESS_LIMIT: { worker: "apps/web", namespaceId: 4204, limit: 3000, per: "address, every request that reaches the Worker" },
  GIT_ANONYMOUS_LIMIT: { worker: "apps/web", namespaceId: 4205, limit: 120, per: "address, git requests without credentials" },
  GIT_SIGNED_LIMIT: { worker: "apps/web", namespaceId: 4206, limit: 1200, per: "credential, git requests with credentials" },
  // The same as API_TOKEN_LIMIT: a token counts alike on the website and the API.
  WEB_TOKEN_LIMIT: { worker: "apps/web", namespaceId: 4207, limit: 1000, per: "token, pages and data requests with an access token" },
  // services/repos (src/lib.rs): what an anonymous clone can cost a repository's owner.
  PACK_FILL_LIMIT: { worker: "services/repos", namespaceId: 4301, limit: 30, per: "repository, packs written to the pack cache" },
  ANONYMOUS_FETCH_LIMIT: { worker: "services/repos", namespaceId: 4302, limit: 120, per: "repository, anonymous fetches the store answers" },
  // apps/api (src/limits.rs): REST and MCP, which count apart.
  API_ANONYMOUS_LIMIT: { worker: "apps/api", namespaceId: 4401, limit: 60, per: "address, requests without a token" },
  API_TOKEN_LIMIT: { worker: "apps/api", namespaceId: 4402, limit: 1000, per: "token" },
  // services/og: drawing a card that is not in the cache.
  OG_RENDER_LIMIT: { worker: "services/og", namespaceId: 4501, limit: 60, per: "address, cards drawn" },
  // apps/status: asking for a subscription, which sends an email.
  STATUS_SUBSCRIBE_LIMIT: { worker: "apps/status", namespaceId: 4601, limit: 3, per: "address" },
  STATUS_EMAIL_LIMIT: { worker: "apps/status", namespaceId: 4602, limit: 2, per: "email address" },
} as const satisfies Record<string, RateLimitSpec>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/**
 * Counts one request against `binding` under `key`. Never throws: a missing
 * binding or one that fails is `unavailable`, which callers let through.
 */
export async function checkLimit(binding: RateLimitBinding | undefined, key: string): Promise<LimitVerdict> {
  if (!binding) return "unavailable";
  try {
    const { success } = await binding.limit({ key });
    return success ? "allowed" : "limited";
  } catch (error) {
    console.error(JSON.stringify({ event: "rate_limit.unavailable", error: String(error) }));
    return "unavailable";
  }
}

/** Whether the request is past its limit. Fails open, like `checkLimit`. */
export async function isLimited(binding: RateLimitBinding | undefined, key: string): Promise<boolean> {
  return (await checkLimit(binding, key)) === "limited";
}

/** The client's address as Cloudflare saw it, for keys; `unknown` when there is none (local dev). */
export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

/**
 * A key for a secret (a session cookie, a token, a credential): `prefix:`
 * and the first 16 hex digits of its SHA-256, so the secret itself never
 * reaches the rate limiter.
 */
export async function secretKey(prefix: string, secret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  let hex = "";
  for (const byte of digest.subarray(0, 8)) hex += byte.toString(16).padStart(2, "0");
  return `${prefix}:${hex}`;
}

/** A 429 with `Retry-After`, as plain text unless `headers` says otherwise. */
export function tooManyRequests(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(LIMIT_PERIOD_SECONDS),
      "cache-control": "no-store",
      ...headers,
    },
  });
}
