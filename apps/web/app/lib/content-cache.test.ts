import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTENT_ORIGIN, type SharedCache, WeightedLru, contentCache, contentKey, weightOfLines } from "./content-cache.ts";

test("a content key is a hash of every part, in order, and never of a join that could collide", async () => {
  const key = await contentKey(["typescript", "const a = 1;"]);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, await contentKey(["typescript", "const a = 1;"]));
  assert.notEqual(key, await contentKey(["tsx", "const a = 1;"]));
  assert.notEqual(key, await contentKey(["typescript", "const a = 2;"]));
  // The same characters split differently are different content.
  assert.notEqual(await contentKey(["ab", "c"]), await contentKey(["a", "bc"]));
  assert.notEqual(await contentKey(["a:b"]), await contentKey(["a", "b"]));
});

test("the isolate's memory keeps the most recently used within its weight", () => {
  const lru = new WeightedLru<string>(100, (value) => value.length);
  lru.set("a", "x".repeat(20));
  lru.set("b", "x".repeat(20));
  lru.set("c", "x".repeat(20));
  assert.equal(lru.weight, 60);
  // Reading `a` makes it the newest; `b` is now the oldest.
  assert.ok(lru.get("a"));
  lru.set("d", "x".repeat(20));
  lru.set("e", "x".repeat(20));
  lru.set("f", "x".repeat(20));
  assert.equal(lru.get("b"), undefined);
  assert.ok(lru.get("a"));
  assert.ok(lru.weight <= 100);
  // Replacing an entry does not count it twice.
  lru.set("a", "y");
  assert.equal(lru.get("a"), "y");
  assert.ok(lru.weight <= 100);
  // One entry heavier than a quarter of the whole is never kept.
  lru.set("big", "x".repeat(26));
  assert.equal(lru.get("big"), undefined);
});

test("lines weigh their characters", () => {
  assert.equal(weightOfLines(["ab", null, ""]), 2 + 8 + 0 + 8 + 0 + 8);
});

/** A data centre's cache in memory, as caches.default answers. */
function fakeShared() {
  const kept = new Map<string, string>();
  const shared: SharedCache = {
    async match(url) {
      const body = kept.get(url);
      return body === undefined ? undefined : new Response(body);
    },
    async put(url, response) {
      kept.set(url, await response.text());
    },
  };
  return { kept, shared };
}

test("an answer is computed once, then read from the isolate, then from the data centre", async () => {
  const { kept, shared } = fakeShared();
  const deferred: Promise<unknown>[] = [];
  const options = {
    name: "test-lines",
    version: "v1",
    maxWeight: 1_000,
    weigh: weightOfLines,
    shared: () => shared,
    defer: (work: Promise<unknown>) => void deferred.push(work),
  };
  const cached = contentCache<string[]>(options);
  let runs = 0;
  const compute = async () => {
    runs += 1;
    return ["<b>a</b>", "b"];
  };
  assert.deepEqual(await cached(["rust", "a\nb"], compute), ["<b>a</b>", "b"]);
  await Promise.all(deferred);
  assert.equal(runs, 1);
  assert.equal(kept.size, 1);
  const [url] = kept.keys();
  assert.ok(url!.startsWith(`${CONTENT_ORIGIN}test-lines/v1/`));
  // The isolate has it.
  assert.deepEqual(await cached(["rust", "a\nb"], compute), ["<b>a</b>", "b"]);
  assert.equal(runs, 1);
  // Another isolate (a fresh cache) finds the data centre's copy.
  const other = contentCache<string[]>(options);
  assert.deepEqual(await other(["rust", "a\nb"], compute), ["<b>a</b>", "b"]);
  assert.equal(runs, 1);
  // Other content, or the same content for another language, is another entry.
  await cached(["rust", "a\nc"], compute);
  await cached(["go", "a\nb"], compute);
  assert.equal(runs, 3);
});

test("a new version never reads what an old one kept", async () => {
  const { shared } = fakeShared();
  const make = (version: string) =>
    contentCache<string[]>({ name: "test", version, maxWeight: 1_000, weigh: weightOfLines, shared: () => shared, defer: () => {} });
  const deferred: Promise<unknown>[] = [];
  const first = contentCache<string[]>({
    name: "test",
    version: "v1",
    maxWeight: 1_000,
    weigh: weightOfLines,
    shared: () => shared,
    defer: (work) => void deferred.push(work),
  });
  await first(["x"], async () => ["old"]);
  await Promise.all(deferred);
  assert.deepEqual(await make("v1")(["x"], async () => ["new"]), ["old"]);
  assert.deepEqual(await make("v2")(["x"], async () => ["new"]), ["new"]);
});

test("nothing to keep is not kept, and a broken shared entry counts as missing", async () => {
  const { kept, shared } = fakeShared();
  const cached = contentCache<string[]>({ name: "t", version: "v1", maxWeight: 1_000, weigh: weightOfLines, shared: () => shared, defer: () => {} });
  let runs = 0;
  assert.equal(await cached(["none"], async () => (runs++, null)), null);
  assert.equal(await cached(["none"], async () => (runs++, null)), null);
  assert.equal(runs, 2);
  assert.equal(kept.size, 0);

  const url = `${CONTENT_ORIGIN}t/v1/${await contentKey(["t", "v1", "broken"])}`;
  kept.set(url, "{not json");
  assert.deepEqual(await cached(["broken"], async () => ["fresh"]), ["fresh"]);
});

test("without a data centre's cache the isolate still keeps answers", async () => {
  const cached = contentCache<string[]>({ name: "t", version: "v1", maxWeight: 1_000, weigh: weightOfLines, shared: () => null, defer: () => {} });
  let runs = 0;
  await cached(["a"], async () => (runs++, ["x"]));
  await cached(["a"], async () => (runs++, ["x"]));
  assert.equal(runs, 1);
});
