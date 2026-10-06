#!/usr/bin/env node
// Releases of the self-hosted runner, `g1t-runner` (crates/runner): built
// for every platform, checksummed, signed, and published to the
// g1t-downloads R2 bucket that g1t.sh serves at /downloads/runner/
// (apps/web/app/routes/downloads-runner.ts).
//
//   node scripts/runner-release.mjs keygen            # once: the release key
//   node scripts/runner-release.mjs build [--targets linux-x64,windows-x64]
//   node scripts/runner-release.mjs sign              # latest.json + .sig
//   node scripts/runner-release.mjs verify            # checks the signature
//   node scripts/runner-release.mjs publish [--dry-run]
//
// What a release is, at runner/<version>/ in the bucket:
//
//   g1t-runner-linux-x64, -linux-arm64, -macos-x64, -macos-arm64,
//   -windows-x64.exe    the binaries
//   SHA256SUMS          `sha256  name`, one line each
//   manifest.json       { version, published_at, agent_image, files: { platform: { name, sha256 } } }
//
// and at runner/: latest.json (the newest release's manifest) and
// latest.json.sig, its Ed25519 signature in base64. A runner trusts a
// release only when the signature checks out against the public key built
// into it (G1T_RUNNER_RELEASE_KEY at build time) and every file's SHA-256
// is the manifest's (crates/runner/src/selfhosted/update.rs).
//
// Environment:
//   RUNNER_RELEASE_KEY      the private key (keygen prints it): a g1t Actions secret
//   G1T_RUNNER_RELEASE_KEY  the public key, built into the binaries
//   RUNNER_AGENT_IMAGE      the image agent work runs in, named in the manifest
//
// Every target is cross-compiled with cargo-zigbuild (`cargo install
// cargo-zigbuild`, and zig on PATH), so one Linux machine builds them all.

import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TARGETS = {
  "linux-x64": { triple: "x86_64-unknown-linux-musl", file: "g1t-runner-linux-x64" },
  "linux-arm64": { triple: "aarch64-unknown-linux-musl", file: "g1t-runner-linux-arm64" },
  "macos-x64": { triple: "x86_64-apple-darwin", file: "g1t-runner-macos-x64" },
  "macos-arm64": { triple: "aarch64-apple-darwin", file: "g1t-runner-macos-arm64" },
  "windows-x64": { triple: "x86_64-pc-windows-gnu", file: "g1t-runner-windows-x64.exe", exe: true },
};
const BUCKET = "g1t-downloads";

export function version() {
  const toml = readFileSync(join(ROOT, "crates/runner/Cargo.toml"), "utf8");
  const found = /^version\s*=\s*"([^"]+)"/m.exec(toml);
  if (!found) throw new Error("crates/runner/Cargo.toml has no version");
  return found[1];
}

const outDir = (v = version()) => join(ROOT, "target", "runner-release", v);

/** The 32 raw bytes of an Ed25519 public key, in base64, as the runner takes it. */
export function rawPublicKey(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32).toString("base64");
}

export function keygen() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    private: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    public: rawPublicKey(publicKey),
  };
}

function privateKey(text = process.env.RUNNER_RELEASE_KEY) {
  if (!text) throw new Error("RUNNER_RELEASE_KEY is not set");
  return createPrivateKey({ key: Buffer.from(text, "base64"), format: "der", type: "pkcs8" });
}

/** Signs `bytes`: the signature in base64. */
export function signBytes(bytes, key) {
  return sign(null, bytes, key).toString("base64");
}

