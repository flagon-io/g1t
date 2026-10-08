import assert from "node:assert/strict";
import { test } from "node:test";

import { cacheKinds, duration, formatLabel, parseGatewayModels, servedBy, shortCount, statusTone, tokenKinds, totalTokens } from "./gateway.ts";

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

test("a request says which format it came in and who served it", () => {
  assert.equal(formatLabel("openai"), "OpenAI");
  assert.equal(formatLabel("anthropic"), "Anthropic");
  assert.deepEqual(servedBy({ ownKey: false, provider: "workers-ai", connection: null }).label, "g1t · Workers AI");
  assert.deepEqual(servedBy({ ownKey: false, provider: "anthropic", connection: null }).label, "g1t · Anthropic");
  const own = servedBy({ ownKey: true, provider: "openai_endpoint", connection: "Office GPU" });
  assert.equal(own.label, "Office GPU");
  assert.match(own.hint, /OpenAI-compatible endpoint: counted, not charged/);
  assert.equal(servedBy({ ownKey: false, provider: "", connection: null }).label, "None");
});

test("a connection's AI Gateway models are typed as a list", () => {
  assert.deepEqual(parseGatewayModels(" gpt-*, ollama/*  claude-haiku-5-5 "), ["gpt-*", "ollama/*", "claude-haiku-5-5"]);
  assert.deepEqual(parseGatewayModels(""), []);
});

test("cache tokens read in words, hour-long writes named", () => {
  assert.equal(cacheKinds({ cacheRead: 12_000, cacheWrite: 2_400, cacheWriteHour: 0 }), "12,000 read from the cache, 2,400 written");
  assert.equal(cacheKinds({ cacheRead: 0, cacheWrite: 2_400, cacheWriteHour: 2_400 }), "0 read from the cache, 2,400 written, 2,400 of them to the hour-long cache");
});
