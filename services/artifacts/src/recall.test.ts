import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_IN_FILTER, QueryCache, TOP_K, TOP_K_UNFILTERED, fuseRanks, queryKey, vectorQueryPlan } from "./recall.ts";

test("the index is filtered by the allowed spaces, or by workspace and after when there are too many", () => {
  assert.equal(vectorQueryPlan("w1", []), null);
  assert.deepEqual(vectorQueryPlan("w1", ["s1", "s2", "s1"]), { topK: TOP_K, filter: { workspace_id: "w1", space_ids: ["s1", "s2"] }, filterAfter: false });
  const many = Array.from({ length: MAX_IN_FILTER + 1 }, (_, i) => `s${i}`);
  assert.deepEqual(vectorQueryPlan("w1", many), { topK: TOP_K_UNFILTERED, filter: { workspace_id: "w1" }, filterAfter: true });
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
