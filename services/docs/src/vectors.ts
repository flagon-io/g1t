/**
 * The semantic index's two adapters: what turns text into vectors
 * (`Embedder`) and where vectors are kept and searched (`VectorStore`).
 * Docs only ever talks to these, so a self-hosted g1t could put another
 * model or vector database behind them. Only Cloudflare's are built
 * today: Workers AI (`@cf/baai/bge-base-en-v1.5`, 768 dimensions) and
 * Vectorize (the `g1t-docs` index, cosine, metadata indexes on
 * `workspace_id` and `space_id`). Without them (no AI or VECTORS
 * binding), Docs keeps its passages in D1 and recall matches words only.
 *
 * Folios (Artifacts mode) have an index of their own, `g1t-folios`
 * (binding FOLIO_VECTORS), filtered by `workspace_id`, `scope` and `kind`:
 * the same two adapters, another index.
 */

/**
 * Workers AI's embedding model, as the index was made with. Pinned:
 * vectors from another model mean nothing beside these, so changing it
 * means a new index, rebuilt (the backfill, src/indexer.ts).
 */
export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
/** Texts per embedding call. */
export const EMBED_BATCH = 50;

export type Embedder = {
  /** One vector per text, in order. Throws when the model can't answer. */
  embed(texts: string[]): Promise<number[][]>;
};

export type VectorMetadata = {
  workspace_id: string;
  /** Docs' pages and projects' docs (index `g1t-docs`). */
  space_id?: string;
  /** Folios (index `g1t-folios`): `space:<id>` or `folio:<access root>` (src/access.ts `folioScope`). */
  scope?: string;
  kind: "page" | "repo_file" | "doc" | "slides" | "design" | "dashboard";
  page_id?: string;
  repo_file_id?: string;
  repo_id?: string;
  folio_id?: string;
};

export type VectorFilter = {
  workspace_id: string;
  /** Only these spaces; absent for every space (then the caller filters what comes back). */
  space_ids?: string[];
  /** Folios: only these scopes; absent for every scope (then the caller filters what comes back). */
  scopes?: string[];
};

export type VectorMatch = { id: string; score: number };

export type VectorStore = {
  upsert(vectors: { id: string; values: number[]; metadata: VectorMetadata }[]): Promise<void>;
  /** Stored vectors' values by id, for passages that only moved. Missing ids are left out. */
  get(ids: string[]): Promise<{ id: string; values: number[] }[]>;
  delete(ids: string[]): Promise<void>;
  query(vector: number[], options: { topK: number; filter: VectorFilter }): Promise<VectorMatch[]>;
};

/** Workers AI as the embedder. */
export function cloudflareEmbedder(ai: Ai): Embedder {
  return {
    async embed(texts) {
      const out: number[][] = [];
      for (let at = 0; at < texts.length; at += EMBED_BATCH) {
        const batch = texts.slice(at, at + EMBED_BATCH);
        const embedded = (await ai.run(EMBED_MODEL as Parameters<Ai["run"]>[0], { text: batch } as never)) as { data?: number[][] };
        const data = embedded.data ?? [];
        if (data.length !== batch.length) throw new Error(`the embedding model answered ${data.length} of ${batch.length}`);
        out.push(...data);
      }
      return out;
    },
  };
}

/** Vectorize's `getByIds`, `deleteByIds` and `upsert` take at most this many at once (kept well under its limits). */
const STORE_BATCH = 20;
const UPSERT_BATCH = 100;

/** Vectorize as the store. */
export function cloudflareVectors(index: Vectorize): VectorStore {
  return {
    async upsert(vectors) {
      for (let at = 0; at < vectors.length; at += UPSERT_BATCH) {
        await index.upsert(vectors.slice(at, at + UPSERT_BATCH).map((v) => ({ id: v.id, values: v.values, metadata: v.metadata as unknown as Record<string, VectorizeVectorMetadata> })));
      }
    },
    async get(ids) {
      const out: { id: string; values: number[] }[] = [];
      for (let at = 0; at < ids.length; at += STORE_BATCH) {
        const found = await index.getByIds(ids.slice(at, at + STORE_BATCH));
        for (const v of found) if (v.values) out.push({ id: v.id, values: Array.from(v.values as ArrayLike<number>) });
      }
      return out;
    },
    async delete(ids) {
      for (let at = 0; at < ids.length; at += STORE_BATCH * 5) await index.deleteByIds(ids.slice(at, at + STORE_BATCH * 5));
    },
    async query(vector, options) {
      const filter: Record<string, unknown> = { workspace_id: options.filter.workspace_id };
      if (options.filter.space_ids) filter.space_id = { $in: options.filter.space_ids };
      if (options.filter.scopes) filter.scope = { $in: options.filter.scopes };
      const found = await index.query(vector, { topK: options.topK, returnMetadata: "none", returnValues: false, filter: filter as VectorizeVectorMetadataFilter });
      return found.matches.map((m) => ({ id: m.id, score: m.score }));
    },
  };
}
