import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  type AgentRouting,
  type ChangeSize,
  DEFAULT_ROUTING,
  canReachModel,
  changeSize,
  chooseTier,
  gatewaySession,
  lastAttemptFailed,
  modelEnv,
  parseRouting,
} from "./model-env.ts";

const routes: AgentRouting = {
  ...DEFAULT_ROUTING,
  tiers: {
    small: { modelName: "Claude Haiku 4.5", model: "claude-haiku-4-5-20251001" },
    large: { modelName: "Claude Sonnet 5.5", model: "claude-sonnet-5-5" },
  },
};
const tags = { repo: "acme/site", pull: 12 };
const direct = { ANTHROPIC_API_KEY: "sk-test", AI_GATEWAY_ID: "", CLOUDFLARE_ACCOUNT_ID: "acct" };

/** `ANTHROPIC_CUSTOM_HEADERS` as the harness reads it: one header per line. */
function customHeaders(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    vars.ANTHROPIC_CUSTOM_HEADERS.split("\n").map((line) => {
      const at = line.indexOf(": ");
      return [line.slice(0, at), line.slice(at + 2)];
    }),
  );
}

const small: ChangeSize = { files: 3, lines: 80, sensitive: [] };

test("planning and catching up run on the small tier, making a change on the large", () => {
  assert.equal(chooseTier("plan", {}, routes), "small");
  assert.equal(chooseTier("update", {}, routes), "small");
  assert.equal(chooseTier("implement", {}, routes), "large");
  assert.equal(chooseTier("implement", { change: small }, routes), "large");
});

test("a review is small only for a small change that touches nothing sensitive", () => {
  assert.equal(chooseTier("review", { change: small }, routes), "small");
  assert.equal(chooseTier("review", { change: { ...small, lines: 200, files: 10 } }, routes), "small");
  assert.equal(chooseTier("review", { change: { ...small, lines: 201 } }, routes), "large");
  assert.equal(chooseTier("review", { change: { ...small, files: 11 } }, routes), "large");
  assert.equal(chooseTier("review", { change: { ...small, sensitive: ["CI workflows"] } }, routes), "large");
  assert.equal(chooseTier("review", { change: small, labels: ["Security"] }, routes), "large");
  assert.equal(chooseTier("review", { change: small, labels: ["docs"] }, routes), "small");
});

test("a review of a change g1t cannot size runs on the large tier", () => {
  assert.equal(chooseTier("review", {}, routes), "large");
  assert.equal(chooseTier("review", { change: null }, routes), "large");
  assert.equal(chooseTier("review", { change: { files: 0, lines: 0, sensitive: [] } }, routes), "large");
});

test("a retry after a failed attempt goes up to the large tier", () => {
  assert.equal(chooseTier("plan", { retry: true }, routes), "large");
  assert.equal(chooseTier("update", { retry: true }, routes), "large");
  assert.equal(chooseTier("review", { change: small, retry: true }, routes), "large");
});

test("a retry is the same work again after its latest attempt failed", () => {
  assert.equal(lastAttemptFailed([]), false);
  assert.equal(lastAttemptFailed([{ status: "failed" }, { status: "succeeded" }]), true);
  assert.equal(lastAttemptFailed([{ status: "succeeded" }, { status: "failed" }]), false);
  assert.equal(lastAttemptFailed([{ status: "stopped", halted: "budget" }]), true);
  assert.equal(lastAttemptFailed([{ status: "stopped", halted: null }]), false);
  assert.equal(lastAttemptFailed([{ status: "running" }]), false);
  assert.equal(lastAttemptFailed([{ status: "failed", title: "Add search" }], "Add search "), true);
  assert.equal(lastAttemptFailed([{ status: "failed", title: "Add search" }], "Add billing"), false);
});

test("the configuration decides the tiers, the rules and the limits", () => {
  const parsed = parseRouting(
    JSON.stringify({
      tiers: { small: { modelName: "Small", model: "small-1" } },
      tasks: { update: "large" },
      smallChange: { lines: 50 },
    }),
  );
  assert.deepEqual(parsed.tiers.small, { modelName: "Small", model: "small-1" });
  assert.deepEqual(parsed.tiers.large, DEFAULT_ROUTING.tiers.large);
  assert.equal(chooseTier("update", {}, parsed), "large");
  assert.equal(chooseTier("plan", {}, parsed), "small");
  assert.equal(chooseTier("review", { change: { ...small, lines: 51 } }, parsed), "large");
  assert.equal(chooseTier("review", { change: { ...small, files: 10, lines: 50 } }, parsed), "small");
  assert.deepEqual(parseRouting(undefined), DEFAULT_ROUTING);
  assert.deepEqual(parseRouting("not json"), DEFAULT_ROUTING);
});

