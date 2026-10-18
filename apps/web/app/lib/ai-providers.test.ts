import assert from "node:assert/strict";
import { test } from "node:test";

import { type AiProvider, AI_PROVIDERS } from "@g1t/contracts/ai";
import { CONNECTORS } from "@g1t/contracts/connectors";

import { AI_PROVIDER_GROUPS, AI_PROVIDER_LOOKS, aiProvidersIn, isEndpoint } from "./ai-providers.ts";
import { aiPagePath, providerPage, sectionKind } from "./integration-sections.ts";

test("every AI provider is shown, once, in a group", () => {
  const providers = Object.keys(AI_PROVIDERS) as AiProvider[];
  assert.equal(providers.length, 14);
  assert.deepEqual(Object.keys(AI_PROVIDER_LOOKS).sort(), [...providers].sort());
  const grouped = AI_PROVIDER_GROUPS.flatMap(({ group }) => aiProvidersIn(group));
  assert.deepEqual(grouped, providers);
  for (const provider of providers) {
    const look = AI_PROVIDER_LOOKS[provider];
    assert.ok(look.blurb.length > 0, provider);
    if (look.keyUrl) assert.ok(look.keyUrl.startsWith("https://"), provider);
    // Every provider that takes a key says where to get one, and how.
    assert.equal(Boolean(look.keyUrl && look.keyHow), !isEndpoint(provider), provider);
    // Only the endpoints show an icon in place of initials.
    assert.equal(look.mark === "", isEndpoint(provider), provider);
  }
});

test("AI providers are the workspace's AI settings, not integrations", () => {
  // None is in the integrations directory.
  const ai = new Set<string>(Object.keys(AI_PROVIDERS));
  assert.deepEqual(
    CONNECTORS.filter((connector) => connector.provider && ai.has(connector.provider)),
    [],
  );
  assert.equal(providerPage("alerts"), "integrations/alerts");
  assert.equal(providerPage("tracker"), "integrations/trackers");
  assert.equal(sectionKind("models"), null);
  assert.equal(sectionKind("alerts"), "alerts");
  assert.equal(sectionKind("trackers"), "tracker");
  assert.equal(sectionKind("gateway"), null);
});

test("older links to the AI providers' page open the AI page", () => {
  assert.equal(aiPagePath("acme", ""), "/acme/-/ai");
  assert.equal(aiPagePath("acme", "?add=openai"), "/acme/-/ai?add=openai#add");
  assert.equal(aiPagePath("acme", "?_routes=root&add=openai"), "/acme/-/ai?add=openai#add");
});
