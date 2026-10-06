import assert from "node:assert/strict";
import { test } from "node:test";

import type { BumpArgs } from "@g1t/contracts";

import { bumpEnv, bumpProblem, bumpSandboxName, isSystem, systemActor } from "./bump.ts";
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
  for (const branch of ["main", "g1t/security/", "feature/g1t/security/x", "g1t/security/a..b", "g1t/security/a b", "g1t/security/a:b"]) {
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
    BUMP_ECOSYSTEM: "npm",
    BUMP_PACKAGE: "@babel/traverse",
    BUMP_VERSION: "7.23.2",
    BUMP_LOCKFILES: '["package-lock.json","web/package-lock.json"]',
    COMMIT_MESSAGE: "Update @babel/traverse to 7.23.2",
  });
  assert.equal(bumpEnv({ ...args, message: " " }, "main", "t").COMMIT_MESSAGE, "Update @babel/traverse to 7.23.2");
  assert.equal(bumpSandboxName(args), "bump:acme/site:g1t/security/babel-traverse-7.23.2");
});

test("a security update reaches the package registries and nothing else builds get", () => {
  const hosts = buildHosts("bump");
  for (const host of ["registry.npmjs.org", "repo.yarnpkg.com", "index.crates.io", "static.crates.io", "proxy.golang.org", "sum.golang.org", "pypi.org", "files.pythonhosted.org"]) {
    assert.ok(hosts.includes(host), host);
  }
  for (const host of ["github.com", "api.cloudflare.com", "ghcr.io"]) assert.ok(!hosts.includes(host), host);
});