test("a change's size is its files and the lines added and removed", () => {
  assert.deepEqual(
    changeSize([{ additions: 10, deletions: 2 }, { additions: 0, deletions: 5 }], ["secrets"]),
    { files: 2, lines: 17, sensitive: ["secrets"] },
  );
});

test("the tier decides the model, and the harness's small tasks use the small tier", () => {
  const large = modelEnv(direct, routes, "implement", "large", tags);
  assert.equal(large.ANTHROPIC_MODEL, "claude-sonnet-5-5");
  assert.equal(large.AGENT_MODEL_NAME, "Claude Sonnet 5.5");
  assert.equal(large.ANTHROPIC_SMALL_FAST_MODEL, "claude-haiku-4-5-20251001");
  assert.equal(large.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-haiku-4-5-20251001");
  const review = modelEnv(direct, routes, "review", "small", tags);
  assert.equal(review.ANTHROPIC_MODEL, "claude-haiku-4-5-20251001");
  assert.equal(review.AGENT_MODEL_NAME, "Claude Haiku 4.5");
});

test("without a gateway, requests go to the provider directly", () => {
  const vars = modelEnv(direct, routes, "implement", "large", tags);
  assert.equal(vars.ANTHROPIC_BASE_URL, undefined);
  assert.equal(vars.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.equal(vars.ANTHROPIC_API_KEY, "sk-test");
});

test("with a gateway, requests go through it and say what they are for", () => {
  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t" }, routes, "review", "large", tags);
  assert.equal(vars.ANTHROPIC_BASE_URL, "https://gateway.ai.cloudflare.com/v1/acct/g1t/anthropic");
  assert.deepEqual(customHeaders(vars), {
    "cf-aig-metadata": '{"task":"review","tier":"large","repo":"acme/site","pull":12}',
  });
});

test("a run straight to the gateway carries its session, so billing can settle it", () => {
  const session = gatewaySession();
  assert.match(session, /^rs_[0-9a-f]{24}$/);
  assert.notEqual(gatewaySession(), session);
  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t" }, routes, "implement", "small", { ...tags, session });
  const metadata = JSON.parse(customHeaders(vars)["cf-aig-metadata"]);
  assert.equal(metadata.session, session);
  // The gateway keeps at most five metadata entries.
  assert.ok(Object.keys(metadata).length <= 5);
});

test("an authenticated gateway is sent its token", () => {
  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok" }, routes, "implement", "large", tags);
  assert.equal(customHeaders(vars)["cf-aig-authorization"], "Bearer tok");
  assert.equal(vars.ANTHROPIC_API_KEY, "sk-test");
});

test("when the gateway holds the provider's key, the sandbox never gets it", () => {
  const gatewayOnly = { AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" };
  assert.equal(canReachModel(gatewayOnly), true);
  assert.equal(modelEnv(gatewayOnly, routes, "implement", "large", tags).ANTHROPIC_API_KEY, "tok");
  assert.equal(canReachModel({ AI_GATEWAY_ID: "g1t", CLOUDFLARE_ACCOUNT_ID: "acct" }), false);
  assert.equal(canReachModel(direct), true);
});

// A stand-in for the gateway: what a sandbox's agent sends, given these
// variables, arrives at the gateway's path with both credentials.
test("a request built from these variables reaches a gateway as expected", async () => {
  const seen: { url?: string; key?: string; gateway?: string; metadata?: string; model?: string } = {};
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.url = request.url;
      seen.key = request.headers["x-api-key"] as string;
      seen.gateway = request.headers["cf-aig-authorization"] as string;
      seen.metadata = request.headers["cf-aig-metadata"] as string;
      seen.model = JSON.parse(body).model;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ type: "message", content: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };

  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok" }, routes, "implement", "large", tags);
  // Same path as the real gateway, on the stand-in's address.
  const base = vars.ANTHROPIC_BASE_URL.replace("https://gateway.ai.cloudflare.com", `http://localhost:${port}`);
  await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": vars.ANTHROPIC_API_KEY, ...customHeaders(vars), "content-type": "application/json" },
    body: JSON.stringify({ model: vars.ANTHROPIC_MODEL, max_tokens: 1, messages: [] }),
  });
  server.close();

  assert.deepEqual(seen, {
    url: "/v1/acct/g1t/anthropic/v1/messages",
    key: "sk-test",
    gateway: "Bearer tok",
    metadata: '{"task":"implement","tier":"large","repo":"acme/site","pull":12}',
    model: "claude-sonnet-5-5",
  });
});
