import assert from "node:assert/strict";
import { test } from "node:test";

import type { RepoMirror } from "@g1t/contracts";

import { frameOf, hiddenOnMirror, projectPageAt, projectPages } from "./chrome.ts";

const visitor = { signedIn: false, workspace: false };
const mirror = (state: RepoMirror["state"], warm = false): RepoMirror => ({
  state,
  remote: "github.com/acme/web",
  url: "https://github.com/acme/web",
  since: "2026-10-08T10:00:00Z",
  warm,
});
const member = { signedIn: true, workspace: true };
const newcomer = { signedIn: true, workspace: false };

test("signing in, signing up and choosing a workspace stand alone, for everyone", () => {
  for (const path of [
    "/login",
    "/login/two-factor",
    "/register",
    "/register/",
    "/invite/abc123",
    "/verify",
    "/confirm-email",
    "/forgot",
    "/reset",
    "/device",
    "/oauth/authorize",
    "/auth/github/callback",
    "/auth/github/username",
    "/workspaces/new",
    "/workspaces/new.data",
  ]) {
    for (const viewer of [visitor, member, newcomer]) assert.equal(frameOf(path, viewer), "standalone", path);
  }
});

test("answering an invitation stands alone until you belong to a workspace", () => {
  assert.equal(frameOf("/invitations", newcomer), "standalone");
  assert.equal(frameOf("/invitations", member), "app");
});

test("someone signed in gets the app everywhere else, public pages included", () => {
  for (const path of ["/", "/explore", "/u/ada", "/other/web", "/acme/-/home", "/notifications", "/pricing", "/does/not/exist"]) {
    assert.equal(frameOf(path, member), "app", path);
    assert.equal(frameOf(path, newcomer), "app", path);
  }
});

test("a visitor gets the public frame everywhere else", () => {
  for (const path of ["/", "/explore", "/search", "/u/ada", "/acme", "/acme/web", "/acme/web/issues/4", "/policies/privacy", "/nothing/here/at/all"]) {
    assert.equal(frameOf(path, visitor), "public", path);
  }
  // A workspace named like a page is still a workspace, and still public to a visitor.
  assert.equal(frameOf("/loginx", visitor), "public");
});

test("a project's menu hides member-only pages from everyone else", () => {
  const visitor = projectPages(false);
  assert.deepEqual(visitor.slice(0, 4), ["code", "issues", "pulls", "actions"]);
  for (const page of ["security", "settings"] as const) {
    assert.ok(!visitor.includes(page), page);
    assert.ok(projectPages(true).includes(page), page);
  }
  // Security needs push once the role is known: Read and Triage do not see it.
  assert.ok(!projectPages(true, { push: false }).includes("security"));
  assert.ok(projectPages(true, { push: true }).includes("security"));
  // Anyone who can read a repository sees its deployments.
  assert.ok(visitor.includes("deployments") && projectPages(true).includes("deployments"));
});

test("a mirror's menu lists what it offers: a read-only copy until it is taken over", () => {
  const can = { push: true };
  const all = projectPages(true, can);
  assert.deepEqual(projectPages(true, can, null), all);
  assert.deepEqual(projectPages(true, can, mirror("takeover")), all);
  // Standing by: code, security, insights and settings. Nothing that works or runs.
  assert.deepEqual(projectPages(true, can, mirror("standby")), ["code", "security", "insights", "settings"]);
  assert.deepEqual(projectPages(false, undefined, mirror("standby")), ["code", "insights"]);
  // Workflows show when they run here: CI failover, or a standby kept warm.
  assert.deepEqual(projectPages(true, can, mirror("ci")), ["code", "actions", "security", "insights", "settings"]);
  assert.ok(projectPages(true, can, mirror("standby", true)).includes("actions"));
  assert.ok(!projectPages(true, can, mirror("handing_back", true)).includes("actions"));
  assert.ok(!projectPages(true, can, mirror("handing_back")).includes("issues"));
});

test("a page a mirror does not offer stands behind the read-only note, by its name", () => {
  const standby = mirror("standby");
  assert.deepEqual(hiddenOnMirror("issues", standby), { page: "issues", what: "issues" });
  assert.deepEqual(hiddenOnMirror("issues/new", standby), { page: "issues", what: "issues" });
  assert.deepEqual(hiddenOnMirror("pulls", standby), { page: "pulls", what: "pull requests" });
  assert.deepEqual(hiddenOnMirror("queue", standby), { page: "pulls", what: "pull requests" });
  assert.deepEqual(hiddenOnMirror("sessions", standby), { page: "pulls", what: "pull requests" });
  assert.deepEqual(hiddenOnMirror("deployments/d1", standby), { page: "deployments", what: "deployments" });
  assert.deepEqual(hiddenOnMirror("labels", standby), { page: "issues", what: "issues" });
  assert.deepEqual(hiddenOnMirror("milestones/2", standby), { page: "issues", what: "issues" });
  assert.deepEqual(hiddenOnMirror("actions", standby), { page: "actions", what: "workflows" });
  assert.deepEqual(hiddenOnMirror("releases/new", standby), { page: "code", what: "releases" });
  // What a read-only copy still shows.
  for (const path of ["", "code", "tree/main/src", "commits", "branches", "releases", "compare", "security/vulnerabilities", "contributors", "settings/mirroring", "issues/12", "pull/3/files"]) {
    assert.equal(hiddenOnMirror(path, standby), null, path);
  }
  // Workflows stay when they run here; everything stays once g1t leads.
  assert.equal(hiddenOnMirror("actions", mirror("ci")), null);
  assert.equal(hiddenOnMirror("actions", mirror("standby", true)), null);
  assert.equal(hiddenOnMirror("issues", mirror("takeover")), null);
  assert.equal(hiddenOnMirror("issues", null), null);
  assert.ok(hiddenOnMirror("pulls", mirror("handing_back")));
});

test("the phone's project strip lights the page a path is under", () => {
  assert.equal(projectPageAt(""), "overview");
  assert.equal(projectPageAt("blob/main/README.md"), "code");
  assert.equal(projectPageAt("commit/abc123"), "code");
  assert.equal(projectPageAt("issues/12"), "issues");
  assert.equal(projectPageAt("milestones"), "issues");
  assert.equal(projectPageAt("pull/3/files"), "pulls");
  assert.equal(projectPageAt("queue"), "pulls");
  assert.equal(projectPageAt("sessions/12"), "pulls");
  assert.equal(projectPageAt("memory"), "code");
  assert.equal(projectPageAt("actions/runs/9"), "actions");
  assert.equal(projectPageAt("security/secret-scanning"), "security");
  assert.equal(projectPageAt("stargazers"), "insights");
  assert.equal(projectPageAt("settings/branches"), "settings");
  assert.equal(projectPageAt("soon/uptime", { uptime: "observability" }), "observability");
  assert.equal(projectPageAt("observability/logs"), "observability");
  assert.equal(projectPageAt("pulse"), null);
});
