import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENTS,
  AGENT_IDS,
  AGENT_STORAGE_KEY,
  DEFAULT_AGENT,
  MCP_URL,
  agentsFor,
  cursorInstallLink,
  getAgentChoice,
  parseAgent,
  readAgentChoice,
  setAgentChoice,
  subscribeAgentChoice,
  writeAgentChoice,
} from "./agent-setup.ts";

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

test("a choice is remembered and read back", () => {
  const store = memory();
  assert.equal(writeAgentChoice(() => store, "codex"), true);
  assert.equal(store.map.get(AGENT_STORAGE_KEY), "codex");
  assert.equal(readAgentChoice(() => store), "codex");
});

test("no choice, an unknown one, or storage that throws falls back to the default", () => {
  assert.equal(readAgentChoice(() => memory()), DEFAULT_AGENT);
  const store = memory();
  store.setItem(AGENT_STORAGE_KEY, "notepad");
  assert.equal(readAgentChoice(() => store), DEFAULT_AGENT);
  assert.equal(readAgentChoice(() => throwing), DEFAULT_AGENT);
  assert.equal(readAgentChoice(() => null), DEFAULT_AGENT);
  assert.equal(
    readAgentChoice(() => {
      throw new Error("no localStorage");
    }),
    DEFAULT_AGENT,
  );
  assert.equal(writeAgentChoice(() => throwing, "cursor"), false);
  assert.equal(writeAgentChoice(() => null, "cursor"), false);
});

test("every toggle on the page follows the last choice", () => {
  const store = memory();
  let heard = 0;
  const stop = subscribeAgentChoice(() => heard++);
  setAgentChoice("opencode", () => store);
  assert.equal(getAgentChoice(), "opencode");
  assert.equal(store.map.get(AGENT_STORAGE_KEY), "opencode");
  assert.equal(heard, 1);
  // Storage that refuses still changes the page.
  setAgentChoice("cursor", () => throwing);
  assert.equal(getAgentChoice(), "cursor");
  assert.equal(heard, 2);
  stop();
  setAgentChoice("codex", () => store);
  assert.equal(heard, 2);
});

test("parseAgent accepts only known agents", () => {
  for (const id of AGENT_IDS) assert.equal(parseAgent(id), id);
  assert.equal(parseAgent("Claude Code"), null);
  assert.equal(parseAgent(null), null);
});

test("every snippet points at the MCP server", () => {
  for (const id of AGENT_IDS) assert.ok(AGENTS[id].code.includes(MCP_URL), id);
  assert.deepEqual(JSON.parse(AGENTS.cursor.code), { mcpServers: { g1t: { url: MCP_URL } } });
  assert.equal(JSON.parse(AGENTS.opencode.code).mcp.g1t.type, "remote");
  const config = new URL(cursorInstallLink()).searchParams.get("config");
  assert.deepEqual(JSON.parse(atob(config ?? "")), { url: MCP_URL });
});

test("the snippets can point at another MCP server", () => {
  const mcp = "http://localhost:8790/mcp";
  const agents = agentsFor(mcp);
  for (const id of AGENT_IDS) {
    assert.ok(agents[id].code.includes(mcp), id);
    assert.ok(!agents[id].code.includes(MCP_URL), id);
  }
  const config = new URL(cursorInstallLink(mcp)).searchParams.get("config");
  assert.deepEqual(JSON.parse(atob(config ?? "")), { url: mcp });
});
