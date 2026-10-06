import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowDomain } from "@g1t/contracts";

import { SANDBOX_BINDINGS, jobHosts, sandboxNamespace } from "./egress.ts";

const domains: WorkflowDomain[] = [
  { domain: "api.cloudflare.com", workflows: ["deploy.yml"], environments: ["production"] },
  { domain: "*.example.com", workflows: [], environments: [] },
];
const policy = { workflowDomains: domains };
const deploy = { workflow: ".g1t/workflows/deploy.yml", environment: "production", trusted: true };

test("a trusted workflow job reaches the workflow-only domains that name it", () => {
  assert.deepEqual(jobHosts(policy, "actions", deploy), ["api.cloudflare.com", "*.example.com"]);
  assert.deepEqual(jobHosts(policy, "actions", { ...deploy, workflow: "DEPLOY.yml", environment: "Production" }), [
    "api.cloudflare.com",
    "*.example.com",
  ]);
  // Another environment, none, or another workflow: only the open entry.
  assert.deepEqual(jobHosts(policy, "actions", { ...deploy, environment: "staging" }), ["*.example.com"]);
  assert.deepEqual(jobHosts(policy, "actions", { ...deploy, environment: null }), ["*.example.com"]);
  assert.deepEqual(jobHosts(policy, "actions", { ...deploy, workflow: ".g1t/workflows/ci.yml" }), ["*.example.com"]);
});

test("nothing else ever reaches them: forks, deploy builds, unknown jobs", () => {
  assert.deepEqual(jobHosts(policy, "actions", { ...deploy, trusted: false }), []);
  assert.deepEqual(jobHosts(policy, "deploy", deploy), []);
  assert.deepEqual(jobHosts(policy, "actions", null), []);
  assert.deepEqual(jobHosts(policy, "actions", { ...deploy, workflow: null }), []);
  // Guardrails from before the list existed.
  assert.deepEqual(jobHosts({}, "actions", deploy), []);
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
