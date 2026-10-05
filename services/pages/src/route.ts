/**
 * What a request's host is: g1t.page itself, an app's address on it, the
 * hostname custom domains point at, or a custom domain.
 *
 * Kept free of imports so its tests run on Node as they are.
 */

export const DOMAIN = "g1t.page";
/** Where custom domains point (the Cloudflare for SaaS fallback origin). */
export const FALLBACK = `domains.${DOMAIN}`;

export type Route =
  | { kind: "home" }
  | { kind: "fallback" }
  | { kind: "app"; label: string }
  | { kind: "custom"; hostname: string }
  | { kind: "invalid" };

const LABEL = /^[a-z0-9-]{1,63}$/;
const HOST = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function route(rawHost: string): Route {
  const host = rawHost.toLowerCase().replace(/\.$/, "");
  if (host === DOMAIN) return { kind: "home" };
  if (host === FALLBACK) return { kind: "fallback" };
  if (host.endsWith(`.${DOMAIN}`)) {
    const label = host.slice(0, -DOMAIN.length - 1);
    return LABEL.test(label) ? { kind: "app", label } : { kind: "invalid" };
  }
  return HOST.test(host) && host.length <= 253 ? { kind: "custom", hostname: host } : { kind: "invalid" };
}

/** What the deployments service writes under a custom hostname. */
export type DomainEntry = { script: string; redirect: string | null; project?: string };

/** Reads a stored entry, or null if it is not one. */
export function parseEntry(value: unknown): DomainEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.script !== "string" || !LABEL.test(entry.script)) return null;
  const redirect = typeof entry.redirect === "string" && HOST.test(entry.redirect) ? entry.redirect : null;
  return { script: entry.script, redirect };
}

/** The same path and query on `target`, over https. */
export function redirectTo(requestUrl: string, target: string): string {
  const url = new URL(requestUrl);
  return `https://${target}${url.pathname}${url.search}`;
}
