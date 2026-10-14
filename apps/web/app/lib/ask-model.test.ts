import assert from "node:assert/strict";
import { test } from "node:test";

import { autoOffered, defaultModel, modelLabel, modelOptions } from "./ask-model.ts";

const anthropic = {
  id: "con_1",
  provider: "anthropic" as const,
  models: ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"],
  config: {},
};

test("Auto is the picker's first option and its default", () => {
  assert.deepEqual(
    modelOptions(anthropic).map((option) => option.value),
    ["auto", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"],
  );
  assert.equal(modelOptions(anthropic)[0]!.label, "Auto");
  // Nothing chosen yet, or another AI provider than Ask's: Auto.
  assert.equal(defaultModel(anthropic, null), "auto");
  assert.equal(defaultModel(anthropic, { provider_id: "con_2", model: "gpt-5", auto: false }), "auto");
  // Ask's own AI provider on Auto, as every route that never picked is.
  assert.equal(defaultModel(anthropic, { provider_id: "con_1", model: null, auto: true }), "auto");
});

test("an explicit pick stays picked", () => {
  assert.equal(defaultModel(anthropic, { provider_id: "con_1", model: "claude-opus-5-5", auto: false }), "claude-opus-5-5");
  // A pick the provider no longer lists falls back to Auto.
  assert.equal(defaultModel(anthropic, { provider_id: "con_1", model: "claude-2", auto: false }), "auto");
});

test("an AI provider that lists no models, or an Azure deployment, has no Auto", () => {
  const endpoint = { id: "con_3", provider: "openai_endpoint" as const, models: [], config: { model: "qwen3-coder" } };
  assert.equal(autoOffered(endpoint), false);
  assert.deepEqual(modelOptions(endpoint), []);
  assert.equal(defaultModel(endpoint, null), "qwen3-coder");
  const azure = { id: "con_4", provider: "azure_openai" as const, models: ["gpt-5"], config: { model: "prod-gpt" } };
  assert.equal(autoOffered(azure), false);
  assert.equal(defaultModel(azure, { provider_id: "con_4", model: "prod-gpt", auto: false }), "prod-gpt");
});

test("the chosen model reads as Auto, or by its name", () => {
  assert.equal(modelLabel({ model: null, auto: true }), "Auto");
  assert.equal(modelLabel({ model: "claude-sonnet-5-5", auto: false }), "claude-sonnet-5-5");
  assert.equal(modelLabel(null), "");
});
