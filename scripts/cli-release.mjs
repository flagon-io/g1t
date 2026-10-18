#!/usr/bin/env node
// Releases of the g1t CLI (crates/g1t): built for every platform,
// checksummed, signed, and published to the g1t-downloads R2 bucket that
// g1t.sh serves at /downloads/cli/ (apps/web/app/routes/downloads-runner.ts).
// g1t.sh/install and g1t.sh/install.ps1 (apps/web/app/content/install/)
// install the newest one.
//
//   node scripts/cli-release.mjs build      # every platform, in the cargo-zigbuild image (Docker)
//   node scripts/cli-release.mjs manifest   # SHA256SUMS, manifest.json and latest.json from what was built
//   node scripts/cli-release.mjs sign       # latest.json.sig
//   node scripts/cli-release.mjs verify     # checks the signature
//   node scripts/cli-release.mjs publish [--dry-run]
//
// At cli/<version>/ in the bucket: g1t-linux-x64, -linux-arm64,
// -macos-x64, -macos-arm64, -windows-x64.exe, SHA256SUMS, manifest.json and
// latest.json.sig; at cli/: latest.json, the newest release's manifest, and
// latest.json.sig, its Ed25519 signature in base64. SHA256SUMS is what the
// install scripts check a download against; the signature is what a CLI
// that updates itself will check, with the same release key as the
// runner's (scripts/runner-release.mjs keygen):
//
//   RUNNER_RELEASE_KEY      the private key: a g1t Actions secret
//   G1T_RUNNER_RELEASE_KEY  the public key, for `verify`
//
// The macOS builds link Apple's Security framework (the keychain), whose
// SDK the rust-cross/cargo-zigbuild image carries, so `build` runs there.

import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { signBytes, verifyBytes } from "./runner-release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUCKET = "g1t-downloads";
// Pinned by digest, so a release builds with the toolchain (Rust 1.93.0,
// zig 0.16.0) its cache was built with, and `latest` moving never changes a
// release under it. To move on: `docker pull ghcr.io/rust-cross/cargo-zigbuild:latest`
// and take the digest from `docker image inspect --format '{{json .RepoDigests}}'`.
// The Caches workflow keys the build's cache by it (ci-cache.mjs keys:
// zigbuild), so a new digest starts a new entry.
export const BUILDER = "ghcr.io/rust-cross/cargo-zigbuild@sha256:d8313491ec5798de0633fdc1c5753761bff79967bea69076020dc78121b2cca8";
export const TARGETS = {
  "linux-x64": { triple: "x86_64-unknown-linux-musl", file: "g1t-linux-x64" },
  "linux-arm64": { triple: "aarch64-unknown-linux-musl", file: "g1t-linux-arm64" },
  "macos-x64": { triple: "x86_64-apple-darwin", file: "g1t-macos-x64" },
  "macos-arm64": { triple: "aarch64-apple-darwin", file: "g1t-macos-arm64" },
  "windows-x64": { triple: "x86_64-pc-windows-gnu", file: "g1t-windows-x64.exe", exe: true },
};

export function version() {
  const found = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, "crates/g1t/Cargo.toml"), "utf8"));
  if (!found) throw new Error("crates/g1t/Cargo.toml has no version");
  return found[1];
}

const outDir = (v = version()) => join(ROOT, "target", "cli-release", v);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, ...options });
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

/**
 * The release's manifest, from the binaries in `dir`: each platform's file
 * with its SHA-256. Writes SHA256SUMS, manifest.json and latest.json there.
 */
export function manifest(dir, v, now = new Date()) {
  const files = {};
  for (const [platform, target] of Object.entries(TARGETS)) {
    const path = join(dir, target.file);
    if (!existsSync(path)) continue;
    files[platform] = { name: target.file, sha256: sha256(readFileSync(path)) };
  }
  if (Object.keys(files).length === 0) throw new Error(`no binaries in ${dir}: node scripts/cli-release.mjs build`);
  const body = { version: v, published_at: now.toISOString(), files };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(join(dir, "manifest.json"), text);
  writeFileSync(join(dir, "latest.json"), text);
  writeFileSync(
    join(dir, "SHA256SUMS"),
    Object.values(files)
      .map((f) => `${f.sha256}  ${f.name}`)
      .join("\n") + "\n",
  );
  return body;
}

/**
 * The builder container's flags. Its target is target/zig in the
 * checkout, which the workflows cache (cli-release-…). In a workflow job,
 * Cargo's registry is the job's own ~/.cargo/registry, which the crates
 * entry (cargo-crates-…) restores; elsewhere a Docker volume keeps it.
 */
