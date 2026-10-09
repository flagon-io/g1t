/**
 * Work done on content that never changes once written: highlighting a
 * file's text, turning a README into a tree. The answer depends on the
 * content alone, so it is kept by a hash of that content and is good for
 * as long as the code that made it is the same (`version`, part of every
 * key). No viewer, path or branch is in the key, so the same text reached
 * by another branch, commit or page is the same entry, and nothing in an
 * entry says whose it is or where it came from.
 */

/**
 * A key for `parts`: SHA-256 over each part, length-prefixed, so
 * `["ab", "c"]` and `["a", "bc"]` never collide. Hex, 64 characters.
 */
export async function contentKey(parts: readonly string[]): Promise<string> {
  const text = parts.map((part) => `${part.length}:${part}`).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * An isolate's memory of recent answers, bounded by their total weight
 * (characters, roughly) rather than by count, so a few large files cannot
 * hold more than `maxWeight` between them. The least recently used go
 * first. An entry heavier than a quarter of the whole is never kept.
 */
export class WeightedLru<V> {
  private readonly entries = new Map<string, { value: V; weight: number }>();
  private total = 0;
  private readonly maxWeight: number;
  private readonly weigh: (value: V) => number;

  constructor(maxWeight: number, weigh: (value: V) => number) {
    this.maxWeight = maxWeight;
    this.weigh = weigh;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Most recently used last.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const weight = Math.max(1, this.weigh(value));
    this.delete(key);
    if (weight > this.maxWeight / 4) return;
    this.entries.set(key, { value, weight });
    this.total += weight;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.maxWeight) break;
      this.entries.delete(oldest);
      this.total -= entry.weight;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.weight;
  }

  get size(): number {
    return this.entries.size;
  }

  get weight(): number {
    return this.total;
  }
}

/** The weight of a list of strings: their characters. */
export function weightOfLines(lines: readonly (string | null)[]): number {
  let total = 0;
  for (const line of lines) total += (line?.length ?? 0) + 8;
  return total;
}

/** The data centre's cache, as far as a content cache needs it (`caches.default`). */
export type SharedCache = {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
};

/** Where shared entries live: a name nothing outside can ask for. */
export const CONTENT_ORIGIN = "https://content.g1t.internal/";

/** A shared entry is good for this long; its key changes when its content or code does. */
export const SHARED_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type ContentCacheOptions<V> = {
  /** What is kept, e.g. `highlight-lines`: part of every key. */
  name: string;
  /** Bumped whenever the code that makes an entry changes what it makes. */
  version: string;
  /** The isolate's share, in `weigh` units. */
  maxWeight: number;
  weigh: (value: V) => number;
  /** The data centre's cache, or null where there is none (tests, local development). */
  shared: () => SharedCache | null;
  /** Lets a write to the shared cache finish after the answer (`waitUntil`). */
  defer: (work: Promise<unknown>) => void;
};

/**
 * `compute`'s answer for content `parts`, kept in the isolate and in the
 * data centre's cache. The isolate is asked first, then the data centre;
 * only when neither has it is `compute` run, and its answer kept in both.
 * A null answer (nothing to keep: no language, too large, failed) is
 * returned and never kept. A shared entry that cannot be read is treated
 * as missing.
 */
export function contentCache<V>(options: ContentCacheOptions<V>) {
  const memory = new WeightedLru<V>(options.maxWeight, options.weigh);
  const cached = async (parts: readonly string[], compute: () => Promise<V | null>): Promise<V | null> => {
    const key = await contentKey([options.name, options.version, ...parts]);
    const remembered = memory.get(key);
    if (remembered !== undefined) return remembered;
    const url = `${CONTENT_ORIGIN}${options.name}/${options.version}/${key}`;
    const shared = options.shared();
    if (shared) {
      const found = await shared.match(url).catch(() => undefined);
      if (found) {
        const value = (await found.json().catch(() => undefined)) as V | undefined;
        if (value !== undefined && value !== null) {
          memory.set(key, value);
          return value;
        }
      }
    }
    const value = await compute();
    if (value === null) return null;
    memory.set(key, value);
    if (shared) {
      const response = new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${SHARED_MAX_AGE_SECONDS}` },
      });
      options.defer(shared.put(url, response).catch(() => undefined));
    }
    return value;
  };
  return Object.assign(cached, { memory });
}
