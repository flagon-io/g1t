import assert from "node:assert/strict";
import { test } from "node:test";

import { amount, monthCost } from "./metering.ts";

/** Cloudflare's prices, at cost: $0.30 per million requests, $0.02 per million CPU ms, $0.10 a custom domain a month. */
const COSTS = { millionRequests: 300_000, millionCpuMs: 20_000, domainMonth: 100_000 };

test("every request and CPU millisecond is metered from the first, with nothing included", () => {
  // What used to be inside a 1 million request, 3 million CPU ms allowance now costs what it costs.
  const month = monthCost({ requests: 1_000_000, cpu_ms: 3_000_000, peak_domains: 0 }, COSTS);
  assert.equal(month.traffic.micros, 300_000 + 60_000);
  assert.equal(month.domains.micros, 0);
  assert.equal(month.micros, 360_000);
  assert.equal(month.traffic.detail, "1 million requests and 3 million CPU ms");
  // A single request is a fraction of a millionth, rounded up.
  assert.equal(monthCost({ requests: 1, cpu_ms: 0, peak_domains: 0 }, COSTS).micros, 1);
});

test("a busy workspace on the plan is never capped, only charged", () => {
  // 500 million requests in a month: $150 to g1t, no count stops it.
  const month = monthCost({ requests: 500_000_000, cpu_ms: 2_000_000_000, peak_domains: 40 }, COSTS);
  assert.equal(month.traffic.micros, 150_000_000 + 40_000_000);
  assert.equal(month.domains.micros, 4_000_000);
  assert.equal(month.description, "500,000,000 requests, 2,000,000,000 CPU ms, 40 custom domains");
});

test("custom domains are charged from the first, by the month", () => {
  const month = monthCost({ requests: 0, cpu_ms: 0, peak_domains: 1 }, COSTS);
  assert.equal(month.domains.micros, 100_000);
  assert.equal(month.domains.detail, "1 custom domain");
  assert.equal(month.traffic.detail, null);
  assert.equal(monthCost({ requests: 0, cpu_ms: 0, peak_domains: 3 }, COSTS).domains.detail, "3 custom domains");
});

test("apps are not metered: a month with only apps up and no traffic costs nothing", () => {
  const month = monthCost({ requests: 0, cpu_ms: 0, peak_domains: null }, COSTS);
  assert.equal(month.micros, 0);
  assert.equal(month.description, "");
});

test("amounts read plainly", () => {
  assert.equal(amount(840_000), "840,000");
  assert.equal(amount(1_240_000), "1.2 million");
  assert.equal(amount(0), "0");
});
