import assert from "node:assert/strict";
import { test } from "node:test";

import { CONNECTOR_CATEGORIES, CONNECTORS, connectorPath, connectorView, connectorsFor } from "./connectors.ts";
import { PROVIDERS } from "./integrations.ts";

test("every connector has a unique id, a category and a scope", () => {
  const ids = new Set<string>();
  const categories = new Set(CONNECTOR_CATEGORIES.map((category) => category.id));
  for (const connector of CONNECTORS) {
    assert.ok(!ids.has(connector.id), `${connector.id} is listed twice`);
    ids.add(connector.id);
    assert.match(connector.id, /^[a-z0-9-]+$/, connector.id);
    assert.ok(categories.has(connector.category), connector.id);
    assert.ok(connector.scopes.length > 0, connector.id);
    assert.ok(connector.description.length > 0 && !connector.description.includes("\n"), connector.id);
  }
});

test("every category has connectors, and an available one in each scope it has is set up somewhere", () => {
  for (const category of CONNECTOR_CATEGORIES) {
    assert.ok(CONNECTORS.some((connector) => connector.category === category.id), category.id);
  }
  for (const scope of ["workspace", "personal"] as const) {
    for (const view of connectorsFor(scope)) {
      if (view.status === "available") assert.ok(view.href?.startsWith("/"), `${view.id} (${scope}) has nowhere to set it up`);
      else assert.equal(view.href, null, view.id);
    }
  }
});

test("every integration provider is an available connector", () => {
  for (const provider of Object.keys(PROVIDERS)) {
    const connector = CONNECTORS.find((c) => c.provider === provider);
    assert.ok(connector, `${provider} has no connector`);
    assert.equal(connector.status, "available", provider);
  }
});

test("a connector shows its personal side to you", () => {
  const github = CONNECTORS.find((c) => c.id === "github")!;
  const mine = connectorView(github, "personal")!;
  assert.equal(mine.href, "/settings/github");
  assert.ok(mine.capabilities.includes("Signs you in"));
  assert.equal(mine.alsoIn, "workspace");
  const linear = CONNECTORS.find((c) => c.id === "linear")!;
  assert.equal(connectorView(linear, "workspace")!.status, "available");
  assert.equal(connectorView(linear, "personal")!.status, "soon");
  assert.equal(connectorView(linear, "personal")!.href, null);
  const calendar = CONNECTORS.find((c) => c.id === "google-calendar")!;
  assert.equal(connectorView(calendar, "workspace"), null);
});

test("a setup path names the workspace", () => {
  assert.equal(connectorPath("/:workspace/-/integrations/models?add=openai#add", "acme"), "/acme/-/integrations/models?add=openai#add");
  assert.equal(connectorPath("/new/github?workspace=:workspace", "acme"), "/new/github?workspace=acme");
});
