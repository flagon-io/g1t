import assert from "node:assert/strict";
import { test } from "node:test";

import { frameOf, projectPageAt, projectPages } from "./chrome.ts";

const visitor = { signedIn: false, workspace: false };
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
  for (const path of ["/", "/explore", "/u/ada", "/other/web", "/acme/-/today", "/notifications", "/pricing", "/does/not/exist"]) {
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
  assert.deepEqual(visitor.slice(0, 5), ["code", "issues", "pulls", "agents", "actions"]);
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

test("the phone's project strip lights the page a path is under", () => {
  assert.equal(projectPageAt(""), "overview");
  assert.equal(projectPageAt("blob/main/README.md"), "code");
  assert.equal(projectPageAt("commit/abc123"), "code");
  assert.equal(projectPageAt("issues/12"), "issues");
  assert.equal(projectPageAt("milestones"), "issues");
  assert.equal(projectPageAt("pull/3/files"), "pulls");
  assert.equal(projectPageAt("queue"), "pulls");
  assert.equal(projectPageAt("sessions/abc"), "agents");
  assert.equal(projectPageAt("actions/runs/9"), "actions");
  assert.equal(projectPageAt("security/secret-scanning"), "security");
  assert.equal(projectPageAt("stargazers"), "insights");
  assert.equal(projectPageAt("settings/branches"), "settings");
  assert.equal(projectPageAt("soon/logs", { logs: "observability" }), "observability");
  assert.equal(projectPageAt("soon/boards", { boards: "issues" }), "issues");
  assert.equal(projectPageAt("pulse"), null);
});
