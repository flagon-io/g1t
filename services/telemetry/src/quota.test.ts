import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH,
  GB,
  TELEMETRY_MICROS_PER_GB,
  capOf,
  dailyCap,
  freeMonthlyBytes,
  overCap,
  overCapMessage,
  sizeOf,
  telemetryCost,
  telemetryDetail,
} from "./quota.ts";

test("a free workspace sends a thirtieth of 1 GB a day", () => {
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
  assert.match(overCapMessage(35_791_395), /its 34 MB for today across its projects/);
  // A held workspace's projects take nothing.
  assert.equal(overCap(0, 1, 0), true);
  assert.match(overCapMessage(0), /put a hold on/);
});

test("a held workspace takes nothing, a free one its day's share, the plan no cap; unknown is free", () => {
  assert.equal(capOf("held", 100), 0);
  assert.equal(capOf("free", 100), 100);
  assert.equal(capOf("paid", 100), null);
  assert.equal(capOf(null, 100), 100);
});

test("what is sent past the free amount costs by the GB; up to it, nothing", () => {
  assert.equal(telemetryCost(DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH, DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH, TELEMETRY_MICROS_PER_GB), 0);
  assert.equal(telemetryCost(10, 100, TELEMETRY_MICROS_PER_GB), 0);
  assert.equal(telemetryCost(GB + 100, 100, 8_500_000), 8_500_000);
  assert.equal(telemetryCost(GB / 2, 0, 8_500_000), 4_250_000);
  assert.equal(telemetryDetail(2_400_000_000, DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH), "2.40 GB sent, 1.07 GB free");
});

test("a row counts as what is kept of it", () => {
  assert.equal(sizeOf({ body: "hello" }), '{"body":"hello"}'.length);
  assert.equal(sizeOf(undefined), 0);
});
