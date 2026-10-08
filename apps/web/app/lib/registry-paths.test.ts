import assert from "node:assert/strict";
import { test } from "node:test";

import { registryWorkspace, servicePath } from "./registry-paths.ts";

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

test("the Maven repositories go to the packages service", () => {
  for (const path of [
    "/-/maven/acme/com/acme/web/maven-metadata.xml",
    "/-/maven/acme/com/acme/web/maven-metadata.xml.sha1",
    "/-/maven/acme/com/acme/web/1.0.0/web-1.0.0.jar",
    "/-/maven/acme/com/acme/web/1.0-SNAPSHOT/web-1.0-20261006.120000-1.pom",
    // An artifact named like a git endpoint is still Maven's.
    "/-/maven/acme/com/acme/info/refs",
  ]) {
    assert.equal(servicePath(path), "packages", path);
  }
  assert.equal(servicePath("/-/maven"), null);
  assert.equal(servicePath("/acme/-/maven/x"), null);
});

test("the NuGet feeds go to the packages service", () => {
  for (const path of [
    "/-/nuget/acme/v3/index.json",
    "/-/nuget/acme/v3/flatcontainer/acme.web/index.json",
    "/-/nuget/acme/v3/flatcontainer/acme.web/1.0.0/acme.web.1.0.0.nupkg",
    "/-/nuget/acme/v3/registration/acme.web/index.json",
    "/-/nuget/acme/v3/query",
    "/-/nuget/acme/api/v2/package",
    "/-/nuget/acme/api/v2/package/Acme.Web/1.0.0",
  ]) {
    assert.equal(servicePath(path), "packages", path);
  }
  assert.equal(servicePath("/-/nuget"), null);
  assert.equal(servicePath("/acme/-/nuget/x"), null);
});

test("the RubyGems registries go to the packages service", () => {
  for (const path of [
    "/-/rubygems/acme/versions",
    "/-/rubygems/acme/info/hello",
    "/-/rubygems/acme/names",
    "/-/rubygems/acme/gems/hello-0.1.0.gem",
    "/-/rubygems/acme/api/v1/gems",
    "/-/rubygems/acme/api/v1/gems/yank",
  ]) {
    assert.equal(servicePath(path), "packages", path);
  }
  assert.equal(servicePath("/-/rubygems"), null);
  assert.equal(servicePath("/acme/-/rubygems/x"), null);
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

test("a registry request names its workspace, and can be moved to another", () => {
  const cases: [string, string, string][] = [
    ["/-/cargo/g1t/index/config.json", "g1t", "/-/cargo/flagon-io/index/config.json"],
    ["/-/composer/g1t/packages.json", "g1t", "/-/composer/flagon-io/packages.json"],
    ["/-/maven/g1t/io/flagon/sdk/1.0/sdk-1.0.jar", "g1t", "/-/maven/flagon-io/io/flagon/sdk/1.0/sdk-1.0.jar"],
    ["/-/nuget/g1t/v3/index.json", "g1t", "/-/nuget/flagon-io/v3/index.json"],
    ["/-/rubygems/g1t/info/sdk", "g1t", "/-/rubygems/flagon-io/info/sdk"],
    ["/-/npm/@g1t%2fcli", "g1t", "/-/npm/@flagon-io%2fcli"],
    ["/-/npm/@g1t/cli/-/cli-1.0.0.tgz", "g1t", "/-/npm/@flagon-io/cli/-/cli-1.0.0.tgz"],
    ["/-/npm/-/package/@g1t%2Fcli/dist-tags/next", "g1t", "/-/npm/-/package/@flagon-io%2Fcli/dist-tags/next"],
    ["/v2/g1t/runner/manifests/latest", "g1t", "/v2/flagon-io/runner/manifests/latest"],
    ["/v2/G1T/runner/blobs/uploads/upl_1", "g1t", "/v2/flagon-io/runner/blobs/uploads/upl_1"],
  ];
  for (const [path, slug, moved] of cases) {
    const named = registryWorkspace(path);
    assert.equal(named?.slug, slug, path);
    assert.equal(named?.under("flagon-io"), moved, path);
  }
  for (const path of ["/v2", "/v2/", "/v2/token", "/-/npm", "/-/npm/-/whoami", "/-/npm/-/ping", "/-/npm/unscoped"]) {
    assert.equal(registryWorkspace(path), null, path);
  }
});
