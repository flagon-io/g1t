import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayModel, User } from "@g1t/contracts";

import {
  anthropicError,
  callerOf,
  errorMessage,
  gatewayRecord,
  gatewayRoute,
  hostedRequest,
  requestId,
  sessionOf,
  unoffered,
  unpriced,
} from "./gateway.ts";

const workspaceToken = (scopes: string[] | null, name = "ci"): User => ({
  id: "wsp_1",
  username: "Acme",
  kind: "workspace",
  workspaces: [{ slug: "acme", role: "member" }],
  token: { token_id: "tok_1", scopes, name },
});

const sonnet: GatewayModel = {
  model: "claude-sonnet-5-5",
  name: "Claude Sonnet 5.5",
  provider: "anthropic",
  inputMicros: 2_000_000,
  outputMicros: 10_000_000,
  cacheReadMicros: 200_000,
  cacheWriteMicros: 2_500_000,
};

test("a workspace's token with models:write is let through, as that workspace", () => {
  const who = callerOf(workspaceToken(["repo:read", "models:write"]));
  assert.ok("caller" in who);
  assert.deepEqual(who.caller, { workspace: "acme", tokenId: "tok_1", tokenName: "ci" });
  // Full access holds every scope.
  assert.ok("caller" in callerOf(workspaceToken(null)));
});

test("without models:write, or not a workspace's token, it is refused as Anthropic would", () => {
  const reader = callerOf(workspaceToken(["models:read", "billing:write"]));
  assert.ok(!("caller" in reader));
  assert.equal(reader.status, 403);
  assert.equal(reader.type, "permission_error");
  assert.match(reader.message, /models:write/);

  const person: User = { id: "usr_1", username: "ada", token: { token_id: "tok_2", scopes: null } };
  const personal = callerOf(person);
  assert.ok(!("caller" in personal));
  assert.equal(personal.status, 403);
  assert.match(personal.message, /workspace's access token/);

  const unknown = callerOf(null);
  assert.ok(!("caller" in unknown));
  assert.equal(unknown.status, 401);
  assert.equal(unknown.type, "authentication_error");

  // A workspace acting through a signed-in session, not a token, is not a caller either.
  const session: User = { id: "wsp_1", username: "acme", kind: "workspace" };
  assert.ok(!("caller" in callerOf(session)));
});

test("errors are in Anthropic's shape", async () => {
  const response = anthropicError(402, "billing_error", "Out of AI credit.");
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { type: "error", error: { type: "billing_error", message: "Out of AI credit." } });
});

test("the gateway answers messages and counting tokens only", () => {
  assert.equal(gatewayRoute("/v1/messages"), "messages");
  assert.equal(gatewayRoute("/v1/messages?beta=true"), "messages");
  assert.equal(gatewayRoute("/v1/messages/count_tokens"), "count_tokens");
  assert.equal(gatewayRoute("/v1/messages/batches"), null);
  assert.equal(gatewayRoute("/v1/models"), null);
});

test("only the models g1t prices are offered on its key", () => {
  assert.equal(unoffered("claude-sonnet-5-5", [sonnet]), null);
  const why = unoffered("gpt-5", [sonnet, sonnet]);
  assert.match(why ?? "", /gpt-5 is not offered/);
  assert.match(why ?? "", /It offers claude-sonnet-5-5\. /);
  assert.match(unoffered(undefined, [sonnet]) ?? "", /model/);
});

test("requests to g1t's models go through its gateway, tagged, without the caller's token", () => {
  const hosted = { AI_GATEWAY_ID: "g1t", CLOUDFLARE_ACCOUNT_ID: "acct", AI_GATEWAY_TOKEN: "gw-token" };
  const incoming = new Headers({
    "x-api-key": "g1t_secret",
    authorization: "Bearer g1t_secret",
    "anthropic-version": "2023-06-01",
    "cf-aig-metadata": "{\"workspace\":\"someone-else\"}",
  });
  const caller = { workspace: "acme", tokenId: "tok_1", tokenName: "ci" };
  const { url, headers } = hostedRequest(hosted, "/v1/messages", incoming, caller, "gw_tok_1_2026100712");
  assert.equal(url, "https://gateway.ai.cloudflare.com/v1/acct/g1t/anthropic/v1/messages");
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("cf-aig-authorization"), "Bearer gw-token");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.deepEqual(JSON.parse(headers.get("cf-aig-metadata") ?? "{}"), {
    task: "gateway",
    workspace: "acme",
    token: "tok_1",
    session: "gw_tok_1_2026100712",
  });
  // With no gateway, straight to Anthropic with g1t's key.
  const direct = hostedRequest({ AI_GATEWAY_ID: "", CLOUDFLARE_ACCOUNT_ID: "", ANTHROPIC_API_KEY: "sk-g1t" }, "/v1/messages", incoming, caller, "s");
  assert.equal(direct.url, "https://api.anthropic.com/v1/messages");
  assert.equal(direct.headers.get("x-api-key"), "sk-g1t");
});

