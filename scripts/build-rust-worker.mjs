#!/usr/bin/env node
// Builds the Rust Worker in the current folder: the build command in each
// Rust unit's wrangler.jsonc, so `wrangler deploy`, `wrangler dev` and
// scripts/deploy.mjs all build the same way.
//
// worker-build is installed only when it is missing or another version:
// `cargo install` on every build cost a crates.io index check each time,
// and a full compile on a fresh machine. Every Rust Worker shares the
// workspace's Cargo target directory, so builds running side by side take
// turns on Cargo's lock while their wasm-bindgen and wasm-opt steps
// overlap. How hard wasm-opt works is each crate's
// [package.metadata.wasm-pack.profile.release] (docs/DEPLOYING.md).
//
//   node ../../scripts/build-rust-worker.mjs [worker-build args]
//   node scripts/build-rust-worker.mjs --ensure   # install only

import { spawnSync } from "node:child_process";

export const WORKER_BUILD_VERSION = "0.8.7";

const run = (command, args, options = {}) =>
  spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });

/** The installed worker-build's version, or null. */
export function installedVersion() {
  const found = spawnSync("worker-build", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  return found.status === 0 ? found.stdout.trim() : null;
}

/** Installs the pinned worker-build unless it is already there. */
export function ensureWorkerBuild() {
  const version = installedVersion();
  if (version === WORKER_BUILD_VERSION) return;
  console.error(`worker-build ${version ?? "is missing"}; installing ${WORKER_BUILD_VERSION}`);
  const installed = run("cargo", ["install", "-q", "--locked", `worker-build@${WORKER_BUILD_VERSION}`, "--force"]);
  if (installed.status !== 0) process.exit(installed.status ?? 1);
}

// Run, not imported (scripts/deploy.mjs imports ensureWorkerBuild).
if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/build-rust-worker.mjs")) {
  const args = process.argv.slice(2);
  ensureWorkerBuild();
  if (!args.includes("--ensure")) {
    const built = run("worker-build", ["--release", ...args]);
    process.exit(built.status ?? 1);
  }
}
