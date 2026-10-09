import assert from "node:assert/strict";
import { test } from "node:test";

import { SETTINGS_PAGES, WORKSPACE_PAGES, pagePath, sidebarCurrent, underWorkspace, workspacePage, workspaceRedirect } from "./workspace-nav.ts";

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
  // Code's Overview lives at -/overview now: not an old address.
  assert.equal(workspaceRedirect("/acme/-/overview"), null);
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

test("an alias or old name leads to the same page under the workspace", () => {
  assert.equal(underWorkspace("/g1t", "", "flagon-io"), "/flagon-io");
  assert.equal(underWorkspace("/g1t/g1t/issues", "?q=is%3Aopen", "flagon-io"), "/flagon-io/g1t/issues?q=is%3Aopen");
  assert.equal(underWorkspace("/g1t/g1t/blob/main/README.md", "", "flagon-io"), "/flagon-io/g1t/blob/main/README.md");
  assert.equal(underWorkspace("/g1t/-/people/", "", "flagon-io"), "/flagon-io/-/people");
});

test("a click's data request for an alias leads to the page, not its data", () => {
  assert.equal(underWorkspace("/g1t.data", "?_routes=routes%2Fworkspace%2Flayout", "flagon-io"), "/flagon-io");
  assert.equal(
    underWorkspace("/g1t/g1t/pulls.data", "?_routes=routes%2Frepo%2Flayout&state=closed", "flagon-io"),
    "/flagon-io/g1t/pulls?state=closed",
  );
});

test("the rail's mode follows the address", async () => {
  const { modeOf, modeHome, homePath } = await import("./workspace-nav.ts");
  assert.equal(modeOf("/", "acme"), "home");
  assert.equal(modeOf("/acme", "acme"), "home");
  assert.equal(modeOf("/acme/-/home", "acme"), "home");
  assert.equal(modeOf("/explore", "acme"), "home");
  assert.equal(modeOf("/inbox", "acme"), "inbox");
  assert.equal(modeOf("/settings/emails", "acme"), "account");
  assert.equal(modeOf("/acme/-/chat/general", "acme"), "chat");
  assert.equal(modeOf("/acme/-/chat/dm/c1.data", "acme"), "chat");
  assert.equal(modeOf("/acme/-/agents", "acme"), "agents");
  assert.equal(modeOf("/acme/-/agents/ship/profile", "acme"), "agents");
  assert.equal(modeOf("/acme/-/context", "acme"), "agents");
  assert.equal(modeOf("/acme/-/memory", "acme"), "agents");
  assert.equal(modeOf("/acme/-/docs", "acme"), "docs");
  assert.equal(modeOf("/acme/-/overview", "acme"), "code");
  assert.equal(modeOf("/acme/-/projects", "acme"), "code");
  assert.equal(modeOf("/acme/-/security", "acme"), "code");
  assert.equal(modeOf("/acme/-/security/settings", "acme"), "workspace");
  assert.equal(modeOf("/acme/-/people", "acme"), "workspace");
  assert.equal(modeOf("/acme/-/billing", "acme"), "workspace");
  assert.equal(modeOf("/acme/-/tokens", "acme"), "workspace");
  assert.equal(modeOf("/acme/-/workspace", "acme"), "workspace");
  assert.equal(modeOf("/acme/web/pulls", "acme"), "code");
  assert.equal(modeOf("/new", "acme"), "code");
  // Another workspace's chat is not this one's mode; its repositories are Code's.
  assert.equal(modeOf("/other/-/chat", "acme"), "code");
  assert.equal(modeHome("home", "acme"), "/acme/-/home");
  assert.equal(modeHome("code", "acme"), "/acme/-/overview");
  assert.equal(modeHome("workspace", "acme"), "/acme/-/workspace");
  assert.equal(homePath("acme"), "/acme/-/home");
  assert.equal(homePath("acme", "?agent=new"), "/acme/-/overview?agent=new");
  assert.equal(homePath("acme", "?tab=landed&_routes=x"), "/acme/-/overview?tab=landed");
});

test("a member without Code access is sent around Code's pages", async () => {
  const { codeGate } = await import("./workspace-nav.ts");
  const none = ["acme"];
  assert.equal(codeGate("/", "", none, "acme"), "/acme/-/home");
  assert.equal(codeGate("/", "", none, "other"), null);
  assert.equal(codeGate("/acme", "", none, "acme"), "/acme/-/home");
  assert.equal(codeGate("/acme/web/pull/3", "?x=1", none, "acme"), "/acme/-/code-access?from=%2Facme%2Fweb%2Fpull%2F3%3Fx%3D1");
  assert.equal(codeGate("/acme/-/projects", "", none, "acme"), "/acme/-/code-access?from=%2Facme%2F-%2Fprojects");
  assert.equal(codeGate("/acme/-/chat/general", "", none, "acme"), null);
  assert.equal(codeGate("/acme/-/code-access", "", none, "acme"), null);
  assert.equal(codeGate("/other/web", "", none, "acme"), null);
  assert.equal(codeGate("/acme/web", "", [], "acme"), null);
});
