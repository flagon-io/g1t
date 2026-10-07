// The self-hosted scheduler's cron matching (deploy/self-host/scheduler.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";

import { due, fieldValues, matches, run } from "../../deploy/self-host/scheduler.mjs";

const at = (iso) => new Date(iso);

test("fields read numbers, ranges, lists and steps", () => {
  assert.deepEqual([...fieldValues("*/15", { min: 0, max: 59 })], [0, 15, 30, 45]);
  assert.deepEqual([...fieldValues("1-5", { min: 0, max: 59 })], [1, 2, 3, 4, 5]);
  assert.deepEqual([...fieldValues("3,7,10-20/5", { min: 0, max: 59 })], [3, 7, 10, 15, 20]);
  assert.equal(fieldValues("60", { min: 0, max: 59 }), null);
  assert.equal(fieldValues("*/0", { min: 0, max: 59 }), null);
  assert.equal(fieldValues("x", { min: 0, max: 59 }), null);
});

test("the services' crons match when hosted g1t's would fire", () => {
  assert.ok(matches("37 * * * *", at("2026-10-06T12:37:00Z")));
  assert.ok(!matches("37 * * * *", at("2026-10-06T12:38:00Z")));
  assert.ok(matches("*/15 * * * *", at("2026-10-06T12:45:00Z")));
  assert.ok(matches("41 3 * * *", at("2026-10-06T03:41:59Z")));
  assert.ok(!matches("41 3 * * *", at("2026-10-06T04:41:00Z")));
  assert.ok(matches("* * * * *", at("2026-10-06T00:00:00Z")));
  // Sunday is 0 or 7; with both day fields given, either may match.
  assert.ok(matches("0 0 * * 7", at("2026-10-04T00:00:00Z")));
  assert.ok(matches("0 0 1 * 1", at("2026-10-05T00:00:00Z")));
  assert.ok(!matches("bad cron", at("2026-10-06T00:00:00Z")));
});

test("what is due is each matching cron of each service", () => {
  const schedules = [
    { worker: "g1t-packages", crons: ["37 * * * *"] },
    { worker: "g1t-webhooks", crons: ["* * * * *"] },
    { worker: "g1t-identity", crons: ["*/15 * * * *"] },
  ];
  assert.deepEqual(due(schedules, at("2026-10-06T12:37:00Z")), [
    { worker: "g1t-packages", cron: "37 * * * *" },
    { worker: "g1t-webhooks", cron: "* * * * *" },
  ]);
});

test("a run asks Wrangler for the handler, and a slow one is not doubled", async () => {
  const asked = [];
  let finish;
  const slow = (url, init) => {
    asked.push({ url, body: JSON.parse(init.body) });
    return new Promise((resolve) => {
      finish = () => resolve(new Response(JSON.stringify({ success: true, result: { outcome: "ok" } })));
    });
  };
  const job = { worker: "g1t-webhooks", cron: "* * * * *" };
  const first = run("http://127.0.0.1:8787", job, { fetch: slow });
  // The minute after, it is still running: skipped, not started again.
  assert.equal(await run("http://127.0.0.1:8787", job, { fetch: slow }), false);
  finish();
  assert.equal(await first, true);
  assert.deepEqual(asked, [
    { url: "http://127.0.0.1:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=g1t-webhooks", body: { cron: "* * * * *" } },
  ]);
  const failing = async () => new Response(JSON.stringify({ success: true, result: { outcome: "exception" } }));
  assert.equal(await run("http://127.0.0.1:8787", job, { fetch: failing }), false);
});
