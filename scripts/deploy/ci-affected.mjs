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
//   node scripts/deploy/ci-affected.mjs --npm
//
// With --job it says whether a run needs one of CI's other jobs (JOBS), as
// the output `run` (true or false), on the same terms: anything but a pull
// request or a queue state, or anything failing, runs it, except a push of
// a commit the merge queue tested (below). With --npm it says which npm
// workspaces the TypeScript job type checks and tests, how much it
// installs, and which of its other checks run (npmPlan, below).
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
import { basename, dirname, join, relative, sep } from "node:path";
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
 * The npm workspaces the build job builds (`deploy.mjs build --only
 * web,sudo,docs`), and the deploy tool's own files it builds them with.
 */
export const BUILT = ["apps/web", "apps/sudo", "apps/docs"];
export const BUILD_TOOL = ["scripts/deploy.mjs", "scripts/deploy/", "scripts/build-rust-worker.mjs", "scripts/build-runner.mjs", "deploy/stack.jsonc"];

/**
 * CI's other jobs a pull request may pass without running, and whether a
 * change to `files` needs each: `desktop` its own files (DESKTOP), `build`
 * (the site, sudo and the docs) a change that reaches one of their npm
 * workspaces (npmAffected, through `npm`, the workspace graph) or the
 * deploy tool that builds them.
 */
export const JOBS = {
  desktop: (files) => files.some((file) => DESKTOP.some((entry) => under(file, entry))),
  build: (files, npm) => {
    if (files.some((file) => BUILD_TOOL.some((entry) => under(file, entry)))) return true;
    const reached = npmAffected(npm, files);
    return reached === null || npm.some((w) => BUILT.includes(w.dir) && reached.includes(w.name));
  },
};

/** Whether a change to `files` needs `job` (a key of JOBS) to run; `npm` is the npm workspace graph (npmGraph). */
export function needs(job, files, npm = []) {
  return files.length > 0 && JOBS[job](files, npm);
}

/**
 * Whether `path` is `entry`, or under it when `entry` is a folder (a
 * trailing `/`). In `entry`, `*` stands for one path segment's name, and
 * a leading `**` and slash for any folders: every wrangler.jsonc, say.
 */
function under(path, entry) {
  if (!entry.includes("*")) return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
  const pattern = entry
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/^\*\*\//, "(?:.*/)?")
    .replace(/(?<!\.)\*/g, "[^/]*");
  return new RegExp(`^${pattern}${entry.endsWith("/") ? "" : "$"}`).test(path);
}

// ── npm workspaces ──────────────────────────────────────────────────────
//
// The TypeScript job, on a pull request or a queue state, type checks and
// tests only the npm workspaces the change reaches: those whose folder holds
// a changed file (or that read it, NPM_READS), and every workspace that
// depends on them, however far, through package.json `dependencies` and
// `devDependencies` (packages/contracts reaches the apps and every service).
// A change to the install or to the TypeScript every workspace shares
// (NPM_EVERYTHING) reaches all of them. Its other checks run when their own
// files change (CHECKS). A push runs everything, as for the Rust parts.

/**
 * Files any change to which type checks and tests every npm workspace and
 * runs every check of the TypeScript job: the root manifest and lockfile,
 * npm's and Node's settings, the TypeScript options every workspace extends,
 * this workflow, and the scripts that decide and run it.
 */
export const NPM_EVERYTHING = [
  "package.json",
  "package-lock.json",
  ".npmrc",
  ".nvmrc",
  "tsconfig.base.json",
  ".g1t/workflows/ci.yml",
  "scripts/deploy/ci-affected.mjs",
  "scripts/deploy/ci-workspaces.mjs",
  "scripts/deploy/npm-ci.mjs",
  // npmWorkspace(), the graph this file walks.
  "scripts/deploy/stack.mjs",
];

/**
 * Files outside a workspace's folder (or in another's, by a path rather
 * than a package dependency) that its code or tests read, and the
 * workspaces (by folder) that read them. ci-affected.test.mjs checks that
 * every relative path a workspace's source names outside its folder is
 * here or a package dependency.
 */
