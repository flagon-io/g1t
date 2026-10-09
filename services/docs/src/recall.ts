/**
 * Recall's choices, apart from where the passages come from: how the
 * vector query is filtered, which matches are close enough, and how
 * passages are picked (an agent's required reading first, at most two per
 * document, words only to fill). Pure; src/index.ts `recallForAgent` and
 * hybrid search run it over Vectorize and D1.
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
/** The score a passage found only by its words carries: below the floor, so callers can tell. */
export const WORDS_SCORE = 0.5;
/** Nearest passages asked of the index. */
export const TOP_K = 24;
/** Asked when the index can't filter by space and recall filters after: more, so enough are left. */
export const TOP_K_UNFILTERED = 50;
/** The most space ids put in one `$in` filter; past it, filter after the query (a Vectorize filter is at most 2 KB of JSON). */
export const MAX_IN_FILTER = 40;
/** Passages from one page or file at most. */
export const PER_DOC = 2;
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 10;

export function recallLimit(limit: unknown): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

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
 * The spaces recall looks in first: those asked for (an agent's required
 * reading) that may be read. Never wider than what may be read.
 */
export function requiredSpaces(allowed: string[], asked: unknown): string[] {
  if (!Array.isArray(asked)) return [];
  const may = new Set(allowed);
  return [...new Set(asked.map(String))].filter((id) => may.has(id));
}

export type Candidate = {
  /** The passage's id: `<doc>:<seq>`. */
  id: string;
  /** Its page's or file's id. */
  doc_id: string;
  space_id: string;
  score: number;
  /** Found by meaning (the index) or by its words (full text). */
  by: "meaning" | "words";
};

/**
 * The passages to hand over, best first: by meaning above the floor,
 * required spaces first, then the rest; then, if that is fewer than
 * `limit`, by words, required spaces first. At most PER_DOC from one
 * document, each passage once, only from `allowed`.
 */
export function pickPassages<T extends Candidate>(candidates: T[], options: { allowed: Set<string>; required?: string[]; limit: number; floor?: number }): T[] {
  const floor = options.floor ?? MEANING_FLOOR;
  const required = new Set(options.required ?? []);
  const usable = candidates.filter((c) => options.allowed.has(c.space_id));
  const meaning = usable.filter((c) => c.by === "meaning" && c.score >= floor).sort((a, b) => b.score - a.score);
  const words = usable.filter((c) => c.by === "words");
  const out: T[] = [];
  const taken = new Set<string>();
  const perDoc = new Map<string, number>();
  const take = (list: T[]) => {
    for (const c of list) {
      if (out.length >= options.limit) return;
      if (taken.has(c.id)) continue;
      const n = perDoc.get(c.doc_id) ?? 0;
      if (n >= PER_DOC) continue;
      taken.add(c.id);
      perDoc.set(c.doc_id, n + 1);
      out.push(c);
    }
  };
  take(meaning.filter((c) => required.has(c.space_id)));
  take(meaning.filter((c) => !required.has(c.space_id)));
  take(words.filter((c) => required.has(c.space_id)));
  take(words.filter((c) => !required.has(c.space_id)));
  return out;
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
 * A query's embeddings, kept a minute per isolate: an agent asked the same
 * thing again in a session, or a search page reloaded, embeds once.
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
