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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** `1.99.0` from `rustc 1.99.0 (90b35a623 2026-09-30)`; null if it is not that. */
export function rustVersion(text) {
  return text.match(/^rustc (\S+)/)?.[1] ?? null;
}

function keys() {
  const rustc = spawnSync("rustc", ["-V"], { encoding: "utf8" });
  const rust = rustVersion(rustc.stdout ?? "");
  if (!rust) throw new Error(`rustc -V said ${JSON.stringify(rustc.stdout ?? rustc.error?.message)}`);
  const outputs = { rust };
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

if (process.argv[1] && basename(process.argv[1]) === "ci-cache.mjs") {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "keys") keys();
  else if (command === "prune") prune(rest);
  else {
    console.error("usage: node scripts/deploy/ci-cache.mjs keys | prune <profile dir>... -- <cargo args>");
    process.exit(2);
  }
}
