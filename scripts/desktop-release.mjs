#!/usr/bin/env node
// Releases of the desktop app (apps/desktop): built on each platform,
// signed by Tauri's updater key, collected into one folder, described in
// a manifest, and published to the g1t-downloads R2 bucket that g1t.sh
// serves at /downloads/desktop/ (apps/web/app/routes/downloads-runner.ts).
// The app checks `desktop/latest.json` for updates
// (apps/desktop/src-tauri/src/updates.rs); g1t.sh/download lists the same
// release (apps/web/app/routes/download.tsx).
//
//   node scripts/desktop-release.mjs keygen                    # once: the updater's signing key
//   node scripts/desktop-release.mjs build [--windows-from-linux]
//   node scripts/desktop-release.mjs collect                   # this machine's bundles, into the release folder
//   node scripts/desktop-release.mjs manifest [--notes "…"]    # latest.json and SHA256SUMS from what is collected
//   node scripts/desktop-release.mjs publish [--dry-run]
//
// What a release is, at desktop/<version>/ in the bucket:
//
//   g1t-<version>-windows-x64-setup.exe   (+ .sig)   the Windows installer, and what the updater fetches
//   g1t-<version>-macos-arm64.dmg, -macos-x64.dmg    what people download on a Mac
//   g1t-<version>-macos-arm64.app.tar.gz (+ .sig)    what the updater fetches on a Mac
//   g1t-<version>-linux-x64.AppImage (+ .sig)        runs anywhere; what the updater fetches on Linux
//   g1t-<version>-linux-x64.deb, .rpm                packages
//   SHA256SUMS                                       `sha256  name`, one line each
//   manifest.json                                    { version, pub_date, notes, platforms, downloads }
//
// and at desktop/: latest.json, the newest release's manifest. `platforms`
// is what Tauri's updater reads: each platform's file and its signature,
// made with the private key as the bundles are built and checked against
// the public key in tauri.conf.json. `downloads` is what the download page
// lists: every file, with its platform, kind, size and SHA-256.
//
// Environment:
//   TAURI_SIGNING_PRIVATE_KEY            the updater's private key (keygen makes it): a g1t Actions secret
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD   its password; empty for a key made with --ci
//   CLOUDFLARE_API_TOKEN                 for publish

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "apps/desktop");
const TAURI = join(APP, "src-tauri");
const BUCKET = "g1t-downloads";

/** What each platform's folder of bundles holds, and what the updater calls the platform. */
export const PLATFORMS = {
  "windows-x64": { triple: "x86_64-pc-windows-msvc", updater: "windows-x86_64" },
  "windows-arm64": { triple: "aarch64-pc-windows-msvc", updater: "windows-aarch64" },
  "macos-arm64": { triple: "aarch64-apple-darwin", updater: "darwin-aarch64" },
  "macos-x64": { triple: "x86_64-apple-darwin", updater: "darwin-x86_64" },
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", updater: "linux-x86_64" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", updater: "linux-aarch64" },
};

export function version() {
  const toml = readFileSync(join(TAURI, "Cargo.toml"), "utf8");
  const found = /^version\s*=\s*"([^"]+)"/m.exec(toml);
  if (!found) throw new Error("apps/desktop/src-tauri/Cargo.toml has no version");
  return found[1];
}

const outDir = (v = version()) => join(ROOT, "target", "desktop-release", v);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The platform this machine is, as releases name it. */
export function hostPlatform(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  return `${os}-${arch === "arm64" ? "arm64" : "x64"}`;
}

/** The platform a Rust target triple builds for, or null. */
export function platformOfTriple(triple) {
  return Object.keys(PLATFORMS).find((key) => PLATFORMS[key].triple === triple) ?? null;
}

/**
 * A bundle's place in a release: `{ platform, arch, kind, name, updater }`
 * for a file Tauri produced, or null for one that is not published (an
 * MSI, say). `name` is the file's name in the release, `updater` whether
 * the updater fetches this kind of file on that platform.
 */
