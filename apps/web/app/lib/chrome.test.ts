import assert from "node:assert/strict";
import { test } from "node:test";

import { VISITOR_LINKS, projectPages, usesAppShell } from "./chrome.ts";

test("someone signed in always gets the sidebar", () => {
  for (const path of ["/", "/pricing", "/acme/web", "/explore", "/does/not/exist"]) {
    assert.equal(usesAppShell(path, true), true, path);
  }
});

test("a visitor gets the sidebar on app pages", () => {
  for (const path of [
    "/acme/web",
    "/acme/web/code",
    "/acme/web/issues/4",
    "/acme",
    "/nothing/here/at/all",
  ]) {
    assert.equal(usesAppShell(path, false), true, path);
  }
});

test("a visitor gets the marketing frame on the front, pricing and sign-in pages", () => {
  for (const path of ["/", "/pricing", "/pricing/", "/login", "/register", "/verify", "/confirm-email", "/forgot", "/reset", "/device", "/oauth/authorize"]) {
    assert.equal(usesAppShell(path, false), false, path);
  }
});

test("a visitor reads profiles, Explore and Search in the public frame, with no sidebar", () => {
  for (const path of ["/u/ada", "/u/ada/", "/explore", "/explore/", "/search"]) {
    assert.equal(usesAppShell(path, false), false, path);
  }
  // A workspace named like a page is still a workspace.
  assert.equal(usesAppShell("/u", false), true);
  assert.equal(usesAppShell("/explorers", false), true);
});

test("a visitor reads the policies, security, support and status in the marketing frame", () => {
  for (const path of ["/policies", "/policies/terms", "/policies/privacy/", "/security", "/support", "/status"]) {
    assert.equal(usesAppShell(path, false), false, path);
  }
  // A workspace's own security page is still the app's.
  assert.equal(usesAppShell("/acme/-/security", false), true);
});

test("a visitor's sidebar offers Explore and Search", () => {
  assert.deepEqual(VISITOR_LINKS.map((link) => link.to), ["/explore", "/search"]);
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
