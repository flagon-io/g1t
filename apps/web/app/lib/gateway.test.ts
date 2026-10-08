import assert from "node:assert/strict";
import { test } from "node:test";

import { duration, shortCount, statusTone, tokenKinds, totalTokens } from "./gateway.ts";

test("token counts read short", () => {
  assert.equal(shortCount(812), "812");
  assert.equal(shortCount(12_400), "12.4K");
  assert.equal(shortCount(150_000), "150K");
  assert.equal(shortCount(3_000_000), "3M");
});

test("a request's tokens add up and are named by kind", () => {
  const request = { input: 1_840, output: 512, cacheRead: 12_000, cacheWrite: 0 };
  assert.equal(totalTokens(request), 14_352);
  assert.equal(tokenKinds(request), "1,840 input, 512 output, 12,000 cache read, 0 cache write");
});

test("refusals for money or rate are warnings, other failures are errors", () => {
  assert.deepEqual(statusTone(200), { label: "200", tone: "success" });
  assert.equal(statusTone(402).tone, "warn");
  assert.equal(statusTone(429).tone, "warn");
  assert.equal(statusTone(400).tone, "danger");
  assert.equal(statusTone(529).tone, "danger");
});

test("durations read plainly", () => {
  assert.equal(duration(840), "840 ms");
  assert.equal(duration(4_210), "4.2 s");
  assert.equal(duration(125_000), "2 min 5 s");
});
