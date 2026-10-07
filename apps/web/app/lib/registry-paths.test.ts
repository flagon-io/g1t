import assert from "node:assert/strict";
import { test } from "node:test";

import { servicePath } from "./registry-paths.ts";

test("the container registry's paths go to the packages service", () => {
  for (const path of [
    "/v2",
    "/v2/",
    "/v2/token",
    "/v2/acme/web/manifests/latest",
    "/v2/acme/web/api/blobs/uploads/upl_1",
    "/v2/acme/web/tags/list",
    "/v2/acme/web/referrers/sha256:abc",
  ]) {
    assert.equal(servicePath(path), "packages", path);
  }
});

test("the npm registry's paths go to the packages service", () => {
  for (const path of [
    "/-/npm",
    "/-/npm/",
    "/-/npm/@acme%2fweb",
    "/-/npm/@acme/web/-/web-1.0.0.tgz",
    "/-/npm/-/package/@acme%2fweb/dist-tags/next",
    "/-/npm/-/whoami",
    // A package named like a git endpoint is still npm's.
    "/-/npm/@acme/info/refs",
  ]) {
    assert.equal(servicePath(path), "packages", path);
  }
  for (const path of ["/-/npmx", "/acme/-/npm", "/acme/-/packages"]) {
    assert.equal(servicePath(path), null, path);
  }
});

test("the Composer registries go to the packages service", () => {
  for (const path of [
    "/-/composer/acme/packages.json",
    "/-/composer/acme/p2/acme/lib.json",
    "/-/composer/acme/p2/acme/lib~dev.json",
    `/-/composer/acme/dist/acme/lib/${"a".repeat(40)}.zip`,
  ]) {
    assert.equal(servicePath(path), "packages", path);
  }
  assert.equal(servicePath("/-/composer"), null);
});

test("the Cargo registries go to the packages service", () => {
  for (const path of [
    "/-/cargo/acme/index/config.json",
    "/-/cargo/acme/index/se/rd/serde",
    "/-/cargo/acme/index/3/a/abc",
    "/-/cargo/acme/api/v1/crates/new",
    "/-/cargo/acme/api/v1/crates/serde/1.0.0/download",
    "/-/cargo/acme/api/v1/crates/serde/1.0.0/yank",
    // A crate named like a git endpoint is still Cargo's.
    "/-/cargo/acme/index/in/fo/info/refs",
  ]) {
    assert.equal(servicePath(path), "packages", path);
  }
  assert.equal(servicePath("/-/cargo"), null);
  assert.equal(servicePath("/acme/-/cargo/x"), null);
});

test("git goes to repos, and everything else is the site's", () => {
  assert.equal(servicePath("/acme/web.git/info/refs"), "git");
  assert.equal(servicePath("/acme/web/git-receive-pack"), "git");
  // A registry image named like a git endpoint is still the registry's.
  assert.equal(servicePath("/v2/acme/info/refs"), "packages");
  for (const path of ["/", "/acme", "/acme/web", "/v2x", "/acme/v2", "/acme/-/packages"]) {
    assert.equal(servicePath(path), null, path);
  }
});
