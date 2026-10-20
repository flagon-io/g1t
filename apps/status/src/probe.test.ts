import assert from "node:assert/strict";
import { test } from "node:test";

import { isbot } from "isbot";

import { components } from "./components.ts";
import { BROWSER_USER_AGENT, USER_AGENT, coloOf, combine, confirmSlow, judgeStorage, judgedMs, probe, runCheck, serverOf, serverTotal, step } from "./probe.ts";

const answer = (status: number) => async () => new Response("x", { status });

test("page loads say they are a browser, so the site streams them; the name stays on the end", async () => {
  // The isbot apps/web's entry.server.tsx uses: a match waits for the full render.
  assert.equal(isbot(USER_AGENT), true, "the plain user agent reads as a crawler");
  assert.equal(isbot(BROWSER_USER_AGENT), false);
  assert.match(BROWSER_USER_AGENT, /g1t-status\/1\.0/);
  const seen: string[] = [];
  const fetcher = async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers).get("user-agent") ?? "");
    return new Response("x");
  };
  await step(fetcher, { url: "https://a/", browser: true });
  await step(fetcher, { url: "https://a/" });
  assert.deepEqual(seen, [BROWSER_USER_AGENT, USER_AGENT]);
  // The site's pages load as a browser would; git, the API and the rest as before.
  const parts = components({ SITE_URL: "https://g1t.sh", API_URL: "https://api.g1t.sh", PROBE_REPO: "flagon-io/g1t", DOCS_URL: "https://docs.g1t.sh" });
  const browsing = parts.flatMap((p) => (p.check.kind === "http" ? p.check.steps.filter((s) => s.browser).map((s) => s.url) : []));
  assert.deepEqual(browsing, ["https://g1t.sh/login", "https://g1t.sh/flagon-io/g1t", "https://g1t.sh/explore"]);
});

test("the data centre that answered is read from cf-ray", async () => {
  assert.equal(coloOf("8c1f2e3d4a5b6c7d-IAD"), "IAD");
  assert.equal(coloOf("8c1f2e3d4a5b6c7d-ams"), "AMS");
  assert.equal(coloOf(null), null);
  assert.equal(coloOf("nonsense"), null);
  const ray = async () => new Response("x", { headers: { "cf-ray": "8c1f2e3d4a5b6c7d-SJC" } });
  assert.equal((await step(ray, { url: "https://a/" })).colo, "SJC");
  assert.equal((await step(answer(200), { url: "https://a/" })).colo, undefined);
  assert.equal(
    combine([
      { ok: true, ms: 1 },
      { ok: true, ms: 2, colo: "FRA" },
    ]).colo,
    "FRA",
  );
});

test("a slow answer is asked again at once: one slow answer is not slow, two are", async () => {
  // Fast the second time: counts as the fast one, keeping the first time.
  assert.deepEqual(confirmSlow({ ok: true, ms: 2400, colo: "IAD" }, { ok: true, ms: 300, colo: "IAD" }), { ok: true, ms: 300, colo: "IAD", first_ms: 2400 });
  // Slow twice: slow, at the faster of the two.
  assert.deepEqual(confirmSlow({ ok: true, ms: 2400 }, { ok: true, ms: 1900 }), { ok: true, ms: 1900, first_ms: 2400 });
  // A second try that failed does not make it worse.
  assert.deepEqual(confirmSlow({ ok: true, ms: 2400 }, { ok: false, ms: 5000, error: "timed out" }), { ok: true, ms: 2400, first_ms: 2400 });

  let calls = 0;
  const times = [1200, 200];
  let clock = 0;
  const timedFetch = async () => {
    clock += times[calls++] ?? 0;
    return new Response("x");
  };
  const check = { kind: "http" as const, steps: [{ url: "https://a/" }] };
  // A fake clock through the fetch: probe() asks again only when the first is slow.
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const confirmed = await probe(check, { fetch: timedFetch, billing: null }, 800);
    assert.equal(calls, 2);
    assert.deepEqual(confirmed, { ok: true, ms: 200, first_ms: 1200 });
    calls = 0;
    clock = 0;
    times.splice(0, 2, 300, 300);
    assert.deepEqual(await probe(check, { fetch: timedFetch, billing: null }, 800), { ok: true, ms: 300 });
    assert.equal(calls, 1, "a check in time is not asked twice");
  } finally {
    Date.now = realNow;
  }
  // Failures are not asked again: detection's N of M decides about them (detect.ts).
  calls = 0;
  const failing = async () => {
    calls += 1;
    return new Response("x", { status: 502 });
  };
  assert.equal((await probe(check, { fetch: failing, billing: null }, 800))!.ok, false);
  assert.equal(calls, 1);
});

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
  assert.deepEqual(
    combine([
      { ok: true, ms: 10 },
      { ok: true, ms: 30 },
    ]),
    { ok: true, ms: 30 },
  );
  assert.deepEqual(
    combine([
      { ok: true, ms: 10 },
      { ok: false, ms: 5, error: "HTTP 500" },
    ]),
    { ok: false, ms: 10, error: "HTTP 500" },
  );
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

