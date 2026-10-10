import assert from "node:assert/strict";
import { test } from "node:test";

import { applyChanges } from "./definition.ts";
import { clampTier, effortOf, effortPlan, higherEffort, lowerEffort, reasoningEffort } from "./routing.ts";
import { TEMPLATE_IDS } from "./templates.ts";
import { runTurn } from "./turn.ts";

const input = { handle: "ship", display_name: "Ship", role: "Release manager", title: "Release Manager", instructions: "Ship releases." };

test("each setting moves the starting tier, the reasoning and a session's steps together", () => {
  assert.deepEqual(effortPlan("low", "large"), { level: "low", start: "small", steps: 5 });
  assert.deepEqual(effortPlan("medium", "large"), { level: "medium", start: "large", steps: 8 });
  assert.deepEqual(effortPlan("medium", "small"), { level: "medium", start: "small", steps: 8 }, "medium keeps where the work starts");
  assert.deepEqual(effortPlan("high", "small"), { level: "high", start: "large", steps: 10 }, "high starts on large at least");
  assert.deepEqual(effortPlan("high", "frontier"), { level: "high", start: "frontier", steps: 10 });
  assert.deepEqual(effortPlan("max", "small"), { level: "max", start: "frontier", steps: 12 });
});

test("auto runs at medium, and works harder on a session someone had to steer", () => {
  assert.equal(effortPlan("auto", "small").level, "medium");
  assert.equal(effortPlan(undefined, "large").level, "medium", "no setting is auto");
  assert.deepEqual(effortPlan("auto", "large", { raised: true }), { level: "high", start: "large", steps: 10 });
  // An explicit setting is never raised.
  assert.equal(effortPlan("low", "large", { raised: true }).level, "low");
});

test("the floor and the ceiling still hold over effort", () => {
  assert.equal(clampTier(effortPlan("max", "small").start, null, "large"), "large", "the ceiling is the spending rail");
  assert.equal(clampTier(effortPlan("low", "large").start, "large", null), "large", "a floor lifts low effort's small tier");
});

test("reasoning is sent only to g1t's tiers whose model takes it", () => {
  assert.equal(reasoningEffort("high", { capabilities: ["effort", "tools"] }, false), "high");
  assert.equal(reasoningEffort("high", { capabilities: ["tools"] }, false), null, "a model without effort");
  assert.equal(reasoningEffort("low", {}, false), "low", "a route from configuration says nothing, so it is sent");
  assert.equal(reasoningEffort("max", { capabilities: ["effort"] }, true), null, "never to a model the workspace's route names");
});

test("levels order and step", () => {
  assert.equal(higherEffort(null, "medium"), "medium");
  assert.equal(higherEffort("high", "medium"), "high");
  assert.equal(lowerEffort("max"), "high");
  assert.equal(lowerEffort("low"), null);
  assert.equal(effortOf({ effort: "max" }), "max");
  assert.equal(effortOf({ effort: "enormous" as never }), "auto");
  assert.equal(effortOf(null), "auto");
});

test("effort is part of the definition, and only the five settings are taken", () => {
  const made = applyChanges(null, { ...input, routing: { effort: "high" } }, TEMPLATE_IDS);
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.equal(made.value.routing.effort, "high");
  // Changing other routing keeps it.
  const next = applyChanges(made.value, { routing: { ceiling: "large" } }, TEMPLATE_IDS);
  assert.ok(next.ok && next.value.routing.effort === "high");
  const bad = applyChanges(made.value, { routing: { effort: "turbo" as never } }, TEMPLATE_IDS);
  assert.ok(!bad.ok);
  if (!bad.ok) assert.match(bad.message, /auto, low, medium, high or max/);
});

test("a turn sends the effort as output_config, and nothing when there is none", async () => {
  const sent: Record<string, unknown>[] = [];
  const send = async (body: Record<string, unknown>) => {
    sent.push(body);
    return { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
  };
  await runTurn(send, { model: "m", system: "s", messages: [{ role: "user", content: "hi" }], tools: null, price: null, effort: "low" });
  await runTurn(send, { model: "m", system: "s", messages: [{ role: "user", content: "hi" }], tools: null, price: null });
  assert.deepEqual(sent[0].output_config, { effort: "low" });
  assert.equal(sent[1].output_config, undefined);
});
