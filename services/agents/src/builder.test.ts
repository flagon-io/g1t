import assert from "node:assert/strict";
import { test } from "node:test";

import { FOUNDATIONAL_SKILL_IDS } from "../../../packages/contracts/src/skills.ts";

import {
  BUILDER_HANDLE,
  draftSystem,
  freeHandle,
  handleFrom,
  jsonIn,
  proposalFrom,
  redraftFrom,
  startingBudget,
  trySystem,
  tryTurns,
  wordsOf,
} from "./builder.ts";
import { applyChanges } from "./definition.ts";
import { checkHandle } from "./handle.ts";
import { TEMPLATE_IDS } from "./templates.ts";

const drafted = {
  display_name: "Juniper",
  name_ideas: ["Wren", "Juniper", "Basil", "!!"],
  title: "Release Manager",
  department: "Engineering",
  team: "release",
  instructions: "You cut releases.\n- Read merged pull requests since the last tag.\n- Write the notes.",
  responsibilities: ["Cut a release every Tuesday", "Write the release notes", "Ask in #releases before tagging"],
  personality_preset: "friendly",
  personality: "Short sentences.",
  skills: ["documents", "code", "made-up"],
  integrations: [{ id: "linear", why: "Reads the issues a release closes." }, { id: "nope", why: "x" }, { id: "linear", why: "twice" }],
  routines: [{ name: "Tuesday release", when: "Every Tuesday at 10:00", instructions: "Cut the release." }, { name: "", when: "" }],
  floor: "frontier",
  ceiling: "small",
};

test("a description becomes a complete definition that create takes as it is", () => {
  const made = proposalFrom(drafted, { scope: "personal", taken: new Set(), budget: startingBudget("personal", null) });
  assert.ok(made.ok);
  const { definition } = made.value;
  assert.equal(definition.handle, "juniper");
  assert.equal(definition.display_name, "Juniper");
  assert.equal(definition.scope, "personal");
  assert.ok(!("team" in definition) && !("department" in definition), "a draft names no team or department, whatever the model says");
  assert.deepEqual(definition.budget, { monthly_micros: 20_000_000, daily_micros: null, task_micros: 2_000_000 }, "$20 a month, $2 a session");
  assert.deepEqual(definition.routing, { floor: null, ceiling: "small", providers: [], pinned: null }, "a floor above the ceiling is dropped");
  assert.deepEqual(made.value.skills, ["documents", "code"], "unknown skills are left out");
  assert.deepEqual(definition.skills_off, FOUNDATIONAL_SKILL_IDS.filter((id) => id !== "documents" && id !== "code"));
  assert.deepEqual(made.value.integrations, [{ id: "linear", why: "Reads the issues a release closes." }], "only the catalog's, once each");
  assert.equal(made.value.routines.length, 1);
  assert.deepEqual(made.value.name_ideas, ["Wren", "Basil"]);
  const { scope: _scope, ...input } = definition;
  assert.ok(applyChanges(null, input, TEMPLATE_IDS).ok);
});

test("a draft takes a free handle, and a workspace draft the workspace's default budget", () => {
  const made = proposalFrom(drafted, { scope: "workspace", taken: new Set(["juniper", "juniper-2"]), budget: startingBudget("workspace", 30_000_000) });
  assert.ok(made.ok);
  assert.equal(made.value.definition.handle, "juniper-3");
  assert.deepEqual(made.value.definition.budget, { monthly_micros: 30_000_000, daily_micros: null, task_micros: null });
});

test("a draft with every skill unnamed keeps them all on; one with no job can't be created", () => {
  const all = proposalFrom({ ...drafted, skills: [] }, { scope: "workspace", taken: new Set(), budget: startingBudget("workspace", null) });
  assert.ok(all.ok);
  assert.deepEqual(all.value.definition.skills_off, []);
  assert.equal(proposalFrom({ ...drafted, instructions: "" }, { scope: "workspace", taken: new Set(), budget: startingBudget("workspace", null) }).ok, false);
  assert.equal(proposalFrom(null, { scope: "workspace", taken: new Set(), budget: startingBudget("workspace", null) }).ok, false);
});