test("the site's own time is read from Server-Timing's total", () => {
  // As apps/web's lib/perf.ts `serverTiming` writes it.
  assert.equal(serverTotal(`total;dur=406;desc="web to first byte", loader.root;dur=180, rpc;dur=406;desc="12 service calls"`), 406);
  assert.equal(serverTotal(`loader.root;dur=180, total;dur=91.5`), 91.5);
  // A page from the site's cache, or none at all, says nothing of its time.
  assert.equal(serverTotal(`cache;desc="hit, 17s old"`), null);
  assert.equal(serverTotal(null), null);
  assert.equal(serverTotal(`total;desc="no time"`), null);
});

test("page speed is judged on the site's time; a cached page on its time less the way here", async () => {
  // Pages that say their time: judged on it, whatever the way here took.
  assert.equal(
    serverOf(
      [
        { ok: true, ms: 610, server_ms: 420 },
        { ok: true, ms: 500, server_ms: 300 },
      ],
      { ok: true, ms: 200 },
    ),
    420,
  );
  // A cached page says nothing: its time less the baseline's, never below nothing.
  assert.equal(
    serverOf(
      [
        { ok: true, ms: 610, server_ms: 120 },
        { ok: true, ms: 350 },
      ],
      { ok: true, ms: 200 },
    ),
    150,
  );
  assert.equal(serverOf([{ ok: true, ms: 150 }], { ok: true, ms: 200 }), 0);
  // No baseline: the whole time, never less.
  assert.equal(serverOf([{ ok: true, ms: 350 }], { ok: false, ms: 5000, error: "timed out" }), 350);

  // Through probe: a project page that took 300 ms at the site, and Explore from its cache.
  const asked: string[] = [];
  const site = (total: number) => async (url: string) => {
    asked.push(url);
    if (url.endsWith("/favicon.ico")) return new Response("x");
    const timing = url.endsWith("/explore") ? `cache;desc="hit, 4s old"` : `total;dur=${total};desc="web to first byte"`;
    return new Response("x", { headers: { "server-timing": timing, "cf-ray": "8c1f2e3d4a5b6c7d-SEA" } });
  };
  const speed = components({ SITE_URL: "https://g1t.sh", PROBE_REPO: "flagon-io/g1t" }).find((p) => p.key === "speed")!;
  assert.deepEqual(speed.check.kind === "http" && speed.check.serverTime, { baseline: "https://g1t.sh/favicon.ico" });
  const fast = await probe(speed.check, { fetch: site(300), billing: null }, speed.slowMs!);
  assert.deepEqual(asked.sort(), ["https://g1t.sh/explore", "https://g1t.sh/favicon.ico", "https://g1t.sh/flagon-io/g1t"], "the pages and the baseline, once");
  assert.deepEqual([fast!.ok, fast!.colo, fast!.server_ms, judgedMs(fast!)], [true, "SEA", 300, 300]);
  // Slow at the site is slow, however near the check ran, and asked again before it counts.
  const slow = await probe(speed.check, { fetch: site(1200), billing: null }, speed.slowMs!);
  assert.deepEqual([slow!.server_ms, slow!.first_ms != null], [1200, true]);
  // Other checks are judged on the whole time, header or not.
  const login = await runCheck({ kind: "http", steps: [{ url: "https://g1t.sh/login" }] }, { fetch: site(1200), billing: null });
  assert.equal(login!.server_ms, undefined);
  // A page that failed is a failure, with no time of the site's to judge.
  const failed = await runCheck(speed.check, { fetch: async (url) => new Response("x", { status: url.endsWith(".ico") ? 200 : 502 }), billing: null });
  assert.deepEqual([failed!.ok, failed!.server_ms], [false, undefined]);
});
