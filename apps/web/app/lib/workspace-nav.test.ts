import assert from "node:assert/strict";
import { test } from "node:test";

import { SETTINGS_PAGES, WORKSPACE_PAGES, pagePath, sidebarCurrent, workspacePage, workspaceRedirect } from "./workspace-nav.ts";

test("a path is one of the workspace's pages, or none", () => {
  assert.equal(workspacePage("/acme", "acme"), "overview");
  assert.equal(workspacePage("/Acme/", "acme"), "overview");
  assert.equal(workspacePage("/acme.data", "acme"), "overview");
  assert.equal(workspacePage("/acme/-/projects", "acme"), "projects");
  assert.equal(workspacePage("/acme/-/people", "acme"), "people");
  assert.equal(workspacePage("/acme/-/packages", "acme"), "packages");
  assert.equal(workspacePage("/acme/-/teams", "acme"), "teams");
  assert.equal(workspacePage("/acme/-/insights", "acme"), "insights");
  // One package or team has a page of its own; settings and the rest have headings.
  assert.equal(workspacePage("/acme/-/packages/npm/web", "acme"), null);
  assert.equal(workspacePage("/acme/-/teams/web", "acme"), null);
  assert.equal(workspacePage("/acme/-/settings", "acme"), null);
  assert.equal(workspacePage("/acme/-/agents", "acme"), null);
  assert.equal(workspacePage("/acme/web", "acme"), null);
  assert.equal(workspacePage("/other", "acme"), null);
});

test("every page that once had a tab has a sidebar row", () => {
  for (const page of ["overview", ...WORKSPACE_PAGES] as const) {
    const path = page === "overview" ? "/acme" : `/acme/-/${page}`;
    assert.equal(sidebarCurrent(path, "acme"), page, path);
  }
});

test("one sidebar row is current wherever you are in the workspace", () => {
  assert.equal(sidebarCurrent("/", "acme"), "mission");
  assert.equal(sidebarCurrent("/inbox", "acme"), "inbox");
  assert.equal(sidebarCurrent("/support", "acme"), "support");
  assert.equal(sidebarCurrent("/acme/-/projects.data", "acme"), "projects");
  // Within a team or a package, its row stays lit.
  assert.equal(sidebarCurrent("/acme/-/teams/web/settings", "acme"), "teams");
  assert.equal(sidebarCurrent("/acme/-/packages/npm/web", "acme"), "packages");
  assert.equal(sidebarCurrent("/acme/-/agents", "acme"), "agents");
  assert.equal(sidebarCurrent("/acme/-/usage", "acme"), "usage");
  // Every page the Settings row drills into.
  for (const page of SETTINGS_PAGES) assert.equal(sidebarCurrent(`/acme/-/${page}`, "acme"), "settings", page);
  // Another workspace's pages, a project and a person light nothing here.
  assert.equal(sidebarCurrent("/other/-/projects", "acme"), null);
  assert.equal(sidebarCurrent("/acme/web", "acme"), null);
  assert.equal(sidebarCurrent("/u/ada", "acme"), null);
  assert.equal(sidebarCurrent("/acme", null), null);
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

test("?tab= opens that page, keeping the rest of the query", () => {
  assert.equal(workspaceRedirect("/acme", "?tab=repositories"), "/acme/-/projects");
  assert.equal(workspaceRedirect("/acme", "?tab=projects&q=api"), "/acme/-/projects?q=api");
  assert.equal(workspaceRedirect("/acme", "?tab=members"), "/acme/-/people");
  assert.equal(workspaceRedirect("/acme", "?tab=overview"), "/acme");
  assert.equal(workspaceRedirect("/acme", "?tab=settings"), "/acme/-/settings");
  assert.equal(workspaceRedirect("/acme", "?tab=nonsense"), null);
  assert.equal(workspaceRedirect("/acme", ""), null);
});

test("a click's data request is for the same page as a full load", () => {
  assert.equal(pagePath("/acme/-/insights.data"), "/acme/-/insights");
  assert.equal(pagePath("/acme/-/insights/"), "/acme/-/insights");
  assert.equal(workspaceRedirect("/acme/-/members.data", "?_routes=routes%2Fworkspace%2Fmoved-members"), "/acme/-/people");
  assert.equal(workspaceRedirect("/acme/-/members.data", "?_routes=x&q=ada"), "/acme/-/people?q=ada");
});
