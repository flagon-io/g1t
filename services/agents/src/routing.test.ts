import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_ROUTING as POLICY, parseRouting } from "../../runner/src/model-env.ts";
import { allowedProviders, clampTier, limitsAgree, pinnedModel, replyModel } from "./routing.ts";

test("a tier is held between the floor and the ceiling", () => {
  assert.equal(clampTier("small", null, null), "small");
  assert.equal(clampTier("small", "large", null), "large", "a reviewer's floor lifts a reply");
  assert.equal(clampTier("frontier", null, "large"), "large", "triage's ceiling caps it");
  assert.equal(clampTier("large", "small", "frontier"), "large");
  assert.equal(clampTier("small", "frontier", "frontier"), "frontier");
});

test("a floor above the ceiling: the ceiling wins, and validation says no", () => {
  assert.equal(clampTier("small", "frontier", "large"), "large");
  assert.equal(clampTier("frontier", "frontier", "small"), "small");
  assert.equal(limitsAgree("frontier", "large"), false);
  assert.equal(limitsAgree("large", "large"), true);
  assert.equal(limitsAgree(null, "small"), true);
});

test("providers: empty means whatever the workspace allows; a list narrows it", () => {
  assert.deepEqual(allowedProviders({ providers: [] }, null), { hosted: true, own: false });
  assert.deepEqual(allowedProviders({ providers: [] }, "int_1"), { hosted: true, own: true });
  assert.deepEqual(allowedProviders({ providers: ["g1t"] }, "int_1"), { hosted: true, own: false });
  assert.deepEqual(allowedProviders({ providers: ["int_1"] }, "int_1"), { hosted: false, own: true });
  assert.deepEqual(allowedProviders({ providers: ["int_2"] }, "int_1"), { hosted: false, own: false }, "a provider the workspace no longer has");
  // The profile form's choices.
  assert.deepEqual(allowedProviders({ providers: ["workspace"] }, "int_1"), { hosted: false, own: true });
  assert.deepEqual(allowedProviders({ providers: ["workspace"] }, null), { hosted: false, own: false }, "own providers only, and it has none");
  assert.deepEqual(allowedProviders({ providers: ["g1t", "workspace"] }, "int_1"), { hosted: true, own: true });
});

test("a reply runs on the small tier's model, moved by the agent's limits", () => {
  const limits = { floor: null, ceiling: null, pinned: null };
  assert.equal(replyModel(POLICY, limits).model, POLICY.tiers.small.model);
  const reviewer = replyModel(POLICY, { ...limits, floor: "large" });
  assert.equal(reviewer.tier, "large");
  assert.equal(reviewer.model, POLICY.tiers.large.model);
  assert.deepEqual(reviewer.price, POLICY.tiers.large.price);
  // The workspace chose frontier for replies; a ceiling still holds.
  assert.equal(replyModel(POLICY, { ...limits, ceiling: "large" }, { chosen: "frontier" }).tier, "large");
});

test("the tier's model comes from AGENT_ROUTING, never from code", () => {
  const policy = parseRouting(JSON.stringify({ tiers: { small: { modelName: "Tiny 1", model: "tiny-1" } } }));
  const routed = replyModel(policy, { floor: null, ceiling: null, pinned: null });
  assert.equal(routed.model, "tiny-1");
  assert.equal(routed.modelName, "Tiny 1");
  assert.equal(routed.price, null, "a model named without a price has none");
});

test("a pinned model or a route's own model replaces the tier's", () => {
  assert.equal(pinnedModel("openai/gpt-x"), "gpt-x");
  assert.equal(pinnedModel(null), null);
  const pinned = replyModel(POLICY, { floor: null, ceiling: null, pinned: "acme/llama-9" });
  assert.equal(pinned.model, "llama-9");
  assert.equal(pinned.price, null);
  assert.equal(replyModel(POLICY, { floor: null, ceiling: null, pinned: "acme/llama-9" }, { named: "route-model" }).model, "route-model");
});
