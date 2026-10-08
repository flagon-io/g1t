import { waitUntil } from "cloudflare:workers";

import { mustReadFresh } from "./perf.server";

/**
 * A few seconds of memory for answers that rarely change and are asked on
 * every page, such as the sidebar's projects and the workspace's spend:
 * kept per isolate, and in the data centre's cache so the other isolates
 * there find it too, by a key that names the viewer, so one person's answer
 * is never another's. A person's pages land on many isolates, so the
 * isolate's memory alone was rarely there when the next page asked.
 *
 * Never used while the answer must be current: during a request that
 * writes, and for a while after the person's last write (lib/perf.ts,
 * `PRIMARY_WINDOW_SECONDS`). Failures and `{ ok: false }` results are not
 * kept.
 */
const kept = new Map<string, { until: number; value: unknown }>();

/** Entries kept at most; the oldest go first. */
const MAX_ENTRIES = 2_000;

/** Where the data centre's cache keeps them: a name nothing outside can ask for. */
const ORIGIN = "https://short.g1t.internal/";

function colo(): Cache | null {
  try {
    return (caches as unknown as { default: Cache }).default ?? null;
  } catch {
    // No cache (local development).
    return null;
  }
}

function keep(key: string, ttlMs: number, value: unknown) {
  kept.delete(key);
  kept.set(key, { until: Date.now() + ttlMs, value });
  if (kept.size > MAX_ENTRIES) kept.delete(kept.keys().next().value as string);
}

/**
 * Only settled answers are kept, never a promise still in flight: a
 * Worker's I/O belongs to the request that started it, so another request
 * must not wait on it.
 */
export async function shortCache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const cache = colo();
  const url = ORIGIN + encodeURIComponent(key);
  if (mustReadFresh()) {
    kept.delete(key);
    // What the data centre kept is older than what they just did.
    if (cache) waitUntil(cache.delete(url).then(() => undefined, () => undefined));
    return load();
  }
  const hit = kept.get(key);
  if (hit && hit.until > Date.now()) return hit.value as T;
  if (cache) {
    const shared = await cache.match(url).catch(() => undefined);
    if (shared) {
      const value = (await shared.json().catch(() => undefined)) as T | undefined;
      const left = Number(shared.headers.get("x-until")) - Date.now();
      if (value !== undefined && left > 0) {
        keep(key, Math.min(left, ttlMs), value);
        return value;
      }
    }
  }
  const value = await load();
  const failed = typeof value === "object" && value != null && "ok" in value && value.ok === false;
  if (!failed) {
    keep(key, ttlMs, value);
    if (cache && value !== undefined) {
      const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
      const response = new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          // Not `private`: the cache would refuse it. The key names the viewer.
          "cache-control": `max-age=${seconds}`,
          "x-until": String(Date.now() + ttlMs),
        },
      });
      // After the page is sent: the person waits for nothing here.
      waitUntil(cache.put(url, response).catch(() => undefined));
    }
  }
  return value;
}
