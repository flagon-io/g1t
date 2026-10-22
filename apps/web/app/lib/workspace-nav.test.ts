import assert from "node:assert/strict";
import { test } from "node:test";

import { movedCodePath, pagePath, repositoriesPath, underWorkspace, workspacePage, workspaceRedirect } from "./workspace-nav.ts";

test("a path is one of the workspace's pages, or none", () => {
  assert.equal(workspacePage("/acme", "acme"), "overview");
  assert.equal(workspacePage("/Acme/", "acme"), "overview");
  assert.equal(workspacePage("/acme.data", "acme"), "overview");
  assert.equal(workspacePage("/acme/-/code/repositories", "acme"), "code/repositories");
  assert.equal(workspacePage("/acme/-/projects", "acme"), null);
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

test("old addresses go to where their pages are now", () => {
  // Members and invites is a page of People's again.
  assert.equal(workspaceRedirect("/acme/-/members"), null);
  assert.equal(workspaceRedirect("/acme/-/today", "?x=1"), "/acme/-/home?x=1");
  // Home is the front page itself: not an old address.
  assert.equal(workspaceRedirect("/acme/-/home"), null);
  // Code's Overview lives at -/overview now: not an old address.
  assert.equal(workspaceRedirect("/acme/-/overview"), null);
  assert.equal(workspaceRedirect("/acme/-/soon/teams"), "/acme/-/teams");
  // The Marketplace, Customize and Agents are gone: their old addresses lead nowhere.
  assert.equal(workspaceRedirect("/acme/-/marketplace/agents"), null);
  assert.equal(workspaceRedirect("/acme/-/marketplace/extensions"), null);
  assert.equal(workspaceRedirect("/acme/-/agents/skills"), null);
  assert.equal(workspaceRedirect("/acme/-/soon/insights", "?x=1"), "/acme/-/insights?x=1");
  assert.equal(workspaceRedirect("/acme/-/soon/uptime"), null);
  assert.equal(workspaceRedirect("/acme/-/people"), null);
  assert.equal(workspaceRedirect("/acme/web"), null);
});

test("Code's Repositories are at -/code/repositories, and its old Projects address goes there, query and all", () => {
  assert.equal(repositoriesPath("acme"), "/acme/-/code/repositories");
  assert.equal(repositoriesPath("acme", "q=api&sort=name"), "/acme/-/code/repositories?q=api&sort=name");
  assert.equal(movedCodePath("/acme/-/projects"), "/acme/-/code/repositories");
  assert.equal(movedCodePath("/acme/-/projects/", "?q=api&kind=app"), "/acme/-/code/repositories?q=api&kind=app");
  assert.equal(movedCodePath("/acme/-/projects.data", "?q=api&_routes=x"), "/acme/-/code/repositories?q=api");
  assert.equal(movedCodePath("/acme/-/work/projects"), null);
  assert.equal(movedCodePath("/acme/projects"), null);
});

test("?tab= opens that page, keeping the rest of the query", () => {
  assert.equal(workspaceRedirect("/acme", "?tab=repositories"), "/acme/-/code/repositories");
  assert.equal(workspaceRedirect("/acme", "?tab=projects&q=api"), "/acme/-/code/repositories?q=api");
  assert.equal(workspaceRedirect("/acme", "?tab=members"), "/acme/-/members");
  assert.equal(workspaceRedirect("/acme", "?tab=people"), "/acme/-/people");
  assert.equal(workspaceRedirect("/acme", "?tab=overview"), "/acme");
  assert.equal(workspaceRedirect("/acme", "?tab=settings"), "/acme/-/settings/profile");
  assert.equal(workspaceRedirect("/acme", "?tab=nonsense"), null);
  assert.equal(workspaceRedirect("/acme", ""), null);
});

test("a click's data request is for the same page as a full load", () => {
  assert.equal(pagePath("/acme/-/insights.data"), "/acme/-/insights");
  assert.equal(pagePath("/acme/-/insights/"), "/acme/-/insights");
  assert.equal(workspaceRedirect("/acme/-/today.data", "?_routes=routes%2Fworkspace%2Fmoved-today"), "/acme/-/home");
  assert.equal(workspaceRedirect("/acme/-/today.data", "?_routes=x&q=ada"), "/acme/-/home?q=ada");
});

test("an alias or old name leads to the same page under the workspace", () => {
  assert.equal(underWorkspace("/g1t", "", "flagon-io"), "/flagon-io");
  assert.equal(underWorkspace("/g1t/g1t/issues", "?q=is%3Aopen", "flagon-io"), "/flagon-io/g1t/issues?q=is%3Aopen");
  assert.equal(underWorkspace("/g1t/g1t/blob/main/README.md", "", "flagon-io"), "/flagon-io/g1t/blob/main/README.md");
  assert.equal(underWorkspace("/g1t/-/people/", "", "flagon-io"), "/flagon-io/-/people");
});

test("a click's data request for an alias leads to the page, not its data", () => {
  assert.equal(underWorkspace("/g1t.data", "?_routes=routes%2Fworkspace%2Flayout", "flagon-io"), "/flagon-io");
  assert.equal(underWorkspace("/g1t/g1t/pulls.data", "?_routes=routes%2Frepo%2Flayout&state=closed", "flagon-io"), "/flagon-io/g1t/pulls?state=closed");
});

test("the rail's mode follows the address", async () => {
  const { modeOf, modeHome, homePath } = await import("./workspace-nav.ts");
  assert.equal(modeOf("/", "acme"), "home");
  // The workspace's own page is Code's front page.
  assert.equal(modeOf("/acme", "acme"), "code");
  assert.equal(modeOf("/acme/-/home", "acme"), "home");
  // g1t's own public pages light no mode.
  assert.equal(modeOf("/explore", "acme"), "site");
  assert.equal(modeOf("/u/ada", "acme"), "site");
  assert.equal(modeOf("/search.data", "acme"), "site");
  assert.equal(modeOf("/notifications", "acme"), "notifications");
  assert.equal(modeOf("/settings/emails", "acme"), "account");
  assert.equal(modeOf("/acme/-/chat/general", "acme"), "chat");
  assert.equal(modeOf("/acme/-/chat/dm/c1.data", "acme"), "chat");
  // Agents mode and Memory are gone: their old addresses fall to Code's not-found page.
  assert.equal(modeOf("/acme/-/agents", "acme"), "code");
  assert.equal(modeOf("/acme/-/memory", "acme"), "code");
  assert.equal(modeOf("/acme/-/library/artifacts", "acme"), "artifacts");
  assert.equal(modeOf("/acme/-/library/artifacts/spaces/general", "acme"), "artifacts");
  assert.equal(modeOf("/acme/-/routines", "acme"), "routines");
  // Docs mode is gone: its old addresses are nobody's mode, so they fall to Code's not-found page.
  assert.equal(modeOf("/acme/-/docs", "acme"), "code");
  assert.equal(modeOf("/acme/-/overview", "acme"), "code");
  assert.equal(modeOf("/acme/-/projects", "acme"), "code");
  assert.equal(modeOf("/acme/-/code/repositories", "acme"), "code");
  assert.equal(modeOf("/acme/-/security", "acme"), "code");
  assert.equal(modeOf("/acme/-/settings/security", "acme"), "workspace");
  assert.equal(modeOf("/acme/-/people", "acme"), "people");
  assert.equal(modeOf("/acme/-/teams/web", "acme"), "people");
  assert.equal(modeOf("/acme/-/people/ana", "acme"), "people");
  // Members, invitations and permissions are the workspace's settings.
  assert.equal(modeOf("/acme/-/settings/members", "acme"), "workspace");
  assert.equal(modeOf("/acme/-/settings/members/invitations", "acme"), "workspace");
  assert.equal(modeOf("/acme/-/settings/permissions", "acme"), "workspace");
  assert.equal(modeOf("/acme/-/apps", "acme"), "apps");
  assert.equal(modeOf("/acme/-/settings/billing", "acme"), "workspace");
  assert.equal(modeOf("/acme/-/settings/tokens", "acme"), "workspace");
  assert.equal(modeOf("/acme/-/settings/profile", "acme"), "workspace");
  assert.equal(modeOf("/acme/web/pulls", "acme"), "code");
  assert.equal(modeOf("/new", "acme"), "code");
  // Another workspace's chat is Chat (a guest in its channels); its repositories are Code's.
  assert.equal(modeOf("/other/-/chat", "acme"), "chat");
  assert.equal(modeOf("/other/web", "acme"), "code");
  assert.equal(modeHome("home", "acme"), "/acme/-/home");
  assert.equal(modeHome("notifications", "acme"), "/notifications");
  assert.equal(modeHome("people", "acme"), "/acme/-/people");
  assert.equal(modeHome("apps", "acme"), "/acme/-/apps");
  assert.equal(modeHome("code", "acme"), "/acme");
  assert.equal(modeHome("workspace", "acme"), "/acme/-/settings/profile");
  assert.equal(homePath("acme"), "/acme/-/home");
  assert.equal(homePath("acme", "?tab=landed&_routes=x"), "/acme/-/home");
});

test("Workspace mode's sidebar knows which group and page an address is", async () => {
  const { WORKSPACE_SETTINGS_GROUPS, modeOf, workspaceSettingsPage } = await import("./workspace-nav.ts");
  const at = (group: string, page: string, parent = page) => ({ group, page, parent });
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/profile", "acme"), at("profile", "profile"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/chat", "acme"), at("automation", "chat-settings"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/emoji", "acme"), at("automation", "emoji", "chat-settings"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/work", "acme"), at("automation", "work-settings"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/members", "acme"), at("access", "members"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/members/invitations.data", "acme"), at("access", "invitations", "members"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/permissions", "acme"), at("access", "permissions"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/rules/rs_1", "acme"), at("automation", "rules", "repositories"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/security", "acme"), at("security", "security-settings"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/sso", "acme"), at("security", "sso", "authentication"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/usage", "acme"), at("access", "usage", "billing"));
  assert.deepEqual(workspaceSettingsPage("/acme/-/settings/billing/entries", "acme"), at("access", "billing"));
  // The overview, Code's security page, an old address and another workspace are no settings page.
  assert.equal(workspaceSettingsPage("/acme/-/overview", "acme"), null);
  assert.equal(workspaceSettingsPage("/acme/-/security", "acme"), null);
  assert.equal(workspaceSettingsPage("/acme/-/members", "acme"), null);
  assert.equal(workspaceSettingsPage("/other/-/settings/profile", "acme"), null);
  // Every real page is in Workspace mode, under `-/settings/`, and every key is unique.
  const keys = new Set<string>();
  for (const group of WORKSPACE_SETTINGS_GROUPS) {
    for (const page of group.pages.flatMap((top) => [top, ...(top.pages ?? [])])) {
      assert.ok(!keys.has(page.key), `${page.key} twice`);
      keys.add(page.key);
      assert.ok(page.path.startsWith("settings/"), page.path);
      // Integrations are Apps's, beside the settings' sidebar.
      assert.equal(modeOf(`/acme/-/${page.path}`, "acme"), page.key === "integrations" ? "apps" : "workspace", page.path);
    }
  }
});

test("a member without Code access is sent around Code's pages", async () => {
  const { codeGate } = await import("./workspace-nav.ts");
  const none = ["acme"];
  assert.equal(codeGate("/", "", none, "acme"), "/acme/-/home");
  assert.equal(codeGate("/", "", none, "other"), null);
  assert.equal(codeGate("/acme", "", none, "acme"), "/acme/-/home");
  assert.equal(codeGate("/acme/web/pull/3", "?x=1", none, "acme"), "/acme/-/code-access?from=%2Facme%2Fweb%2Fpull%2F3%3Fx%3D1");
  assert.equal(codeGate("/acme/-/projects", "", none, "acme"), "/acme/-/code-access?from=%2Facme%2F-%2Fprojects");
  assert.equal(codeGate("/acme/-/code/repositories", "", none, "acme"), "/acme/-/code-access?from=%2Facme%2F-%2Fcode%2Frepositories");
  assert.equal(codeGate("/acme/-/chat/general", "", none, "acme"), null);
  assert.equal(codeGate("/acme/-/code-access", "", none, "acme"), null);
  // The settings of Code's parts are closed with them; the rest of the settings are not.
  assert.equal(codeGate("/acme/-/settings/rules/rs_1", "", none, "acme"), "/acme/-/code-access?from=%2Facme%2F-%2Fsettings%2Frules%2Frs_1");
  assert.equal(codeGate("/acme/-/settings/actions", "", none, "acme"), "/acme/-/code-access?from=%2Facme%2F-%2Fsettings%2Factions");
  assert.equal(codeGate("/acme/-/settings/members", "", none, "acme"), null);
  assert.equal(codeGate("/acme/-/settings/profile", "", none, "acme"), null);
  assert.equal(codeGate("/other/web", "", none, "acme"), null);
  assert.equal(codeGate("/acme/web", "", [], "acme"), null);
  // Work is every member's: its pages, and a repository's old issue, label
  // and milestone addresses and `#12` links, which lead there.
  assert.equal(codeGate("/acme/-/work", "", none, "acme"), null);
  assert.equal(codeGate("/acme/-/work/12", "", none, "acme"), null);
  assert.equal(codeGate("/acme/-/work/labels", "", none, "acme"), null);
  assert.equal(codeGate("/acme/web/issues/12", "", none, "acme"), null);
  assert.equal(codeGate("/acme/web/issues", "", none, "acme"), null);
  assert.equal(codeGate("/acme/web/milestones/2", "", none, "acme"), null);
  assert.equal(codeGate("/acme/web/ref/12", "", none, "acme"), null);
  // A repository's Sessions page is Code's.
  assert.equal(codeGate("/acme/web/sessions", "", none, "acme"), "/acme/-/code-access?from=%2Facme%2Fweb%2Fsessions");
});

test("Work is a mode of its own, after Home", async () => {
  const { modeOf, modeHome } = await import("./workspace-nav.ts");
  assert.equal(modeOf("/acme/-/work", "acme"), "work");
  assert.equal(modeOf("/acme/-/work.data", "acme"), "work");
  assert.equal(modeOf("/acme/-/work/12", "acme"), "work");
  assert.equal(modeOf("/acme/-/work/new", "acme"), "work");
  assert.equal(modeOf("/acme/-/work/labels", "acme"), "work");
  assert.equal(modeOf("/acme/-/work/milestones/3", "acme"), "work");
  // Sessions are Work's: its list and each session light Work.
  assert.equal(modeOf("/acme/-/work/sessions", "acme"), "work");
  assert.equal(modeOf("/acme/-/work/sessions/ses_1.data", "acme"), "work");
  // Sessions are Chat's now, beside the people you talk to.
  assert.equal(modeOf("/acme/-/chat/sessions", "acme"), "chat");
  assert.equal(modeOf("/acme/-/chat/sessions/ses_1", "acme"), "chat");
  assert.equal(modeOf("/acme/-/library/artifacts", "acme"), "artifacts");
  assert.equal(modeOf("/acme/-/library", "acme"), "artifacts");
  // Their old address is no page of its own any more, so it falls to Code's not-found page.
  assert.equal(modeOf("/acme/-/sessions", "acme"), "code");
  assert.equal(modeHome("work", "acme"), "/acme/-/work");
  // A repository's pages, its Sessions among them, are Code's.
  assert.equal(modeOf("/acme/web/sessions", "acme"), "code");
});

test("g1t beyond your workspaces is browsed, and whose it is", async () => {
  const { browsingOf, shellMode } = await import("./workspace-nav.ts");
  const viewer = { slug: "acme", memberships: ["acme", "Side-Co"], shared: [{ namespace: "friend", name: "notes" }], username: "ada" };
  // Explore and search are nobody's.
  assert.deepEqual(browsingOf("/explore", viewer), { owner: null });
  assert.deepEqual(browsingOf("/explore.data", viewer), { owner: null });
  assert.deepEqual(browsingOf("/search", viewer), { owner: null });
  // Someone's profile is theirs; your own is no one's being browsed.
  assert.deepEqual(browsingOf("/u/grace", viewer), { owner: { kind: "person", name: "grace" } });
  assert.deepEqual(browsingOf("/u/Ada", viewer), { owner: null });
  // Another workspace, its pages and its projects.
  assert.deepEqual(browsingOf("/other", viewer), { owner: { kind: "workspace", name: "other", repo: null } });
  assert.deepEqual(browsingOf("/other/-/projects", viewer), { owner: { kind: "workspace", name: "other", repo: null } });
  assert.deepEqual(browsingOf("/other/site/pulls/3", viewer), { owner: { kind: "workspace", name: "other", repo: "site" } });
  // Your workspaces are never browsed, the one you are in or another (the shell switches to it).
  assert.equal(browsingOf("/acme/web", viewer), null);
  assert.equal(browsingOf("/acme/-/projects", viewer), null);
  assert.equal(browsingOf("/side-co/api", viewer), null);
  // A project shared with you is Code's; the rest of its workspace is browsed.
  assert.equal(browsingOf("/friend/notes/issues", viewer), null);
  assert.deepEqual(browsingOf("/friend/other", viewer), { owner: { kind: "workspace", name: "friend", repo: "other" } });
  // g1t's own pages and files are no one's.
  for (const path of [
    "/",
    "/settings/emails",
    "/notifications",
    "/new",
    "/policies/terms",
    "/workspaces/new",
    "/invitations",
    "/robots.txt",
    "/.well-known/g1t.json",
    "/u",
  ]) {
    assert.equal(browsingOf(path, viewer), null, path);
  }
  // Without a workspace there is no rail, and nothing is browsed.
  assert.equal(browsingOf("/explore", { slug: null, memberships: [] }), null);
  // The shell's mode: browse beyond your workspaces, the address's mode otherwise.
  assert.equal(shellMode("/explore", viewer), "browse");
  assert.equal(shellMode("/u/grace", viewer), "browse");
  assert.equal(shellMode("/other/site", viewer), "browse");
  assert.equal(shellMode("/acme/web", viewer), "code");
  assert.equal(shellMode("/friend/notes", viewer), "code");
  assert.equal(shellMode("/acme/-/chat", viewer), "chat");
  // Another workspace's channels, where you are a guest, are Chat's, not browsed.
  assert.equal(browsingOf("/flagon-io/-/chat/community-support", viewer), null);
  assert.equal(shellMode("/flagon-io/-/chat/community-support", viewer), "chat");
  assert.equal(shellMode("/flagon-io/-/chat", viewer), "chat");
  assert.equal(shellMode("/policies", viewer), "site");
});
