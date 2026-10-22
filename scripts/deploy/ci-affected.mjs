// Which of a CI Rust part's crates a run tests. On a pull request or a
// merge queue state, the workspace crates whose files it changes and every
// workspace crate that depends on them (from `cargo metadata`, through
// dependencies of every kind); anywhere else, every one. Most pull
// requests touch a few crates, and a part compiled and tested all of its
// own whatever changed.
//
//   node scripts/deploy/ci-affected.mjs -p <crate>...
//   node scripts/deploy/ci-affected.mjs --job desktop|build
//   node scripts/deploy/ci-affected.mjs --tested
//
// With --job it says whether a run needs one of CI's other jobs (JOBS), as
// the output `run` (true or false), on the same terms: anything but a pull
// request or a queue state, or anything failing, runs it, except a push of
// a commit the merge queue tested (below).
//
// It takes the part's `-p` arguments and writes to the step's outputs
// (GITHUB_OUTPUT):
//
//   crates  those of them to test, in the same order: all, some or none
//   whole   true when that is all of them
//   tested  true when the merge queue tested this commit (below): the part
//           compiles its tests, for main's caches, and runs none
//
// What a pull request changes is its test merge commit against its first
// parent, the base branch's tip it was merged into (services/repos
// test_merge.rs), so the checkout fetches two commits deep. What a merge
// queue state changes is its commit against the default branch's tip it
// was built on (the event's `merge_group.base_sha`), fetched when the
// entries ahead put it deeper than that. When the commit is not a merge
// (g1t could not make one and the run builds the head), or anything here
// fails, every crate is tested.
//
// A push to main of a commit a `merge_group` run of CI passed on is one
// the merge queue landed: it moves main to exactly the commit it tested
// (services/work queue.rs lands by fast-forward to the tested state). Such
// a push is `tested` (--tested writes only that), asked of the API with
// the job's token (GITHUB_TOKEN, which needs `actions: read`). Any other
// push, or a question that fails, is not, and CI tests everything.
//
// A file outside every crate's folder tests the crates that read it
// (READS), or every crate when the build itself reads it (EVERYTHING), and
// nothing otherwise: the site, the TypeScript services and the docs are
// not the Rust build's. ci-affected.test.mjs checks that every file a
// crate's source names outside its own folder is in one or the other.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
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
  // The merge queue's tests check that the runner's sweep builds a queue
  // waiting on a refusal again, every five minutes.
  ["services/runner/src/index.ts", ["g1t-work"]],
  ["services/runner/wrangler.jsonc", ["g1t-work"]],
  // Code scanning's tests read the scanner's fixtures.
  ["crates/scan/fixtures/", ["g1t-security"]],
];

/**
 * The desktop job's files: the app, outside the workspace with a lockfile
 * of its own and no path dependency on it; the release scripts whose tests
 * the job runs, and the CLI's manifest cli-release.mjs reads its version
 * from; what installs Tauri's packages; and the toolchain and this
 * workflow's own files.
 */
export const DESKTOP = [
  "apps/desktop/",
  "scripts/desktop-release.mjs",
  "scripts/desktop-release.test.mjs",
  "scripts/mobile-release.mjs",
  "scripts/mobile-release.test.mjs",
  "scripts/cli-release.mjs",
  "scripts/cli-release.test.mjs",
  "crates/g1t/Cargo.toml",
  "scripts/apt-install.sh",
  "rust-toolchain",
  "rust-toolchain.toml",
  ".cargo/",
  ".g1t/workflows/ci.yml",
  "scripts/deploy/ci-affected.mjs",
  "scripts/deploy/ci-cache.mjs",
];

/**
 * CI's other jobs a pull request may pass without running, and whether a
 * changed file needs each: `desktop` its own files (DESKTOP), `build` (the
 * site, sudo and the docs) any file but Rust source, which none of them
 * reads. TypeScript runs on every pull request: its tests and the
 * conformance suite read Rust source and manifests throughout.
 */
export const JOBS = {
  desktop: (file) => DESKTOP.some((entry) => under(file, entry)),
  build: (file) => !file.endsWith(".rs"),
};

/** Whether a change to `files` needs `job` (a key of JOBS) to run. */
export function needs(job, files) {
  return files.some(JOBS[job]);
}

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

/** The run's event payload (GITHUB_EVENT_PATH), or an empty one. */
function eventPayload() {
  const path = process.env.GITHUB_EVENT_PATH;
  return path ? JSON.parse(readFileSync(path, "utf8")) : {};
}

