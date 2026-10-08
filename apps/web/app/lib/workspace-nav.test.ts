import assert from "node:assert/strict";
import { test } from "node:test";

import { pagePath, workspaceRedirect, workspaceTab, workspaceTabs } from "./workspace-nav.ts";

test("everyone sees Overview, Projects and Packages; members and owners see more", () => {
  const keys = (member: boolean, owner: boolean) => workspaceTabs("acme", { member, owner }).map((tab) => tab.key);
  assert.deepEqual(keys(false, false), ["overview", "projects", "packages"]);
  assert.deepEqual(keys(true, false), ["overview", "projects", "packages", "teams", "people", "insights"]);
  assert.deepEqual(keys(true, true), ["overview", "projects", "packages", "teams", "people", "insights", "settings"]);
});

test("tabs carry counts, and say which are coming", () => {
  const tabs = workspaceTabs("acme", { member: true, owner: false, projects: 412, people: 7 });
  assert.equal(tabs.find((tab) => tab.key === "projects")?.count, 412);
  assert.equal(tabs.find((tab) => tab.key === "people")?.count, 7);
  assert.equal(tabs.find((tab) => tab.key === "teams")?.soon, undefined);
  assert.equal(tabs.find((tab) => tab.key === "insights")?.soon, true);
  assert.equal(tabs.find((tab) => tab.key === "overview")?.to, "/acme");
  assert.equal(tabs.find((tab) => tab.key === "projects")?.to, "/acme/-/projects");
});

test("a path is a tab, or one of the workspace's other pages", () => {
  assert.equal(workspaceTab("/acme", "acme"), "overview");
  assert.equal(workspaceTab("/Acme/", "acme"), "overview");
  assert.equal(workspaceTab("/acme/-/projects", "acme"), "projects");
  assert.equal(workspaceTab("/acme/-/people", "acme"), "people");
  assert.equal(workspaceTab("/acme/-/packages", "acme"), "packages");
  // One package has a page of its own; settings and the rest have headings.
  assert.equal(workspaceTab("/acme/-/packages/npm/web", "acme"), null);
  assert.equal(workspaceTab("/acme/-/settings", "acme"), null);
  assert.equal(workspaceTab("/acme/-/agents", "acme"), null);
  assert.equal(workspaceTab("/acme/web", "acme"), null);
  assert.equal(workspaceTab("/other", "acme"), null);
});

test("old addresses go to where their pages are now", () => {
  assert.equal(workspaceRedirect("/acme/-/members"), "/acme/-/people");
  assert.equal(workspaceRedirect("/acme/-/overview"), "/acme");
  assert.equal(workspaceRedirect("/acme/-/soon/teams"), "/acme/-/teams");
  assert.equal(workspaceRedirect("/acme/-/soon/insights", "?x=1"), "/acme/-/insights?x=1");
  assert.equal(workspaceRedirect("/acme/-/soon/board"), null);
  assert.equal(workspaceRedirect("/acme/-/people"), null);
  assert.equal(workspaceRedirect("/acme/web"), null);
});

test("?tab= opens that tab, keeping the rest of the query", () => {
  assert.equal(workspaceRedirect("/acme", "?tab=repositories"), "/acme/-/projects");
  assert.equal(workspaceRedirect("/acme", "?tab=projects&q=api"), "/acme/-/projects?q=api");
  assert.equal(workspaceRedirect("/acme", "?tab=members"), "/acme/-/people");
  assert.equal(workspaceRedirect("/acme", "?tab=overview"), "/acme");
  assert.equal(workspaceRedirect("/acme", "?tab=nonsense"), null);
  assert.equal(workspaceRedirect("/acme", ""), null);
});

test("a click's data request is for the same page as a full load", () => {
  assert.equal(pagePath("/acme/-/insights.data"), "/acme/-/insights");
  assert.equal(pagePath("/acme/-/insights/"), "/acme/-/insights");
  assert.equal(workspaceRedirect("/acme/-/members.data", "?_routes=routes%2Fworkspace%2Fmoved-members"), "/acme/-/people");
  assert.equal(workspaceRedirect("/acme/-/members.data", "?_routes=x&q=ada"), "/acme/-/people?q=ada");
});
