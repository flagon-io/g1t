import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelUpstream } from "@g1t/contracts";

import { isAnswer, runMayCall, tokenReport } from "./report.ts";
import { NO_TOKENS, measure } from "./usage.ts";

const upstream: ModelUpstream = {
  route: "g1t",
  api: "anthropic",
  model: null,
  official: false,
  provider: "g1t",
  workspace: "acme",
  repo: "acme/web",
  number: 7,
  task: "implement",
  session: "ms_abc",
  tier: "large",
  requestedBy: "ada",
  baseUrl: null,
  apiKey: null,
  authHeader: null,
};

test("only messages are answers; counting tokens is not", () => {
  assert.equal(isAnswer("/v1/messages"), true);
  assert.equal(isAnswer("/v1/messages?beta=true"), true);
  assert.equal(isAnswer("/v1/messages/count_tokens?beta=true"), false);
  assert.equal(isAnswer("/v1/models"), false);
});

test("an answer's tokens are reported under its run and person", () => {
  const report = tokenReport(upstream, "claude-opus-4", { input: 3, output: 9, cacheRead: 100, cacheWrite: 0 });
  assert.deepEqual(report, {
    workspace: "acme",
    session: "ms_abc",
    person: "ada",
    model: "claude-opus-4",
    tier: "large",
    input: 3,
    output: 9,
    cacheRead: 100,
    cacheWrite: 0,
  });
  // A route that names a model counts under it.
  assert.equal(tokenReport({ ...upstream, model: "gpt-x", tier: null }, "other", { ...NO_TOKENS, output: 1 })?.model, "gpt-x");
});

test("nothing used, or no session to count it under, is not reported", () => {
  assert.equal(tokenReport(upstream, null, { ...NO_TOKENS }), null);
  assert.equal(tokenReport({ ...upstream, session: "" }, null, { ...NO_TOKENS, input: 1 }), null);
});

test("the model that answered is read from the answer", async () => {
  const body = `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-x", usage: { input_tokens: 1 } } })}\n\n`;
  const streamed = measure(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  await streamed.response.text();
  assert.equal(await streamed.model, "claude-x");
  const whole = measure(Response.json({ model: "claude-y", usage: { output_tokens: 2 } }));
  await whole.response.text();
  assert.equal(await whole.model, "claude-y");
});

test("a run's token reaches answers, token counts and the model list, and nothing else", () => {
  assert.ok(runMayCall("/v1/messages", "POST"));
  assert.ok(runMayCall("/v1/messages?beta=true", "POST"));
  assert.ok(runMayCall("/v1/messages/count_tokens", "POST"));
  assert.ok(runMayCall("/v1/models", "GET"));
  assert.ok(runMayCall("/v1/models/claude-sonnet-5-5", "GET"));
  assert.equal(runMayCall("/v1/messages/batches", "POST"), false);
  assert.equal(runMayCall("/v1//messages", "POST"), false);
  assert.equal(runMayCall("/v1/complete", "POST"), false);
  assert.equal(runMayCall("/v1/models", "POST"), false);
  assert.equal(runMayCall("/v1/files", "GET"), false);
});
