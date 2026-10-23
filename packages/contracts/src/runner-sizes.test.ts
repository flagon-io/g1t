import assert from "node:assert/strict";
import test from "node:test";

import { offeredSizeSaid, runnerSize, runnerSizes, sizesSaid } from "./instances.ts";

test("the sizes are g1t's machines by name, smallest first", () => {
  assert.deepEqual(
    runnerSizes().map((size) => `${size.name} ${size.vcpu} ${size.memoryMib}`),
    ["Small 1 6144", "Standard 2 8192", "Large 4 12288"],
  );
  assert.equal(runnerSize("8-core"), null);
});

test("a size says the sandbox its jobs get when it is not the size, never fewer CPUs or less than its least memory", () => {
  assert.equal(offeredSizeSaid({ size: "2-core" }), "Standard");
  assert.equal(offeredSizeSaid({ size: "2-core", cpus: 4, memory_mib: 16384 }), "Standard → 4 vCPU · 16 GB");
  assert.equal(offeredSizeSaid({ size: "4-core", memory_mib: 8192 }), "Large → 4 vCPU · 8 GB");
  assert.equal(offeredSizeSaid({ size: "2-core", cpus: 1, memory_mib: 1024 }), "Standard → 2 vCPU · 6 GB");
  assert.deepEqual(
    runnerSizes().map((size) => size.leastMemoryMib / 1024),
    [4, 6, 8],
  );
  assert.equal(sizesSaid([{ size: "1-core" }, { size: "2-core", memory_mib: 12288 }]), "Small, Standard → 2 vCPU · 12 GB");
  assert.equal(sizesSaid([]), "no sizes");
});
