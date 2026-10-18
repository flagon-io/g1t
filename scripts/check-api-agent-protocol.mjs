// Run after building apps/api. All rate-limit exhaustion is local, never production.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = resolve("apps/api/build");
const config = readFileSync("apps/api/wrangler.jsonc", "utf8");
const services = [...config.matchAll(/"binding":\s*"([^"]+)"\s*,\s*"service"/g)].map((m) => m[1]);
let calls = 0;
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    name: "api-agent-protocol",
    cf: false,
    modulesRoot: root,
    modules: [
      { type: "ESModule", path: resolve(root, "index.js") },
      { type: "CompiledWasm", path: resolve(root, "index_bg.wasm") },
    ],
    compatibilityDate: "2026-09-26",
    serviceBindings: Object.fromEntries(
      services.map((name) => [
        name,
        async () => {
          calls++;
          return Response.json(null);
        },
      ]),
    ),
    ratelimits: {
      API_ANONYMOUS_LIMIT: { namespace_id: "4401", simple: { limit: 60, period: 60 } },
      API_TOKEN_LIMIT: { namespace_id: "4402", simple: { limit: 1000, period: 60 } },
    },
  }),
);
try {
  const origin = await runtime.ready;
  const request = (path, init) => fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(15_000) });
  const openapi = await request("/openapi.json");
  assert.equal(openapi.status, 200);
  assert.equal(openapi.headers.get("x-g1t-api-version"), "1");
  assert.equal(openapi.headers.get("ratelimit-policy"), '"anonymous";q=60;w=60');
  assert.equal(openapi.headers.get("ratelimit"), null, "no fabricated remaining count");
  const spec = await openapi.json();
  assert.ok(spec.components.securitySchemes.oauth.flows.authorizationCode.scopes["repo:read"]);
  assert.equal((await request("/", { headers: { "X-G1t-Api-Version": "1" } })).status, 200);
  assert.equal((await request("/v1/")).status, 200);
  const before = calls;
  assert.equal(
    (
      await request("/workspaces/example/work", {
        method: "POST",
        headers: { "X-G1t-Api-Version": "unsupported", "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    422,
  );
  assert.equal(calls, before, "unsupported versions cannot execute a mutation");
  const cors = await request("/repos", { method: "OPTIONS" });
  assert.equal(cors.status, 204);
  assert.match(cors.headers.get("access-control-allow-headers"), /x-g1t-api-version/);
  assert.match(cors.headers.get("access-control-expose-headers"), /ratelimit-policy/);
  let exhausted;
  for (let i = 0; i < 65; i++) {
    const answer = await request("/");
    await answer.text();
    if (answer.status === 429) {
      exhausted = answer;
      break;
    }
  }
  assert.ok(exhausted, "local quota must be exhausted");
  assert.equal(exhausted.headers.get("retry-after"), "60");
  assert.equal(exhausted.headers.get("ratelimit"), '"anonymous";r=0;t=60');
  assert.equal(exhausted.headers.get("ratelimit-policy"), '"anonymous";q=60;w=60');
  console.log("API Worker: OpenAPI, version selection, mutation rejection, CORS, policy and actual 429 headers verified.");
} finally {
  await runtime.dispose();
}