test("on g1t's models, only what is charged by its tokens is let through", () => {
  const plain = { model: "claude-sonnet-5-5", max_tokens: 10, messages: [] };
  assert.equal(unpriced(plain), null);
  assert.equal(unpriced({ ...plain, speed: "standard", inference_geo: "global" }), null);
  // The caller's own tools, and the client tools Anthropic defines, cost only their tokens.
  const clientTools = [{ name: "lookup", input_schema: {} }, { type: "custom", name: "x" }, { type: "bash_20250124", name: "bash" }, { type: "text_editor_20250728", name: "e" }, { type: "computer_toolset_20260801", name: "c" }, { type: "memory_20250818", name: "memory" }];
  assert.equal(unpriced({ ...plain, tools: clientTools }), null);
  // Billed otherwise by the provider: refused, pointing at the workspace's own key.
  assert.match(unpriced({ ...plain, speed: "fast" }) ?? "", /Fast mode/);
  assert.match(unpriced({ ...plain, inference_geo: "us" }) ?? "", /inference_geo/);
  assert.match(unpriced({ ...plain, fallbacks: "default" }) ?? "", /fallbacks/);
  assert.match(unpriced({ ...plain, container: { skills: [] } }) ?? "", /Containers/);
  const search = unpriced({ ...plain, tools: [{ type: "web_search_20260209", name: "web_search" }] }) ?? "";
  assert.match(search, /web_search_20260209/);
  assert.match(search, /own Anthropic key/);
});

test("a caller cannot set the gateway's own headers", () => {
  const caller = { workspace: "acme", tokenId: "tok_1", tokenName: null };
  const incoming = new Headers({ "cf-aig-custom-cost": "{\"total_cost\":0}", "cf-aig-cache-ttl": "3600", "cf-aig-skip-cache": "true" });
  const { headers } = hostedRequest({ AI_GATEWAY_ID: "g1t", CLOUDFLARE_ACCOUNT_ID: "acct" }, "/v1/messages", incoming, caller, "s");
  assert.equal(headers.get("cf-aig-custom-cost"), null);
  assert.equal(headers.get("cf-aig-cache-ttl"), null);
  assert.equal(headers.get("cf-aig-skip-cache"), null);
});

test("a request has its own id and is logged under its token's hour", () => {
  assert.match(requestId(), /^gw_[0-9a-f]{24}$/);
  assert.notEqual(requestId(), requestId());
  assert.equal(sessionOf("tok_1", new Date("2026-10-07T12:34:56Z")), "gw_tok_1_2026100712");
});

test("what billing is told: tokens by kind, whose key, and how it went", () => {
  const record = gatewayRecord({
    id: "gw_1",
    caller: { workspace: "acme", tokenId: "tok_1", tokenName: "ci" },
    model: "claude-sonnet-5-5",
    tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 },
    status: 200,
    ownKey: true,
    streamed: true,
    durationMs: 812.4,
  });
  assert.deepEqual(record, {
    id: "gw_1",
    workspace: "acme",
    tokenId: "tok_1",
    tokenName: "ci",
    model: "claude-sonnet-5-5",
    input: 10,
    output: 5,
    cacheRead: 100,
    cacheWrite: 0,
    status: 200,
    ownKey: true,
    streamed: true,
    durationMs: 812,
    error: null,
  });
});

test("a provider's error is logged by its message", () => {
  assert.equal(errorMessage(429, JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Slow down." } })), "Slow down.");
  assert.equal(errorMessage(502, "<html>bad gateway</html>"), "The model provider answered 502.");
});
