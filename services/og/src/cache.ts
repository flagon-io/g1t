/**
 * Part of every cache key: bump it when the cards' design changes, so the
 * cards already cached are drawn again.
 */
export const DESIGN = "1";

/**
 * The address a card is cached under: only the parameters that change it,
 * in order, so stray ones (trackers, cache busters) cannot fill the cache.
 */
export function cacheKey(url: URL): string {
  const wanted =
    url.pathname === "/docs" ? ["title", "section", "description"] : url.pathname === "/image" ? ["path", "v"] : [];
  const key = new URL(url.pathname, url.origin);
  key.searchParams.set("design", DESIGN);
  for (const name of wanted) {
    const value = url.searchParams.get(name);
    if (value !== null) key.searchParams.set(name, value);
  }
  return key.toString();
}
