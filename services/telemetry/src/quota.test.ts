import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH, dailyCap, freeMonthlyBytes, overCap, overCapMessage, sizeOf } from "./quota.ts";

test("a free workspace's project sends a thirtieth of 1 GB a day", () => {
  assert.equal(freeMonthlyBytes(undefined), DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH);
  assert.equal(freeMonthlyBytes(" "), DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH);
  assert.equal(freeMonthlyBytes("3000"), 3000);
  assert.equal(freeMonthlyBytes("0"), 0);
  assert.equal(dailyCap(3000), 100);
  assert.equal(dailyCap(0), null);
  assert.equal(dailyCap(DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH), 35_791_395);
});

test("past the day's share is over, and no cap never is", () => {
  assert.equal(overCap(90, 10, 100), false);
  assert.equal(overCap(90, 11, 100), true);
  assert.equal(overCap(1e12, 1e12, null), false);
  assert.match(overCapMessage(35_791_395), /its 34 MB for today/);
  // A held workspace's projects take nothing.
  assert.equal(overCap(0, 1, 0), true);
  assert.match(overCapMessage(0), /put a hold on/);
});

test("a row counts as what is kept of it", () => {
  assert.equal(sizeOf({ body: "hello" }), '{"body":"hello"}'.length);
  assert.equal(sizeOf(undefined), 0);
});
