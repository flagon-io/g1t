import assert from "node:assert/strict";
import { test } from "node:test";

import type { BumpArgs } from "@g1t/contracts";

import { bumpEnv, bumpProblem, bumpSandboxName, isBranchName, isSystem, registryHosts, systemActor } from "./bump.ts";
import { buildHosts } from "./egress.ts";

const PREFIX = "g1t/security/";

const args: BumpArgs = {
  repo: { namespace: "Acme", name: "site" },
  ecosystem: "npm",
  package: "@babel/traverse",
  version: "7.23.2",
  lockfiles: ["package-lock.json", "web/package-lock.json"],
  branch: "g1t/security/babel-traverse-7.23.2",
  message: "Update @babel/traverse to 7.23.2",
};

test("a well-formed update can start", () => {
  assert.equal(bumpProblem(args, PREFIX), null);
  for (const ecosystem of ["crates.io", "Go", "PyPI"]) {
    assert.equal(bumpProblem({ ...args, ecosystem }, PREFIX), null, ecosystem);
  }
});

test("the branch must be a security update's", () => {
  for (const branch of ["main", "g1t/security/", "feature/g1t/security/x", "g1t/security/a..b", "g1t/security/a b", "g1t/security/a:b", "g1t/security/x.lock"]) {
    assert.match(bumpProblem({ ...args, branch }, PREFIX) ?? "", /starts with g1t\/security\//, branch);
  }
});

test("names, versions and lockfiles are checked before anything starts", () => {
  assert.match(bumpProblem({ ...args, ecosystem: "RubyGems" }, PREFIX) ?? "", /cannot update RubyGems/);
  assert.match(bumpProblem({ ...args, package: "--registry=evil" }, PREFIX) ?? "", /package's name/);
  assert.match(bumpProblem({ ...args, version: "1.0; rm -rf /" }, PREFIX) ?? "", /version/);
  assert.match(bumpProblem({ ...args, lockfiles: [] }, PREFIX) ?? "", /between 1 and/);
  assert.match(bumpProblem({ ...args, lockfiles: ["../Cargo.lock"] }, PREFIX) ?? "", /not a path inside/);
  assert.match(bumpProblem({ ...args, lockfiles: ["/etc/Cargo.lock"] }, PREFIX) ?? "", /not a path inside/);
  assert.match(bumpProblem({ ...args, repo: { namespace: "", name: "site" } }, PREFIX) ?? "", /repository/);
  assert.match(bumpProblem(null, PREFIX) ?? "", /arguments/);
});

test("g1t acts as itself, a member of the workspace", () => {
  const actor = systemActor("Acme");
  assert.deepEqual(actor, { id: "g1t", username: "g1t", kind: "system", verified: true, workspaces: [{ slug: "acme", role: "member" }] });
  assert.equal(isSystem(actor), true);
  assert.equal(isSystem({ id: "usr_1", username: "ada" }), false);
  assert.equal(isSystem(null), false);
});

test("the sandbox is given what bump mode reads", () => {
  const env = bumpEnv(args, "main", "g1t_token");
  assert.deepEqual(env, {
    MODE: "bump",
    G1T_USER: "acme",
    G1T_TOKEN: "g1t_token",
    GIT_REMOTE: "https://g1t.sh/Acme/site.git",
    GIT_BRANCH_BASE: "main",
    GIT_BRANCH: "g1t/security/babel-traverse-7.23.2",
    BUMP_KIND: "security",
    BUMP_ECOSYSTEM: "npm",
    BUMP_PACKAGE: "@babel/traverse",
    BUMP_VERSION: "7.23.2",
    BUMP_PACKAGES: '[{"package":"@babel/traverse","version":"7.23.2"}]',
    BUMP_STRATEGY: "increase",
    BUMP_FORCE: "0",
    BUMP_REGISTRIES: "[]",
    BUMP_LOCKFILES: '["package-lock.json","web/package-lock.json"]',
    COMMIT_MESSAGE: "Update @babel/traverse to 7.23.2",
  });
  assert.equal(bumpEnv({ ...args, message: " " }, "main", "t").COMMIT_MESSAGE, "Update @babel/traverse to 7.23.2");
  assert.equal(bumpSandboxName(args), "bump:acme/site:g1t/security/babel-traverse-7.23.2");
});

const update: BumpArgs = {
  ...args,
  kind: "version",
  package: "lodash",
  version: "4.17.21",
  packages: [
    { package: "lodash", version: "4.17.21" },
    { package: " vitest ", version: "1.6.0" },
  ],
  branch: "deps/npm/lodash",
  message: "Bump lodash and vitest",
  strategy: "widen",
  force: true,
  registries: [{ type: "npm-registry", url: "https://npm.acme.dev/", token: "s3cret", scopes: ["@acme"] }],
};

test("a version update names any branch git takes", () => {
  assert.equal(bumpProblem(update, PREFIX), null);
  for (const branch of ["main", "dependabot/npm/lodash-4.17.21", "deps"]) {
    assert.equal(bumpProblem({ ...update, branch }, PREFIX), null, branch);
  }
  for (const branch of ["", "a b", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a@{1}", "-x", "/x", "refs/heads/x", "x/", "x.lock", "x".repeat(201)]) {
    assert.match(bumpProblem({ ...update, branch }, PREFIX) ?? "", /not a branch name/, branch);
  }
  assert.equal(isBranchName("deps/npm/lodash"), true);
  assert.equal(isBranchName(undefined), false);
});

test("a version update's packages, strategy and registries are checked", () => {
  assert.match(bumpProblem({ ...update, kind: "major" as "version" }, PREFIX) ?? "", /cannot make a major update/);
  assert.match(bumpProblem({ ...update, package: "" }, PREFIX) ?? "", /A version update needs the package's name/);
  assert.match(bumpProblem({ ...update, packages: [{ package: "--evil", version: "1" }] }, PREFIX) ?? "", /each package's name/);
  assert.match(bumpProblem({ ...update, packages: [{ package: "lodash", version: "1 2" }] }, PREFIX) ?? "", /raise lodash to/);
  const many = Array.from({ length: 51 }, (_, i) => ({ package: `p${i}`, version: "1.0.0" }));
  assert.match(bumpProblem({ ...update, packages: many }, PREFIX) ?? "", /at most 50 packages/);
  for (const strategy of ["increase", "increase-if-necessary", "widen", "lockfile-only"]) {
    assert.equal(bumpProblem({ ...update, strategy }, PREFIX), null, strategy);
  }
  assert.match(bumpProblem({ ...update, strategy: "auto" }, PREFIX) ?? "", /not a versioning strategy/);
  const registry = update.registries![0]!;
  assert.match(bumpProblem({ ...update, registries: [{ ...registry, type: "maven-repository" }] }, PREFIX) ?? "", /cannot read a maven-repository registry/);
  for (const url of ["http://npm.acme.dev", "npm.acme.dev", "https://", "https:// x"]) {
    assert.match(bumpProblem({ ...update, registries: [{ ...registry, url }] }, PREFIX) ?? "", /starts with https/, url);
  }
  assert.match(bumpProblem({ ...update, registries: [{ ...registry, token: "x".repeat(2001) }] }, PREFIX) ?? "", /credentials/);
  assert.match(bumpProblem({ ...update, registries: [{ ...registry, scopes: ["acme"] }] }, PREFIX) ?? "", /not an npm scope/);
  assert.match(bumpProblem({ ...update, registries: Array.from({ length: 21 }, () => registry) }, PREFIX) ?? "", /at most 20 private registries/);
  for (const type of ["cargo-registry", "python-index", "goproxy-server"]) {
    assert.equal(bumpProblem({ ...update, registries: [{ type, url: "https://r.acme.dev/x", username: "u", password: "p", replacesBase: true }] }, PREFIX), null, type);
  }
});

test("a version update's sandbox is told what to raise, how and from where", () => {
  const env = bumpEnv(update, "main", "t");
  assert.equal(env.BUMP_KIND, "version");
  assert.equal(env.GIT_BRANCH, "deps/npm/lodash");
  assert.equal(env.BUMP_PACKAGE, "lodash");
  assert.equal(env.BUMP_VERSION, "4.17.21");
  assert.equal(env.BUMP_PACKAGES, '[{"package":"lodash","version":"4.17.21"},{"package":"vitest","version":"1.6.0"}]');
  assert.equal(env.BUMP_STRATEGY, "widen");
  assert.equal(env.BUMP_FORCE, "1");
  assert.deepEqual(JSON.parse(env.BUMP_REGISTRIES!), update.registries);
  assert.equal(env.COMMIT_MESSAGE, "Bump lodash and vitest");
  assert.equal(bumpEnv({ ...update, message: "" }, "main", "t").COMMIT_MESSAGE, "Update lodash and 1 more");
  const one = bumpEnv({ ...update, packages: [], strategy: undefined, force: undefined, registries: undefined }, "main", "t");
  assert.equal(one.BUMP_PACKAGES, '[{"package":"lodash","version":"4.17.21"}]');
  assert.equal(one.BUMP_STRATEGY, "increase");
  assert.equal(one.BUMP_FORCE, "0");
  assert.equal(one.BUMP_REGISTRIES, "[]");
});

test("a security update reaches the package registries and nothing else builds get", () => {
  const hosts = buildHosts("bump");
  for (const host of ["registry.npmjs.org", "repo.yarnpkg.com", "index.crates.io", "static.crates.io", "proxy.golang.org", "sum.golang.org", "pypi.org", "files.pythonhosted.org"]) {
    assert.ok(hosts.includes(host), host);
  }
  for (const host of ["github.com", "api.cloudflare.com", "ghcr.io"]) assert.ok(!hosts.includes(host), host);
});

test("an update's private registries are reachable from its sandbox", () => {
  assert.deepEqual(registryHosts(update), [...new Set((update.registries ?? []).map((registry) => new URL(registry.url).host))]);
  assert.deepEqual(registryHosts(args), []);
});