export function classify(file, platform, v) {
  const [os, arch] = platform.split("-");
  const lower = file.toLowerCase();
  const named = (suffix) => `g1t-${v}-${platform}${suffix}`;
  if (lower.endsWith(".sig")) return null;
  if (os === "windows" && lower.endsWith("-setup.exe")) return { platform: os, arch, kind: "installer", name: named("-setup.exe"), updater: true };
  if (os === "macos" && lower.endsWith(".app.tar.gz")) return { platform: os, arch, kind: "update", name: named(".app.tar.gz"), updater: true };
  if (os === "macos" && lower.endsWith(".dmg")) return { platform: os, arch, kind: "dmg", name: named(".dmg"), updater: false };
  if (os === "linux" && lower.endsWith(".appimage")) return { platform: os, arch, kind: "appimage", name: named(".AppImage"), updater: true };
  if (os === "linux" && lower.endsWith(".deb")) return { platform: os, arch, kind: "deb", name: named(".deb"), updater: false };
  if (os === "linux" && lower.endsWith(".rpm")) return { platform: os, arch, kind: "rpm", name: named(".rpm"), updater: false };
  return null;
}

/** The folders Tauri put bundles in, by the platform each is for. */
export function bundleDirs(target = join(TAURI, "target")) {
  const found = [];
  const host = join(target, "release", "bundle");
  if (existsSync(host)) found.push({ platform: hostPlatform(), dir: host });
  if (!existsSync(target)) return found;
  for (const entry of readdirSync(target)) {
    const platform = platformOfTriple(entry);
    const dir = join(target, entry, "release", "bundle");
    if (platform && existsSync(dir)) found.push({ platform, dir });
  }
  return found;
}

/** Every file in a bundle folder, one level of kind folders down. */
function bundleFiles(dir) {
  const files = [];
  for (const kind of readdirSync(dir)) {
    const folder = join(dir, kind);
    if (!statSync(folder).isDirectory()) continue;
    for (const file of readdirSync(folder)) {
      if (statSync(join(folder, file)).isFile()) files.push(join(folder, file));
    }
  }
  return files;
}

/**
 * The manifest of a release folder: Tauri's updater format (`platforms`),
 * plus `downloads` for the download page. `entries` are the collected
 * files' notes (collect.json), `signatures` each updater file's `.sig`.
 */
export function manifest(entries, v, { date = new Date().toISOString(), notes = "", base = `https://g1t.sh/downloads/desktop/${v}` } = {}) {
  const platforms = {};
  const downloads = [];
  for (const entry of entries) {
    if (entry.updater && entry.signature) {
      const key = PLATFORMS[`${entry.platform}-${entry.arch}`]?.updater;
      if (key) platforms[key] = { url: `${base}/${entry.name}`, signature: entry.signature };
    }
    if (entry.kind !== "update") {
      downloads.push({ platform: entry.platform, arch: entry.arch, kind: entry.kind, name: entry.name, size: entry.size, sha256: entry.sha256 });
    }
  }
  downloads.sort((a, b) => a.platform.localeCompare(b.platform) || a.arch.localeCompare(b.arch) || a.kind.localeCompare(b.kind));
  return { version: v, pub_date: date, notes, platforms, downloads };
}

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, shell: process.platform === "win32", ...options });
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function keygen() {
  console.error("Making the updater's key pair with Tauri's signer. Keep the private key as the g1t Actions secret DESKTOP_SIGNING_KEY,");
  console.error("and put the public key in apps/desktop/src-tauri/tauri.conf.json (plugins.updater.pubkey).");
  run("npx", ["tauri", "signer", "generate", "--ci"], { cwd: APP });
}