export const NPM_READS = [
  // og's cards name a roadmap item as the site does.
  ["apps/web/app/lib/roadmap.ts", ["services/og"]],
  // markdown-tree.test.ts renders the repository's own documents.
  ["README.md", ["apps/web"]],
  ["CONTRIBUTING.md", ["apps/web"]],
  // So does the docs' Cloudflare guide, under apps/docs (no dependency).
  ["apps/docs/src/content/docs/guides/deploy-to-cloudflare.md", ["apps/web"]],
  // The phone app's icon script draws the mark.
  ["packages/theme/mark.svg", ["apps/mobile"]],
];

/**
 * The TypeScript job's checks besides the workspaces' own, and the files
 * each reads: the tests of the deploy tool, the conformance report and the
 * ops scripts, the deploy manifest against every wrangler.jsonc, and the
 * Claude Code plugin's hooks and published marketplace. Each runs when one
 * of its files changes, or with NPM_EVERYTHING. ci-affected.test.mjs checks
 * that every repository path their tests name is among them.
 */
export const CHECKS = {
  // scripts/deploy/*.test.mjs: the deploy tool and what it plans from.
  deploy: [
    "scripts/",
    "deploy/",
    ".g1t/workflows/",
    ".gitignore",
    "Cargo.lock",
    "services/runner/",
    "services/identity/",
    "services/*/migrations/",
    "**/wrangler.jsonc",
    "**/wrangler.toml",
    "**/Cargo.toml",
    "**/package.json",
  ],
  // conformance/*.test.mjs: the services' Rust, SQL and migrations,
  // run in Miniflare.
  conformance: ["conformance/", "scripts/conformance-diff.mjs", "scripts/deploy/stack.mjs", "services/"],
  // scripts/ops/*.test.mjs.
  ops: ["scripts/ops/", "scripts/deploy/", "services/repos/wrangler.jsonc", "services/billing/src/", "deploy/self-host/"],
  // deploy.mjs manifest --check.
  manifest: ["deploy/stack.jsonc", "scripts/deploy.mjs", "scripts/deploy/", "**/wrangler.jsonc", "**/wrangler.toml"],
  // The plugin's hooks' tests, and plugins-release.mjs check and its tests.
  plugins: ["plugins/", "scripts/plugins-release.mjs", "scripts/plugins-release.test.mjs"],
};

/** The checks (keys of CHECKS) a change to `files` runs; `null` files run every one. */
export function checks(files) {
  return Object.keys(CHECKS).filter(
    (name) => files === null || files.some((file) => NPM_EVERYTHING.includes(file) || CHECKS[name].some((entry) => under(file, entry))),
  );
}

/**
 * The npm workspaces as a list: each one's package name, its folder, the
 * workspaces it depends on, and its scripts (from npmWorkspace's map, and
 * each package.json).
 */
export function npmGraph(packages, scriptsOf = () => ({})) {
  return [...packages].map(([name, { dir, deps }]) => ({ name, dir, deps: [...deps], scripts: scriptsOf(dir) }));
}

/**
 * The npm workspaces a change to `files` reaches: `null` for every one,
 * otherwise their names, sorted. A file belongs to the workspace whose
 * folder holds it.
 */
export function npmAffected(graph, files) {
  const byDir = new Map(graph.map((w) => [w.dir, w.name]));
  const touched = new Set();
  for (const file of files) {
    if (NPM_EVERYTHING.includes(file)) return null;
    const owner = graph.find((w) => file.startsWith(`${w.dir}/`));
    if (owner) touched.add(owner.name);
    for (const [entry, readers] of NPM_READS) if (under(file, entry)) for (const dir of readers) if (byDir.has(dir)) touched.add(byDir.get(dir));
  }
  const dependents = new Map(graph.map((w) => [w.name, []]));
  for (const w of graph) for (const dep of w.deps) dependents.get(dep)?.push(w.name);
  const out = new Set();
  const queue = [...touched];
  while (queue.length) {
    const name = queue.pop();
    if (out.has(name)) continue;
    out.add(name);
    queue.push(...(dependents.get(name) ?? []));
  }
  return [...out].sort();
}