export function builderArgs({ root = ROOT, env = process.env, home = homedir() } = {}) {
  const registry = env.GITHUB_ACTIONS === "true" ? `${join(env.CARGO_HOME || join(home, ".cargo"), "registry").replaceAll("\\", "/")}` : "g1t-cargo-registry";
  return [
    "-e",
    "CARGO_TARGET_DIR=/src/target/zig",
    // The release key's public half, built into the CLI so `g1t upgrade`
    // can check releases (crates/g1t/src/commands/upgrade.rs).
    ...(env.G1T_RUNNER_RELEASE_KEY ? ["-e", `G1T_RUNNER_RELEASE_KEY=${env.G1T_RUNNER_RELEASE_KEY}`] : []),
    "-v",
    `${root.replaceAll("\\", "/")}:/src`,
    "-v",
    `${registry}:/usr/local/cargo/registry`,
    "-w",
    "/src",
    BUILDER,
  ];
}

/**
 * What the container runs. It runs as root, so on a host with users what
 * it wrote is handed back to the one running this, for the cache to save
 * and prune.
 */
export function builderScript(triples, owner = process.getuid ? `${process.getuid()}:${process.getgid()}` : null) {
  const build = `set -e; for t in ${triples}; do rustup target add $t >/dev/null 2>&1; cargo zigbuild --release --locked --package g1t --target $t; done`;
  return owner ? `trap 'chown -R ${owner} /src/target/zig /usr/local/cargo/registry' EXIT; ${build}` : build;
}

function build() {
  const v = version();
  const dir = outDir(v);
  mkdirSync(dir, { recursive: true });
  const triples = Object.values(TARGETS)
    .map((t) => t.triple)
    .join(" ");
  // One container builds every platform; its target folder is kept apart
  // from the host's so the two never mix.
  run("docker", ["run", "--rm", ...builderArgs(), "sh", "-c", builderScript(triples)], { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  for (const target of Object.values(TARGETS)) {
    const built = join(ROOT, "target", "zig", target.triple, "release", target.exe ? "g1t.exe" : "g1t");
    writeFileSync(join(dir, target.file), readFileSync(built));
  }
  const m = manifest(dir, v);
  console.log(`built ${Object.keys(m.files).length} binaries of g1t ${v} into ${dir}`);
}

function privateKey(text = process.env.RUNNER_RELEASE_KEY) {
  if (!text) throw new Error("RUNNER_RELEASE_KEY is not set");
  return createPrivateKey({ key: Buffer.from(text, "base64"), format: "der", type: "pkcs8" });
}

function signRelease() {
  const dir = outDir();
  const bytes = readFileSync(join(dir, "latest.json"));
  writeFileSync(join(dir, "latest.json.sig"), signBytes(bytes, privateKey()));
  console.log(`signed g1t ${version()}`);
}

function verifyRelease() {
  const dir = outDir();
  const publicRaw = process.env.G1T_RUNNER_RELEASE_KEY;
  if (!publicRaw) throw new Error("G1T_RUNNER_RELEASE_KEY is not set");
  const ok = verifyBytes(readFileSync(join(dir, "latest.json")), readFileSync(join(dir, "latest.json.sig"), "utf8"), publicRaw);
  if (!ok) throw new Error("latest.json's signature is not the release key's");
  const m = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  for (const file of Object.values(m.files)) {
    if (sha256(readFileSync(join(dir, file.name))) !== file.sha256) throw new Error(`${file.name} is not the file the manifest names`);
  }
  console.log(`g1t ${m.version}: the signature and every file check out`);
}

function publish(dryRun) {
  const v = version();
  const dir = outDir(v);
  if (!existsSync(join(dir, "manifest.json"))) throw new Error(`nothing built for ${v}: node scripts/cli-release.mjs build`);
  const signed = existsSync(join(dir, "latest.json.sig"));
  const put = (key, file, type) => {
    if (dryRun) return console.log(`would put ${key}`);
    run("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--remote", "--content-type", type], {
      shell: process.platform === "win32",
      // Away from the repository's .env, which may hold a token meant for
      // something else (as scripts/deploy does).
      cwd: join(ROOT, "apps/web"),
    });
  };
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  for (const file of Object.values(m.files)) put(`cli/${v}/${file.name}`, join(dir, file.name), "application/octet-stream");
  put(`cli/${v}/manifest.json`, join(dir, "manifest.json"), "application/json");
  put(`cli/${v}/SHA256SUMS`, join(dir, "SHA256SUMS"), "text/plain");
  if (signed) put(`cli/${v}/latest.json.sig`, join(dir, "latest.json.sig"), "text/plain");
  // Last, so `latest` never names a version whose files are not up yet.
  if (signed) put("cli/latest.json.sig", join(dir, "latest.json.sig"), "text/plain");
  put("cli/latest.json", join(dir, "latest.json"), "application/json");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/cli-release.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "build") build();
  else if (command === "manifest") manifest(outDir(), version());
  else if (command === "sign") signRelease();
  else if (command === "verify") verifyRelease();
  else if (command === "publish") publish(rest.includes("--dry-run"));
  else {
    console.error("usage: node scripts/cli-release.mjs build|manifest|sign|verify|publish [--dry-run]");
    process.exit(2);
  }
}