function build(windowsFromLinux) {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) console.error("warning: TAURI_SIGNING_PRIVATE_KEY is not set; these bundles cannot be fetched by the updater");
  console.error(`building ${hostPlatform()}`);
  run("npx", ["tauri", "build", "--ci"], { cwd: APP });
  if (windowsFromLinux) {
    // Tauri's cross build: cargo-xwin for the MSVC target, NSIS for the
    // installer, both on PATH (the release workflow installs them).
    console.error("building windows-x64 from here");
    run("rustup", ["target", "add", PLATFORMS["windows-x64"].triple]);
    run("npx", ["tauri", "build", "--ci", "--runner", "cargo-xwin", "--target", PLATFORMS["windows-x64"].triple, "--bundles", "nsis"], { cwd: APP });
  }
}

/**
 * Copies this machine's bundles into the release folder under their
 * release names, with each updater file's signature, and notes what each
 * is in collect.json there, one line per file, so folders from several
 * machines merge by copying them together.
 */
function collect() {
  const v = version();
  const dir = outDir(v);
  mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const { platform, dir: bundles } of bundleDirs()) {
    for (const file of bundleFiles(bundles)) {
      const entry = classify(basename(file), platform, v);
      if (!entry) continue;
      const bytes = readFileSync(file);
      copyFileSync(file, join(dir, entry.name));
      let signature = null;
      if (entry.updater) {
        const sig = `${file}.sig`;
        if (!existsSync(sig)) throw new Error(`${basename(file)} has no .sig: was TAURI_SIGNING_PRIVATE_KEY set when it was built?`);
        signature = readFileSync(sig, "utf8").trim();
        copyFileSync(sig, join(dir, `${entry.name}.sig`));
      }
      entries.push({ ...entry, size: bytes.length, sha256: sha256(bytes), signature });
      console.error(`collected ${entry.name}`);
    }
  }
  if (entries.length === 0) throw new Error("no bundles found: run build first");
  // One notes file per machine, so the folders of several machines merge
  // by copying them together (the release workflow does).
  writeFileSync(join(dir, `collect-${hostPlatform()}.json`), `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`collected ${entries.length} files of ${v} into ${dir}`);
}

const isNotes = (name) => /^collect-.*\.json$/.test(name);

function writeManifest(notes) {
  const v = version();
  const dir = outDir(v);
  const collected = existsSync(dir) ? readdirSync(dir).filter(isNotes) : [];
  if (collected.length === 0) throw new Error(`${dir} has no collect-*.json: run collect first`);
  const entries = collected.flatMap((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
  const m = manifest(entries, v, { notes });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(join(dir, "SHA256SUMS"), entries.map((e) => `${e.sha256}  ${e.name}`).join("\n") + "\n");
  console.log(`manifest for ${v}: ${Object.keys(m.platforms).length} platforms the updater serves, ${m.downloads.length} downloads`);
}

function publish(dryRun) {
  const v = version();
  const dir = outDir(v);
  if (!existsSync(join(dir, "latest.json"))) throw new Error("no latest.json: run manifest first");
  const put = (key, file, type) => {
    const args = ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--remote", "--content-type", type];
    if (dryRun) console.log(`would put ${key}`);
    else run("npx", args, { cwd: join(ROOT, "apps/web") });
  };
  const type = (name) => (name.endsWith(".json") ? "application/json" : name.endsWith(".sig") || name === "SHA256SUMS" ? "text/plain" : "application/octet-stream");
  // The version's files first; latest.json last, so no app is pointed at
  // files that are not there yet.
  for (const name of readdirSync(dir)) {
    if (name === "latest.json" || isNotes(name)) continue;
    put(`desktop/${v}/${name}`, join(dir, name), type(name));
  }
  put("desktop/latest.json", join(dir, "latest.json"), "application/json");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/desktop-release.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name) => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  try {
    switch (command) {
      case "keygen":
        keygen();
        break;
      case "build":
        build(rest.includes("--windows-from-linux"));
        break;
      case "collect":
        collect();
        break;
      case "manifest":
        writeManifest(option("notes") ?? "");
        break;
      case "publish":
        publish(rest.includes("--dry-run"));
        break;
      default:
        console.error("usage: node scripts/desktop-release.mjs keygen|build|collect|manifest|publish");
        process.exit(2);
    }
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
