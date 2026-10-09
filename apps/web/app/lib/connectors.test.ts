import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorsFor } from "@g1t/contracts/connectors";

import {
  arrange,
  askHref,
  categoriesWith,
  categoryCounts,
  categoryFilter,
  groupByCategory,
  matchesQuery,
  monogram,
  tileColor,
} from "./connectors.ts";

const workspace = connectorsFor("workspace");
const personal = connectorsFor("personal");
const none = new Set<string>();

test("the two contexts list different connectors", () => {
  const ids = (views: typeof workspace) => new Set(views.map((view) => view.id));
  assert.ok(ids(personal).has("google-calendar"));
  assert.ok(!ids(workspace).has("google-calendar"), "a calendar is your own");
  assert.ok(ids(workspace).has("sentry"));
  assert.ok(!ids(personal).has("sentry"), "alerts are the workspace's");
  assert.ok(ids(workspace).has("github") && ids(personal).has("github"), "GitHub is both");
});

test("a category shows only its own connectors, sorted into connected, available and soon", () => {
  const found = arrange(workspace, { category: "monitoring", query: "", connected: new Set(["sentry"]) });
  assert.deepEqual(found.connected.map((view) => view.id), ["sentry"]);
  assert.ok(found.available.some((view) => view.id === "datadog"));
  assert.ok(!found.available.some((view) => view.id === "sentry"), "connected is not also available");
  assert.ok(found.soon.some((view) => view.id === "pagerduty"));
  for (const view of [...found.connected, ...found.available, ...found.soon]) assert.equal(view.category, "monitoring");
});

test("all shows everything once", () => {
  const found = arrange(workspace, { category: "all", query: "", connected: none });
  assert.equal(found.available.length + found.soon.length, workspace.length);
});

test("search finds by name, description, tag and keyword, across every category", () => {
  const found = arrange(workspace, { category: "design", query: "sentry", connected: none });
  assert.deepEqual(found.available.map((view) => view.id), ["sentry"], "a search is not held to the category");
  assert.ok(matchesQuery(personal.find((view) => view.id === "google-calendar")!, "in a meeting"));
  assert.ok(matchesQuery(workspace.find((view) => view.id === "anthropic")!, "claude"));
  assert.ok(matchesQuery(workspace.find((view) => view.id === "incident-io")!, "incidentio"));
  assert.ok(matchesQuery(workspace.find((view) => view.id === "pagerduty")!, "opens ISSUES"));
  assert.ok(!matchesQuery(workspace.find((view) => view.id === "figma")!, "kubernetes"));
});

test("the navigation counts each category and leaves out empty ones", () => {
  const counts = categoryCounts(workspace);
  assert.equal(counts.all, workspace.length);
  assert.ok(counts.ai >= 14);
  const mine = categoriesWith(personal).map((category) => category.id);
  assert.ok(mine.includes("calendar"));
  const groups = groupByCategory(personal);
  assert.equal(groups.reduce((sum, group) => sum + group.views.length, 0), personal.length);
});

test("an unknown category is all of them", () => {
  assert.equal(categoryFilter("ai"), "ai");
  assert.equal(categoryFilter("nope"), "all");
  assert.equal(categoryFilter(null), "all");
});

test("a tile has the connector's letters and a steady colour", () => {
  assert.equal(monogram("PagerDuty"), "PD");
  assert.equal(monogram("Google Calendar"), "GC");
  assert.equal(monogram("Sentry"), "S");
  assert.equal(monogram("incident.io"), "II");
  assert.equal(monogram("1Password"), "1P");
  assert.equal(tileColor("figma"), tileColor("figma"));
});

test("asking for a connector names it and who it is for", () => {
  const href = askHref({ connector: { id: "slack", name: "Slack" }, scope: "workspace", workspace: "acme", address: "hey@example.com" });
  assert.ok(href.startsWith("mailto:hey@example.com?subject=Integration%20request%3A%20Slack"));
  assert.ok(decodeURIComponent(href).includes("For the workspace: acme"));
  const mine = askHref({ connector: { id: "google-calendar", name: "Google Calendar" }, scope: "personal", workspace: null, address: "hey@example.com" });
  assert.ok(decodeURIComponent(mine).includes("For my own account."));
});
