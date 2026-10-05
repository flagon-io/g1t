/**
 * Who is asking: sudo sits behind Cloudflare Access, and checks Access's
 * work itself on every request. Access signs a JWT for each request it
 * lets through and sends it in `Cf-Access-Jwt-Assertion`; this verifies
 * its RS256 signature against the team's published keys, its audience,
 * issuer and lifetime, and then that its email belongs to g1t staff.
 *
 * Plain Web Crypto, no dependencies and no Workers imports, so the tests
 * run it under Node as it runs on Workers.
 */

/** Where sudo is served; the only origin a change may be posted from. */
export const ORIGIN = "https://sudo.g1t.sh";

/** How far clocks may disagree, in seconds. */
const LEEWAY_SECONDS = 30;
/** How long the team's keys are trusted before they are fetched again. */
const JWKS_TTL_MS = 5 * 60_000;
/** A token signed by a key not seen yet refetches the keys, at most this often. */
const JWKS_REFETCH_MS = 30_000;
/** Access tokens are a few kilobytes; anything far larger is not one. */
const MAX_TOKEN_LENGTH = 16_384;

export type AccessSettings = {
  /** The Zero Trust team domain, such as `g1t.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's Audience (AUD) tag. */
  aud: string;
  /** Lowercased staff emails. */
  staff: string[];
};

export type AccessEnv = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  STAFF_EMAILS?: string;
};

/**
 * Reads the settings, or null when any is missing or malformed: sudo then
 * refuses everything rather than guess.
 */
export function readSettings(env: AccessEnv): AccessSettings | null {
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN ?? "");
  const aud = (env.ACCESS_AUD ?? "").trim();
  const staff = parseStaff(env.STAFF_EMAILS ?? "");
  if (!teamDomain || !/^[A-Za-z0-9]{16,128}$/.test(aud) || staff.length === 0) return null;
  return { teamDomain, aud, staff };
}

/**
 * `g1t.cloudflareaccess.com`, given with or without its scheme. Only a
 * Cloudflare Access team domain is accepted, since that is where the
 * signing keys are fetched from.
 */
export function normalizeTeamDomain(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(host) ? host : null;
}

export function parseStaff(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => /^[^@\s]+@[^@\s]+$/.test(email));
}

export type AccessClaims = {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
  sub?: string;
  email?: string;
  [claim: string]: unknown;
};

export type Verified = { ok: true; claims: AccessClaims } | { ok: false; reason: string };

export type VerifyOptions = {
  /** Fetches the team's keys; the global `fetch` unless a test gives another. */
  fetcher?: (url: string) => Promise<Response>;
  /** Milliseconds since the epoch. */
  now?: number;
};

type KeySet = { keys: Map<string, CryptoKey>; fetchedAt: number };

/** The team's signing keys, by team domain, kept briefly in memory. */
const keySets = new Map<string, KeySet>();

/** Forgets the cached keys. For tests. */
export function clearKeyCache(): void {
  keySets.clear();
}

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

async function fetchKeySet(
  teamDomain: string,
  fetcher: (url: string) => Promise<Response>,
  now: number,
): Promise<KeySet> {
  const response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access keys answered ${response.status}`);
  const body = (await response.json()) as { keys?: unknown };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
    if (!jwk || typeof jwk !== "object") continue;
    const { kid, kty, n, e, alg, use } = jwk as Record<string, unknown>;
    if (typeof kid !== "string" || kty !== "RSA" || typeof n !== "string" || typeof e !== "string") continue;
    if (alg !== undefined && alg !== "RS256") continue;
    if (use !== undefined && use !== "sig") continue;
    try {
      keys.set(kid, await crypto.subtle.importKey("jwk", { kty, n, e }, RSA, false, ["verify"]));
    } catch {
      // A key that does not import is skipped; tokens signed by it fail.
    }
  }
  return { keys, fetchedAt: now };
}

/** The key a token names, fetching the team's keys when they are stale or it is new. */
async function keyFor(
  teamDomain: string,
  kid: string,
  fetcher: (url: string) => Promise<Response>,
  now: number,
): Promise<CryptoKey | null> {
  let set = keySets.get(teamDomain);
  const stale = !set || now - set.fetchedAt >= JWKS_TTL_MS;
  const unknown = set && !set.keys.has(kid) && now - set.fetchedAt >= JWKS_REFETCH_MS;
  if (stale || unknown) {
    try {
      set = await fetchKeySet(teamDomain, fetcher, now);
      keySets.set(teamDomain, set);
    } catch {
      // Keys that could not be refreshed are not trusted past their time.
      if (stale) {
        keySets.delete(teamDomain);
        return null;
      }
    }
  }
  return set?.keys.get(kid) ?? null;
}

function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(segment)));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Verifies an Access JWT: signature, algorithm, issuer, audience and lifetime. */
export async function verifyAccessJwt(
  token: string,
  settings: Pick<AccessSettings, "teamDomain" | "aud">,
  options: VerifyOptions = {},
): Promise<Verified> {
  const now = options.now ?? Date.now();
  const fetcher = options.fetcher ?? ((url: string) => fetch(url));

  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "token too long" };
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    return { ok: false, reason: "malformed token" };
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (!header || !payload) return { ok: false, reason: "malformed token" };
  // Only RS256: never `none`, and never a symmetric algorithm keyed with a public key.
  if (header.alg !== "RS256") return { ok: false, reason: "unexpected algorithm" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "no key id" };

  const key = await keyFor(settings.teamDomain, header.kid, fetcher, now);
  if (!key) return { ok: false, reason: "unknown signing key" };

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlBytes(encodedSignature);
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const valid = await crypto.subtle.verify(RSA, key, signature, signed);
  if (!valid) return { ok: false, reason: "bad signature" };

  // Only now that the signature holds do the claims mean anything.
  if (payload.iss !== `https://${settings.teamDomain}`) return { ok: false, reason: "wrong issuer" };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(settings.aud)) return { ok: false, reason: "wrong audience" };
  const seconds = Math.floor(now / 1000);
  if (typeof payload.exp !== "number") return { ok: false, reason: "no expiry" };
  if (seconds >= payload.exp + LEEWAY_SECONDS) return { ok: false, reason: "expired" };
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number") return { ok: false, reason: "malformed nbf" };
    if (seconds + LEEWAY_SECONDS < payload.nbf) return { ok: false, reason: "not yet valid" };
  }
  return { ok: true, claims: payload as AccessClaims };
}

export type Authorized = { ok: true; email: string } | { ok: false; reason: string; email?: string };

/**
 * Whether a request comes from g1t staff, through Access: a valid token
 * whose email is on the staff list. Service tokens carry no email and are
 * refused.
 */
export async function authorize(
  request: Request,
  settings: AccessSettings,
  options: VerifyOptions = {},
): Promise<Authorized> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, reason: "no Access token" };
  const verified = await verifyAccessJwt(token, settings, options);
  if (!verified.ok) return verified;
  const email = typeof verified.claims.email === "string" ? verified.claims.email.trim().toLowerCase() : "";
  if (!email) return { ok: false, reason: "token has no email" };
  if (!settings.staff.includes(email)) return { ok: false, reason: "not staff", email };
  return { ok: true, email };
}

/**
 * Whether a change was posted from sudo's own pages: the browser's
 * `Origin`, or failing that its `Referer`, must be sudo's. A request that
 * says neither is refused.
 */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === ORIGIN;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === ORIGIN;
  } catch {
    return false;
  }
}
