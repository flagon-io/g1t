import assert from "node:assert/strict";
import { test } from "node:test";

import { combine, judgeStorage, runCheck, step } from "./probe.ts";

const answer = (status: number) => async () => new Response("x", { status });

test("a step works on 2xx, or on exactly the status it expects", async () => {
  assert.equal((await step(answer(200), { url: "https://a/" })).ok, true);
  const refused = await step(answer(502), { url: "https://a/" });
  assert.deepEqual([refused.ok, refused.error], [false, "HTTP 502"]);
  assert.equal((await step(answer(401), { url: "https://a/", expect: 401 })).ok, true);
  assert.equal((await step(answer(200), { url: "https://a/", expect: 401 })).ok, false);
});

test("a step that cannot connect, or takes too long, fails with why", async () => {
  const broken = await step(async () => Promise.reject(new TypeError("boom")), { url: "https://a/" });
  assert.equal(broken.error, "could not connect");
  const slow = await step(
    (_url, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    { url: "https://a/" },
    20,
  );
  assert.equal(slow.error, "timed out");
});

test("a check's steps: all must work, and it takes as long as the slowest", () => {
  assert.deepEqual(combine([{ ok: true, ms: 10 }, { ok: true, ms: 30 }]), { ok: true, ms: 30 });
  assert.deepEqual(combine([{ ok: true, ms: 10 }, { ok: false, ms: 5, error: "HTTP 500" }]), { ok: false, ms: 10, error: "HTTP 500" });
});

test("runCheck: billing without a binding, and a part with no check, are null", async () => {
  const probers = { fetch: answer(200), billing: null };
  assert.equal(await runCheck({ kind: "billing" }, probers), null);
  assert.equal(await runCheck({ kind: "none" }, probers), null);
  assert.equal((await runCheck({ kind: "billing" }, { ...probers, billing: async () => ({ version: 1 }) }))!.ok, true);
  assert.equal((await runCheck({ kind: "billing" }, { ...probers, billing: async () => null }))!.error, "no price book");
  const mixed = await runCheck({ kind: "http", steps: [{ url: "https://a/" }, { url: "https://b/", expect: 401 }] }, probers);
  assert.equal(mixed!.ok, false);
});

test("git storage is judged by how its calls went, and quiet is up", async () => {
  const row = (calls: number, errors: number, rate_limited: number, rejected: number, ms_total: number) => ({
    store: "g1t",
    calls,
    errors,
    rate_limited,
    rejected,
    ms_total,
  });
  const report = (...stores: ReturnType<typeof row>[]) => ({ minutes: 5, stores });
  assert.deepEqual(judgeStorage(report()), { ok: true, ms: 0 });
  assert.deepEqual(judgeStorage(report(row(100, 1, 0, 0, 30_000))), { ok: true, ms: 300 });
  // A quarter or more failing, at least five: down.
  const down = judgeStorage(report(row(10, 3, 0, 0, 1_000), row(10, 2, 0, 0, 1_000)));
  assert.deepEqual([down.ok, down.error], [false, "25% of calls failed"]);
  // Too few to tell.
  assert.equal(judgeStorage(report(row(4, 4, 0, 0, 400))).ok, true);
  // Refused by an open breaker: down.
  assert.equal(judgeStorage(report(row(0, 0, 0, 3, 0))).ok, false);
  // Rate limited: degraded, not down.
  const limited = judgeStorage(report(row(100, 2, 2, 0, 10_000)));
  assert.deepEqual([limited.ok, limited.degraded], [true, "Rate limited 2 times in 5 minutes"]);
  // Served from the fallback store: degraded, whatever its own calls did.
  const onFallback = judgeStorage(report({ ...row(20, 0, 0, 0, 200), store: "g1t@fallback" }));
  assert.deepEqual([onFallback.ok, onFallback.degraded], [true, "Served from the backup store: reads work, pushes and merges wait"]);
  const viaCheck = await runCheck({ kind: "storage" }, { fetch: answer(200), billing: null, storage: async () => report(row(1, 0, 0, 0, 5)) });
  assert.deepEqual(viaCheck, { ok: true, ms: 5 });
  assert.equal(await runCheck({ kind: "storage" }, { fetch: answer(200), billing: null }), null);
});
