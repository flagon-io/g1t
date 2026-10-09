import assert from "node:assert/strict";
import { test } from "node:test";

import type { User } from "@g1t/contracts";

import { canManage, canSee } from "./access.ts";
import { DEFAULT_AUTONOMY, DEFAULT_CAPACITY, applyChanges, readJson } from "./definition.ts";
import { TEMPLATES, TEMPLATE_IDS } from "./templates.ts";

const input = { handle: "Ship", display_name: " Ship ", role: "Release manager", instructions: "Cut releases." };

test("a new agent gets safe defaults", () => {
  const made = applyChanges(null, input, TEMPLATE_IDS);
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.equal(made.value.handle, "ship");
  assert.equal(made.value.display_name, "Ship");
  assert.equal(made.value.personality_preset, "crisp");
  assert.equal(made.value.capacity, DEFAULT_CAPACITY);
  assert.deepEqual(made.value.autonomy, DEFAULT_AUTONOMY);
  assert.equal(made.value.autonomy.merge, "approval");
  assert.deepEqual(made.value.routing, { floor: null, ceiling: null, providers: [], pinned: null });
});

test("a new agent needs a handle, a name, a role and instructions", () => {
  for (const missing of ["handle", "display_name", "role", "instructions"] as const) {
    const made = applyChanges(null, { ...input, [missing]: "" }, TEMPLATE_IDS);
    assert.equal(made.ok, false, missing);
  }
  assert.equal(applyChanges(null, { ...input, handle: "g1t" }, TEMPLATE_IDS).ok, false);
});

test("a change merges onto the definition, and is checked", () => {
  const made = applyChanges(null, input, TEMPLATE_IDS);
  assert.ok(made.ok);
  if (!made.ok) return;
  const changed = applyChanges(made.value, { routing: { floor: "large" }, budget: { monthly_micros: 5_000_000 }, autonomy: { merge: "never" } }, TEMPLATE_IDS);
  assert.ok(changed.ok);
  if (!changed.ok) return;
  assert.equal(changed.value.handle, "ship", "untouched fields stay");
  assert.equal(changed.value.routing.floor, "large");
  assert.equal(changed.value.routing.ceiling, null);
  assert.equal(changed.value.budget.monthly_micros, 5_000_000);
  assert.equal(changed.value.budget.daily_micros, null);
  assert.equal(changed.value.autonomy.merge, "never");
  assert.equal(changed.value.autonomy.open_pull_requests, "alone");

  const bad = (changes: object) => applyChanges(made.value, changes, TEMPLATE_IDS).ok;
  assert.equal(bad({ routing: { floor: "frontier", ceiling: "small" } }), false, "floor above ceiling");
  assert.equal(bad({ routing: { floor: "huge" } }), false);
  assert.equal(bad({ routing: { pinned: "no-slash" } }), false);
  assert.equal(bad({ budget: { monthly_micros: -1 } }), false);
  assert.equal(bad({ budget: { daily_micros: 1.5 } }), false);
  assert.equal(bad({ autonomy: { deploy_production: "alone" } }), false, "production deploys always ask");
  assert.equal(bad({ capacity: 0 }), false);
  assert.equal(bad({ capacity: 11 }), false);
  assert.equal(bad({ personality_preset: "pirate" }), false);
  assert.equal(bad({ template: "nope" }), false);
  assert.equal(bad({ template: "qa" }), true);
  for (const providers of [[], ["g1t"], ["workspace"], ["int_1"], ["g1t", "workspace"]]) assert.equal(bad({ routing: { providers } }), true, JSON.stringify(providers));
  assert.equal(bad({ routing: { providers: [""] } }), false);
  assert.equal(bad({ instructions: "x".repeat(8001) }), false);
});

test("a stored JSON column that cannot be read is the default", () => {
  assert.deepEqual(readJson("{bad", { a: 1 }), { a: 1 });
  assert.deepEqual(readJson('{"b":2}', { a: 1 }), { a: 1, b: 2 });
  assert.deepEqual(readJson(null, { a: 1 }), { a: 1 });
});

