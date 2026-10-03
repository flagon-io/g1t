import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { type AgentRoutes, canReachModel, modelEnv } from "./model-env.ts";

const routes: AgentRoutes = {
  implement: { modelName: "Claude Sonnet 5.5", model: "claude-sonnet-5-5" },
  review: { modelName: "Claude Opus 5.5", model: "claude-opus-5-5" },
  update: { modelName: "Claude Sonnet 5.5", model: "claude-sonnet-5-5" },
  plan: { modelName: "Claude Sonnet 5.5", model: "claude-sonnet-5-5" },
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

test("the kind of work decides the model", () => {
  assert.equal(modelEnv(direct, routes, "implement", tags).ANTHROPIC_MODEL, "claude-sonnet-5-5");
  const review = modelEnv(direct, routes, "review", tags);
  assert.equal(review.ANTHROPIC_MODEL, "claude-opus-5-5");
  assert.equal(review.AGENT_MODEL_NAME, "Claude Opus 5.5");
});

test("without a gateway, requests go to the provider directly", () => {
  const vars = modelEnv(direct, routes, "implement", tags);
  assert.equal(vars.ANTHROPIC_BASE_URL, undefined);
  assert.equal(vars.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.equal(vars.ANTHROPIC_API_KEY, "sk-test");
});

test("with a gateway, requests go through it and say what they are for", () => {
  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t" }, routes, "review", tags);
  assert.equal(vars.ANTHROPIC_BASE_URL, "https://gateway.ai.cloudflare.com/v1/acct/g1t/anthropic");
  assert.deepEqual(customHeaders(vars), {
    "cf-aig-metadata": '{"task":"review","repo":"acme/site","pull":12}',
  });
});

test("an authenticated gateway is sent its token", () => {
  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok" }, routes, "implement", tags);
  assert.equal(customHeaders(vars)["cf-aig-authorization"], "Bearer tok");
  assert.equal(vars.ANTHROPIC_API_KEY, "sk-test");
});

test("when the gateway holds the provider's key, the sandbox never gets it", () => {
  const gatewayOnly = { AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" };
  assert.equal(canReachModel(gatewayOnly), true);
  assert.equal(modelEnv(gatewayOnly, routes, "implement", tags).ANTHROPIC_API_KEY, "tok");
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

  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok" }, routes, "implement", tags);
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
    metadata: '{"task":"implement","repo":"acme/site","pull":12}',
    model: "claude-sonnet-5-5",
  });
});
