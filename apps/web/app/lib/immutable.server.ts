/**
 * Things that never change once they exist, such as a commit and its diff,
 * kept in the data centre's cache so only the first visit pays for them.
 *
 * Call this only after the viewer is known to be allowed to see the thing:
 * the cache is shared by everyone who asks for the same key.
 */
const ORIGIN = "https://immutable.g1t.internal/";
/** A year: what is cached here does not go stale. */
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export async function immutable<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const url = ORIGIN + encodeURIComponent(key);
  let cache: Cache | null = null;
  try {
    cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(url);
    if (hit) return (await hit.json()) as T;
  } catch {
    // No cache (local development): load it every time.
  }
  const value = await load();
  if (value != null && cache) {
    await cache
      .put(
        url,
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${MAX_AGE_SECONDS}, immutable` },
        }),
      )
      .catch(() => {});
  }
  return value;
}
