import assert from "node:assert/strict";
import { test } from "node:test";

import { inTime } from "./stream-deadline.ts";

test("an answer in time is passed on", async () => {
  assert.equal(await inTime(Promise.resolve("ready"), null, 50), "ready");
});

test("an answer too slow for the page's stream is the fallback, not an error", async () => {
  const never = new Promise<string>(() => {});
  assert.equal(await inTime(never, null, 10), null);
});

test("a failure is the fallback too", async () => {
  assert.deepEqual(await inTime(Promise.reject(new Error("down")), [], 50), []);
});
