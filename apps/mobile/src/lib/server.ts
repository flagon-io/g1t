/**
 * Which g1t the app talks to. Hosted g1t is the site `https://g1t.sh` and
 * the API `https://api.g1t.sh`; a self-hosted g1t sets its own (SITE_URL
 * and API_URL, apps/api/src/addresses.rs), so the app keeps both.
 *
 * The site is where people sign in and approve the app, and where Chat's
 * routes are; the API is the REST API and the OAuth issuer.
 *
 * Kept free of React Native imports so `npm test` runs it under Node.
 */

export type Server = {
  /** An origin, no trailing slash: `https://g1t.sh`. */
  site: string;
  /** An origin, no trailing slash: `https://api.g1t.sh`. */
  api: string;
  /** False when this g1t sends phones no notifications (its PHONE_PUSH=off, lib/discover.ts). */
  push?: boolean;
};

export const HOSTED: Server = { site: "https://g1t.sh", api: "https://api.g1t.sh" };

/**
 * An origin as typed: http or https with a host, `https://` when no scheme
 * is given; only the origin is kept. Null when it is not a web address.
 * Plain http is accepted for a g1t on this network, as in development.
 */
export function parseOrigin(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * The API's address for a site, when only the site was given: hosted
 * g1t's own, or `api.` in front of a self-hosted site's host, which is
 * how deploy/self-host names it.
 */
export function apiFor(site: string): string {
  if (site === HOSTED.site) return HOSTED.api;
  const url = new URL(site);
  return `${url.protocol}//api.${url.host}`;
}

/** A server from what was typed: the site, and the API if it was given. */
export function parseServer(siteText: string, apiText?: string): Server | null {
  const site = parseOrigin(siteText);
  if (!site) return null;
  if (apiText && apiText.trim()) {
    const api = parseOrigin(apiText);
    if (!api) return null;
    return { site, api };
  }
  return { site, api: apiFor(site) };
}

export function isHosted(server: Server): boolean {
  return server.site === HOSTED.site && server.api === HOSTED.api;
}

/** The site's address for a path, such as a page to open in the browser. */
export function siteUrl(server: Server, path: string): string {
  return server.site + (path.startsWith("/") ? path : `/${path}`);
}

/** The socket address for one of the site's live paths. */
export function socketUrl(server: Server, path: string): string {
  return siteUrl(server, path).replace(/^http/, "ws");
}
