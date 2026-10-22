import assert from "node:assert/strict";
import { test } from "node:test";

import { agentRuleText, agentTitle } from "./agent-rule.ts";

test("each rule says why a change is an agent's", () => {
  assert.equal(agentRuleText("session"), "a session g1t recorded is tied to it");
  assert.equal(agentRuleText("trailer:agent-logs-url"), "an Agent-Logs-Url trailer on its commits");
  assert.equal(agentRuleText("trailer:made-with-cursor"), "“Made with Cursor” on its commits");
  assert.equal(agentRuleText("author:copilot"), "Copilot is the author of its commits");
  assert.equal(agentRuleText("coauthor:cursor"), "Cursor is a co-author of its commits");
  // An agent g1t has no card for is named by its id; a rule it doesn't know, as it is.
  assert.equal(agentRuleText("author:someagent"), "someagent is the author of its commits");
  assert.equal(agentRuleText("heuristic:new"), "heuristic:new");
  assert.equal(agentRuleText(null), null);
});

test("the title reads as a sentence with or without a rule", () => {
  assert.equal(agentTitle("coauthor:claude"), "An agent's: Claude is a co-author of its commits");
  assert.equal(agentTitle(undefined), "An agent's");
});
