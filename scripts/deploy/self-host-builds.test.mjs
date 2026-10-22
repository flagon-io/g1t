import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { selfHostBuilds, selfHostRust } from "./self-host-builds.mjs";
import { ROOT, loadStack } from "./stack.mjs";

const stack = loadStack();

test("CI builds ahead exactly the Rust Workers the self-host image builds from source", () => {
  const dockerfile = readFileSync(join(ROOT, "deploy/self-host/Dockerfile"), "utf8");
  const loop = [...dockerfile.matchAll(/for service in ([a-z ]+); do/g)][0][1].trim().split(/\s+/);
  // The services' loop, and the API built after it.
  assert.ok(dockerfile.includes("cd apps/api && worker-build --release"));
  const fromSource = [...loop, "api"].sort();
  assert.deepEqual(
    selfHostRust(stack)
      .map((unit) => unit.path.split("/").pop())
      .sort(),
    fromSource,
  );
  const built = selfHostBuilds(stack).flatMap((job) => job.units.split(","));
  assert.deepEqual(
    [...built].sort(),
    selfHostRust(stack)
      .map((unit) => unit.id)
      .sort(),
    "each built once",
  );
});

test("the self-host builds split into several jobs, as a deploy's do", () => {
  const builds = selfHostBuilds(stack);
  assert.ok(builds.length > 1, "one job would build them all in turn");
  assert.deepEqual(
    builds.map((job) => job.group),
    builds.map((_, i) => `rust-${i + 1}`),
  );
});

test("the image takes the prebuilt Workers only when asked, and builds them from source by default", () => {
  const dockerfile = readFileSync(join(ROOT, "deploy/self-host/Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG RUST_BUILD=rust$/m);
  assert.match(dockerfile, /^FROM scratch AS rust-prebuilt$/m);
  assert.match(dockerfile, /^FROM \$\{RUST_BUILD\} AS rust-out$/m);
  const override = readFileSync(join(ROOT, "deploy/self-host/docker-compose.prebuilt.yml"), "utf8");
  for (const service of ["g1t", "status"]) assert.match(override, new RegExp(`^  ${service}:$`, "m"));
  assert.equal([...override.matchAll(/RUST_BUILD: rust-prebuilt/g)].length, 2);
});
