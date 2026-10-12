/**
 * Screenshots of a project's production: one per deploy, kept in R2 under
 * the app's g1t.page hostname, with the commit it shows. An app on
 * g1t.page is visited only by hostname: a custom domain serves the same
 * app. A project deployed elsewhere is visited at its production address,
 * when that is a public one (below).
 */

export const DEPLOYMENTS_DOMAIN = "g1t.page";
/** The page is drawn at this size; the overview shows it scaled down. */
export const VIEWPORT = { width: 1280, height: 800 };
/** How long a page has to settle before it is taken anyway. */
export const SETTLE_MS = 12_000;
/** A screenshot that could not be taken is tried again after this long. */
export const RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * An app's production at `commit`. `since` is when it was last deployed:
 * a resumed or moved app is deployed again at the same commit, and a
 * screenshot from before that (of a page saying it was paused, say) is not
 * current.
 */
export type ShotRequest = { host: string; commit: string; since?: string };

/** Kept screenshots and attempt notes older than this are deleted; a page asking for one again takes it anew. */
export const KEEP_DAYS = 30;

/** Hostnames on g1t.page that are not apps. */
const RESERVED = new Set(["domains", "www"]);

/** The request, if it names an app on g1t.page and a commit. */
export function parseShot(input: unknown): ShotRequest | null {
  if (!input || typeof input !== "object") return null;
  const { host, commit, since } = input as Record<string, unknown>;
  if (typeof host !== "string" || typeof commit !== "string") return null;
  const name = host.toLowerCase();
  const suffix = `.${DEPLOYMENTS_DOMAIN}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) || RESERVED.has(label)) return null;
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return null;
  const shot: ShotRequest = { host: name, commit: commit.toLowerCase() };
  if (typeof since === "string" && Number.isFinite(Date.parse(since))) shot.since = since;
  return shot;
}

/** Where an app's screenshot is kept. */
export function shotKey(host: string): string {
  return `production/${host}.jpg`;
}

/** Where the last attempt at an app's screenshot is noted. */
export function attemptKey(host: string): string {
  return `attempts/${host}`;
}

/** Whether a kept screenshot shows the request: its commit, taken after the deploy. */
export function isCurrent(kept: { commit: string; capturedAt: string }, request: ShotRequest): boolean {
  if (kept.commit !== request.commit) return false;
  if (!request.since) return true;
  return Date.parse(kept.capturedAt) >= Date.parse(request.since);
}

/** Whether a kept object is old enough to delete. */
export function expired(uploaded: Date, now: number, days = KEEP_DAYS): boolean {
  return now - uploaded.getTime() > days * 24 * 60 * 60 * 1000;
}

/** Whether to try again: not for the same commit within `RETRY_AFTER_MS`. */
export function shouldAttempt(last: { commit?: string; at?: string } | null | undefined, commit: string, now: number): boolean {
  if (!last?.at || last.commit !== commit) return true;
  const at = Date.parse(last.at);
  return !Number.isFinite(at) || now - at >= RETRY_AFTER_MS;
}

/*
 * Production deployed elsewhere: a project that runs on its own pipeline,
 * at the address it was given (or the one its reported production
 * deployment names). Its screenshot is kept apart from g1t.page apps',
 * under `external/<host>.jpg`, by the address's host. With no g1t deploy
 * to say when it changed, it is taken when the address is set or changed,
 * when a production deployment is reported for it, and otherwise at most
 * once a day (index.ts's cron). Its `commit` is the reported deploy's
 * commit, or the UTC day it was taken for (`YYYY-MM-DD`).
 */

/** A kept screenshot of an external production older than this is taken again. */
export const EXTERNAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** External productions the daily cron takes at most, the stalest first; the rest wait a day. */
export const EXTERNAL_PER_RUN = 40;

/** An external production: the address to visit, keyed by its host. */
export type ExternalShot = ShotRequest & { url: string };

/** Where an external production's screenshot is kept. */
export function externalShotKey(host: string): string {
  return `external/${host}.jpg`;
}

/** Where the last attempt at an external production's screenshot is noted. */
export function externalAttemptKey(host: string): string {
  return `attempts/external/${host}`;
}

/** The UTC day of `now`, as an external screenshot's `commit` when no deploy names one. */
export function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Hosts g1t serves itself and never visits as someone's production: its
 * own services (any name under g1t.sh but g1t.sh itself), the usercontent
 * origin, and g1t.page, whose apps are taken per deploy instead.
 */
const OWN_DOMAINS = ["g1t.sh", "g1tusercontent.com", DEPLOYMENTS_DOMAIN];
/** g1t's own site is a production like any other. */
const OWN_ALLOWED = new Set(["g1t.sh", "www.g1t.sh"]);
/** Names that only resolve on a private network, or never on the internet. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".test", ".invalid", ".example", ".onion", ".arpa"];

/** Whether a dotted-quad address is not a public one; null when the host is not one. */
function privateIPv4(host: string): boolean | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  if (parts.some((part) => Number(part) > 255)) return true;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * Whether a host is a public name or address on the internet: no
 * loopback, private, link-local, shared or reserved address, no name that
 * only means something on a private network, and none of g1t's own
 * services but g1t.sh. A name is not resolved here: Browser Rendering's
 * browser runs on the public internet and cannot reach a private network
 * whatever a name resolves to.
 */
export function isPublicHost(input: string): boolean {
  const host = input.toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return false;
  // An IPv6 literal: none is let through. A site is visited by its name.
  if (host.includes(":") || host.startsWith("[")) return false;
  const v4 = privateIPv4(host);
  if (v4 !== null) return !v4;
  // An integer, octal or hexadecimal form of an address.
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/.test(host)) return false;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) return false;
  if (host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  if (OWN_ALLOWED.has(host)) return true;
  return !OWN_DOMAINS.some((own) => host === own || host.endsWith(`.${own}`));
}

/**
 * The request, if it names a public http(s) address on its usual port and
 * either a commit or a UTC day. The address keeps its path and query,
 * without its fragment; one with a user or password is refused.
 */
export function parseExternalShot(input: unknown): ExternalShot | null {
  if (!input || typeof input !== "object") return null;
  const { url, commit, since } = input as Record<string, unknown>;
  if (typeof url !== "string" || typeof commit !== "string" || url.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  if (!isPublicHost(parsed.hostname)) return null;
  const version = commit.toLowerCase();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(version) && Number.isFinite(Date.parse(version));
  if (!/^[0-9a-f]{7,64}$/.test(version) && !day) return null;
  parsed.hash = "";
  const shot: ExternalShot = { host: parsed.hostname.toLowerCase().replace(/\.$/, ""), url: parsed.toString(), commit: version };
  if (typeof since === "string" && Number.isFinite(Date.parse(since))) shot.since = since;
  return shot;
}

/**
 * Whether a kept external screenshot still stands for the address: taken
 * within `EXTERNAL_MAX_AGE_MS`, and after `since` (the reported deploy).
 */
export function isFresh(kept: { capturedAt: string } | null | undefined, now: number, since?: string): boolean {
  if (!kept) return false;
  const at = Date.parse(kept.capturedAt);
  if (!Number.isFinite(at) || now - at >= EXTERNAL_MAX_AGE_MS) return false;
  return !since || !Number.isFinite(Date.parse(since)) || at >= Date.parse(since);
}

/**
 * The external productions the daily cron takes: those whose screenshot
 * is missing or not fresh, the stalest first, at most `limit`.
 */
export function dueForRefresh<T extends { capturedAt: string | null }>(targets: readonly T[], now: number, limit = EXTERNAL_PER_RUN): T[] {
  const age = (target: T) => (target.capturedAt ? Date.parse(target.capturedAt) || 0 : 0);
  return targets
    .filter((target) => !isFresh(target.capturedAt ? { capturedAt: target.capturedAt } : null, now))
    .sort((a, b) => age(a) - age(b))
    .slice(0, limit);
}