/** `names` and every workspace they depend on, however far: what an install of them needs. */
export function npmClosure(graph, names) {
  const byName = new Map(graph.map((w) => [w.name, w]));
  const out = new Set();
  const queue = [...names];
  while (queue.length) {
    const name = queue.pop();
    if (out.has(name) || !byName.has(name)) continue;
    out.add(name);
    queue.push(...byName.get(name).deps);
  }
  return [...out].sort();
}

/**
 * What the TypeScript job does for a change: `reached` the workspaces it
 * reaches (`null` for every one, see npmAffected), `checks` (CHECKS) to
 * run, and `tested`, a push the merge queue tested, which only type checks
 * every workspace (for tsc's cache) and runs nothing else. Returns:
 *
 *   typecheck  workspaces whose `typecheck` script runs
 *   test       workspaces whose `test` script runs
 *   checks     the checks that run
 *   install    `all`, `none`, or the npm ci arguments that install only
 *              the workspaces checked and what they depend on
 *   whole      every workspace is checked and tested
 */
export function npmPlan(graph, { reached, checks: run, tested = false }) {
  const all = reached === null || tested;
  const names = all ? graph.map((w) => w.name) : reached;
  const has = (script) => graph.filter((w) => names.includes(w.name) && w.scripts?.[script]).map((w) => w.name);
  const typecheck = has("typecheck");
  const test = tested ? [] : has("test");
  const checks = tested ? [] : run;
  const workspaces = [...new Set([...typecheck, ...test])];
  let install;
  if (all) install = "all";
  // Conformance runs Miniflare and esbuild, the root's (wrangler's).
  else if (!workspaces.length) install = checks.includes("conformance") ? "--workspaces=false" : "none";
  else install = ["--include-workspace-root", ...npmClosure(graph, workspaces).flatMap((name) => ["-w", name])].join(" ");
  return { typecheck, test, checks, install, whole: all };
}

/** The repository's npm workspaces, with their scripts. */
async function repositoryGraph() {
  const { npmWorkspace } = await import("./stack.mjs");
  return npmGraph(npmWorkspace(ROOT), (dir) => JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")).scripts ?? {});
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
      run = needs(job, files, job === "build" ? await repositoryGraph() : []);
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

/**
 * `--npm`: what the TypeScript job does (npmPlan), as the outputs
 * `typecheck` and `test` (workspace names, space-separated), `install`
 * (whether it installs at all) and `install-args` (npm ci's arguments for
 * part of the lockfile, empty for all of it), `whole`, `tested`, and each
 * check of CHECKS as true or false.
 */
async function mainNpm() {
  const queue = await tested();
  if (queue.tested) console.log(queue.why);
  const graph = await repositoryGraph();
  let reached = null;
  let changed = [];
  try {
    const { files, why } = changedFiles();
    if (files) {
      reached = npmAffected(graph, files);
      changed = files;
      console.log(
        `${files.length} files changed; ${reached ? `workspaces reached: ${reached.join(", ") || "none"}` : "the install's or the job's own files among them, so every workspace"}`,
      );
    } else {
      console.log(why.replace("tests every crate", "checks every workspace"));
    }
  } catch (error) {
    console.log(`::warning title=Affected workspaces::${error.message.split("\n")[0]}; every workspace is checked`);
    reached = null;
  }
  const plan = npmPlan(graph, { reached, checks: checks(reached === null ? null : changed), tested: queue.tested });
  console.log(`Type checks: ${plan.typecheck.join(" ") || "none"}`);
  console.log(`Tests: ${queue.tested ? "none (the merge queue ran them)" : plan.test.join(" ") || "none"}`);
  console.log(`Checks: ${plan.checks.join(", ") || "none"}`);
  console.log(`Install: ${plan.install}`);
  const lines = [
    `tested=${queue.tested}`,
    `typecheck=${plan.typecheck.join(" ")}`,
    `test=${plan.test.join(" ")}`,
    `install=${plan.install !== "none"}`,
    `install-args=${plan.install === "all" || plan.install === "none" ? "" : plan.install}`,
    `whole=${plan.whole}`,
    ...Object.keys(CHECKS).map((name) => `${name}=${plan.checks.includes(name)}`),
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

async function main(args) {
  if (args[0] === "--job") return mainJob(args[1]);
  if (args[0] === "--tested") return mainTested();
  if (args[0] === "--npm") return mainNpm();
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
