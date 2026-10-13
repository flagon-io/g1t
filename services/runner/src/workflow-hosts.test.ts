import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { WorkflowDomain } from "@g1t/contracts";

import {
  INSTANCE_TYPES,
  STANDARD_INSTANCE,
  instanceNamed,
  machineNamed,
  machineSize,
  machines,
  priceScale,
  runnerMinutes,
} from "../../../packages/contracts/src/instances.ts";

import { SANDBOX_BINDINGS, jobHosts, jobNamespaceOf, sandboxNamespace } from "./egress.ts";

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

test("each label in the machine catalogue runs in its own class, bound and sized as wrangler.jsonc says", () => {
  type Size = { vcpu: number; memory_mib: number; disk_mb: number };
  // wrangler.jsonc's comments are whole lines.
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(text) as {
    containers: { class_name: string; instance_type: unknown }[];
    durable_objects: { bindings: { name: string; class_name: string }[] };
  };
  // The named Cloudflare instance types a machine may be, at the sizes
  // Cloudflare gives them. A custom type would be a row here once the
  // account may use them.
  const named: Record<string, Size> = {
    "standard-3": { vcpu: 2, memory_mib: 8 * 1024, disk_mb: 16_000 },
    "standard-4": { vcpu: 4, memory_mib: 12 * 1024, disk_mb: 20_000 },
  };
  // Every class has a label, and every label a class.
  assert.deepEqual(
    INSTANCE_TYPES.map((instance) => instance.sandboxClass).sort(),
    config.containers.map((container) => container.class_name).sort(),
  );
  for (const instance of INSTANCE_TYPES) {
    const type = config.containers.find((c) => c.class_name === instance.sandboxClass)?.instance_type;
    const size = typeof type === "string" ? named[type] : undefined;
    assert.ok(size, `${instance.sandboxClass}: ${JSON.stringify(type)}`);
    assert.equal(type, instance.container, instance.label);
    assert.deepEqual(
      { vcpu: size.vcpu, memoryGib: size.memory_mib / 1024, diskGb: size.disk_mb / 1000 },
      { vcpu: instance.vcpu, memoryGib: instance.memoryGib, diskGb: instance.diskGb },
      instance.label,
    );
    // Its binding, here and in wrangler.jsonc, is what a job starts in.
    const binding = SANDBOX_BINDINGS[instance.sandboxClass];
    assert.ok(binding, `${instance.sandboxClass} has no binding in SANDBOX_BINDINGS`);
    assert.ok(
      config.durable_objects.bindings.some((b) => b.name === binding && b.class_name === instance.sandboxClass),
      binding,
    );
    assert.equal(jobNamespaceOf({ [binding]: instance.label }, instance), instance.label);
  }
  // A class not deployed here: the job is not started on another machine.
  assert.equal(jobNamespaceOf({ SANDBOX: "standard" }, INSTANCE_TYPES[2]!), null);
  assert.equal(jobNamespaceOf({ SANDBOX: "standard" }, { sandboxClass: "Sandbox64Core" }), null);
});

test("runs-on labels are the catalogue's, and a job is charged its minutes rounded up", () => {
  assert.equal(instanceNamed("ubuntu-latest"), STANDARD_INSTANCE);
  assert.equal(instanceNamed("G1T-4Core").machine, "4-core");
  assert.equal(instanceNamed("g1t-2core").machine, STANDARD_INSTANCE.machine);
  assert.deepEqual(
    machines().map((m) => [m.machine, m.microsPerMinute, machineSize(m)]),
    [
      ["2-core", 4000, "2 vCPU, 8 GiB, 16 GB"],
      ["4-core", 7000, "4 vCPU, 12 GiB, 20 GB"],
    ],
  );
  assert.equal(machineNamed("4-core")?.label, "g1t-4core");
  assert.equal(machineNamed("8-core"), null);
  assert.equal(priceScale(instanceNamed("g1t-4core")), 1.75);
  assert.deepEqual([0, 1, 60, 61, 3600].map(runnerMinutes), [0, 1, 1, 2, 60]);
});
