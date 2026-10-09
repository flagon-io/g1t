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
  assert.equal(bad({ template: "reviewer" }), true);
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
  assert.deepEqual(TEMPLATE_IDS, ["planner", "implementer", "reviewer", "triage", "documenter", "release-manager", "on-call"]);
  for (const template of TEMPLATES) {
    const made = applyChanges(null, { ...template, template: template.id }, TEMPLATE_IDS);
    assert.ok(made.ok, template.id);
  }
  const byId = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
  assert.equal(byId.reviewer.routing.floor, "large");
  assert.equal(byId.triage.routing.ceiling, "large");
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