test("the model's answer is read fenced or bare, and junk is nothing", () => {
  assert.deepEqual(jsonIn('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(jsonIn('Here it is: {"a": {"b": 2}} done'), { a: { b: 2 } });
  assert.equal(jsonIn("no json"), null);
  assert.equal(jsonIn("[1, 2]"), null);
});

test("handles come from names, and are never reserved", () => {
  assert.equal(handleFrom("Margo Lee"), "margo-lee");
  assert.equal(handleFrom("Zoë"), "zoe");
  assert.ok(checkHandle(freeHandle("g1t", new Set())).ok);
  assert.ok(checkHandle(freeHandle("New", new Set())).ok);
  assert.equal(checkHandle(BUILDER_HANDLE).ok, false, "the builder's bill name is no agent's handle");
});

const before = (() => {
  const made = applyChanges(
    null,
    {
      handle: "juniper",
      display_name: "Juniper",
      title: "Release Manager",
      instructions: "You cut releases.",
      responsibilities: ["Cut releases", "Write notes"],
      budget: { monthly_micros: 20_000_000, task_micros: 2_000_000 },
    },
    TEMPLATE_IDS,
  );
  assert.ok(made.ok);
  return made.value;
})();

test("a change in words keeps only what differs", () => {
  const changed = redraftFrom(
    { display_name: "Juniper", instructions: "You cut releases. Answer in Spanish.", monthly_dollars: 50, session_dollars: 2, summary: "Answers in Spanish; $50 a month." },
    before,
    false,
  );
  assert.ok(changed.ok);
  assert.deepEqual(changed.value.changes, { instructions: "You cut releases. Answer in Spanish.", budget: { monthly_micros: 50_000_000 } });
  assert.equal(changed.value.summary, "Answers in Spanish; $50 a month.");
});

test("renaming moves a handle that followed the name, and @g1t keeps who it is", () => {
  const renamed = redraftFrom({ display_name: "Wren", summary: "Renamed." }, before, false);
  assert.ok(renamed.ok);
  assert.deepEqual(renamed.value.changes, { display_name: "Wren", handle: "wren" });
  const builtin = redraftFrom({ display_name: "Boss", title: "Chief", personality: "Dry." }, before, true);
  assert.ok(builtin.ok);
  assert.deepEqual(builtin.value.changes, { personality: "Dry." });
});

test("a change that asks for nothing says so", () => {
  const none = redraftFrom({ summary: "" }, before, false);
  assert.equal(none.ok, false);
  assert.equal(redraftFrom({ instructions: "" }, before, false).ok, false, "a job is never emptied");
});

test("Try it takes alternating turns that end with the person's", () => {
  const turns = tryTurns([
    { role: "assistant", content: "hi" },
    { role: "user", content: "one" },
    { role: "user", content: "two" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "three" },
  ]);
  assert.ok(turns.ok);
  assert.deepEqual(turns.value, [
    { role: "user", content: "one\n\ntwo" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "three" },
  ]);
  assert.equal(tryTurns([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]).ok, false);
  assert.equal(tryTurns([]).ok, false);
  assert.equal(tryTurns(Array.from({ length: 30 }, () => ({ role: "user", content: "x" }))).ok, false);
});

test("Try it speaks with the agent's own prompt, said to be a preview with no tools", () => {
  const prompt = trySystem({ workspace: "acme", definition: before, asker: { username: "ana" }, today: new Date("2026-10-10T00:00:00Z") });
  assert.match(prompt, /You are Juniper \(@juniper\)/);
  assert.match(prompt, /This is a preview/);
  assert.match(prompt, /You can only read this conversation right now/);
  assert.match(draftSystem("acme", "personal"), /personal agent/);
  assert.match(draftSystem("acme", "workspace"), /linear: Linear/);
});

test("descriptions and requests are checked", () => {
  assert.equal(wordsOf("", "description").ok, false);
  assert.equal(wordsOf("x".repeat(2001), "description").ok, false);
  assert.equal(wordsOf("x".repeat(1001), "request").ok, false);
  assert.deepEqual(wordsOf("  Cut releases  ", "description"), { ok: true, value: "Cut releases" });
});
