import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyMcp } from "./mcp-readiness.mjs";

test("MCP initializes, notifies, forwards negotiated headers and verifies action scopes", async () => {
  const methods = [];
  const fetcher = async (_url, options) => {
    if (!options.body) return Response.json({ tools: [{ name: "repository", actions: [{ name: "get", scope: "repo:read" }] }], scopes_supported: ["repo:read"] });
    const request = JSON.parse(options.body);
    methods.push(request.method);
    if (request.method === "initialize") return Response.json({ id: 1, result: { protocolVersion: "2025-03-26" } }, { headers: { "mcp-session-id": "test-session" } });
    assert.equal(options.headers["MCP-Protocol-Version"], "2025-03-26");
    assert.equal(options.headers["Mcp-Session-Id"], "test-session");
    if (request.method === "notifications/initialized") {
      assert.equal(request.id, undefined);
      return new Response(null, { status: 202 });
    }
    return Response.json({ id: 2, result: { tools: [{ name: "repository", inputSchema: { type: "object", properties: { action: { enum: ["get"] } } } }] } });
  };
  assert.deepEqual(await verifyMcp("test-token", fetcher), { tools: 1, actions: 1 });
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
});

test("MCP authorization failures are reported without credential contents", async () => {
  await assert.rejects(verifyMcp("secret", async () => new Response(null, { status: 401 })), /401/);
});
