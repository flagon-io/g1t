import assert from "node:assert/strict";
import { test } from "node:test";

import {
  answered,
  capReached,
  describeError,
  noMachine,
  OWED_GIVE_UP_MS,
  OWED_MAX_DELAY_SECONDS,
  owedDelaySeconds,
  recordOwed,
  START_POLL_MS,
  START_WAIT,
  stoppedShort,
  tellStopped,
  withinTimeCap,
} from "./lifecycle.ts";

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

test("an earlier attempt's time cap does not stop the attempt running now", () => {
  const minute = 60_000;
  // Desktop release, Linux job: attempt 1 started 12:47:17 with a 60-minute
  // cap, so its alarm fired at 13:50:17, four minutes into attempt 3 in the
  // same Durable Object.
  const attempt3 = Date.UTC(2026, 9, 12, 13, 46, 15);
  const alarm = Date.UTC(2026, 9, 12, 13, 50, 17);
  assert.equal(capReached(attempt3, 60, alarm), false);
  // Its own alarm, at its cap and the alarm's grace, does stop it.
  assert.equal(capReached(attempt3, 60, attempt3 + 63 * minute), true);
  assert.equal(capReached(attempt3, 60, attempt3 + 60 * minute), true);
  assert.equal(capReached(attempt3, 60, attempt3 + 60 * minute - 1), false);
});

test("a sandbox with no run or no cap is never stopped for time", () => {
  const now = Date.now();
  assert.equal(capReached(undefined, 60, now), false);
  assert.equal(capReached(now - 120 * 60_000, undefined, now), false);
  assert.equal(capReached(now - 120 * 60_000, 0, now), false);
});

test("a sandbox g1t stopped fails even when its exit code says 0", () => {
  assert.equal(stoppedShort(0, null), false);
  assert.equal(stoppedShort(0, "It ran into its time cap of 60 minutes."), true);
  assert.equal(stoppedShort(137, null), true);
  assert.equal(stoppedShort(1, "why"), true);
});

test("sandbox time billing confirms is forgotten; the rest is kept and tried again later", async () => {
  const now = 1_000_000_000;
  const owed = [
    { usage: { reference: "sandbox/a/1" }, attempts: 0, since: now },
    { usage: { reference: "sandbox/b/2" }, attempts: 2, since: now - 1000 },
  ];
  const sent: string[] = [];
  const result = await recordOwed(
    owed,
    async (usage) => {
      sent.push(usage.reference);
      if (usage.reference === "sandbox/b/2") throw new Error("billing answered 503");
      return true;
    },
    now,
  );
  assert.deepEqual(sent, ["sandbox/a/1", "sandbox/b/2"]);
  assert.deepEqual(
    result.recorded.map((entry) => entry.usage.reference),
    ["sandbox/a/1"],
  );
  // The same usage, under the same reference: billing records it once.
  assert.deepEqual(result.kept, [{ usage: { reference: "sandbox/b/2" }, attempts: 3, since: now - 1000 }]);
  assert.deepEqual(result.lost, []);
  assert.equal(result.retryInSeconds, owedDelaySeconds(3));
});

test("nothing kept means no retry; time tried for a week is given up", async () => {
  const now = 1_000_000_000;
  const done = await recordOwed([{ usage: { reference: "r" }, attempts: 0, since: now }], async () => true, now);
  assert.equal(done.retryInSeconds, null);
  const old = await recordOwed([{ usage: { reference: "r" }, attempts: 40, since: now - OWED_GIVE_UP_MS }], async () => false, now);
  assert.deepEqual(old.kept, []);
  assert.equal(old.lost.length, 1);
  assert.equal(old.retryInSeconds, null);
});

test("tries back off from 30 seconds to an hour", () => {
  assert.equal(owedDelaySeconds(0), 30);
  assert.equal(owedDelaySeconds(1), 30);
  assert.equal(owedDelaySeconds(2), 60);
  assert.equal(owedDelaySeconds(5), 480);
  assert.equal(owedDelaySeconds(8), OWED_MAX_DELAY_SECONDS);
  assert.equal(owedDelaySeconds(1000), OWED_MAX_DELAY_SECONDS);
});

test("a sandbox Cloudflare has no container for waits for a machine; any other failure does not", () => {
  assert.equal(noMachine(new Error("there is no container instance that can be provided to this durable object")), true);
  assert.equal(noMachine("Error: There is no Container instance available at this time"), true);
  assert.equal(noMachine(new Error("the container exited with code 1")), false);
  assert.equal(noMachine(undefined), false);
});

test("a start asks for a container once a second, for the library's 8 seconds", () => {
  assert.equal(START_POLL_MS, 1000);
  assert.equal(START_WAIT.waitInterval, START_POLL_MS);
  assert.equal(START_WAIT.waitInterval * START_WAIT.retries, 8000);
});
