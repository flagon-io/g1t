// The keys of the Rust caches in g1t's own workflows, and the pruning of a
// Cargo target before it is saved. CONTRIBUTING.md ("How g1t's own CI
// caches") has the whole scheme.
//
//   node scripts/deploy/ci-cache.mjs keys
//   node scripts/deploy/ci-cache.mjs prune <profile dir>... -- <cargo args>
//
// keys writes to the step's outputs (GITHUB_OUTPUT):
//
//   rust     rustc's version, such as 1.99.0. Everything Cargo compiles
//            depends on it, so a new toolchain starts a new line of entries
//            rather than restoring the old one's, whose files it would
//            only carry along unused.
//   cargo    a hash of the packages Cargo.lock takes from crates.io and git,
//            leaving out the workspace's own: a release bumps a crate's
//            version, which changes Cargo.lock and nothing that is cached.
//            Keyed by the whole file, 25 of the 31 changes to Cargo.lock in
//            the week before this were version bumps, and each saved every
//            Rust cache again (the test build's 0.7 to 1.7 GB each time).
//   desktop  the same for apps/desktop/src-tauri/Cargo.lock.
//   zigbuild the first 12 hex characters of the cargo-zigbuild image's
//            digest (scripts/cli-release.mjs): the CLI's release builds in
//            it, with its own Rust, so its cache is keyed by the image
//            rather than by this machine's rustc.
//
// prune runs Cargo again with --message-format=json once the build is done
// (everything is fresh, so it only lists what it built) and deletes, from
// each profile dir's deps/, build/ and .fingerprint/, the files and folders
// of units this build did not use. A target restored from an older entry
// (a restore key) keeps the old versions of whatever changed beside the new
// ones, and saving it carried them on forever: CI's test build grew from
// 671 MB to 1,687 MB in a day, two thirds of the way to the 2 GB an entry
// may hold, and its restore from 15 s to a minute. Anything unexpected
// (Cargo fails, lists nothing) prunes nothing.
//
// tidy deletes the entries a newer one of the same kind has replaced. A
// kind is a key less its last part (`cargo-test-Linux-1.99.0-` for
// `cargo-test-Linux-1.99.0-830c05ffde674de7`), on one ref: each new
// lockfile saves a new entry of every kind, and the old ones stayed until
// the repository's 10 GiB was full, when the entries restored longest ago
// went, which were Deploy's. On the day this was written the repository
// held 10.4 GiB, most of it two or three generations of the same builds,
// and a deploy found none of its caches. The newest entry of a kind stays,
// as does any used in the last hour (a run may be restoring it), and
// sccache's, one for each compiled crate, are left to the quota. Needs a
// token that may delete the repository's caches (`actions: write`).
//
//   node scripts/deploy/ci-cache.mjs tidy [--dry-run]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILDER } from "../cli-release.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The `[[package]]` blocks of a Cargo.lock that come from a registry or git: not the workspace's own. */
export function externalPackages(lock) {
  return lock
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) => block.trim())
    .filter((block) => /^source = /m.test(block))
    .sort();
}

/** 16 hex characters of the SHA-256 of a Cargo.lock's external packages. */
export function depsHash(lock) {
  return createHash("sha256").update(externalPackages(lock).join("\n\n")).digest("hex").slice(0, 16);
}

/** 12 hex characters of an image reference's digest (`name@sha256:…`); null for a tag, which moves. */
export function imageDigest(reference) {
  return reference.match(/@sha256:([0-9a-f]{64})$/)?.[1].slice(0, 12) ?? null;
}

/** `1.99.0` from `rustc 1.99.0 (90b35a623 2026-09-30)`; null if it is not that. */
export function rustVersion(text) {
  return text.match(/^rustc (\S+)/)?.[1] ?? null;
}

function keys() {
  const rustc = spawnSync("rustc", ["-V"], { encoding: "utf8" });
  const rust = rustVersion(rustc.stdout ?? "");
  if (!rust) throw new Error(`rustc -V said ${JSON.stringify(rustc.stdout ?? rustc.error?.message)}`);
  const zigbuild = imageDigest(BUILDER);
  if (!zigbuild) throw new Error(`scripts/cli-release.mjs builds in ${BUILDER}, which is not pinned by digest`);
  const outputs = { rust, zigbuild };
  for (const [name, path] of [
    ["cargo", "Cargo.lock"],
    ["desktop", "apps/desktop/src-tauri/Cargo.lock"],
  ]) {
    const file = join(ROOT, path);
    if (existsSync(file)) outputs[name] = depsHash(readFileSync(file, "utf8"));
  }
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

/** The 16-hex-character hash Cargo puts on a unit's files and folders (`libserde-0123456789abcdef.rlib`), or null. */
export function unitHash(name) {
  return name.match(/-([0-9a-f]{16})(?:\.[^/]*)?$/)?.[1] ?? null;
}

/** The hashes of every unit in Cargo's JSON messages: its files, and a build script's out dir. */
export function usedHashes(messages) {
  const used = new Set();
  for (const line of messages.split("\n")) {
    if (!line.startsWith("{")) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const paths = [...(m.filenames ?? []), ...(m.executable ? [m.executable] : [])];
    if (m.reason === "build-script-executed" && m.out_dir) paths.push(m.out_dir.replace(/[\\/]out$/, ""));
    for (const path of paths) {
      // A unit's own folder (build/foo-<hash>/build-script-build) or file (deps/libfoo-<hash>.rlib).
      for (const part of path.split(/[\\/]/).slice(-2)) {
        const hash = unitHash(part);
        if (hash) used.add(hash);
      }
    }
  }
  return used;
}

/** What to delete from a profile dir: deps/ files and build/, .fingerprint/ folders of units not in `used`. */
export function stale(dir, used) {
  const out = [];
  for (const sub of ["deps", "build", ".fingerprint"]) {
    const at = join(dir, sub);
    if (!existsSync(at)) continue;
    for (const name of readdirSync(at)) {
      const hash = unitHash(name);
      if (hash && !used.has(hash)) out.push(join(at, name));
    }
  }
  return out;
}

function bytes(path) {
  const s = statSync(path, { throwIfNoEntry: false });
  if (!s) return 0;
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), 0);
}

