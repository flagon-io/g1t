import assert from "node:assert/strict";
import { test } from "node:test";

import { CONNECTORS } from "@g1t/contracts/connectors";

import { AI_PROVIDER_GROUPS, AI_PROVIDERS, aiProvidersIn, isEndpoint } from "./ai-providers.ts";
import { integrationsSection, sectionKind } from "./integration-sections.ts";

test("every AI provider is in the catalogue, once, in a group", () => {
  // The integrations directory's AI models, each an AI provider's connection.
  const models = CONNECTORS.flatMap((connector) => (connector.category === "ai" && connector.provider ? [connector.provider] : []));
  assert.ok(models.length > 0);
  assert.deepEqual(Object.keys(AI_PROVIDERS).sort(), [...models].sort());
  const grouped = AI_PROVIDER_GROUPS.flatMap(({ group }) => aiProvidersIn(group));
  assert.deepEqual([...grouped].sort(), [...models].sort());
  for (const provider of models) {
    const entry = AI_PROVIDERS[provider]!;
    assert.ok(entry.blurb.length > 0, provider);
    if (entry.keyUrl) assert.ok(entry.keyUrl.startsWith("https://"), provider);
    // Only the endpoints show an icon in place of initials.
    assert.equal(entry.mark === "", isEndpoint(provider), provider);
  }
});

test("AI providers are set up on their own page", () => {
  assert.equal(integrationsSection("models"), "models");
  assert.equal(sectionKind("models"), "models");
  assert.equal(sectionKind("alerts"), "alerts");
  assert.equal(sectionKind("trackers"), "tracker");
  assert.equal(sectionKind("gateway"), null);
});
