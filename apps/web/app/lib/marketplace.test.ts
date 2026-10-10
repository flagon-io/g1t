import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentTemplate, InstallRequest } from "@g1t/contracts";
import { connectorsFor } from "@g1t/contracts/connectors";

import { FIRST_PARTY_EXTENSIONS } from "@g1t/contracts/marketplace";

import { addPath, agentListings, comingIntegrations, extensionListings, integrationListings, integrationMatches, marketplaceForm, routingWords } from "./marketplace.ts";
import { modeOf } from "./workspace-nav.ts";

const template = (id: string, title: string): AgentTemplate => ({
  id,
  display_name: title.split(" ")[0]!,
  handle: id,
  name_ideas: [],
  role: title,
  title,
  department: "Engineering",
  responsibilities: ["Do the work"],
  subagents: [],
  instructions: "",
  personality_preset: "crisp",
  routing: { floor: null, ceiling: null, providers: [], pinned: null },
});

const request = (listing: string, by: string, status: InstallRequest["status"] = "open"): InstallRequest => ({
  id: `ins_${listing}_${by}`,
  listing,
  kind: listing.startsWith("agent:") ? "agent" : "integration",
  name: listing,
  note: null,
  requested_by: by,
  requested_at: "2026-10-10T12:00:00Z",
  status,
  resolved_by: null,
  resolved_at: null,
});

test("a role counts the agents hired into it, not archived ones", () => {
  const [eng, qa] = agentListings(
    [template("engineering", "Software Engineer"), template("qa", "QA Engineer")],
    [
      { id: "a1", handle: "otto", display_name: "Otto", template: "engineering", archived_at: null },
      { id: "a2", handle: "bolt", display_name: "Bolt", template: "engineering", archived_at: "2026-10-01T00:00:00Z" },
      { id: "a3", handle: "g1t", display_name: "g1t", template: null, archived_at: null },
    ],
    [request("agent:qa", "ana"), request("agent:qa", "bo"), request("agent:engineering", "ana", "declined")],
    "Ana",
  );
  assert.deepEqual(eng!.hired.map((a) => a.handle), ["otto"]);
  assert.equal(eng!.requested, false, "a turned-down request isn't waiting");
  assert.equal(qa!.hired.length, 0);
  assert.equal(qa!.requested, true, "usernames match whatever their case");
  assert.equal(qa!.waiting, 2);
});

test("without the agents service, nobody counts as hired", () => {
  const [eng] = agentListings([template("engineering", "Software Engineer")], null, [], "ana");
  assert.deepEqual(eng!.hired, []);
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
  assert.equal(addPath({ listing: "agent:qa" }, "acme", views), "/acme/-/agents/new?template=qa");
  assert.equal(addPath({ listing: "integration:jira" }, "acme", views), "/acme/-/integrations/trackers?add=jira#add");
  assert.equal(addPath({ listing: "nonsense" }, "acme", views), null);
});

test("the Marketplace's forms are read strictly", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return data;
  };
  assert.deepEqual(marketplaceForm(form({ intent: "request", listing: "agent:qa", note: "  flaky  " })), { intent: "request", listing: "agent:qa", note: "flaky" });
  assert.deepEqual(marketplaceForm(form({ intent: "request", listing: "agent:qa" })), { intent: "request", listing: "agent:qa", note: null });
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

test("routing limits read as words", () => {
  assert.equal(routingWords({ floor: null, ceiling: null }), "Any model the work needs");
  assert.equal(routingWords({ floor: "large", ceiling: null }), "Large models or better");
  assert.equal(routingWords({ floor: null, ceiling: "large" }), "Up to large models");
});

test("the Marketplace is part of Apps, not a mode of its own", () => {
  assert.equal(modeOf("/acme/-/marketplace", "acme"), "apps");
  assert.equal(modeOf("/acme/-/marketplace/agents/qa", "acme"), "apps");
});
