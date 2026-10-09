import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_IN_FILTER, MEANING_FLOOR, QueryCache, TOP_K, TOP_K_UNFILTERED, fuseRanks, pickPassages, queryKey, recallLimit, requiredSpaces, vectorQueryPlan, type Candidate } from "./recall.ts";
import { ftsAnyQuery } from "./search.ts";

const c = (id: string, space: string, score: number, by: Candidate["by"] = "meaning"): Candidate => ({ id, doc_id: id.split(":")[0]!, space_id: space, score, by });

test("the index is filtered by the allowed spaces, or by workspace and after when there are too many", () => {
  assert.equal(vectorQueryPlan("w1", []), null);
  assert.deepEqual(vectorQueryPlan("w1", ["s1", "s2", "s1"]), { topK: TOP_K, filter: { workspace_id: "w1", space_ids: ["s1", "s2"] }, filterAfter: false });
  const many = Array.from({ length: MAX_IN_FILTER + 1 }, (_, i) => `s${i}`);
  assert.deepEqual(vectorQueryPlan("w1", many), { topK: TOP_K_UNFILTERED, filter: { workspace_id: "w1" }, filterAfter: true });
});

test("required reading never widens what may be read", () => {
  assert.deepEqual(requiredSpaces(["s1", "s2"], ["s2", "s3", "s2"]), ["s2"]);
  assert.deepEqual(requiredSpaces(["s1"], null), []);
  assert.deepEqual(requiredSpaces(["s1"], "s1"), []);
});

test("limits: five by default, ten at most", () => {
  assert.equal(recallLimit(undefined), 5);
  assert.equal(recallLimit(0), 5);
  assert.equal(recallLimit(3), 3);
  assert.equal(recallLimit(50), 10);
  assert.equal(recallLimit("x"), 5);
});

test("only close enough, only allowed, at most two per page, best first", () => {
  const picked = pickPassages(
    [
      c("p1:0", "s1", 0.81),
      c("p1:1", "s1", 0.8),
      c("p1:2", "s1", 0.79),
      c("p2:0", "s1", 0.7),
      c("p3:0", "secret", 0.95),
      c("p4:0", "s1", MEANING_FLOOR - 0.01),
    ],
    { allowed: new Set(["s1"]), limit: 10 },
  );
  assert.deepEqual(
    picked.map((p) => p.id),
    ["p1:0", "p1:1", "p2:0"],
  );
});

test("required spaces come first, then the rest", () => {
  const picked = pickPassages([c("a:0", "s1", 0.9), c("b:0", "s2", 0.75), c("c:0", "s1", 0.85)], { allowed: new Set(["s1", "s2"]), required: ["s2"], limit: 2 });
  assert.deepEqual(
    picked.map((p) => p.id),
    ["b:0", "a:0"],
  );
});

test("words fill in only when meaning finds too few, and never twice", () => {
  const candidates = [c("a:0", "s1", 0.9), c("a:0", "s1", 0.5, "words"), c("b:0", "s1", 0.5, "words"), c("c:0", "s1", 0.5, "words"), c("d:0", "nope", 0.5, "words")];
  assert.deepEqual(
    pickPassages(candidates, { allowed: new Set(["s1"]), limit: 3 }).map((p) => `${p.id}/${p.by}`),
    ["a:0/meaning", "b:0/words", "c:0/words"],
  );
  assert.deepEqual(
    pickPassages(candidates, { allowed: new Set(["s1"]), limit: 1 }).map((p) => p.id),
    ["a:0"],
  );
  // Nothing close and no words: nothing.
  assert.deepEqual(pickPassages([c("x:0", "s1", 0.3)], { allowed: new Set(["s1"]), limit: 5 }), []);
});

test("hybrid search fuses ranks: found both ways first", () => {
  assert.deepEqual(fuseRanks(["a", "b", "c"], ["c", "d"]), ["c", "a", "b", "d"]);
  assert.deepEqual(fuseRanks([], ["x", "y"]), ["x", "y"]);
});

test("query embeddings are kept a minute", () => {
  const cache = new QueryCache(60_000, 2);
  cache.set("a", [1], 0);
  assert.deepEqual(cache.get("a", 59_000), [1]);
  assert.equal(cache.get("a", 61_000), null);
  cache.set("a", [1], 0);
  cache.set("b", [2], 1);
  cache.set("c", [3], 2);
  assert.equal(cache.get("a", 3), null);
  assert.deepEqual(cache.get("c", 3), [3]);
  assert.equal(queryKey("  How do   we Deploy? "), "how do we deploy?");
});

test("recall's word fallback matches any meaningful word", () => {
  assert.equal(ftsAnyQuery("How do we roll back a deploy?"), '"roll" OR "back" OR "deploy"');
  assert.equal(ftsAnyQuery("is it a"), null);
  assert.equal(ftsAnyQuery('NEAR("x") deploy-key'), '"near" OR "deploy" OR "key"');
});