test("every template is a valid definition with the routing its job needs", () => {
  assert.deepEqual(TEMPLATE_IDS, ["engineering", "qa", "operations", "docs", "product", "support", "sales"]);
  for (const template of TEMPLATES) {
    const made = applyChanges(null, { ...template, template: template.id }, TEMPLATE_IDS);
    assert.ok(made.ok, template.id);
  }
  const byId = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
  assert.equal(byId.qa.routing.floor, "large", "careful review never runs below large");
  assert.equal(byId.product.routing.ceiling, "large", "intake never runs above it");
  assert.equal(new Set(TEMPLATES.map((t) => t.handle)).size, TEMPLATES.length, "handles are distinct");
});

test("members see a workspace's agents; owners change them", () => {
  const person = (role: "owner" | "member"): User => ({ id: "u", username: "u", workspaces: [{ slug: "acme", role }] }) as User;
  assert.ok(canSee(person("member"), "ACME"));
  assert.ok(!canManage(person("member"), "acme"));
  assert.ok(canManage(person("owner"), "acme"));
  assert.ok(!canSee(person("owner"), "other"));
  assert.ok(!canSee(null, "acme"));
  const token = { id: "w", username: "acme", kind: "workspace" } as User;
  assert.ok(canManage(token, "acme"), "the workspace's own token");
  assert.ok(!canSee(token, "other"));
});

test("templates are named like teammates, with more names to shuffle, each a valid handle", async () => {
  const { checkHandle } = await import("./handle.ts");
  const byId = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
  assert.equal(byId.qa.display_name, "Margo");
  assert.equal(byId.qa.handle, "margo");
  for (const template of TEMPLATES) {
    assert.ok(!/reviewer|planner|triage|implementer|documenter|on-call|release/i.test(template.display_name), `${template.id} has a name, not a job title`);
    assert.ok(template.name_ideas.length >= 6 && template.name_ideas.length <= 10, template.id);
    assert.ok(template.name_ideas.includes(template.display_name), `${template.id}'s own name is among its ideas`);
    for (const name of template.name_ideas) assert.ok(checkHandle(name.toLowerCase()).ok, `${name} works as a handle`);
    assert.equal(new Set(template.name_ideas).size, template.name_ideas.length, `${template.id} repeats no name`);
  }
});

test("an agent's avatar seed starts as its handle, can be changed, and stays through a rename", () => {
  const made = applyChanges(null, input, TEMPLATE_IDS);
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.equal(made.value.avatar_seed, "ship");
  const renamed = applyChanges(made.value, { handle: "skipper" }, TEMPLATE_IDS);
  assert.ok(renamed.ok);
  if (renamed.ok) assert.equal(renamed.value.avatar_seed, "ship", "a new name keeps the face");
  const reseeded = applyChanges(made.value, { avatar_seed: "ship-2" }, TEMPLATE_IDS);
  assert.ok(reseeded.ok);
  if (reseeded.ok) assert.equal(reseeded.value.avatar_seed, "ship-2");
  assert.equal(applyChanges(made.value, { avatar_seed: "x".repeat(65) }, TEMPLATE_IDS).ok, false);
  const chosen = applyChanges(null, { ...input, avatar_seed: "blob" }, TEMPLATE_IDS);
  assert.ok(chosen.ok && chosen.value.avatar_seed === "blob");
});

