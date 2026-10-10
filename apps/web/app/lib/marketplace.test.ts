import assert from "node:assert/strict";
import { test } from "node:test";

import type { InstallRequest } from "@g1t/contracts";
import { connectorsFor } from "@g1t/contracts/connectors";

import { FIRST_PARTY_EXTENSIONS, extensionById } from "@g1t/contracts/marketplace";

import { STARTER_KITS, addPath, comingIntegrations, extensionListings, integrationListings, integrationMatches, isConnectedSystem, marketplaceForm } from "./marketplace.ts";
import { modeOf } from "./workspace-nav.ts";

const request = (listing: string, by: string, status: InstallRequest["status"] = "open"): InstallRequest => ({
  id: `ins_${listing}_${by}`,
  listing,
  kind: listing.startsWith("extension:") ? "extension" : "integration",
  name: listing,
  note: null,
  requested_by: by,
  requested_at: "2026-10-10T12:00:00Z",
  status,
  resolved_by: null,
  resolved_at: null,
});

test("only integrations a workspace can connect today are listed, connected first", () => {
  const views = connectorsFor("workspace");
  const listings = integrationListings(views, { sentry: { detail: "acme", problem: null, manage: "/acme/-/integrations/alerts" } }, [], "ana", "acme");
  assert.ok(listings.every((l) => l.view.status === "available"));
  assert.equal(listings[0]!.view.id, "sentry");
  assert.equal(listings[0]!.href, "/acme/-/integrations/alerts", "managed where it is managed");
  const linear = listings.find((l) => l.view.id === "linear")!;
  assert.equal(linear.href, "/acme/-/integrations/trackers?add=linear#add", "connected on its setup page");
  assert.ok(!listings.some((l) => l.view.id === "slack"));
  assert.ok(comingIntegrations(views).some((v) => v.id === "slack"));
  assert.ok(integrationMatches(linear, "tracker"));
  assert.ok(!integrationMatches(linear, "deploys"));
});

test("an owner adds what a request asks for where it is added", () => {
  const views = connectorsFor("workspace");
  assert.equal(addPath({ listing: "agent:qa" }, "acme", views), null, "agents aren't added from the Marketplace");
  assert.equal(addPath({ listing: "integration:jira" }, "acme", views), "/acme/-/integrations/trackers?add=jira#add");
  assert.equal(addPath({ listing: "nonsense" }, "acme", views), null);
});

test("the Marketplace's forms are read strictly", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return data;
  };
  assert.deepEqual(marketplaceForm(form({ intent: "request", listing: "integration:jira", note: "  flaky  " })), { intent: "request", listing: "integration:jira", note: "flaky" });
  assert.deepEqual(marketplaceForm(form({ intent: "request", listing: "extension:support" })), { intent: "request", listing: "extension:support", note: null });
  assert.equal(marketplaceForm(form({ intent: "request", listing: "agent:qa" })), null, "agents start from templates in Agents");
  assert.equal(marketplaceForm(form({ intent: "request", listing: "app:qa" })), null);
  assert.deepEqual(marketplaceForm(form({ intent: "resolve", id: "ins_1", status: "declined" })), { intent: "resolve", id: "ins_1", status: "declined" });
  assert.equal(marketplaceForm(form({ intent: "resolve", id: "ins_1", status: "open" })), null);
  assert.equal(marketplaceForm(form({ intent: "install" })), null);
});

test("extensions list published ones first, each with its install", () => {
  const published = { ...FIRST_PARTY_EXTENSIONS[1]!, id: "standup", status: "available" as const, source: { repo: "flagon-io/standup", tag: "v1.0.0" }, version: "1.0.0" };
  const install = { id: "ins_1", listing: "extension:standup", version: "1.0.0", plan: "free", installed_by: "chase", installed_at: "2026-10-10T00:00:00Z", enabled: true, disabled_by: null, disabled_at: null, budget_monthly_micros: null };
  const listings = extensionListings([...FIRST_PARTY_EXTENSIONS, published], [install], [request("extension:support", "ana")], "ana");
  assert.equal(listings[0]!.manifest.id, "standup");
  assert.equal(listings[0]!.install?.version, "1.0.0");
  assert.equal(listings.find((l) => l.manifest.id === "support")!.requested, true);
  assert.equal(listings.find((l) => l.manifest.id === "mail")!.install, null);
});

test("coming integrations include the ones each person connects, once", () => {
  const workspace = connectorsFor("workspace");
  const personal = connectorsFor("personal");
  const coming = comingIntegrations(workspace, personal).map((v) => v.id);
  assert.ok(coming.includes("slack"));
  assert.ok(coming.includes("gmail"), "Gmail is each person's");
  assert.ok(coming.includes("google-calendar"));
  assert.equal(new Set(coming).size, coming.length);
});

test("installing, switching and removing an extension are read from forms", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return data;
  };
  assert.deepEqual(marketplaceForm(form({ intent: "install", extension: "support" })), { intent: "install", extension: "support" });
  assert.deepEqual(marketplaceForm(form({ intent: "switch", listing: "extension:support", enabled: "off" })), { intent: "switch", listing: "extension:support", enabled: false });
  assert.equal(marketplaceForm(form({ intent: "switch", listing: "integration:sentry", enabled: "off" })), null);
  assert.deepEqual(marketplaceForm(form({ intent: "uninstall", listing: "extension:support" })), { intent: "uninstall", listing: "extension:support" });
  assert.equal(addPath({ listing: "extension:mail" }, "acme", []), "/acme/-/marketplace/extensions/mail");
});

test("starter kits name extensions that are listed, and connected systems are told apart", () => {
  for (const kit of STARTER_KITS) {
    assert.ok(kit.extensions.length > 0, kit.id);
    for (const id of kit.extensions) assert.ok(extensionById(id), `${kit.id}: ${id}`);
  }
  const systems = FIRST_PARTY_EXTENSIONS.filter(isConnectedSystem).map((m) => m.id);
  assert.deepEqual(systems, ["helpdesk-bridge", "crm-bridge", "erp-bridge"]);
  assert.ok(FIRST_PARTY_EXTENSIONS.filter(isConnectedSystem).every((m) => m.bridges), "a connected system says what it bridges");
});

test("the Marketplace is part of Apps, not a mode of its own", () => {
  assert.equal(modeOf("/acme/-/marketplace", "acme"), "apps");
  assert.equal(modeOf("/acme/-/marketplace/extensions/mail", "acme"), "apps");
  assert.equal(modeOf("/acme/-/agents/templates", "acme"), "agents", "agent templates are Agents'");
});
