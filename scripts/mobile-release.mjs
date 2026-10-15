#!/usr/bin/env node
// Releases of the phone app (apps/mobile) for Android, published on
// g1t.sh/download while the app is not in Google Play: built by EAS from
// the `preview` profile (g1t (experimental), sh.g1t.app.preview, a signed release
// APK that needs no computer), downloaded, described in a manifest, and
// published to the g1t-downloads R2 bucket that g1t.sh serves at
// /downloads/mobile/ (apps/web/app/routes/downloads-runner.ts). The
// download page lists the newest (apps/web/app/routes/download.tsx).
//
// Google Play and the App Store publish an organization's apps only once
// it is verified with a D-U-N-S number; until Flagon's is, this is how the
// app is given out. Installed copies take most changes over the air
// (expo-updates, the `preview` channel: `eas update --channel preview`);
// a release here is for what needs a new install.
//
//   node scripts/mobile-release.mjs build                     # EAS builds the APK (about 15 minutes)
//   node scripts/mobile-release.mjs fetch [--build <id>]      # downloads the newest finished preview build, or that one
//   node scripts/mobile-release.mjs manifest [--notes "…"]    # latest.json and SHA256SUMS from what was fetched
//   node scripts/mobile-release.mjs publish [--dry-run]
//
// What a release is, at mobile/<version>/ in the bucket:
//
//   g1t-<version>-android.apk    the app, signed with the upload key EAS keeps
//   SHA256SUMS                   `sha256  name`
//   manifest.json                { version, build, pub_date, notes, downloads }
//
// and at mobile/: latest.json, the newest release's manifest. `version` is
// apps/mobile/app.config.ts's, `build` the Android versionCode EAS gave it.
//
// Environment:
//   EXPO_TOKEN              for build and fetch (an Expo access token, from expo.dev)
//   CLOUDFLARE_API_TOKEN    for publish
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "apps/mobile");
const BUCKET = "g1t-downloads";
/** The EAS command line, pinned so a release does not change with its newest version. */
const EAS = ["--yes", "eas-cli@24.12.1"];
const PROFILE = "preview";

/** The app's version, as app.config.ts says it. */
export function version() {
  const config = readFileSync(join(APP, "app.config.ts"), "utf8");
  const found = /^\s*version:\s*"([^"]+)"/m.exec(config);
  if (!found) throw new Error("no version in apps/mobile/app.config.ts");
  return found[1];
}

/** What a release's APK is called. */
export function apkName(v) {
  return `g1t-${v}-android.apk`;
}

const outDir = (v) => join(ROOT, "target/mobile-release", v);

/**
 * The manifest for a release folder's files: each one's size and SHA-256,
 * and SHA256SUMS as `sha256sum` writes it.
 */
export function manifestFor({ version: v, build, notes, files, now = new Date() }) {
  const downloads = files.map((file) => ({ platform: "android", kind: "apk", name: file.name, size: file.size, sha256: file.sha256 }));
  return {
    manifest: { version: v, build, pub_date: now.toISOString(), notes: notes || undefined, downloads },
    sums: files.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n",
  };
}

/** The newest finished build, from `eas build:list --json`, or null. */
export function newestBuild(list) {
  const finished = (Array.isArray(list) ? list : []).filter((build) => build?.status === "FINISHED" && build?.artifacts?.buildUrl);
  finished.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return finished[0] ?? null;
}

// A token pasted with a newline breaks the request's header, and EAS says
// only that its GraphQL request failed.
if (process.env.EXPO_TOKEN) process.env.EXPO_TOKEN = process.env.EXPO_TOKEN.trim();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout ?? "";
}

function build() {
  run("npx", [...EAS, "build", "--platform", "android", "--profile", PROFILE, "--non-interactive", "--wait"], { cwd: APP });
}

async function fetchBuild(id) {
  const v = version();
  const args = id
    ? ["build:view", id, "--json"]
    : ["build:list", "--platform", "android", "--build-profile", PROFILE, "--status", "finished", "--limit", "5", "--json", "--non-interactive"];
  const answer = JSON.parse(run("npx", [...EAS, ...args], { cwd: APP, capture: true }));
  const chosen = id ? answer : newestBuild(answer);
  if (!chosen?.artifacts?.buildUrl) throw new Error("no finished preview build: run build first");
  if (chosen.appVersion && chosen.appVersion !== v) {
    throw new Error(`the build is version ${chosen.appVersion}, but apps/mobile is ${v}`);
  }
  const response = await fetch(chosen.artifacts.buildUrl);
  if (!response.ok) throw new Error(`downloading the APK failed: ${response.status}`);
  const dir = outDir(v);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, apkName(v)), Buffer.from(await response.arrayBuffer()));
  writeFileSync(join(dir, "build.json"), JSON.stringify({ id: chosen.id, build: chosen.appBuildVersion ?? null }, null, 2));
  console.log(`fetched build ${chosen.id} (versionCode ${chosen.appBuildVersion ?? "?"}) into ${dir}`);
}

function writeManifest(notes) {
  const v = version();
  const dir = outDir(v);
  const apk = join(dir, apkName(v));
  if (!existsSync(apk)) throw new Error("no APK: run fetch first");
  const meta = existsSync(join(dir, "build.json")) ? JSON.parse(readFileSync(join(dir, "build.json"), "utf8")) : {};
  const bytes = readFileSync(apk);
  const files = [{ name: apkName(v), size: statSync(apk).size, sha256: createHash("sha256").update(bytes).digest("hex") }];
  const { manifest, sums } = manifestFor({ version: v, build: meta.build ?? null, notes, files });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  console.log(`${apkName(v)}: ${files[0].size} bytes, sha256 ${files[0].sha256}`);
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
  const type = (name) =>
    name.endsWith(".apk") ? "application/vnd.android.package-archive" : name.endsWith(".json") ? "application/json" : "text/plain";
  // The version's files first; latest.json last, so the page never offers a file that is not there yet.
  for (const name of readdirSync(dir)) {
    if (name === "latest.json" || name === "build.json") continue;
    put(`mobile/${v}/${name}`, join(dir, name), type(name));
  }
  put("mobile/latest.json", join(dir, "latest.json"), "application/json");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/mobile-release.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name) => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  try {
    switch (command) {
      case "build":
        build();
        break;
      case "fetch":
        await fetchBuild(option("build"));
        break;
      case "manifest":
        writeManifest(option("notes") ?? "");
        break;
      case "publish":
        publish(rest.includes("--dry-run"));
        break;
      default:
        console.error("usage: node scripts/mobile-release.mjs build|fetch|manifest|publish");
        process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