/** Whether `signature` is the key's over `bytes`, given the raw public key in base64. */
export function verifyBytes(bytes, signature, publicRaw) {
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicRaw, "base64")]);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  return verify(null, bytes, key, Buffer.from(signature, "base64"));
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The manifest of the files in a release folder. */
export function manifest(dir, v, agentImage = process.env.RUNNER_AGENT_IMAGE || null) {
  const files = {};
  for (const [platform, target] of Object.entries(TARGETS)) {
    const path = join(dir, target.file);
    if (existsSync(path)) files[platform] = { name: target.file, sha256: sha256(readFileSync(path)) };
  }
  return { version: v, published_at: new Date().toISOString(), agent_image: agentImage, files };
}

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, shell: process.platform === "win32", ...options });
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function build(targets) {
  const v = version();
  const dir = outDir(v);
  mkdirSync(dir, { recursive: true });
  if (!process.env.G1T_RUNNER_RELEASE_KEY) console.error("warning: G1T_RUNNER_RELEASE_KEY is not set; these builds will not update themselves");
  for (const platform of targets) {
    const target = TARGETS[platform];
    if (!target) throw new Error(`unknown target ${platform}; one of ${Object.keys(TARGETS).join(", ")}`);
    console.error(`building ${platform} (${target.triple})`);
    run("rustup", ["target", "add", target.triple]);
    run("cargo", ["zigbuild", "--release", "--locked", "--package", "g1t-runner", "--target", target.triple]);
    const built = join(ROOT, "target", target.triple, "release", target.exe ? "g1t-runner.exe" : "g1t-runner");
    copyFileSync(built, join(dir, target.file));
  }
  const m = manifest(dir, v);
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(join(dir, "SHA256SUMS"), Object.values(m.files).map((f) => `${f.sha256}  ${f.name}`).join("\n") + "\n");
  console.log(`built ${Object.keys(m.files).length} binaries of ${v} into ${dir}`);
}

function signRelease() {
  const v = version();
  const dir = outDir(v);
  const bytes = readFileSync(join(dir, "manifest.json"));
  writeFileSync(join(dir, "latest.json"), bytes);
  writeFileSync(join(dir, "latest.json.sig"), signBytes(bytes, privateKey()));
  console.log(`signed ${v}`);
}

function verifyRelease() {
  const dir = outDir();
  const publicRaw = process.env.G1T_RUNNER_RELEASE_KEY;
  if (!publicRaw) throw new Error("G1T_RUNNER_RELEASE_KEY is not set");
  const ok = verifyBytes(readFileSync(join(dir, "latest.json")), readFileSync(join(dir, "latest.json.sig"), "utf8"), publicRaw);
  if (!ok) throw new Error("latest.json's signature is not the release key's");
  const m = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  for (const file of Object.values(m.files)) {
    if (sha256(readFileSync(join(dir, file.name))) !== file.sha256) throw new Error(`${file.name}'s SHA-256 is not the manifest's`);
  }
  console.log(`verified ${m.version}: ${Object.keys(m.files).length} files`);
}

function publish(dryRun) {
  const v = version();
  const dir = outDir(v);
  const put = (key, file, type) => {
    const args = ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--remote", "--content-type", type];
    if (dryRun) console.log(`would put ${key}`);
    else run("npx", args, { cwd: join(ROOT, "apps/web") });
  };
  // The version's files first; latest.json last, so no runner is pointed
  // at files that are not there yet.
  for (const name of readdirSync(dir)) {
    if (name.startsWith("latest.json")) continue;
    put(`runner/${v}/${name}`, join(dir, name), name.endsWith(".json") ? "application/json" : "application/octet-stream");
  }
  put("runner/latest.json", join(dir, "latest.json"), "application/json");
  put("runner/latest.json.sig", join(dir, "latest.json.sig"), "text/plain");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/runner-release.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name) => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  try {
    switch (command) {
      case "keygen": {
        const keys = keygen();
        console.log(`RUNNER_RELEASE_KEY=${keys.private}\nG1T_RUNNER_RELEASE_KEY=${keys.public}`);
        console.error("Keep RUNNER_RELEASE_KEY secret (a g1t Actions secret); G1T_RUNNER_RELEASE_KEY is public and goes into every build.");
        break;
      }
      case "build":
        build((option("targets") ?? Object.keys(TARGETS).join(",")).split(","));
        break;
      case "sign":
        signRelease();
        break;
      case "verify":
        verifyRelease();
        break;
      case "publish":
        publish(rest.includes("--dry-run"));
        break;
      default:
        console.error("usage: node scripts/runner-release.mjs keygen|build|sign|verify|publish");
        process.exit(2);
    }
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
