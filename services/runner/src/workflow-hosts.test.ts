import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { WorkflowDomain } from "@g1t/contracts";

import { INSTANCE_TYPES } from "../../../packages/contracts/src/instances.ts";

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

test("each sandbox class is the size the contracts give its runs-on label", () => {
  type Size = { vcpu: number; memory_mib: number; disk_mb: number };
  // wrangler.jsonc's comments are whole lines.
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(text) as { containers: { class_name: string; instance_type: unknown }[] };
  // The named Cloudflare instance types a machine may be, at the sizes
  // Cloudflare gives them. No custom instance types.
  const named: Record<string, Size> = {
    "standard-3": { vcpu: 2, memory_mib: 8 * 1024, disk_mb: 16_000 },
    "standard-4": { vcpu: 4, memory_mib: 12 * 1024, disk_mb: 20_000 },
  };
  const classes = Object.keys(SANDBOX_BINDINGS);
  assert.equal(INSTANCE_TYPES.length, classes.length);
  INSTANCE_TYPES.forEach((instance, i) => {
    const type = config.containers.find((c) => c.class_name === classes[i])?.instance_type;
    const size = typeof type === "string" ? named[type] : undefined;
    assert.ok(size, `${classes[i]}: ${JSON.stringify(type)}`);
    assert.equal(type, instance.container, instance.label);
    assert.deepEqual(
      { vcpu: size.vcpu, memoryGib: size.memory_mib / 1024, diskGb: size.disk_mb / 1000 },
      { vcpu: instance.vcpu, memoryGib: instance.memoryGib, diskGb: instance.diskGb },
      instance.label,
    );
  });
});
