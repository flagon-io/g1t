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
    "/explore",
    "/search",
    "/u/ada",
    "/acme",
    "/nothing/here/at/all",
  ]) {
    assert.equal(usesAppShell(path, false), true, path);
  }
});

test("a visitor gets the marketing frame on the front, pricing and sign-in pages", () => {
  for (const path of ["/", "/pricing", "/pricing/", "/login", "/register", "/verify", "/forgot", "/reset", "/device", "/oauth/authorize"]) {
    assert.equal(usesAppShell(path, false), false, path);
  }
});

test("a visitor's sidebar offers Explore and Search", () => {
  assert.deepEqual(VISITOR_LINKS.map((link) => link.to), ["/explore", "/search"]);
});

test("a project's menu hides member-only pages from everyone else", () => {
  const visitor = projectPages(false);
  assert.deepEqual(visitor.slice(0, 5), ["code", "issues", "pulls", "agents", "actions"]);
  for (const page of ["deployments", "security", "settings"] as const) {
    assert.ok(!visitor.includes(page), page);
    assert.ok(projectPages(true).includes(page), page);
  }
});
