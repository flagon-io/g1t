#!/usr/bin/env node
// Releases of the g1t CLI (crates/g1t): built for every platform,
// checksummed, and published to the g1t-downloads R2 bucket that g1t.sh
// serves at /downloads/cli/ (apps/web/app/routes/downloads-runner.ts).
//
//   node scripts/cli-release.mjs build      # every platform, in the cargo-zigbuild image (Docker)
//   node scripts/cli-release.mjs publish [--dry-run]
//
// At cli/<version>/ in the bucket: g1t-linux-x64, -linux-arm64,
// -macos-x64, -macos-arm64, -windows-x64.exe, SHA256SUMS and
// manifest.json; at cli/: latest.json, the newest release's manifest.
// Unlike the runner, the CLI does not update itself, so nothing is signed:
// SHA256SUMS is what to check a download against.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUCKET = "g1t-downloads";
const BUILDER = "ghcr.io/rust-cross/cargo-zigbuild:latest";
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
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, ...options });
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function build() {
  const v = version();
  const dir = outDir(v);
  mkdirSync(dir, { recursive: true });
  const triples = Object.values(TARGETS).map((t) => t.triple).join(" ");
  // One container builds every platform; its target folder is kept apart
  // from the host's so the two never mix.
  run("docker", [
    "run", "--rm",
    "-e", "CARGO_TARGET_DIR=/src/target/zig",
    "-v", `${ROOT.replaceAll("\\", "/")}:/src`,
    "-v", "g1t-cargo-registry:/usr/local/cargo/registry",
    "-w", "/src", BUILDER, "sh", "-c",
    `set -e; for t in ${triples}; do rustup target add $t >/dev/null 2>&1; cargo zigbuild --release --locked --package g1t --target $t; done`,
  ], { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  const files = {};
  for (const [platform, target] of Object.entries(TARGETS)) {
    const built = join(ROOT, "target", "zig", target.triple, "release", target.exe ? "g1t.exe" : "g1t");
    const bytes = readFileSync(built);
    writeFileSync(join(dir, target.file), bytes);
    files[platform] = { name: target.file, sha256: sha256(bytes) };
  }
  const manifest = { version: v, published_at: new Date().toISOString(), files };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "SHA256SUMS"), Object.values(files).map((f) => `${f.sha256}  ${f.name}`).join("\n") + "\n");
  console.log(`built ${Object.keys(files).length} binaries of g1t ${v} into ${dir}`);
}

function publish(dryRun) {
  const v = version();
  const dir = outDir(v);
  if (!existsSync(join(dir, "manifest.json"))) throw new Error(`nothing built for ${v}: node scripts/cli-release.mjs build`);
  const put = (key, file, type) => {
    if (dryRun) return console.log(`would put ${key}`);
    run("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--remote", "--content-type", type], {
      shell: process.platform === "win32",
      // Away from the repository's .env, which may hold a token meant for
      // something else (as scripts/deploy does).
      cwd: join(ROOT, "apps/web"),
    });
  };
  for (const target of Object.values(TARGETS)) put(`cli/${v}/${target.file}`, join(dir, target.file), "application/octet-stream");
  put(`cli/${v}/manifest.json`, join(dir, "manifest.json"), "application/json");
  put(`cli/${v}/SHA256SUMS`, join(dir, "SHA256SUMS"), "text/plain");
  // Last, so `latest` never names a version whose files are not up yet.
  put("cli/latest.json", join(dir, "latest.json"), "application/json");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/cli-release.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "build") build();
  else if (command === "publish") publish(rest.includes("--dry-run"));
  else {
    console.error("usage: node scripts/cli-release.mjs build|publish [--dry-run]");
    process.exit(2);
  }
}
