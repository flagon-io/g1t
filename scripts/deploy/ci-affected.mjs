// Which of a CI Rust part's crates a run tests. On a pull request, the
// workspace crates whose files it changes and every workspace crate that
// depends on them (from `cargo metadata`, through dependencies of every
// kind); anywhere else, every one. Most pull requests touch a few crates,
// and a part compiled and tested all of its own whatever changed.
//
//   node scripts/deploy/ci-affected.mjs -p <crate>...
//
// It takes the part's `-p` arguments and writes to the step's outputs
// (GITHUB_OUTPUT):
//
//   crates  those of them to test, in the same order: all, some or none
//   whole   true when that is all of them
//
// What a pull request changes is its test merge commit against its first
// parent, the base branch's tip it was merged into (services/repos
// test_merge.rs), so the checkout fetches two commits deep. When the commit
// is not a merge (g1t could not make one and the run builds the head), or
// anything here fails, every crate is tested.
//
// A file outside every crate's folder tests the crates that read it
// (READS), or every crate when the build itself reads it (EVERYTHING), and
// nothing otherwise: the site, the TypeScript services and the docs are
// not the Rust build's. ci-affected.test.mjs checks that every file a
// crate's source names outside its own folder is in one or the other.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Files any change to which tests every crate: the workspace's manifest
 * and lockfile, the toolchain and Cargo's settings, this workflow, and the
 * scripts its Rust job runs. A path ending in `/` is a folder.
 */
export const EVERYTHING = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain",
  "rust-toolchain.toml",
  ".cargo/",
  ".g1t/workflows/ci.yml",
  "scripts/sccache.sh",
  "scripts/deploy/ci-affected.mjs",
  "scripts/deploy/ci-cache.mjs",
  // ci-cache.mjs keys reads the CLI builder's digest from it.
  "scripts/cli-release.mjs",
];

/**
 * Files outside a crate's folder (or in another's) that a crate's code or
 * tests read, and the crates that read them. A path ending in `/` is a
 * folder.
 */
export const READS = [
  // repository_workflows.rs reads g1t's workflows, and the managed deploy
  // workflow and g1t's own actions.
  [".g1t/workflows/", ["g1t-actions"]],
  [".github/workflows/", ["g1t-actions"]],
  ["workflows/", ["g1t-actions"]],
  ["actions/", ["g1t-actions"]],
  // The Rust contracts are checked against their TypeScript mirror.
  ["packages/contracts/src/", ["g1t-contracts"]],
  // The CLI checks the commands its docs and the plugins name, and the
  // API's routes against the OpenAPI document; the agent sessions hand out
  // the plugin's skills.
  ["apps/docs/src/content/docs/", ["g1t"]],
  ["apps/docs/src/data/openapi.json", ["g1t", "g1t-api"]],
  ["plugins/", ["g1t", "g1t-integrations"]],
  ["README.md", ["g1t"]],
  // The sandbox's image, built into the runner.
  ["deploy/sandbox/", ["g1t-runner"]],
  // Code scanning's tests read the scanner's fixtures.
  ["crates/scan/fixtures/", ["g1t-security"]],
];

/** Whether `path` is `entry`, or under it when `entry` is a folder. */
function under(path, entry) {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

/**
 * The workspace's crates from `cargo metadata --no-deps`: each one's name,
 * its folder relative to the workspace root, and the workspace crates it
 * depends on.
 */
export function workspace(metadata) {
  const root = metadata.workspace_root;
  const members = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter((p) => members.has(p.id));
  const names = new Set(packages.map((p) => p.name));
  return packages.map((p) => ({
    name: p.name,
    dir: relative(root, dirname(p.manifest_path)).split(sep).join("/"),
    deps: [...new Set(p.dependencies.filter((d) => d.path && names.has(d.name)).map((d) => d.name))],
  }));
}

/**
 * The crates to test for a change to `files` (paths from the repository's
 * root): `null` for every one, otherwise their names. A file belongs to the
 * crate whose folder holds it most closely.
 */
export function affected(crates, files) {
  const touched = new Set();
  for (const file of files) {
    if (EVERYTHING.some((entry) => under(file, entry))) return null;
    const owner = crates.filter((c) => file.startsWith(`${c.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (owner) touched.add(owner.name);
    for (const [entry, readers] of READS) if (under(file, entry)) readers.forEach((name) => touched.add(name));
  }
  const dependents = new Map(crates.map((c) => [c.name, []]));
  for (const c of crates) for (const dep of c.deps) dependents.get(dep)?.push(c.name);
  const out = new Set();
  const queue = [...touched].filter((name) => dependents.has(name));
  while (queue.length) {
    const name = queue.pop();
    if (out.has(name)) continue;
    out.add(name);
    queue.push(...dependents.get(name));
  }
  return [...out].sort();
}

/** A part's crates from its `-p` arguments; throws on anything else. */
export function partCrates(args) {
  const crates = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== "-p" || !args[i + 1]) throw new Error(`expected -p <crate>..., got ${args.join(" ")}`);
    crates.push(args[i + 1]);
  }
  return crates;
}

function git(...args) {
  const out = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${(out.stderr || out.error?.message || "").trim()}`);
  return out.stdout;
}

/** The files a pull request's test merge commit changes, or why they are not known. */
function changedFiles() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") return { why: `a ${process.env.GITHUB_EVENT_NAME ?? "local"} run tests every crate` };
  const parents = git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").slice(1);
  if (parents.length !== 2) return { why: "HEAD is not the pull request's test merge commit" };
  // Both sides of a rename: the crate it left changed too.
  const files = git("diff", "--name-only", "--no-renames", "-z", parents[0], "HEAD").split("\0").filter(Boolean);
  return { files };
}

function main(args) {
  const part = partCrates(args);
  let test = part;
  try {
    const { files, why } = changedFiles();
    if (files) {
      const meta = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
      if (meta.status !== 0) throw new Error(`cargo metadata: ${(meta.stderr || meta.error?.message || "").trim()}`);
      const names = affected(workspace(JSON.parse(meta.stdout)), files);
      if (names) test = part.filter((name) => names.includes(name));
      console.log(
        `${files.length} files changed; ${names ? `crates to test: ${names.join(", ") || "none"}` : "the build's own files among them, so every crate"}`,
      );
    } else {
      console.log(why);
    }
  } catch (error) {
    console.log(`::warning title=Affected crates::${error.message.split("\n")[0]}; every crate is tested`);
    test = part;
  }
  const outputs = { crates: test.map((name) => `-p ${name}`).join(" "), whole: String(test.length === part.length) };
  console.log(`This part tests ${test.length} of its ${part.length} crates${test.length ? `: ${test.join(", ")}` : ""}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `crates=${outputs.crates}\nwhole=${outputs.whole}\n`);
}

if (process.argv[1] && basename(process.argv[1]) === "ci-affected.mjs") main(process.argv.slice(2));
