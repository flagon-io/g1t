import assert from "node:assert/strict";
import { test } from "node:test";

import { combine, runCheck, step } from "./probe.ts";

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
