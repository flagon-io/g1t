import assert from "node:assert/strict";

/** Read-only MCP lifecycle and tool/schema check; credentials never enter reports. */
export async function verifyMcp(token, fetcher = fetch) {
  const endpoint = "https://mcp.g1t.sh";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  async function post(method, params, id) {
    const response = await fetcher(endpoint, { method: "POST", headers: { ...headers }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }), signal: AbortSignal.timeout(20_000) });
    if (id === undefined) { assert.equal(response.status, 202); return; }
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.id, id);
    assert.ok(!value.error, "MCP returned an error");
    if (response.headers.get("mcp-session-id")) headers["Mcp-Session-Id"] = response.headers.get("mcp-session-id");
    return value.result;
  }
  const initialized = await post("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "g1t-readiness-check", version: "1" } }, 1);
  assert.equal(initialized.protocolVersion, "2025-03-26");
  headers["MCP-Protocol-Version"] = initialized.protocolVersion;
  await post("notifications/initialized", {});
  const listed = await post("tools/list", {}, 2);
  assert.ok(listed.tools.length > 0);
  const response = await fetcher(endpoint, { signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200);
  const card = await response.json();
  let actions = 0;
  for (const tool of listed.tools) {
    const published = card.tools.find((entry) => entry.name === tool.name);
    assert.ok(published, `Undocumented tool ${tool.name}`);
    assert.equal(tool.inputSchema.type, "object");
    for (const name of tool.inputSchema.properties.action.enum) {
      const action = published.actions.find((entry) => entry.name === name);
      assert.ok(action, `Undocumented action on ${tool.name}`);
      assert.ok(action.scope === null || card.scopes_supported.includes(action.scope), "Unknown action scope");
      actions++;
    }
  }
  return { tools: listed.tools.length, actions };
}
