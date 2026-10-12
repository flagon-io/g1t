import assert from "node:assert/strict";
import { test } from "node:test";

import { detectedLabel, sizeLabel } from "./deploy-kind.ts";

const NAMES = { astro: "Astro", dockerfile: "Dockerfile", flask: "Flask", nextjs: "Next.js" };

test("what a build found is said with what it was built with", () => {
  assert.equal(detectedLabel("static", "astro", NAMES), "Static site · Astro");
  assert.equal(detectedLabel("container", "dockerfile", NAMES), "Container · Dockerfile");
  assert.equal(detectedLabel("container", "flask", NAMES), "Container · Flask, with a Dockerfile g1t wrote");
  assert.equal(detectedLabel("workers", null, NAMES), "Workers project");
  assert.equal(detectedLabel("html", "unknown", NAMES), "Plain HTML");
});

test("a container size reads plainly", () => {
  assert.equal(sizeLabel({ vcpu: 1 / 16, memoryGib: 0.25, diskGb: 2 }), "1/16 vCPU, 256 MiB, 2 GB disk");
  assert.equal(sizeLabel({ vcpu: 2, memoryGib: 8, diskGb: 16 }), "2 vCPU, 8 GiB, 16 GB disk");
});
