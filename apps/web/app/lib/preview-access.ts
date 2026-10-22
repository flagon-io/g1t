/**
 * A pull request's preview (pr-<number>-g1t.<subdomain>.workers.dev,
 * .g1t/workflows/preview.yml) runs against production's data, so only g1t
 * staff may open one. Cloudflare Access stands in front of the preview
 * addresses and signs in whoever comes; this is the second lock, in the
 * Worker: a request to a workers.dev address must carry the token Access
 * adds (`Cf-Access-Jwt-Assertion`), signed by the team's keys and made for
 * the previews' Access application. Without it the answer is 403, so a
 * preview stays shut if Access is ever switched off or misconfigured.
 *
 * g1t.sh and the other custom domains never come through here; the
 * production workers.dev address is turned off, and refused here too.
 */
export type PreviewAccess = {
  /** The Access team's domain, such as `syntaqx.cloudflareaccess.com`. */
  team: string;
  /** The previews' Access application's audience (AUD) tag. */
  aud: string;
};

/** The settings from the Worker's vars, or null when either is missing. */
export function previewAccessSettings(env: unknown): PreviewAccess | null {
  const vars = env as { PREVIEW_ACCESS_TEAM?: string; PREVIEW_ACCESS_AUD?: string };
  if (!vars.PREVIEW_ACCESS_TEAM || !vars.PREVIEW_ACCESS_AUD) return null;
  return { team: vars.PREVIEW_ACCESS_TEAM, aud: vars.PREVIEW_ACCESS_AUD };
}

export function isPreviewHost(hostname: string): boolean {
  return hostname.endsWith(".workers.dev");
}

/**
 * Null when the request may go on; otherwise the 403 to answer with.
 * Settings that are missing refuse every preview request rather than let
 * it through.
 */
export async function refusePreview(
  request: Request,
  settings: PreviewAccess | null,
  fetchKeys: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<Response | null> {
  if (!isPreviewHost(new URL(request.url).hostname)) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (settings && token && (await verifyAccessToken(token, settings, fetchKeys, now))) return null;
  return new Response("This preview is for g1t staff, signed in through Cloudflare Access.\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

type Jwk = JsonWebKey & { kid?: string };

/** The team's signing keys, kept an hour; fetched again for a key not seen. */
let keys: { team: string; at: number; byKid: Map<string, Jwk> } | undefined;
const KEYS_KEPT_MS = 60 * 60 * 1000;

async function signingKey(team: string, kid: string, fetchKeys: typeof fetch, now: number): Promise<Jwk | undefined> {
  const fresh = keys && keys.team === team && now - keys.at < KEYS_KEPT_MS;
  if (!fresh || !keys!.byKid.has(kid)) {
    const response = await fetchKeys(`https://${team}/cdn-cgi/access/certs`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { keys?: Jwk[] };
    keys = { team, at: now, byKid: new Map((body.keys ?? []).filter((k) => k.kid).map((k) => [k.kid!, k])) };
  }
  return keys!.byKid.get(kid);
}

/** Forget the cached keys (tests). */
export function forgetPreviewKeys() {
  keys = undefined;
}

export async function verifyAccessToken(token: string, settings: PreviewAccess, fetchKeys: typeof fetch, now: number): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(text(parts[0])) as { alg?: string; kid?: string };
    const claims = JSON.parse(text(parts[1])) as { aud?: string | string[]; iss?: string; exp?: number; nbf?: number };
    if (header.alg !== "RS256" || !header.kid) return false;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(settings.aud)) return false;
    if (claims.iss !== `https://${settings.team}`) return false;
    const seconds = now / 1000;
    if (typeof claims.exp !== "number" || claims.exp <= seconds) return false;
    if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) return false;
    const jwk = await signingKey(settings.team, header.kid, fetchKeys, now);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}

function bytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function text(base64url: string): string {
  return new TextDecoder().decode(bytes(base64url));
}
