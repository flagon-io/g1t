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

test("git goes to repos, and everything else is the site's", () => {
  assert.equal(servicePath("/acme/web.git/info/refs"), "git");
  assert.equal(servicePath("/acme/web/git-receive-pack"), "git");
  // A registry image named like a git endpoint is still the registry's.
  assert.equal(servicePath("/v2/acme/info/refs"), "packages");
  for (const path of ["/", "/acme", "/acme/web", "/v2x", "/acme/v2", "/acme/-/packages"]) {
    assert.equal(servicePath(path), null, path);
  }
});
