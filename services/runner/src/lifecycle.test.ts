import assert from "node:assert/strict";
import { test } from "node:test";

import { answered, describeError, tellStopped, withinTimeCap } from "./lifecycle.ts";

const quiet = { waitMs: 0 };

test("a stop that is told the first time is told once and logs nothing", async () => {
  const logged: unknown[][] = [];
  let calls = 0;
  const told = await tellStopped("checks", async () => void calls++, { ...quiet, log: (...data) => logged.push(data) });
  assert.equal(told, true);
  assert.equal(calls, 1);
  assert.deepEqual(logged, []);
});

test("a stop that fails once is tried again, and gets through", async () => {
  const logged: unknown[][] = [];
  let calls = 0;
  const told = await tellStopped(
    "queue",
    async () => {
      calls++;
      if (calls === 1) throw new Error("report_queue failed with status 500");
    },
    { ...quiet, log: (...data) => logged.push(data) },
  );
  assert.equal(told, true);
  assert.equal(calls, 2);
  assert.deepEqual(logged, []);
});

test("a stop that cannot be told never throws, and is logged with what and why", async () => {
  const logged: unknown[][] = [];
  let calls = 0;
  const told = await tellStopped(
    "actions",
    async () => {
      calls++;
      throw new Error("job_report answered 503");
    },
    { ...quiet, log: (...data) => logged.push(data) },
  );
  assert.equal(told, false);
  assert.equal(calls, 2);
  assert.deepEqual(logged, [["sandbox stop not reported", "actions", "job_report answered 503"]]);
});

test("whatever is thrown, even nothing, is logged as one line", async () => {
  const logged: unknown[][] = [];
  await tellStopped("plan", () => Promise.reject(undefined), { ...quiet, attempts: 1, log: (...data) => logged.push(data) });
  assert.deepEqual(logged, [["sandbox stop not reported", "plan", "no reason given"]]);
  assert.equal(describeError("gone"), "gone");
  assert.equal(describeError({ code: 7 }), '{"code":7}');
  assert.equal(describeError(new TypeError("bad")), "bad");
});

test("a service that cannot answer is a failure; one that refuses is not", async () => {
  await answered("job_report", new Response("{}", { status: 200 }));
  // The deployments service's answer for a build that already finished.
  await answered("deploy fail", new Response("{}", { status: 404 }));
  await answered("job_report", new Response("{}", { status: 409 }));
  await assert.rejects(answered("job_report", new Response("worker threw", { status: 500 })), /job_report answered 500: worker threw/);
  await assert.rejects(answered("deploy fail", new Response("", { status: 503 })), /^Error: deploy fail answered 503$/);
  await assert.rejects(answered("job_report", new Response("slow down", { status: 429 })), /429/);
});

test("a run inside its time cap is not stopped for inactivity", () => {
  const started = Date.UTC(2026, 9, 8, 12, 0, 0);
  const minute = 60_000;
  const grace = 180;
  // A 240-minute cap outlives the 100-minute sleepAfter.
  assert.equal(withinTimeCap(started, 240, started + 100 * minute, grace), true);
  assert.equal(withinTimeCap(started, 240, started + 242 * minute, grace), true);
  // Past the cap and its alarm's grace: the library may stop it.
  assert.equal(withinTimeCap(started, 240, started + 243 * minute, grace), false);
  assert.equal(withinTimeCap(started, 90, started + 100 * minute, grace), false);
});

test("a sandbox with no cap or no start is stopped for inactivity as before", () => {
  const now = Date.now();
  assert.equal(withinTimeCap(undefined, 90, now, 180), false);
  assert.equal(withinTimeCap(now - 1000, undefined, now, 180), false);
  assert.equal(withinTimeCap(now - 1000, null, now, 180), false);
  assert.equal(withinTimeCap(now - 1000, 0, now, 180), false);
});
