/**
 * Screenshots of a project's production: one per deploy, kept in R2 under
 * the app's g1t.page hostname, with the commit it shows. Only apps on
 * g1t.page are ever visited, and only by hostname: a custom domain serves
 * the same app.
 */

export const DEPLOYMENTS_DOMAIN = "g1t.page";
/** The page is drawn at this size; the overview shows it scaled down. */
export const VIEWPORT = { width: 1280, height: 800 };
/** How long a page has to settle before it is taken anyway. */
export const SETTLE_MS = 12_000;
/** A screenshot that could not be taken is tried again after this long. */
export const RETRY_AFTER_MS = 5 * 60 * 1000;

export type ShotRequest = { host: string; commit: string };

/** Hostnames on g1t.page that are not apps. */
const RESERVED = new Set(["domains", "www"]);

/** The request, if it names an app on g1t.page and a commit. */
export function parseShot(input: unknown): ShotRequest | null {
  if (!input || typeof input !== "object") return null;
  const { host, commit } = input as Record<string, unknown>;
  if (typeof host !== "string" || typeof commit !== "string") return null;
  const name = host.toLowerCase();
  const suffix = `.${DEPLOYMENTS_DOMAIN}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) || RESERVED.has(label)) return null;
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return null;
  return { host: name, commit: commit.toLowerCase() };
}

/** Where an app's screenshot is kept. */
export function shotKey(host: string): string {
  return `production/${host}.jpg`;
}

/** Where the last attempt at an app's screenshot is noted. */
export function attemptKey(host: string): string {
  return `attempts/${host}`;
}

/** Whether to try again: not for the same commit within `RETRY_AFTER_MS`. */
export function shouldAttempt(last: { commit?: string; at?: string } | null | undefined, commit: string, now: number): boolean {
  if (!last?.at || last.commit !== commit) return true;
  const at = Date.parse(last.at);
  return !Number.isFinite(at) || now - at >= RETRY_AFTER_MS;
}
