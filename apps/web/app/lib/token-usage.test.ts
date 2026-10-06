import assert from "node:assert/strict";
import { test } from "node:test";

import { bestDay, cacheShare, compactTokens, heatLevel, shortDay, tokenMix, type TokenUsageView } from "./token-usage.ts";

const usage = (over: Partial<TokenUsageView> = {}): TokenUsageView => ({
  since: "2026-08-26",
  days: 42,
  person: null,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 0,
  activeDays: 0,
  byDay: [],
  ...over,
});

test("token counts read short", () => {
  assert.equal(compactTokens(8_500_000_000), "8.5B");
  assert.equal(compactTokens(412_300_000), "412M");
  assert.equal(compactTokens(12_340), "12.3K");
  assert.equal(compactTokens(2_000_000), "2M");
  assert.equal(compactTokens(940), "940");
  assert.equal(compactTokens(0), "0");
});

test("cache share is reads over every prompt token", () => {
  assert.equal(cacheShare(usage({ inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 })), 0.8);
  assert.equal(cacheShare(usage()), null);
});

test("the grid shades by quartile of the busiest day", () => {
  assert.equal(heatLevel(0, 100), 0);
  assert.equal(heatLevel(1, 100), 1);
  assert.equal(heatLevel(26, 100), 2);
  assert.equal(heatLevel(100, 100), 4);
  assert.equal(heatLevel(5, 0), 0);
});

test("the best day, and none on an empty window", () => {
  assert.deepEqual(bestDay([{ day: "a", tokens: 3 }, { day: "b", tokens: 9 }, { day: "c", tokens: 9 }]), { day: "b", tokens: 9 });
  assert.equal(bestDay([{ day: "a", tokens: 0 }]), null);
});

test("the mix is in its checked order and adds up to one", () => {
  const mix = tokenMix(usage({ inputTokens: 1, cacheReadTokens: 6, cacheWriteTokens: 1, outputTokens: 2 }));
  assert.deepEqual(mix.map((part) => part.key), ["input", "cacheRead", "cacheWrite", "output"]);
  assert.equal(mix.reduce((sum, part) => sum + part.share, 0), 1);
  assert.ok(tokenMix(usage()).every((part) => part.share === 0));
});

test("days are shown short, in UTC", () => {
  assert.equal(shortDay("2026-09-22"), "22 Sept");
  assert.equal(shortDay("nope"), "nope");
});
