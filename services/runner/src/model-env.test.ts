import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { type ConfiguredModel, modelEnv } from "./model-env.ts";

const model: ConfiguredModel = {
  id: "balanced",
  label: "Balanced",
  description: "",
  modelName: "Claude Sonnet 5.5",
  model: "claude-sonnet-5-5",
};
const direct = { ANTHROPIC_API_KEY: "sk-test", AI_GATEWAY_ID: "", CLOUDFLARE_ACCOUNT_ID: "acct" };

test("without a gateway, requests go to the provider directly", () => {
  const vars = modelEnv(direct, model);
  assert.equal(vars.ANTHROPIC_BASE_URL, undefined);
  assert.equal(vars.ANTHROPIC_MODEL, "claude-sonnet-5-5");
  assert.equal(vars.AGENT_MODEL_NAME, "Claude Sonnet 5.5 (Balanced)");
});

test("with a gateway, requests go through it", () => {
  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t" }, model);
  assert.equal(vars.ANTHROPIC_BASE_URL, "https://gateway.ai.cloudflare.com/v1/acct/g1t/anthropic");
  assert.equal(vars.ANTHROPIC_CUSTOM_HEADERS, undefined);
});

test("an authenticated gateway is sent its token", () => {
  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok" }, model);
  assert.equal(vars.ANTHROPIC_CUSTOM_HEADERS, "cf-aig-authorization: Bearer tok");
});

// A stand-in for the gateway: what a sandbox's agent sends, given these
// variables, arrives at the gateway's path with both credentials.
test("a request built from these variables reaches a gateway as expected", async () => {
  const seen: { url?: string; key?: string; gateway?: string; model?: string } = {};
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.url = request.url;
      seen.key = request.headers["x-api-key"] as string;
      seen.gateway = request.headers["cf-aig-authorization"] as string;
      seen.model = JSON.parse(body).model;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ type: "message", content: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };

  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok" }, model);
  // Same path as the real gateway, on the stand-in's address.
  const base = vars.ANTHROPIC_BASE_URL.replace("https://gateway.ai.cloudflare.com", `http://localhost:${port}`);
  const [name, value] = vars.ANTHROPIC_CUSTOM_HEADERS.split(": ");
  await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": vars.ANTHROPIC_API_KEY, [name]: value, "content-type": "application/json" },
    body: JSON.stringify({ model: vars.ANTHROPIC_MODEL, max_tokens: 1, messages: [] }),
  });
  server.close();

  assert.deepEqual(seen, {
    url: "/v1/acct/g1t/anthropic/v1/messages",
    key: "sk-test",
    gateway: "Bearer tok",
    model: "claude-sonnet-5-5",
  });
});
