/**
 * Recall's choices, apart from where the passages come from: how the
 * vector query is filtered, which matches are close enough, and how
 * results of words and meaning are fused. Pure; hybrid search runs it
 * over Vectorize and D1.
 */

/**
 * The least cosine similarity a passage needs to count as being about the
 * query. Measured on g1t's own docs folder (606 passages, chunked and
 * embedded as here, bge-base-en-v1.5 with Workers AI's mean pooling): the
 * best passage for 16 questions the docs answer scored 0.72 to 0.84, while
 * the best for 16 they don't ("hello", a recipe, Postgres tuning, a
 * vacation policy, SSO with Okta) scored 0.54 to 0.67. At 0.6, 11 of those
 * 16 pulled in passages (up to 89 above it); 0.7 keeps every answer and
 * keeps recall quiet when the docs say nothing about the question.
 */
export const MEANING_FLOOR = 0.7;
/** Nearest passages asked of the index. */
export const TOP_K = 24;
/** Asked when the index can't filter by space and recall filters after: more, so enough are left. */
export const TOP_K_UNFILTERED = 50;
/** The most space ids put in one `$in` filter; past it, filter after the query (a Vectorize filter is at most 2 KB of JSON). */
export const MAX_IN_FILTER = 40;

/**
 * How to ask the index: by the allowed spaces when there are few enough
 * to name, otherwise by workspace alone, more of them, filtered after.
 * Null when nothing may be read.
 */
export function vectorQueryPlan(workspaceId: string, allowed: string[]): { topK: number; filter: { workspace_id: string; space_ids?: string[] }; filterAfter: boolean } | null {
  const ids = [...new Set(allowed)];
  if (!ids.length) return null;
  if (ids.length <= MAX_IN_FILTER) return { topK: TOP_K, filter: { workspace_id: workspaceId, space_ids: ids }, filterAfter: false };
  return { topK: TOP_K_UNFILTERED, filter: { workspace_id: workspaceId }, filterAfter: true };
}

/**
 * Hybrid search's order for people: each document's place in the word
 * results and in the meaning results, fused by reciprocal rank (k = 60),
 * so a page both find comes first and either alone still counts.
 */
export function fuseRanks(words: string[], meaning: string[], k = 60): string[] {
  const score = new Map<string, number>();
  const add = (ids: string[]) =>
    [...new Set(ids)].forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  add(words);
  add(meaning);
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * A query's embeddings, kept a minute per isolate: a search page
 * reloaded embeds once.
 */
export class QueryCache {
  private readonly entries = new Map<string, { at: number; vector: number[] }>();
  private readonly ttlMs: number;
  private readonly max: number;
  constructor(ttlMs = 60_000, max = 200) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get(key: string, now = Date.now()): number[] | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (now - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.vector;
  }

  set(key: string, vector: number[], now = Date.now()): void {
    if (this.entries.size >= this.max) {
      for (const [k, v] of this.entries) if (now - v.at > this.ttlMs) this.entries.delete(k);
      while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { at: now, vector });
  }
}

/** A query as the cache keys it: the same words, however spaced or cased. */
export function queryKey(query: string): string {
  return String(query ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 2000);
}