/** The commit a run's changes are against: a pull request's base tip, or a queue state's. */
function base() {
  const event = process.env.GITHUB_EVENT_NAME;
  if (event === "pull_request") {
    const parents = git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").slice(1);
    return parents.length === 2 ? { base: parents[0] } : { why: "HEAD is not the pull request's test merge commit" };
  }
  if (event === "merge_group") {
    const sha = eventPayload().merge_group?.base_sha;
    if (!sha) return { why: "the merge group names no base commit" };
    // Behind the entries ahead of this one, past the checkout's depth.
    if (spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: ROOT }).status !== 0) {
      git("fetch", "--no-tags", "--quiet", "--depth=1", "origin", sha);
    }
    return { base: sha };
  }
  return { why: `a ${event ?? "local"} run tests every crate` };
}

/** The files a pull request's test merge commit, or a merge queue state, changes, or why they are not known. */
function changedFiles() {
  const { base: from, why } = base();
  if (!from) return { why };
  // Both sides of a rename: the crate it left changed too.
  const files = git("diff", "--name-only", "--no-renames", "-z", from, "HEAD").split("\0").filter(Boolean);
  return { files };
}

/** The workflow whose `merge_group` runs vouch for a push. */
export const WORKFLOW = "ci.yml";

/**
 * Whether `runs` (the API's answer for CI's runs on `sha`) hold a
 * `merge_group` run that passed on that very commit. Each is checked, not
 * only filtered by the query: a filter the API ignored never vouches.
 */
export function queueTested(runs, sha) {
  const list = Array.isArray(runs) ? runs : (runs?.workflow_runs ?? []);
  return list.some(
    (run) =>
      run.event === "merge_group" && (run.sha ?? run.head_sha) === sha && run.conclusion === "success" && (!run.path || run.path.split("/").pop() === WORKFLOW),
  );
}

/**
 * Whether this run is a push of a commit the merge queue tested (see the
 * top of this file), and why. Never throws: a failure says no.
 */
async function tested() {
  const { GITHUB_EVENT_NAME: event, GITHUB_SHA: sha, GITHUB_API_URL: api, GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = process.env;
  if (event !== "push") return { tested: false, why: `a ${event ?? "local"} run is not one the merge queue landed` };
  try {
    if (!sha || !api || !repo) throw new Error("GITHUB_SHA, GITHUB_API_URL and GITHUB_REPOSITORY are needed");
    const query = new URLSearchParams({ event: "merge_group", head_sha: sha, status: "success", per_page: "10" });
    const response = await fetch(`${api}/repos/${repo}/actions/workflows/${WORKFLOW}/runs?${query}`, {
      headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${WORKFLOW}'s runs: ${response.status} ${(await response.text()).slice(0, 200)}`);
    const yes = queueTested(await response.json(), sha);
    return {
      tested: yes,
      why: yes
        ? `the merge queue tested ${sha.slice(0, 12)}, so its tests are not run again`
        : `no merge_group run passed on ${sha.slice(0, 12)}: a push that did not come through the merge queue tests everything`,
    };
  } catch (error) {
    console.log(`::warning title=Merge queue::${error.message.split("\n")[0]}; this push tests everything`);
    return { tested: false, why: "whether the merge queue tested it is not known" };
  }
}

/** `--tested`: writes `tested`, whether the merge queue tested this push's commit. */
async function mainTested() {
  const { tested: yes, why } = await tested();
  console.log(why);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tested=${yes}\n`);
}

/** `--job <name>`: writes `run`, whether this run needs the job. */
async function mainJob(job) {
  if (!JOBS[job]) throw new Error(`no job ${job}: one of ${Object.keys(JOBS).join(", ")}`);
  const queue = await tested();
  if (queue.tested) {
    console.log(`${queue.why}; the ${job} job passes without running`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "run=false\n");
    return;
  }
  let run = true;
  try {
    const { files, why } = changedFiles();
    if (files) {
      run = needs(job, files);
      console.log(`${files.length} files changed; ${run ? `the ${job} job's among them` : `none of them the ${job} job's, so it passes without running`}`);
    } else {
      console.log(why.replace("tests every crate", `runs the ${job} job`));
    }
  } catch (error) {
    console.log(`::warning title=Affected files::${error.message.split("\n")[0]}; the ${job} job runs`);
    run = true;
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}

async function main(args) {
  if (args[0] === "--job") return mainJob(args[1]);
  if (args[0] === "--tested") return mainTested();
  const part = partCrates(args);
  let test = part;
  // A push: every crate, compiled, and tested unless the queue did.
  const queue = await tested();
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tested=${queue.tested}\n`);
  if (queue.tested) console.log(queue.why);
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
  console.log(
    `This part ${queue.tested ? "compiles the tests of" : "tests"} ${test.length} of its ${part.length} crates${test.length ? `: ${test.join(", ")}` : ""}`,
  );
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `crates=${outputs.crates}\nwhole=${outputs.whole}\n`);
}

if (process.argv[1] && basename(process.argv[1]) === "ci-affected.mjs") await main(process.argv.slice(2));
