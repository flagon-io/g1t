// Read-only production verification. --mcp uses the existing CLI login without logging it.
// Run: node --use-system-ca scripts/check-agent-readiness.mjs [--mcp]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { verifyMcp } from "./mcp-readiness.mjs";

let failures = 0;
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}
async function get(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  return { response, body: await response.text() };
}
const varies = (response) => (response.headers.get("vary") ?? "").toLowerCase().split(",").map((v) => v.trim()).includes("accept");
for (const [path, status] of [["/", 200], ["/__agent-readiness-nonexistent", 404]]) {
  for (const accept of ["text/markdown", "text/html", "text/html;q=0.2,text/markdown;q=1"]) {
    await check(`${path} Accept: ${accept}`, async () => {
      const { response, body } = await get(`https://g1t.sh${path}`, { accept });
      assert.equal(response.status, status);
      assert.ok(varies(response), "Vary must contain Accept");
      const markdown = accept !== "text/html";
      assert.ok(response.headers.get("content-type")?.startsWith(markdown ? "text/markdown" : "text/html"));
      if (markdown) { assert.ok(body.length > 20); assert.match(body, /\[.*\]\(https:\/\/g1t.sh\/llms.txt\)/); }
      else assert.match(body, /<html/);
    });
  }
}
await check("unsupported homepage representation", async () => assert.equal((await get("https://g1t.sh/", { accept: "application/json" })).response.status, 406));
await check("homepage metadata", async () => {
  const { body } = await get("https://g1t.sh/", { accept: "text/html" });
  assert.match(body, /<html[^>]*lang="en"/);
  assert.match(body, /<link[^>]*rel="canonical"[^>]*href="https:\/\/g1t.sh\/"/);
  assert.match(body, /property="og:image"/);
  assert.match(body, /property="og:type"/);
  const schemas = [...body.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const organization = schemas.find((schema) => schema["@type"] === "Organization");
  assert.equal(organization?.contactPoint?.email, "hey@flagon.io");
});
await check("llms.txt instructions and developer links", async () => {
  const { response, body } = await get("https://g1t.sh/llms.txt");
  assert.equal(response.status, 200);
  assert.match(body, /^# g1t\s/m);
  assert.match(body, /## (When to use g1t|Developer resources)/);
  for (const url of ["https://api.g1t.sh/openapi.json", "https://mcp.g1t.sh/.well-known/oauth-protected-resource", "https://g1t.sh/settings/tokens"]) assert.ok(body.includes(url));
});
await check("OpenAPI scopes and unprefixed versioned API", async () => {
  const { body, response } = await get("https://api.g1t.sh/openapi.json");
  assert.equal(response.status, 200);
  const spec = JSON.parse(body);
  assert.equal(spec.servers[0].url, "https://api.g1t.sh");
  const scopes = spec.components.securitySchemes.oauth.flows.authorizationCode.scopes;
  const metadata = JSON.parse((await get("https://mcp.g1t.sh/.well-known/oauth-protected-resource")).body);
  assert.deepEqual(Object.keys(scopes).sort(), metadata.scopes_supported.sort());
  assert.equal(spec.components.parameters.ApiVersion.name, "X-G1t-Api-Version");
  assert.ok(spec.components.responses.RateLimited.headers["Retry-After"]);
});
for (const path of ["/repos", "/v1/repos"]) await check(`REST ${path} version and limit headers`, async () => {
  const { response, body } = await get(`https://api.g1t.sh${path}`, { "X-G1t-Api-Version": "1" });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(JSON.parse(body)));
  assert.equal(response.headers.get("x-g1t-api-version"), "1");
  assert.equal(response.headers.get("ratelimit-policy"), '"anonymous";q=60;w=60');
});
await check("unsupported REST version fails", async () => assert.equal((await get("https://api.g1t.sh/repos", { "X-G1t-Api-Version": "not-a-version" })).response.status, 422));
for (const url of ["https://g1t.sh/developers", "https://g1t.sh/openapi.json", "https://g1t.sh/mcp", "https://g1t.sh/sitemap.xml", "https://g1t.sh/robots.txt", "https://docs.g1t.sh/reference/api/", "https://docs.g1t.sh/reference/rate-limits/", "https://docs.g1t.sh/guides/authentication/", "https://docs.g1t.sh/guides/cli/", "https://docs.g1t.sh/guides/self-hosting/", "https://g1t.sh/downloads/cli/latest.json"]) {
  await check(url, async () => { const { response, body } = await get(url); assert.equal(response.status, 200); assert.ok(body.length > 20); });
}
await check("published versioning documentation", async () => assert.match((await get("https://docs.g1t.sh/reference/api/")).body, /X-G1t-Api-Version/));
await check("MCP still requires authorization", async () => {
  const response = await fetch("https://mcp.g1t.sh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata/);
  await response.body?.cancel();
});
if (process.argv.includes("--mcp")) await check("authorized MCP initialize and tools/list", async () => {
  const token = execFileSync("g1t", ["auth", "token", "--hostname", "g1t.sh"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const result = await verifyMcp(token);
  console.log(`Verified ${result.tools} protected tools and ${result.actions} documented action scopes.`);
});
process.exitCode = failures ? 1 : 0;
