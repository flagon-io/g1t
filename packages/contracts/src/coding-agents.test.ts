import assert from "node:assert/strict";
import { test } from "node:test";

import { CODING_AGENTS, codingAgentById, codingAgentFor } from "./coding-agents.ts";

test("a coding agent is found by the address on its commits, not by its name", () => {
  assert.equal(codingAgentFor("noreply@anthropic.com")?.id, "claude");
  assert.equal(codingAgentFor("  NoReply@Anthropic.com ")?.id, "claude");
  assert.equal(codingAgentFor("209825114+claude[bot]@users.noreply.github.com")?.id, "claude");
  assert.equal(codingAgentFor("198982749+Copilot@users.noreply.github.com")?.id, "copilot");
  assert.equal(codingAgentFor("49699333+dependabot[bot]@users.noreply.github.com")?.id, "dependabot");
  assert.equal(codingAgentFor("41898282+github-actions[bot]@users.noreply.github.com")?.id, "github-actions");
  assert.equal(codingAgentFor("cursoragent@cursor.com")?.id, "cursor");
  assert.equal(codingAgentFor("ada@example.com"), null);
  assert.equal(codingAgentFor("123+ada@users.noreply.github.com"), null);
  assert.equal(codingAgentFor(""), null);
  assert.equal(codingAgentFor(null), null);
});

test("every agent has a unique id, lowercase addresses and logins, and a mark colour that is a hex or none", () => {
  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const agent of CODING_AGENTS) {
    assert.ok(!ids.has(agent.id), agent.id);
    ids.add(agent.id);
    assert.ok(agent.emails.length + agent.logins.length > 0, `${agent.id} matches nothing`);
    for (const value of [...agent.emails, ...agent.logins]) {
      assert.equal(value, value.toLowerCase(), value);
      assert.ok(!addresses.has(value), `${value} is listed twice`);
      addresses.add(value);
    }
    assert.ok(agent.color === null || /^[0-9A-F]{6}$/.test(agent.color), agent.id);
    assert.ok(agent.url.startsWith("https://"), agent.id);
  }
  assert.equal(codingAgentById("claude")?.name, "Claude");
  assert.equal(codingAgentById("nobody"), null);
});
