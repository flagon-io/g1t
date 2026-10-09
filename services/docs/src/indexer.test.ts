import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { EMBED_PER_HOUR, indexDoc, type IndexDoc } from "./indexer.ts";
import type { Embedder, VectorMetadata, VectorStore } from "./vectors.ts";

/** D1, as far as the indexer uses it, over node's SQLite with the service's migrations. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
    run: async () => db.prepare(sql).run(...(params as never[])),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: ReturnType<typeof statement>[]) => list.map((s) => db.prepare(s.sql).run(...(s.params as never[]))),
  } as unknown as D1Database;
}

function fakes() {
  const vectors = new Map<string, { values: number[]; metadata: VectorMetadata }>();
  let embedded = 0;
  const embedder: Embedder = {
    async embed(texts) {
      embedded += texts.length;
      return texts.map((t) => [t.length, 1]);
    },
  };
  const store: VectorStore = {
    async upsert(list) {
      for (const v of list) vectors.set(v.id, { values: v.values, metadata: v.metadata });
    },
    async get(ids) {
      return ids.filter((id) => vectors.has(id)).map((id) => ({ id, values: vectors.get(id)!.values }));
    },
    async delete(ids) {
      for (const id of ids) vectors.delete(id);
    },
    async query() {
      return [];
    },
  };
  return { vectors, embedder, store, embeddedCount: () => embedded };
}

const section = (name: string) => `## ${name}\n\n${Array.from({ length: 60 }, (_, i) => `${name.toLowerCase()}${i}`).join(" ")}.`;
const page = (markdown: string, over: Partial<IndexDoc> = {}): IndexDoc => ({ kind: "page", doc_id: "pag_1", workspace_id: "w1", space_id: "s1", title: "Ops", markdown, ...over });

test("a page's passages are stored, embedded once, and only changed ones again", async () => {
  const db = fakeD1();
  const f = fakes();
  const first = await indexDoc(db, f.embedder, f.store, page([section("Deploy"), section("Rollback")].join("\n\n")));
  assert.deepEqual(first, { chunks: 2, embedded: 2, capped: false });
  assert.deepEqual([...f.vectors.keys()].sort(), ["pag_1:0", "pag_1:1"]);
  assert.deepEqual(f.vectors.get("pag_1:0")!.metadata, { workspace_id: "w1", space_id: "s1", kind: "page", page_id: "pag_1" });
  // Saved again unchanged: nothing embedded.
  assert.equal((await indexDoc(db, f.embedder, f.store, page([section("Deploy"), section("Rollback")].join("\n\n")))).embedded, 0);
  // One section changed.
  assert.equal((await indexDoc(db, f.embedder, f.store, page([section("Deploy"), section("Restore")].join("\n\n")))).embedded, 1);
  assert.equal(f.embeddedCount(), 3);
  // Word search finds passages by heading and text.
  const hit = await db.prepare("SELECT chunk_id FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ?").bind('"restore"').all<{ chunk_id: string }>();
  assert.deepEqual(
    hit.results.map((r) => r.chunk_id),
    ["pag_1:1"],
  );
});

test("a passage that only moved keeps its vector; gone passages leave the index", async () => {
  const db = fakeD1();
  const f = fakes();
  await indexDoc(db, f.embedder, f.store, page([section("Alpha"), section("Beta"), section("Gamma")].join("\n\n")));
  const before = f.embeddedCount();
  // Alpha removed: Beta and Gamma move up a place, nothing new to embed.
  const r = await indexDoc(db, f.embedder, f.store, page([section("Beta"), section("Gamma")].join("\n\n")));
  assert.equal(r.embedded, 0);
  assert.equal(f.embeddedCount(), before);
  assert.deepEqual([...f.vectors.keys()].sort(), ["pag_1:0", "pag_1:1"]);
  const rows = await db.prepare("SELECT id, heading, hash = vector_hash AS current FROM doc_chunks ORDER BY seq").all<{ id: string; heading: string; current: number }>();
  assert.deepEqual(
    rows.results.map((x) => [x.id, x.heading, x.current]),
    [
      ["pag_1:0", "Beta", 1],
      ["pag_1:1", "Gamma", 1],
    ],
  );
});

test("moving a page to another space files its vectors there without embedding", async () => {
  const db = fakeD1();
  const f = fakes();
  await indexDoc(db, f.embedder, f.store, page(section("Deploy")));
  const r = await indexDoc(db, f.embedder, f.store, page(section("Deploy"), { space_id: "s2" }));
  assert.equal(r.embedded, 0);
  assert.equal(f.vectors.get("pag_1:0")!.metadata.space_id, "s2");
  assert.equal((await db.prepare("SELECT space_id FROM doc_chunks WHERE id = 'pag_1:0'").first<{ space_id: string }>())!.space_id, "s2");
});

test("embedding stops at the hourly cap and the rest waits, kept for words", async () => {
  const db = fakeD1();
  const f = fakes();
  const at = new Date("2026-10-09T10:15:00Z");
  await db.prepare("INSERT INTO doc_embed_usage (workspace_id, hour, chunks, tokens) VALUES ('w1', '2026-10-09T10', ?, 0)").bind(EMBED_PER_HOUR - 1).run();
  const r = await indexDoc(db, f.embedder, f.store, page([section("One"), section("Two"), section("Three")].join("\n\n")), at);
  assert.deepEqual(r, { chunks: 3, embedded: 1, capped: true });
  const waiting = await db.prepare("SELECT COUNT(*) AS n FROM doc_chunks WHERE vector_hash IS NULL OR vector_hash <> hash").first<{ n: number }>();
  assert.equal(waiting!.n, 2);
  // The next hour, a save picks up the rest.
  const later = await indexDoc(db, f.embedder, f.store, page([section("One"), section("Two"), section("Three")].join("\n\n")), new Date("2026-10-09T11:01:00Z"));
  assert.deepEqual(later, { chunks: 3, embedded: 2, capped: false });
});

test("an embedding failure leaves passages for the next save, never throws", async () => {
  const db = fakeD1();
  const f = fakes();
  const broken: Embedder = {
    async embed() {
      throw new Error("model down");
    },
  };
  const r = await indexDoc(db, broken, f.store, page(section("Deploy")));
  assert.equal(r.chunks, 1);
  assert.equal(f.vectors.size, 0);
  assert.equal((await indexDoc(db, f.embedder, f.store, page(section("Deploy")))).embedded, 1);
});

test("without an embedder, passages are kept for words only", async () => {
  const db = fakeD1();
  const r = await indexDoc(db, null, null, page(section("Deploy")));
  assert.deepEqual(r, { chunks: 1, embedded: 0, capped: false });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM doc_chunks_fts").first<{ n: number }>())!.n, 1);
});

test("a project's docs file is indexed with its repository", async () => {
  const db = fakeD1();
  const f = fakes();
  await indexDoc(db, f.embedder, f.store, { kind: "repo_file", doc_id: "rf_x", workspace_id: "w1", space_id: "rds_1", title: "Setup", markdown: `# Setup\n\n${section("Install")}`, repo_id: "r1", path: "docs/setup.md" });
  assert.deepEqual(f.vectors.get("rf_x:0")!.metadata, { workspace_id: "w1", space_id: "rds_1", kind: "repo_file", repo_file_id: "rf_x", repo_id: "r1" });
  const row = await db.prepare("SELECT page_id, repo_file_id, path, heading FROM doc_chunks").first<Record<string, unknown>>();
  assert.deepEqual({ ...row }, { page_id: null, repo_file_id: "rf_x", path: "docs/setup.md", heading: "Install" });
});
