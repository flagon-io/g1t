#!/usr/bin/env node
// The sandbox's images: what `g1t-runner sandbox up` runs on a person's own
// computer (crates/runner/src/selfhosted/launcher/), built from
// deploy/sandbox/Dockerfile for each runner release and listed, with their
// SHA-256, in the release's signed manifest (scripts/runner-release.mjs).
//
//   node scripts/sandbox-image.mjs build --arch x64 --runner target/runner-release/0.3.0/g1t-runner-linux-x64 \
//       [--kind wsl|vm|all] [--out DIR] [--version 0.3.0]
//   node scripts/sandbox-image.mjs section --dir DIR [--runner-image g1t.sh/flagon-io/g1t-runner@sha256:…]
//       [--hosted-image g1t.sh/flagon-io/g1t-hosted@sha256:… [--hosted-image-size BYTES]]
//
// What it makes, in --out (default target/runner-release/<version>/):
//
//   g1t-sandbox-wsl-<arch>.tar.gz      a root filesystem for `wsl --import`
//   g1t-sandbox-vm-<arch>-kernel       a VM's kernel (uncompressed on arm64,
//   g1t-sandbox-vm-<arch>-initrd       as Apple's Virtualization framework
//   g1t-sandbox-vm-<arch>-disk.raw.gz  wants), initrd and ext4 system disk
//
// `section` prints the manifest's `sandbox` section for the files in a
// folder; runner-release.mjs `build` and `sign` take it from sandbox.json
// there. It names g1t's machine image too (scripts/hosted-image.mjs), by
// architecture: amd64 alone, so `hosted_images` has only `x64`, and an
// arm64 sandbox's runner takes no jobs asking for g1t's machines. Building needs Docker with buildx (and QEMU's emulators for the
// other architecture); the VM's disk is made with mke2fs -d inside a
// container, so nothing needs root on the machine.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The files of a sandbox for an architecture, by the key the manifest and the launcher use. */
export function sandboxFiles(arch) {
  return {
    [`wsl-${arch}`]: `g1t-sandbox-wsl-${arch}.tar.gz`,
    [`vm-${arch}-kernel`]: `g1t-sandbox-vm-${arch}-kernel`,
    [`vm-${arch}-initrd`]: `g1t-sandbox-vm-${arch}-initrd`,
    [`vm-${arch}-disk`]: `g1t-sandbox-vm-${arch}-disk.raw.gz`,
  };
}

export const ARCHES = ["x64", "arm64"];
const PLATFORM = { x64: "linux/amd64", arm64: "linux/arm64" };

const sha256File = async (path) => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

/**
 * g1t's machine image by architecture, as the sandbox section names it: it
 * is built for amd64 alone (services/runner/base/Dockerfile).
 */
export function hostedImages(image, size) {
  if (!image) return {};
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`g1t's machine image is named by digest, not ${image}`);
  return { x64: { image, size: Number(size) || null } };
}

