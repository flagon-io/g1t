import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  GITHUB_HOSTED_LABELS,
  INSTANCE_TYPES,
  RETIRED_MACHINES,
  STANDARD_INSTANCE,
  instanceNamed,
  machineNamed,
  machineSize,
  machineTitle,
  machines,
  priceScale,
  runnerMinutes,
} from "../../../packages/contracts/src/instances.ts";

import { SANDBOX_BINDINGS, jobNamespaceOf } from "./egress.ts";

test("each label in the machine catalogue runs in its own class, bound and sized as wrangler.jsonc says", () => {
  type Size = { vcpu: number; memory_mib: number; disk_mb: number };
  // wrangler.jsonc's comments are whole lines.
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(text) as {
    containers: { class_name: string; instance_type: unknown }[];
    durable_objects: { bindings: { name: string; class_name: string }[] };
    migrations: { new_sqlite_classes?: string[]; deleted_classes?: string[] }[];
  };
  // The named Cloudflare instance types a machine may be, at the sizes
  // Cloudflare gives them. A custom type would be a row here once the
  // account may use them.
  const named: Record<string, Size> = {
    "standard-2": { vcpu: 1, memory_mib: 6 * 1024, disk_mb: 12_000 },
    "standard-3": { vcpu: 2, memory_mib: 8 * 1024, disk_mb: 16_000 },
    "standard-4": { vcpu: 4, memory_mib: 12 * 1024, disk_mb: 20_000 },
  };
  // The container classes that are not machines, each named: the git edge
  // (gitedge.ts) serves clones, runs no jobs and no job can ask for it, so
  // it has no label, no price and no sandbox binding.
  const notMachines: Record<string, string> = { GitEdge: "GIT_EDGE" };
  for (const [className, binding] of Object.entries(notMachines)) {
    assert.ok(
      config.containers.some((c) => c.class_name === className),
      `${className} is not in wrangler.jsonc`,
    );
    assert.ok(
      config.durable_objects.bindings.some((b) => b.name === binding && b.class_name === className),
      binding,
    );
    assert.ok(!INSTANCE_TYPES.some((instance) => instance.sandboxClass === className), `${className} is in the machine catalogue`);
    assert.equal(SANDBOX_BINDINGS[className], undefined, `${className} is in SANDBOX_BINDINGS`);
  }
  // Every other class has a label, and every label a class.
  assert.deepEqual(
    INSTANCE_TYPES.map((instance) => instance.sandboxClass).sort(),
    config.containers
      .map((container) => container.class_name)
      .filter((className) => !Object.hasOwn(notMachines, className))
      .sort(),
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
  assert.equal(jobNamespaceOf({ SANDBOX: "standard" }, INSTANCE_TYPES[1]!), null);
  // Every class has a migration that made it, and a retired machine's class
  // is deployed no more and was deleted by one (its objects were each one
  // job's sandbox).
  const created = config.migrations.flatMap((m) => m.new_sqlite_classes ?? []);
  const deleted = config.migrations.flatMap((m) => m.deleted_classes ?? []);
  for (const container of config.containers) {
    assert.ok(created.includes(container.class_name) && !deleted.includes(container.class_name), container.class_name);
  }
  for (const retired of RETIRED_MACHINES) {
    assert.ok(!config.containers.some((c) => c.class_name === retired.sandboxClass), retired.sandboxClass);
    assert.ok(!config.durable_objects.bindings.some((b) => b.class_name === retired.sandboxClass), retired.sandboxClass);
    assert.ok(deleted.includes(retired.sandboxClass), `${retired.sandboxClass} has no deleted_classes migration`);
  }
  assert.equal(jobNamespaceOf({ SANDBOX: "standard" }, { sandboxClass: "Sandbox64Core" }), null);
});

test("the machines a job starts on are the catalogue's, and a job is charged its minutes rounded up", () => {
  // The planner names the machine (`instance_for`): ubuntu-latest is the
  // standard one in a private repository and g1t-4core in a public one.
  assert.equal(instanceNamed("ubuntu-latest"), STANDARD_INSTANCE);
  assert.equal(instanceNamed(null), STANDARD_INSTANCE);
  assert.equal(instanceNamed("Ubuntu-Slim").machine, "1-core");
  assert.equal(instanceNamed("G1T-4Core").machine, "4-core");
  assert.equal(instanceNamed("g1t-4core").sandboxClass, "SandboxLarge");
  assert.equal(instanceNamed("g1t-2core"), STANDARD_INSTANCE);
  assert.deepEqual(
    machines().map((m) => [m.machine, m.microsPerMinute, machineSize(m)]),
    [
      ["2-core", 4000, "2 vCPU, 8 GiB, 16 GB"],
      ["1-core", 3000, "1 vCPU, 6 GiB, 12 GB"],
      ["4-core", 7000, "4 vCPU, 12 GiB, 20 GB"],
    ],
  );
  assert.equal(machineNamed("4-core")?.label, "g1t-4core");
  assert.equal(machineNamed("8-core"), null);
  assert.equal(priceScale(instanceNamed("ubuntu-slim")), 0.75);
  assert.equal(priceScale(instanceNamed("g1t-4core")), 1.75);
  assert.deepEqual(INSTANCE_TYPES.map(machineTitle), ["standard machine", "ubuntu-slim", "4-core machine"]);
  // Every GitHub Linux label is a machine here, public or private; Windows
  // and macOS are none.
  for (const github of GITHUB_HOSTED_LABELS) {
    for (const size of [github.public, github.private]) {
      if (github.os === "linux") assert.equal(instanceNamed(size.machine).label, size.machine, github.githubLabel);
      else assert.equal(size.machine, null, github.githubLabel);
    }
  }
  const latest = GITHUB_HOSTED_LABELS.find((g) => g.githubLabel === "ubuntu-latest")!;
  assert.deepEqual([latest.public.vcpu, latest.public.machine, latest.private.vcpu, latest.private.machine], [4, "g1t-4core", 2, "standard"]);
  const slim = GITHUB_HOSTED_LABELS.find((g) => g.githubLabel === "ubuntu-slim")!;
  assert.deepEqual([slim.public.machine, slim.private.machine], ["ubuntu-slim", "ubuntu-slim"]);
  assert.deepEqual([0, 1, 60, 61, 3600].map(runnerMinutes), [0, 1, 1, 2, 60]);
});
