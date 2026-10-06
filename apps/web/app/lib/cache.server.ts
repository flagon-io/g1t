import { mustReadFresh } from "./perf.server";

/**
 * A few seconds of memory for answers that rarely change and are asked on
 * every page, such as the sidebar's projects and the workspace's spend:
 * kept per isolate, by a key that names the viewer, so one person's answer
 * is never another's.
 *
 * Never used while the answer must be current: during a request that
 * writes, and for a while after the person's last write (lib/perf.ts,
 * `PRIMARY_WINDOW_SECONDS`). Failures and `{ ok: false }` results are not
 * kept.
 */
const kept = new Map<string, { until: number; value: unknown }>();

/** Entries kept at most; the oldest go first. */
const MAX_ENTRIES = 2_000;

/**
 * Only settled answers are kept, never a promise still in flight: a
 * Worker's I/O belongs to the request that started it, so another request
 * must not wait on it.
 */
export async function shortCache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  if (mustReadFresh()) {
    kept.delete(key);
    return load();
  }
  const hit = kept.get(key);
  if (hit && hit.until > Date.now()) return hit.value as T;
  const value = await load();
  const failed = typeof value === "object" && value != null && "ok" in value && value.ok === false;
  if (!failed) {
    kept.delete(key);
    kept.set(key, { until: Date.now() + ttlMs, value });
    if (kept.size > MAX_ENTRIES) kept.delete(kept.keys().next().value as string);
  }
  return value;
}
