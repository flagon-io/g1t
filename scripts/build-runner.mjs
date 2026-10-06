#!/usr/bin/env node
// Builds the g1t runner (crates/runner) as one static Linux binary, the
// only file the runner's image adds to its base (services/runner/Dockerfile).
// Built outside the image, so a change to the runner is a Cargo build and
// a one-file image, not a Docker build of Rust.
//
// The target is x86_64-unknown-linux-musl: statically linked, so it runs
// on any x86-64 Linux, whatever its libc (the sandbox's Debian, or a
// self-hosted runner's machine). Where it is built:
//
//   - natively, on x86-64 Linux with the musl target and musl-gcc
//     (`rustup target add x86_64-unknown-linux-musl`, `apt-get install
//     musl-tools`), which a CI machine can have;
//   - otherwise in a small builder container (rust on Alpine, whose own
//     target is musl), with Docker volumes for Cargo's registry and target
//     directory, so a second build is incremental. This is how it builds
//     on Windows and macOS, where no musl cross-linker is at hand.
//
//   node scripts/build-runner.mjs            # -> target/runner-image/g1t-runner
//   node scripts/build-runner.mjs --docker   # the builder container, wherever
//   node scripts/build-runner.mjs --native   # this machine's Cargo, or fail

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TARGET = "x86_64-unknown-linux-musl";
/** Where the binary is written: the thin image's whole build context. */
export const OUT_DIR = join(ROOT, "target", "runner-image");
export const BINARY = join(OUT_DIR, "g1t-runner");

/**
 * The builder container's image: Rust on Alpine, the same Rust release as
 * rust-toolchain users get, plus musl's headers for crates with C in them
 * (ring). Built once per Rust version and kept by Docker.
 */
export const BUILDER_RUST = "1.99";
const BUILDER_IMAGE = `g1t-runner-builder:${BUILDER_RUST}`;
const BUILDER_DOCKERFILE = `FROM rust:${BUILDER_RUST}-alpine\nRUN apk add --no-cache musl-dev\n`;
/** Docker volumes the builder keeps between builds. */
const VOLUMES = { registry: "g1t-runner-cargo-registry", git: "g1t-runner-cargo-git", target: "g1t-runner-target" };

const run = (command, args, options = {}) => spawnSync(command, args, { stdio: "inherit", ...options });
const quiet = (command, args) => spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Whether this machine can build the musl binary itself. */
export function canBuildNatively() {
  if (platform() !== "linux" || arch() !== "x64") return false;
  const targets = quiet("rustup", ["target", "list", "--installed"]);
  if (targets.status !== 0 || !targets.stdout.split("\n").includes(TARGET)) return false;
  return quiet("musl-gcc", ["--version"]).status === 0 || quiet("sh", ["-c", "command -v musl-gcc"]).status === 0;
}

function native() {
  const built = run("cargo", ["build", "--release", "--locked", "--package", "g1t-runner", "--target", TARGET], {
    cwd: ROOT,
    env: { ...process.env, CC_x86_64_unknown_linux_musl: "musl-gcc" },
  });
  if (built.status !== 0) throw new Error("cargo build of the runner failed");
  return join(ROOT, "target", TARGET, "release", "g1t-runner");
}

function inDocker() {
  const have = quiet("docker", ["image", "inspect", BUILDER_IMAGE, "--format", "{{.Id}}"]);
  if (have.status !== 0) {
    console.error(`building ${BUILDER_IMAGE}`);
    const made = run("docker", ["build", "--platform", "linux/amd64", "-t", BUILDER_IMAGE, "-"], { input: BUILDER_DOCKERFILE, stdio: ["pipe", "inherit", "inherit"] });
    if (made.status !== 0) throw new Error(`could not build ${BUILDER_IMAGE}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  // The source is mounted read-only; Cargo writes only to its volumes, and
  // the binary is copied out to target/runner-image.
  const script = [
    "set -e",
    "cargo build --release --locked --package g1t-runner",
    "cp /target/release/g1t-runner /out/g1t-runner",
  ].join("\n");
  const built = run("docker", [
    "run", "--rm", "--platform", "linux/amd64",
    "-v", `${ROOT}:/src:ro`,
    "-v", `${OUT_DIR}:/out`,
    "-v", `${VOLUMES.registry}:/usr/local/cargo/registry`,
    "-v", `${VOLUMES.git}:/usr/local/cargo/git`,
    "-v", `${VOLUMES.target}:/target`,
    "-e", "CARGO_TARGET_DIR=/target",
    "-e", "CARGO_TERM_COLOR=never",
    "-w", "/src",
    BUILDER_IMAGE, "sh", "-c", script,
  ]);
  if (built.status !== 0) throw new Error("cargo build of the runner in the builder container failed");
  return BINARY;
}

/** Whether a file is a statically linked x86-64 ELF executable. */
export function isStaticElf(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46) return false;
  // 64-bit, little-endian, x86-64.
  if (bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 0x3e) return false;
  // No PT_INTERP program header: nothing to load it but the kernel.
  const phoff = Number(bytes.readBigUInt64LE(32));
  const phentsize = bytes.readUInt16LE(54);
  const phnum = bytes.readUInt16LE(56);
  for (let i = 0; i < phnum; i++) {
    if (bytes.readUInt32LE(phoff + i * phentsize) === 3) return false;
  }
  return true;
}

/** Builds the binary; returns its path (always target/runner-image/g1t-runner). */
export function buildRunner({ mode = "auto" } = {}) {
  const started = Date.now();
  const useNative = mode === "native" || (mode === "auto" && canBuildNatively());
  if (mode === "native" && !canBuildNatively()) {
    throw new Error(`no native musl build here: needs x86-64 Linux, rustup target ${TARGET} and musl-gcc`);
  }
  const built = useNative ? native() : inDocker();
  if (built !== BINARY) {
    mkdirSync(OUT_DIR, { recursive: true });
    copyFileSync(built, BINARY);
  }
  if (!isStaticElf(BINARY)) throw new Error(`${BINARY} is not a static x86-64 Linux binary`);
  const size = statSync(BINARY).size;
  console.error(`g1t-runner: ${(size / 1048576).toFixed(1)} MB, static, built ${useNative ? "natively" : "in the builder container"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return BINARY;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/build-runner.mjs")) {
  const args = process.argv.slice(2);
  const mode = args.includes("--docker") ? "docker" : args.includes("--native") ? "native" : "auto";
  try {
    console.log(buildRunner({ mode }));
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
