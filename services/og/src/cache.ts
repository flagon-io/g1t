import { OG_RENDER_VERSION } from "@g1t/contracts/og";

/**
 * The version of the cards' design, part of every cache key. Bump it (in
 * `packages/contracts/src/og.ts`, which the site and the docs read too)
 * whenever the card design changes, so the cards already cached are drawn
 * again and every page links to a new address.
 */
export const RENDER_VERSION = OG_RENDER_VERSION;

/**
 * The address a card is cached under: the render version, then only the
 * parameters that change the card, in order, including the page's own
 * content version `v`, so stray ones (trackers, cache busters) cannot fill
 * the cache.
 */
export function cacheKey(url: URL): string {
  const wanted =
    url.pathname === "/docs" ? ["title", "section", "description", "v"] : url.pathname === "/image" ? ["path", "v"] : [];
  const key = new URL(url.pathname, url.origin);
  key.searchParams.set("render", RENDER_VERSION);
  for (const name of wanted) {
    const value = url.searchParams.get(name);
    if (value !== null) key.searchParams.set(name, value);
  }
  return key.toString();
}