function prune(args) {
  const split = args.indexOf("--");
  const dirs = split < 0 ? [] : args.slice(0, split);
  const cargo = split < 0 ? [] : args.slice(split + 1);
  if (!dirs.length || !cargo.length) throw new Error("usage: ci-cache.mjs prune <profile dir>... -- <cargo args>");
  const listed = spawnSync("cargo", [...cargo, "--message-format=json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const used = listed.status === 0 ? usedHashes(listed.stdout) : new Set();
  if (!used.size) {
    console.log(`::warning title=Cargo cache::cargo ${cargo.join(" ")} did not list what it built, so nothing is pruned`);
    return;
  }
  for (const dir of dirs) {
    const before = bytes(join(ROOT, dir));
    const gone = stale(join(ROOT, dir), used);
    for (const path of gone) rmSync(path, { recursive: true, force: true });
    const after = bytes(join(ROOT, dir));
    const mb = (n) => `${Math.round(n / 1_048_576)} MB`;
    console.log(`${dir}: ${gone.length} files and folders of units this build did not use, ${mb(before - after)}; ${mb(after)} left`);
  }
}

/** An entry's kind: its ref, and its key less the last `-part`. */
export function kind(entry) {
  const cut = entry.key.lastIndexOf("-");
  return `${entry.ref} ${cut > 0 ? entry.key.slice(0, cut + 1) : entry.key}`;
}

/** How long since its last use an entry replaced by a newer one is kept: a run may still be restoring it. */
export const REPLACED_IDLE_MS = 60 * 60 * 1000;

/**
 * The entries (as the caches API lists them) that a newer entry of the
 * same kind has replaced, and that nothing has used in REPLACED_IDLE_MS.
 */
export function replaced(entries, now = Date.now()) {
  const newest = new Map();
  for (const entry of entries) {
    if (entry.key.startsWith("sccache/")) continue;
    const at = newest.get(kind(entry));
    if (!at || Date.parse(entry.created_at) > Date.parse(at.created_at)) newest.set(kind(entry), entry);
  }
  return entries.filter(
    (entry) =>
      !entry.key.startsWith("sccache/") && newest.get(kind(entry)) !== entry && now - Date.parse(entry.last_accessed_at ?? entry.created_at) > REPLACED_IDLE_MS,
  );
}

/** A caches API answer's JSON, or null when it has none: a deleted entry answers 204 with an empty body. */
export async function answer(response) {
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

async function tidy(args) {
  const dryRun = args.includes("--dry-run");
  const api = process.env.GITHUB_API_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.CACHE_TOKEN;
  if (!api || !repo || !token) throw new Error("tidy needs GITHUB_API_URL, GITHUB_REPOSITORY and CACHE_TOKEN");
  const call = async (method, path) => {
    const response = await fetch(`${api}/repos/${repo}/actions/caches${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`${method} caches${path}: ${response.status} ${await response.text()}`);
    return answer(response);
  };
  const entries = [];
  for (let page = 1; ; page++) {
    const { actions_caches: found = [] } = await call("GET", `?per_page=100&page=${page}&sort=created_at`);
    entries.push(...found);
    if (found.length < 100) break;
  }
  const gone = replaced(entries);
  const mb = (n) => `${Math.round(n / 1_048_576)} MB`;
  const total = (list) => list.reduce((sum, e) => sum + (e.size_in_bytes ?? 0), 0);
  for (const entry of gone) {
    console.log(`${dryRun ? "would delete" : "deleting"} ${entry.key} (${entry.ref}, ${mb(entry.size_in_bytes ?? 0)})`);
    if (!dryRun) await call("DELETE", `/${entry.id}`);
  }
  console.log(`${gone.length} of ${entries.length} entries replaced by newer ones, ${mb(total(gone))} of ${mb(total(entries))}`);
}

if (process.argv[1] && basename(process.argv[1]) === "ci-cache.mjs") {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "keys") keys();
  else if (command === "prune") prune(rest);
  else if (command === "tidy") await tidy(rest);
  else {
    console.error("usage: node scripts/deploy/ci-cache.mjs keys | prune <profile dir>... -- <cargo args> | tidy [--dry-run]");
    process.exit(2);
  }
}