/** The manifest's `sandbox` section for the sandbox files in `dir`. */
export async function section(
  dir,
  runnerImage = process.env.RUNNER_SANDBOX_IMAGE || null,
  hostedImage = process.env.RUNNER_HOSTED_IMAGE || null,
  hostedSize = process.env.RUNNER_HOSTED_IMAGE_SIZE || null,
) {
  const files = {};
  for (const arch of ARCHES) {
    for (const [key, name] of Object.entries(sandboxFiles(arch))) {
      const path = join(dir, name);
      if (existsSync(path)) files[key] = { name, sha256: await sha256File(path), size: statSync(path).size };
    }
  }
  return { runner_image: runnerImage, hosted_images: hostedImages(hostedImage, hostedSize), files };
}

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, ...options });
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function output(command, args) {
  const done = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${done.stderr}`);
  return done.stdout.trim();
}

function version() {
  const toml = readFileSync(join(ROOT, "crates/runner/Cargo.toml"), "utf8");
  return /^version\s*=\s*"([^"]+)"/m.exec(toml)[1];
}

/** A build context: deploy/sandbox and the runner's Linux binary. */
function context(runner) {
  const dir = mkdtempSync(join(tmpdir(), "g1t-sandbox-"));
  for (const name of ["Dockerfile", "wsl.conf", "g1t-sandbox.service", "vm-network.network"]) {
    copyFileSync(join(ROOT, "deploy/sandbox", name), join(dir, name));
  }
  copyFileSync(runner, join(dir, "g1t-runner"));
  return dir;
}

/** Builds a target and exports its file system as a tar. */
function exportTarget(ctx, target, arch, v, tar) {
  const tag = `g1t-sandbox-build:${target}-${arch}`;
  run("docker", ["buildx", "build", "--platform", PLATFORM[arch], "--target", target, "--build-arg", `IMAGE_VERSION=${v}`, "-t", tag, "--load", ctx]);
  const id = output("docker", ["create", "--platform", PLATFORM[arch], tag]);
  try {
    run("docker", ["export", "-o", tar, id]);
  } finally {
    run("docker", ["rm", id], { stdio: "ignore" });
  }
}

async function gzip(from, to) {
  await pipeline(createReadStream(from), createGzip({ level: 9 }), createWriteStream(to));
  rmSync(from);
}

async function buildWsl(ctx, arch, v, out) {
  const tar = join(out, `g1t-sandbox-wsl-${arch}.tar`);
  exportTarget(ctx, "wsl", arch, v, tar);
  await gzip(tar, join(out, sandboxFiles(arch)[`wsl-${arch}`]));
}

async function buildVm(ctx, arch, v, out) {
  const tar = join(out, `g1t-sandbox-vm-${arch}.tar`);
  exportTarget(ctx, "vm", arch, v, tar);
  const names = sandboxFiles(arch);
  // Kernel and initrd out of /boot, and the rest made into an ext4 disk,
  // in a container with e2fsprogs, as root there and nowhere else.
  const script = [
    "set -e",
    "apt-get update -qq >/dev/null && apt-get install -y -qq e2fsprogs >/dev/null",
    "mkdir /work/root && tar -C /work/root -xpf /out/vm.tar",
    `cp /work/root/boot/vmlinuz-* /out/${names[`vm-${arch}-kernel`]}`,
    `cp /work/root/boot/initrd.img-* /out/${names[`vm-${arch}-initrd`]}`,
    // Apple's Virtualization framework boots an uncompressed arm64 Image.
    arch === "arm64"
      ? `if gzip -t /out/${names[`vm-${arch}-kernel`]} 2>/dev/null; then mv /out/${names[`vm-${arch}-kernel`]} /out/k.gz && gzip -dc /out/k.gz > /out/${names[`vm-${arch}-kernel`]} && rm /out/k.gz; fi`
      : "true",
    "mke2fs -q -t ext4 -L g1t-system -d /work/root /out/disk.raw 3G",
    "chmod 0644 /out/*",
  ].join(" && ");
  copyFileSync(tar, join(out, "vm.tar"));
  rmSync(tar);
  run("docker", ["run", "--rm", "--tmpfs", "/work:size=6g", "-v", `${resolve(out)}:/out`, "debian:bookworm-slim", "sh", "-c", script]);
  rmSync(join(out, "vm.tar"));
  await gzip(join(out, "disk.raw"), join(out, names[`vm-${arch}-disk`]));
}

export async function build({ arch, runner, kind = "all", out, v = version() }) {
  if (!PLATFORM[arch]) throw new Error(`--arch is one of ${ARCHES.join(", ")}`);
  if (!runner || !existsSync(runner)) throw new Error("--runner names the runner's static Linux build for that architecture");
  mkdirSync(out, { recursive: true });
  const ctx = context(runner);
  try {
    if (kind === "wsl" || kind === "all") await buildWsl(ctx, arch, v, out);
    if (kind === "vm" || kind === "all") await buildVm(ctx, arch, v, out);
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/sandbox-image.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name) => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  try {
    switch (command) {
      case "build": {
        const v = option("version") ?? version();
        await build({
          arch: option("arch") ?? "x64",
          runner: option("runner"),
          kind: option("kind") ?? "all",
          out: option("out") ?? join(ROOT, "target", "runner-release", v),
          v,
        });
        break;
      }
      case "section": {
        const dir = option("dir") ?? join(ROOT, "target", "runner-release", version());
        const s = await section(
          dir,
          option("runner-image") ?? process.env.RUNNER_SANDBOX_IMAGE ?? null,
          option("hosted-image") ?? process.env.RUNNER_HOSTED_IMAGE ?? null,
          option("hosted-image-size") ?? process.env.RUNNER_HOSTED_IMAGE_SIZE ?? null,
        );
        writeFileSync(join(dir, "sandbox.json"), `${JSON.stringify(s, null, 2)}\n`);
        console.log(JSON.stringify(s, null, 2));
        break;
      }
      default:
        console.error("usage: node scripts/sandbox-image.mjs build|section");
        process.exit(2);
    }
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
