import assert from "node:assert/strict";
import { test } from "node:test";

import { SANDBOX_BINDINGS, allows, harnessEnv, normalizeHost, sandboxNamespace, timeCapMessage } from "./egress.ts";

const hosts = ["registry.npmjs.org", "*.example.com"];

test("a brokered secret's hosts match exactly, or by wildcard", () => {
  assert.equal(allows(hosts, "registry.npmjs.org"), true);
  assert.equal(allows(hosts, "evil.com"), false);
  assert.equal(allows(hosts, "registry.npmjs.org.evil.com"), false);
  assert.equal(allows(hosts, "npmjs.org"), false);
  assert.equal(allows(hosts, ""), false);
  assert.equal(allows([], "registry.npmjs.org"), false);
});

test("hosts are compared without case, port or trailing dot", () => {
  assert.equal(allows(hosts, "Registry.NPMJS.org:443"), true);
  assert.equal(allows(hosts, "registry.npmjs.org."), true);
  assert.equal(normalizeHost("[::1]:8080"), "[::1]");
});

test("a wildcard covers subdomains at any depth, not the domain itself", () => {
  assert.equal(allows(hosts, "api.example.com"), true);
  assert.equal(allows(hosts, "a.b.example.com"), true);
  assert.equal(allows(hosts, "example.com"), false);
  assert.equal(allows(hosts, "badexample.com"), false);
});

test("the harness is told the run's time cap and branch, and nothing about the network", () => {
  const guard = { policy: { minutes: { checks: 90 } }, minutes: 90 };
  const vars = harnessEnv(guard, { UPSTREAM_BRANCH: "trunk" });
  assert.deepEqual(Object.keys(vars), ["GUARDRAILS"]);
  assert.deepEqual(JSON.parse(vars.GUARDRAILS), {
    minutes: 90,
    defaultBranch: "trunk",
  });
  assert.equal(timeCapMessage(1), "Stopped: it reached its time cap of 1 minute.");
});

test("each sandbox class reports to its own namespace", () => {
  const env = { SANDBOX: "standard", SANDBOX_2CORE: "two", SANDBOX_4CORE: "four" } as unknown as object;
  assert.equal(sandboxNamespace(env, "AttemptSandbox"), "standard");
  assert.equal(sandboxNamespace(env, "Sandbox4Core"), "four");
  assert.equal(sandboxNamespace(env, "Sandbox2Core"), "two");
  assert.equal(sandboxNamespace(env, undefined), "standard");
  assert.equal(sandboxNamespace({ SANDBOX: "standard" }, "Sandbox4Core"), "standard");
  assert.deepEqual(Object.keys(SANDBOX_BINDINGS), ["AttemptSandbox", "Sandbox2Core", "Sandbox4Core"]);
});
