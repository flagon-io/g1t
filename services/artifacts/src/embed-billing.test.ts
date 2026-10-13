import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  FREE_EMBED_TOKENS_PER_MONTH,
  embeddingCost,
  embeddingDetail,
  monthTokens,
  overFreeBudget,
  rememberWorkspace,
  reportEmbeddings,
} from "./embed-billing.ts";
import { indexDoc } from "./indexer.ts";
import type { Embedder, VectorStore } from "./vectors.ts";

function fakeD1() {
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
  const d1 = {
    prepare: (sql: string) => statement(sql),
    batch: async (list: ReturnType<typeof statement>[]) => list.map((s) => db.prepare(s.sql).run(...(s.params as never[]))),
  } as unknown as D1Database;
  return { d1, db };
}

const NOW = new Date("2026-10-13T12:00:00Z");

function usage(db: DatabaseSync, workspace: string, hour: string, tokens: number) {
  db.prepare("INSERT INTO doc_embed_usage (workspace_id, hour, chunks, tokens) VALUES (?, ?, 1, ?)").run(workspace, hour, tokens);
}

function billing(free: string[] = [], fail = false) {
  const notes: [string, string, number, string | null | undefined, string | null | undefined][] = [];
  return {
    notes,
    client: {
      async freeWorkspaces(slugs: string[]) {
        if (fail) throw new Error("billing answered 503");
        return slugs.filter((s) => free.includes(s));
      },
      async prices() {
        return { prices: [{ meter: "embedding_tokens", costMicros: 67_000 }] };
      },
      async notePending(workspace: string, source: "context", cost: number, detail?: string | null, month?: string | null) {
        if (fail) throw new Error("billing answered 503");
        notes.push([workspace, source, cost, detail, month]);
        return true;
      },
    },
  };
}

test("each workspace's month of tokens goes to billing as context, once per change, and only this month's", async () => {
  const { d1, db } = fakeD1();
  await rememberWorkspace(d1, { id: "wsp_1", slug: "Acme" });
  usage(db, "wsp_1", "2026-10-01T03", 1_500_000);
  usage(db, "wsp_1", "2026-10-13T11", 500_000);
  usage(db, "wsp_1", "2026-09-30T23", 9_000_000);
  // Not looked up yet: waits.
  usage(db, "wsp_2", "2026-10-13T11", 10);
  assert.equal(await monthTokens(d1, "wsp_1", "2026-10"), 2_000_000);
  const b = billing(["acme"]);
  assert.deepEqual(await reportEmbeddings(d1, b.client, NOW), { reported: 1, unknown: 1 });
  assert.deepEqual(b.notes, [["acme", "context", 134_000, "2.0 million tokens", "2026-10"]]);
  // Nothing new: nothing sent.
  await reportEmbeddings(d1, b.client, NOW);
  assert.equal(b.notes.length, 1);
  usage(db, "wsp_1", "2026-10-13T12", 1000);
  await reportEmbeddings(d1, b.client, NOW);
  assert.deepEqual(b.notes.at(-1), ["acme", "context", 134_067, "2.0 million tokens", "2026-10"]);
});

test("a month's last tokens go as that month's once it is over, then the new month's on their own", async () => {
  const { d1, db } = fakeD1();
  await rememberWorkspace(d1, { id: "wsp_1", slug: "acme" });
  usage(db, "wsp_1", "2026-10-31T20", 1_000_000);
  const b = billing([]);
  await reportEmbeddings(d1, b.client, new Date("2026-10-31T21:00:00Z"));
  assert.deepEqual(b.notes, [["acme", "context", 67_000, "1.0 million tokens", "2026-10"]]);
  // The last quarter hour of October, reported in November: as October's.
  usage(db, "wsp_1", "2026-10-31T23", 1_000_000);
  usage(db, "wsp_1", "2026-11-01T00", 10);
  await reportEmbeddings(d1, b.client, new Date("2026-11-01T00:15:00Z"));
  assert.deepEqual(b.notes.slice(1), [
    ["acme", "context", 134_000, "2.0 million tokens", "2026-10"],
    ["acme", "context", 1, "10 tokens", "2026-11"],
  ]);
  // Nothing new: October is not sent again.
  await reportEmbeddings(d1, b.client, new Date("2026-11-01T00:30:00Z"));
  assert.equal(b.notes.length, 3);
});

test("billing down: nothing is marked reported, and the plan it last said holds", async () => {
  const { d1, db } = fakeD1();
  await rememberWorkspace(d1, { id: "wsp_9", slug: "paid" });
  usage(db, "wsp_9", "2026-10-13T11", FREE_EMBED_TOKENS_PER_MONTH);
  // Unknown is held like a free workspace.
  assert.equal(await overFreeBudget(d1, "wsp_9", NOW), true);
  await reportEmbeddings(d1, billing([]).client, NOW);
  assert.equal(await overFreeBudget(d1, "wsp_9", NOW), false, "on the plan, no budget");
  const down = billing([], true);
  await reportEmbeddings(d1, down.client, NOW);
  assert.equal(await overFreeBudget(d1, "wsp_9", NOW), false, "still the plan billing last said");
  const row = db.prepare("SELECT noted_tokens FROM workspace_billing WHERE workspace_id = 'wsp_9'").get() as { noted_tokens: number };
  assert.equal(row.noted_tokens, FREE_EMBED_TOKENS_PER_MONTH);
});

test("a free workspace past its month's budget embeds nothing more; its passages are kept for words", async () => {
  const { d1, db } = fakeD1();
  await rememberWorkspace(d1, { id: "w1", slug: "free" });
  db.prepare("UPDATE workspace_billing SET plan = 'free'").run();
  usage(db, "w1", "2026-10-02T00", FREE_EMBED_TOKENS_PER_MONTH);
  let embedded = 0;
  const embedder: Embedder = {
    async embed(texts) {
      embedded += texts.length;
      return texts.map(() => [1, 1]);
    },
  };
  const store: VectorStore = { upsert: async () => {}, get: async () => [], delete: async () => {}, query: async () => [] };
  const result = await indexDoc(d1, embedder, store, { kind: "page", doc_id: "pag_1", workspace_id: "w1", space_id: "s1", title: "Ops", markdown: "## Deploy\n\nShip it carefully." }, NOW);
  assert.equal(embedded, 0);
  assert.equal(result.capped, true);
  assert.ok(result.chunks > 0);
  // A new month starts over.
  await indexDoc(d1, embedder, store, { kind: "page", doc_id: "pag_1", workspace_id: "w1", space_id: "s1", title: "Ops", markdown: "## Deploy\n\nShip it carefully." }, new Date("2026-11-01T00:00:00Z"));
  assert.ok(embedded > 0);
});

test("cost and detail", () => {
  assert.equal(embeddingCost(1_000_000, 67_000), 67_000);
  assert.equal(embeddingCost(1, 67_000), 1);
  assert.equal(embeddingCost(-5, 67_000), 0);
  assert.equal(embeddingDetail(1234), "1,234 tokens");
});