test("an agent is hired into a role: title, team or department, responsibilities", async () => {
  const { roleOf } = await import("./definition.ts");
  const made = applyChanges(null, { handle: "margo", display_name: "Margo", title: "QA Engineer", department: "QA", instructions: "Test things.", responsibilities: ["Review pull requests", "Chase flaky checks"] }, TEMPLATE_IDS);
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.equal(made.value.role, "QA Engineer, QA", "the one-line role is made from the title and department");
  const onTeam = applyChanges(made.value, { team: "QA-Core" }, TEMPLATE_IDS);
  assert.ok(onTeam.ok && onTeam.value.role === "QA Engineer on the qa-core team", "a made role follows the title and team");
  const written = applyChanges(made.value, { role: "Keeps us honest" }, TEMPLATE_IDS);
  assert.ok(written.ok);
  if (!written.ok) return;
  const kept = applyChanges(written.value, { title: "QA Lead" }, TEMPLATE_IDS);
  assert.ok(kept.ok && kept.value.role === "Keeps us honest", "a written role is kept");
  assert.equal(roleOf({ title: "", team: null, department: "QA" }), "");
  assert.equal(applyChanges(null, { handle: "x1", display_name: "X", instructions: "y" }, TEMPLATE_IDS).ok, false, "a title or a role is needed");
  const bad = (changes: object) => applyChanges(made.value, changes, TEMPLATE_IDS).ok;
  assert.equal(bad({ responsibilities: ["Only one"] }), false, "2 to 8 duties");
  assert.equal(bad({ responsibilities: Array.from({ length: 9 }, (_, i) => `Duty ${i}`) }), false);
  assert.equal(bad({ responsibilities: [] }), true, "or none yet");
  assert.equal(bad({ team: "not a slug!" }), false);
  assert.equal(bad({ team: null }), true);
});

test("subagents: named, described, at most 8, never wider than their agent", () => {
  const base = applyChanges(null, { ...input, routing: { floor: "large", ceiling: "large" } }, TEMPLATE_IDS);
  assert.ok(base.ok);
  if (!base.ok) return;
  const helper = { name: "flake-hunter", description: "Bisects flaky tests", instructions: "Find the cause.", routing: { floor: "small" as const, ceiling: "frontier" as const }, max_parallel: 3 };
  const withHelper = applyChanges(base.value, { subagents: [helper] }, TEMPLATE_IDS);
  assert.ok(withHelper.ok);
  if (!withHelper.ok) return;
  assert.deepEqual(withHelper.value.subagents[0].routing, { floor: "large", ceiling: "large" }, "held within the agent's limits");
  const loosened = applyChanges(withHelper.value, { routing: { floor: null, ceiling: null } }, TEMPLATE_IDS);
  assert.ok(loosened.ok && loosened.value.subagents[0].routing.floor === "large", "loosening the agent later does not widen what was stored");
  const bad = (subagents: unknown) => applyChanges(base.value, { subagents: subagents as never }, TEMPLATE_IDS).ok;
  assert.equal(bad([{ ...helper, name: "Flake Hunter" }]), false);
  assert.equal(bad([helper, helper]), false, "names are unique");
  assert.equal(bad([{ ...helper, description: "" }]), false);
  assert.equal(bad([{ ...helper, max_parallel: 9 }]), false);
  assert.equal(bad(Array.from({ length: 9 }, (_, i) => ({ ...helper, name: `helper-${i}` }))), false, "at most 8");
  assert.equal(bad([{ ...helper, routing: { floor: "frontier", ceiling: "small" } }]), false);
});

test("agents face the workspace's own people; customer-facing ones aren't available yet", () => {
  const made = applyChanges(null, input, TEMPLATE_IDS);
  assert.ok(made.ok && made.value.faces === "internal");
  const customers = applyChanges(null, { ...input, faces: "customers" }, TEMPLATE_IDS);
  assert.ok(!customers.ok && customers.message === "Customer-facing agents aren't available yet.");
});

test("role templates by department, each with a title, duties and a subagent or two; David is back office", () => {
  const byId = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
  for (const template of TEMPLATES) {
    assert.ok(template.title && template.department, template.id);
    assert.ok(template.responsibilities.length >= 2 && template.responsibilities.length <= 8, template.id);
    assert.ok(template.subagents.length >= 1 && template.subagents.length <= 2, template.id);
  }
  assert.equal(byId.sales.display_name, "David");
  assert.equal(byId.sales.title, "Sales Operations");
  assert.equal(byId.sales.department, "Sales");
  assert.match(byId.sales.instructions, /never contact a customer/i);
  assert.match(byId.sales.instructions, /never promise roadmap/i);
  assert.match(byId.sales.instructions, /audience/);
  assert.ok(!TEMPLATE_IDS.includes("planner"), "planning is g1t's own job");
});
