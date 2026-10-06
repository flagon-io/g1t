import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelUpstream } from "@g1t/contracts";

import { presentedToken, upstreamRequest } from "./route.ts";

const run = { workspace: "acme", repo: "acme/web", number: 7, task: "implement", session: "ms_abc", baseUrl: null, apiKey: null, authHeader: null, api: "anthropic" as const, model: null, official: false, provider: "g1t" };
const hosted = { AI_GATEWAY_ID: "g1t", CLOUDFLARE_ACCOUNT_ID: "acct", AI_GATEWAY_TOKEN: "gw-token" };

function incoming(): Headers {
  return new Headers({
    "x-api-key": "g1tm_run_token",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "tools-2024",
    "content-type": "application/json",
  });
}

test("the run's token is read from either header", () => {
  assert.equal(presentedToken(new Headers({ "x-api-key": "g1tm_a" })), "g1tm_a");
  assert.equal(presentedToken(new Headers({ authorization: "Bearer g1tm_b" })), "g1tm_b");
  assert.equal(presentedToken(new Headers()), null);
});

test("g1t's runs go through its gateway, tagged, without the sandbox's token", () => {
  const upstream: ModelUpstream = { ...run, route: "g1t" };
  const { url, headers } = upstreamRequest(upstream, hosted, "/v1/messages?beta=true", incoming());
  assert.equal(url, "https://gateway.ai.cloudflare.com/v1/acct/g1t/anthropic/v1/messages?beta=true");
  assert.equal(headers.get("cf-aig-authorization"), "Bearer gw-token");
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("anthropic-beta"), "tools-2024");
  assert.deepEqual(JSON.parse(headers.get("cf-aig-metadata") ?? "{}"), {
    task: "implement",
    workspace: "acme",
    repo: "acme/web",
    pull: 7,
    session: "ms_abc",
  });
});

test("a run's tier is tagged at the gateway, so spend can be read per tier", () => {
  const upstream: ModelUpstream = { ...run, route: "g1t", tier: "small" };
  const { headers } = upstreamRequest(upstream, hosted, "/v1/messages", incoming());
  const metadata = JSON.parse(headers.get("cf-aig-metadata") ?? "{}");
  assert.deepEqual(metadata, {
    task: "implement",
    tier: "small",
    repo: "acme/web",
    pull: 7,
    session: "ms_abc",
  });
  // The gateway keeps five entries; the session, which billing settles
  // by, must be one of them.
  assert.ok(Object.keys(metadata).length <= 5);
});

test("a workspace's own Anthropic key goes to Anthropic, and only there", () => {
  const upstream: ModelUpstream = { ...run, route: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-theirs", authHeader: "x-api-key" };
  const { url, headers } = upstreamRequest(upstream, hosted, "/v1/messages", incoming());
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers.get("x-api-key"), "sk-ant-theirs");
  assert.equal(headers.get("cf-aig-authorization"), null);
  assert.equal(headers.get("cf-aig-metadata"), null);
});

test("a workspace's own endpoint gets the key the way it asks for it", () => {
  const upstream: ModelUpstream = { ...run, route: "endpoint", baseUrl: "https://llm.acme.dev/anthropic/", apiKey: "theirs", authHeader: "authorization" };
  const { url, headers } = upstreamRequest(upstream, hosted, "/v1/messages", incoming());
  assert.equal(url, "https://llm.acme.dev/anthropic/v1/messages");
  assert.equal(headers.get("authorization"), "Bearer theirs");
  assert.equal(headers.get("x-api-key"), null);
});
