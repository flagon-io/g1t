import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentTemplate } from "@g1t/contracts";

import { byDepartment, roleLine, routingWords, startPath, templateListings, templatePath, templatesPath } from "./agent-templates.ts";

const template = (id: string, title: string, department = "Engineering"): AgentTemplate => ({
  id,
  display_name: title.split(" ")[0]!,
  handle: id,
  name_ideas: [],
  role: title,
  title,
  department,
  responsibilities: ["Do the work"],
  subagents: [],
  instructions: "",
  personality_preset: "crisp",
  routing: { floor: null, ceiling: null, providers: [], pinned: null },
});

test("templates live under Agents, and starting one opens the new-agent form with it chosen", () => {
  assert.equal(templatesPath("acme"), "/acme/-/agents/templates");
  assert.equal(templatePath("acme", "qa"), "/acme/-/agents/templates/qa");
  assert.equal(startPath("acme", "qa"), "/acme/-/agents/new?template=qa");
});

test("a template counts the agents started from it, not archived ones", () => {
  const [eng, qa] = templateListings(
    [template("engineering", "Software Engineer"), template("qa", "QA Engineer")],
    [
      { id: "a1", handle: "otto", display_name: "Otto", template: "engineering", archived_at: null },
      { id: "a2", handle: "bolt", display_name: "Bolt", template: "engineering", archived_at: "2026-10-01T00:00:00Z" },
      { id: "a3", handle: "g1t", display_name: "g1t", template: null, archived_at: null },
    ],
  );
  assert.deepEqual(eng!.agents.map((a) => a.handle), ["otto"]);
  assert.equal(qa!.agents.length, 0);
});

test("without the agents service, no agent is counted", () => {
  const [eng] = templateListings([template("engineering", "Software Engineer")], null);
  assert.deepEqual(eng!.agents, []);
});

test("templates group by department, in the order they come", () => {
  const groups = byDepartment(templateListings([template("a", "A One"), template("b", "B Two", "Sales"), template("c", "C Three"), template("d", "D Four", "")], null));
  assert.deepEqual(
    groups.map(([department, list]) => [department, list.map((l) => l.template.id)]),
    [
      ["Engineering", ["a", "c"]],
      ["Sales", ["b"]],
      ["Other", ["d"]],
    ],
  );
});

test("a role and its model limits read as words", () => {
  assert.equal(roleLine({ title: "QA Engineer", department: "Engineering" }), "QA Engineer · Engineering");
  assert.equal(roleLine({ title: "QA Engineer", department: "" }), "QA Engineer");
  assert.equal(routingWords({ floor: null, ceiling: null }), "Any model the work needs");
  assert.equal(routingWords({ floor: "large", ceiling: null }), "Large models or better");
  assert.equal(routingWords({ floor: null, ceiling: "large" }), "Up to large models");
});
