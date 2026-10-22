#!/usr/bin/env node
// The self-hosted stack's Rust Workers (deploy/self-host/Dockerfile builds
// them from source), split into CI jobs the way a deploy splits its own
// (rustShards): what .g1t/workflows/self-host.yml builds, with the deploy's
// caches, before it builds the image from them (RUST_BUILD=rust-prebuilt).
// Prints the jobs as JSON, and as `builds=` on GITHUB_OUTPUT when set.
//
//   node scripts/deploy/self-host-builds.mjs
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadStack, rustShards } from "./stack.mjs";

/** The Rust Workers a self-hosted installation runs: in its workerd (`run`) or beside it, as the API is (`separate`). */
export function selfHostRust(stack) {
  return stack.units.filter((unit) => unit.kind === "rust-worker" && (unit.self_host === "run" || unit.self_host === "separate"));
}

/** Their builds as CI jobs: `{ group, units }`, units comma-separated. */
export function selfHostBuilds(stack) {
  return rustShards(selfHostRust(stack)).map((units, i) => ({ group: `rust-${i + 1}`, units: units.map((unit) => unit.id).join(",") }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const builds = JSON.stringify(selfHostBuilds(loadStack()));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `builds=${builds}\n`);
  console.log(builds);
}
