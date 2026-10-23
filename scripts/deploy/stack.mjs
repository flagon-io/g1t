// The deploy manifest (deploy/stack.jsonc) and what it implies: each
// unit's Wrangler config, the shared crates and packages it is built from,
// and which units a set of changed files touches. Pure apart from reading
// files and `cargo metadata`, so the tests can drive it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const STACK_FILE = "deploy/stack.jsonc";
export const KINDS = ["rust-worker", "ts-worker", "react-router", "astro"];
export const SELF_HOST = ["run", "off", "separate", "none"];

/** Strips comments and trailing commas from JSONC. Strings are respected. */
export function parseJsonc(text) {
  let result = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      result += char;
      if (char === "\\") result += text[++i];
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      result += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      result += char;
    }
  }
  return JSON.parse(result.replace(/,(\s*[}\]])/g, "$1"));
}

const readJsonc = (path) => parseJsonc(readFileSync(path, "utf8"));
const posix = (path) => path.replaceAll("\\", "/");

/**
 * The manifest, each unit with its Wrangler config beside it.
 * Units keep the manifest's order.
 */
export function loadStack(root = ROOT) {
  const raw = readJsonc(join(root, STACK_FILE));
  const units = Object.entries(raw.units).map(([id, unit]) => {
    const configPath = join(root, unit.path, "wrangler.jsonc");
    const config = existsSync(configPath) ? readJsonc(configPath) : null;
    return {
      id,
      secrets: [],
      setup: [],
      inputs: [],
      ...unit,
      config,
      bindsTo: (config?.services ?? []).map((binding) => binding.service),
    };
  });
  return { stages: raw.stages, resources: raw.resources ?? {}, units };
}

/** The deployable stages (every stage but migrations), in order. */
export const codeStages = (stack) => stack.stages.filter((stage) => stage !== "migrations");

/**
 * Workspace crates: name -> { dir, deps: [names of workspace crates it
 * depends on as a normal or build dependency] }. From `cargo metadata
 * --no-deps`, which reads only the workspace's manifests.
 */
export function cargoWorkspace(root = ROOT, metadata = null) {
  const meta =
    metadata ??
    JSON.parse(
      execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--offline"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  const crates = new Map();
  for (const pkg of meta.packages) {
    crates.set(pkg.name, {
      dir: posix(relative(meta.workspace_root ?? root, dirname(pkg.manifest_path))),
      deps: [],
      raw: pkg,
    });
  }
  for (const crate of crates.values()) {
    crate.deps = crate.raw.dependencies
      // Dev-dependencies are not in what deploys.
      .filter((dep) => dep.kind !== "dev" && dep.path)
      .map((dep) => dep.name)
      .filter((name) => crates.has(name));
    delete crate.raw;
  }
  return crates;
}

/**
 * npm workspace packages: name -> { dir, deps: [workspace package names] }.
 * dependencies and devDependencies both count: a build reads either.
 */
export function npmWorkspace(root = ROOT) {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dirs = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      if (!existsSync(join(root, parent))) continue;
      for (const name of readdirSync(join(root, parent)).sort()) {
        if (existsSync(join(root, parent, name, "package.json"))) dirs.push(`${parent}/${name}`);
      }
    } else if (existsSync(join(root, pattern, "package.json"))) {
      dirs.push(pattern);
    }
  }
  const packages = new Map();
  const declared = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    packages.set(pkg.name, { dir, deps: [] });
    declared.set(pkg.name, Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
  }
  for (const [name, pkg] of packages) pkg.deps = declared.get(name).filter((dep) => packages.has(dep));
  return packages;
}

/** Every name reachable from `start` through `graph` (start excluded). */
function closure(graph, start) {
  const seen = new Set();
  const stack = [...(graph.get(start)?.deps ?? [])];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    stack.push(...(graph.get(name)?.deps ?? []));
  }
  return [...seen];
}

/** Rust's toolchain and Cargo's settings, should the repository pin them. */
export const RUST_TOOLCHAIN = ["rust-toolchain.toml", "rust-toolchain", ".cargo/config.toml", ".cargo/config"];

/**
 * What every unit is built and deployed with: the manifest (which counts
 * for a unit only when its own entry changed, see plan.mjs) and the
 * workflow that builds and deploys it. The deploy tool's own files are
 * counted by `toolInput`.
 */
export const DEPLOY_INPUTS = [STACK_FILE, ".g1t/workflows/deploy.yml", "scripts/deploy.mjs"];

/**
 * Files of the deploy tool (scripts/deploy/) that decide which units
 * deploy, or serve CI, the status page or the Deployments page, but never
 * change what a unit is built into or how it is deployed. Every other file
 * there, a new one included, counts for every unit, unless TOOL_FOR names
 * the units it counts for.
 */
export const TOOL_NOT_INPUTS = [
  "scripts/deploy/plan.mjs",
  "scripts/deploy/lockfiles.mjs",
  "scripts/deploy/report.mjs",
  "scripts/deploy/status-window.mjs",
  "scripts/deploy/ci-affected.mjs",
  "scripts/deploy/ci-cache.mjs",
  "scripts/deploy/ci-workspaces.mjs",
  // Uploads a pull request's preview of the site; production never sees it.
  "scripts/deploy/preview.mjs",
];

/** Files of the deploy tool only some units are built or deployed with. */
export const TOOL_FOR = {
  // Makes the runner's image and the config it is deployed with.
  "scripts/deploy/image.mjs": (unit) => Boolean(unit.image),
  "scripts/deploy/registry.mjs": (unit) => Boolean(unit.image),
  // Archives and checks the site's assets as it deploys (deploy.mjs's ship).
  "scripts/deploy/web-assets.mjs": (unit) => unit.id === "web",
};

/** Whether `file`, a file of the deploy tool, is something `unit` is built or deployed with. */
export function toolInput(unit, file) {
  if (!file.startsWith("scripts/deploy/") || TOOL_NOT_INPUTS.includes(file) || /\.test\.m?js$/.test(file)) return false;
  return TOOL_FOR[file] ? TOOL_FOR[file](unit) : true;
}

/** Files at the root every unit of a kind is built with. */
export function globalInputs(kind) {
  const inputs = ["package.json", ...DEPLOY_INPUTS];
  if (kind === "rust-worker") inputs.push("Cargo.toml", "Cargo.lock", "scripts/build-rust-worker.mjs", ...RUST_TOOLCHAIN);
  // A Rust worker's JavaScript is a small shim worker-build bundles itself,
  // so the npm lockfile only changes what npm-built units ship.
  else inputs.push("package-lock.json", "tsconfig.base.json");
  return inputs;
}

/**
 * A JavaScript or TypeScript test (`x.test.ts`, `x.spec.tsx`): run by
 * `node --test` or Vitest, never imported by what a Worker or site
 * bundles, and left out of each package's tsconfig.
 */
export const isScriptTest = (file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);

/**
 * Adds to each unit what it is built from:
 *   crate / pkg:   its own crate or package name, when it has one;
 *   dependsOn:     folders of the shared crates and packages it uses;
 *   inputs:        the manifest's own inputs plus the root files its kind uses;
 *   image:         for a Containers image, the folders and files it is built from
 *                  (`dirs`, `files`), and its base's folder (`baseDirs`).
 */
export function resolveStack(stack, { cargo, npm }) {
  const crateByDir = new Map([...cargo].map(([name, crate]) => [crate.dir, name]));
  const pkgByDir = new Map([...npm].map(([name, pkg]) => [pkg.dir, name]));
  for (const unit of stack.units) {
    const crate = crateByDir.get(unit.path) ?? null;
    const pkg = pkgByDir.get(unit.path) ?? null;
    const dirs = new Set();
    if (crate) for (const name of closure(cargo, crate)) dirs.add(cargo.get(name).dir);
    if (pkg) for (const name of closure(npm, pkg)) dirs.add(npm.get(name).dir);
    dirs.delete(unit.path);
    unit.crate = crate;
    unit.pkg = pkg;
    unit.dependsOn = [...dirs].sort();
    // The Rust crates it is built from, whose tests, benches and examples
    // are not.
    unit.crateDirs = crate ? [unit.path, ...closure(cargo, crate).map((name) => cargo.get(name).dir)].sort() : [];
    unit.inputs = [...new Set([...(unit.inputs ?? []), ...globalInputs(unit.kind)])].sort();
    if (unit.image) {
      const name = unit.image.crate;
      const crates = name && cargo.has(name) ? [name, ...closure(cargo, name)] : [];
      // The image is the base (recorded in its lock) plus the binary: a
      // change to the base's folder reaches the image only through a new
      // lock, which `build-base` writes.
      const lock = unit.image.base?.lock;
      unit.image = {
        ...unit.image,
        dirs: crates.map((c) => cargo.get(c).dir).sort(),
        // registry.mjs makes the image: the base's layers and one with the binary.
        files: [
          unit.image.dockerfile,
          ...(lock ? [lock] : []),
          "Cargo.toml",
          "Cargo.lock",
          ...RUST_TOOLCHAIN,
          "scripts/build-runner.mjs",
          "scripts/deploy/registry.mjs",
        ],
        baseDirs: unit.image.base ? [unit.image.base.context] : [],
      };
      for (const dir of unit.image.dirs) if (dir !== unit.path) unit.dependsOn.push(dir);
      unit.dependsOn = [...new Set(unit.dependsOn)].sort();
      unit.crateDirs = [...new Set([...unit.crateDirs, ...unit.image.dirs])].sort();
      unit.inputs = [...new Set([...unit.inputs, "Cargo.toml", "Cargo.lock", ...RUST_TOOLCHAIN, "scripts/build-runner.mjs"])].sort();
    }
  }
  return stack;
}

/** The manifest, resolved against this checkout. */
export function resolvedStack(root = ROOT) {
  return resolveStack(loadStack(root), { cargo: cargoWorkspace(root), npm: npmWorkspace(root) });
}

const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);

/** A Rust crate's folders that its library and binaries are never built from. */
export const CRATE_TEST_DIRS = ["tests", "benches", "examples"];

/**
 * Whether `file` is in the tests, benches or examples of one of
 * `crateDirs`: Cargo builds those only for `cargo test`, `cargo bench` and
 * `--example`, never into what deploys.
 */
export function inCrateTests(file, crateDirs = []) {
  return crateDirs.some((dir) => CRATE_TEST_DIRS.some((sub) => under(file, `${dir}/${sub}`)));
}

const dirOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const baseOf = (path) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The `mod name;` declarations in Rust source `text` that `match` (by name,
 * or by a `#[path]`), each with whether it is under `#[cfg(test)]`.
 * Only outline modules (`mod x;`); the attributes are those directly above.
 */
function declarations(text, match) {
  const found = [];
  const pattern = /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?mod\s+(r#)?(\w+)\s*;/g;
  for (const [, attrs, , name] of text.matchAll(pattern)) {
    const path = /#\[\s*path\s*=\s*"([^"]+)"\s*\]/.exec(attrs)?.[1] ?? null;
    if (!match(name, path)) continue;
    found.push(/#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(attrs));
  }
  return found;
}

/**
 * Whether Rust source `file`, in the `src/` of one of `crateDirs`, is
 * compiled only for tests: every module declaration of it found is under
 * `#[cfg(test)]`, or is in a file that is itself only for tests. A file
 * nothing is found to declare (a new crate root, a deleted file, a module
 * declared some way this does not read) counts as built, so a change to it
 * deploys.
 *
 *   read(path):  a file's text at the commit being deployed, "" if absent
 *   list(dir):   the files directly in a folder at that commit
 */
export function testOnlySource(file, crateDirs, { read, list = () => [] }, depth = 0) {
  if (!file.endsWith(".rs") || depth > 16) return false;
  const crateDir = crateDirs.find((dir) => file.startsWith(`${dir}/src/`));
  if (!crateDir) return false;
  const src = `${crateDir}/src`;
  const dir = dirOf(file);
  const base = baseOf(file).slice(0, -".rs".length);
  // Crate roots and binaries are not declared by anything.
  if (dir === src && ["lib", "main"].includes(base)) return false;
  if (dir === `${src}/bin` || (base === "main" && dirOf(dir) === `${src}/bin`)) return false;
  // Where `mod name;` for this file would be: `a/name.rs` and `a/name/mod.rs`
  // are declared by `a.rs` or `a/mod.rs` (by `lib.rs` or `main.rs` in src).
  const name = base === "mod" ? baseOf(dir) : base;
  const parentDir = base === "mod" ? dirOf(dir) : dir;
  const parents = parentDir === src ? [`${src}/lib.rs`, `${src}/main.rs`] : [`${parentDir}/mod.rs`, `${dirOf(parentDir)}/${baseOf(parentDir)}.rs`];
  // One declaration that is built is enough to stop: most changed files
  // are ordinary modules, settled by reading their parent.
  let declared = false;
  const testOnly = (declarer, isTest) => {
    declared = true;
    return isTest || testOnlySource(declarer, crateDirs, { read, list }, depth + 1);
  };
  for (const parent of parents) {
    for (const isTest of declarations(read(parent), (found, path) => found === name && path === null)) {
      if (!testOnly(parent, isTest)) return false;
    }
  }
  // `#[path = "x.rs"] mod y;` in a file beside it names it directly.
  const fileName = baseOf(file);
  for (const sibling of list(dir).filter((path) => path.endsWith(".rs") && path !== file)) {
    for (const isTest of declarations(read(sibling), (_, path) => path === fileName || path === `./${fileName}`)) {
      if (!testOnly(sibling, isTest)) return false;
    }
  }
  return declared;
}

/**
 * Why a set of changed files (repository-relative, `/`-separated) touches
 * a unit: the first file that does, and through what. Null if none does.
 * Its crates' tests, benches and examples do not, nor JavaScript and
 * TypeScript tests.
 */
export function touches(unit, files) {
  files = files.filter((file) => !inCrateTests(file, unit.crateDirs) && !isScriptTest(file));
  for (const file of files) {
    if (under(file, unit.path)) return { file, via: "its own folder" };
  }
  for (const file of files) {
    const dir = unit.dependsOn.find((d) => under(file, d));
    if (dir) return { file, via: dir };
    if (unit.inputs.includes(file)) return { file, via: file };
    if (toolInput(unit, file)) return { file, via: "the deploy tool" };
  }
  return null;
}

/** Whether changed files touch a unit's Containers image. */
export function touchesImage(unit, files) {
  if (!unit.image) return false;
  return files.some(
    (file) =>
      unit.image.files.includes(file) || (unit.image.dirs.some((dir) => under(file, dir)) && !inCrateTests(file, unit.image.dirs) && !isScriptTest(file)),
  );
}

/** Whether changed files touch the folder a unit's base image is built from. */
export function touchesBase(unit, files) {
  return Boolean(unit.image?.baseDirs?.length) && files.some((file) => unit.image.baseDirs.some((dir) => under(file, dir)));
}

/** Units named on the command line: short names, folders or Worker names. */
export function pick(stack, names) {
  const wanted = names
    .flatMap((name) => name.split(","))
    .map((name) => name.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const found = [];
  for (const name of wanted) {
    const unit = stack.units.find((u) => u.id === name || u.path === name || u.worker === name);
    if (!unit) throw new Error(`No unit called ${name}. Units: ${stack.units.map((u) => u.id).join(", ")}`);
    if (!found.includes(unit)) found.push(unit);
  }
  return found;
}

/** Units grouped by stage, in stage order, keeping the manifest's order inside each. */
export function byStage(stack, units) {
  return codeStages(stack)
    .map((stage) => ({ stage, units: units.filter((u) => u.stage === stage) }))
    .filter((group) => group.units.length);
}

/**
 * A stage's units in the order they can go out. Cloudflare refuses a
 * Worker bound to a Worker that does not exist, so a unit never deployed
 * before (`isNew`, a new or renamed Worker) goes out before the units of
 * its stage that bind to it. Units in one wave go in parallel. Without a
 * new unit, the stage is one wave.
 */
export function waves(units, isNew) {
  const out = [];
  let left = [...units];
  while (left.length) {
    // Workers that do not exist yet and are still to deploy.
    const missing = new Set(left.filter(isNew).map((u) => u.worker));
    const ready = left.filter((u) => !u.bindsTo.some((target) => target !== u.worker && missing.has(target)));
    // New units that bind to each other: no order helps, so all at once.
    const wave = ready.length ? ready : left;
    out.push(wave);
    left = left.filter((u) => !wave.includes(u));
  }
  return out;
}

/**
 * What a unit's build leaves for Wrangler to deploy (repository-relative
 * paths), or none when Wrangler bundles it itself. A Rust Worker's is
 * worker-build's `build/`; a React Router site's, Vite's `build/` and the
 * Cloudflare plugin's `.wrangler/deploy/config.json`, which points Wrangler
 * at the built Worker's config; an Astro site's, `dist/`. CI builds these
 * before any stage deploys, and the stages deploy them (`deploy --prebuilt`).
 */
export function buildOutputs(unit) {
  if (unit.kind === "rust-worker") return [`${unit.path}/build`];
  if (unit.kind === "react-router") return [`${unit.path}/build`, `${unit.path}/.wrangler/deploy`];
  if (unit.kind === "astro") return [`${unit.path}/dist`];
  return [];
}

/**
 * Roughly how long each Rust Worker takes to build, in seconds, with its
 * dependencies cached: what Deploy #530 measured (2026-10-22, the table
 * `deploy.mjs build` prints), on 4 vCPU. A Worker missing here counts as
 * BUILD_SECONDS_DEFAULT. Only the proportions matter: they balance the jobs.
 */
export const BUILD_SECONDS = {
  events: 155,
  work: 147,
  repos: 140,
  api: 132,
  search: 126,
  actions: 118,
  identity: 108,
  billing: 98,
  security: 88,
  packages: 64,
  integrations: 38,
  webhooks: 22,
};
export const BUILD_SECONDS_DEFAULT = 100;

/**
 * The most build time (BUILD_SECONDS) one CI job is given. A job's Workers
 * take turns on Cargo's lock on their shared target, so a job takes about
 * the sum of its Workers' builds; on ubuntu-latest (4 vCPU in a public
 * repository, 2 in a private one, as on GitHub) one big Worker is a job's
 * worth. So the slowest Worker sets
 * the budget, and the small ones share a job up to it: a deploy waits for
 * its slowest Worker's build and no more. A job costs a minute or so of
 * setup (checkout, caches), which is why the small ones share.
 */
export const RUST_JOB_SECONDS = 160;

/**
 * The Rust Workers split into jobs of at most RUST_JOB_SECONDS (or one
 * Worker, if it alone takes longer): slowest first, each into the first
 * job it fits (first-fit decreasing). Each job's Workers in manifest order.
 */
export function rustShards(rust, budget = RUST_JOB_SECONDS) {
  const cost = (unit) => BUILD_SECONDS[unit.id] ?? BUILD_SECONDS_DEFAULT;
  const shards = [];
  const slowestFirst = [...rust].sort((a, b) => cost(b) - cost(a) || rust.indexOf(a) - rust.indexOf(b));
  for (const unit of slowestFirst) {
    let shard = shards.find((s) => s.total + cost(unit) <= budget);
    if (!shard) shards.push((shard = { total: 0, units: [] }));
    shard.total += cost(unit);
    shard.units.push(unit);
  }
  return shards.map((s) => rust.filter((u) => s.units.includes(u)));
}

/**
 * How a stage's units are split into CI jobs, so units that share a build
 * share a sandbox: Rust workers (one Cargo target, at most RUST_JOB_SECONDS
 * of building to a job, rustShards), the TypeScript Workers (cheap),
 * each site that runs a framework build, and each unit whose Containers
 * image must be rebuilt (`images`: ids), which needs Docker.
 */
export function buildGroups(units, images = []) {
  const groups = new Map();
  const add = (key, id) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  };
  const rust = units.filter((u) => u.kind === "rust-worker");
  const shards = rustShards(rust);
  shards.forEach((shard, i) => {
    for (const unit of shard) add(shards.length > 1 ? `rust-${i + 1}` : "rust", unit.id);
  });
  for (const unit of units.filter((u) => u.kind !== "rust-worker")) {
    add(images.includes(unit.id) ? `${unit.id}-image` : unit.kind === "ts-worker" ? "ts" : unit.id, unit.id);
  }
  // `image`: the job builds a Containers image (Docker, on a larger machine).
  // `prebuilt`: its units are built before any stage deploys (buildOutputs).
  return [...groups].map(([group, ids]) => {
    const image = group.endsWith("-image");
    const prebuilt = !image && ids.every((id) => buildOutputs(units.find((u) => u.id === id)).length > 0);
    return { group, units: ids.join(","), rust: group.startsWith("rust"), image, prebuilt };
  });
}

/**
 * What is wrong with the manifest, as sentences. Empty when it is right.
 * `wranglerConfigs`: every wrangler.jsonc in the repository (relative paths).
 */
export function problems(stack, wranglerConfigs = findWranglerConfigs()) {
  const out = [];
  const stages = codeStages(stack);
  if (stack.stages[0] !== "migrations") out.push('The first stage is "migrations".');
  const byWorker = new Map();
  for (const unit of stack.units) {
    const where = `Unit ${unit.id}`;
    if (!KINDS.includes(unit.kind)) out.push(`${where}: kind is one of ${KINDS.join(", ")}.`);
    if (!stages.includes(unit.stage)) out.push(`${where}: stage is one of ${stages.join(", ")}.`);
    if (!SELF_HOST.includes(unit.self_host)) out.push(`${where}: self_host is one of ${SELF_HOST.join(", ")}.`);
    if (!unit.config) {
      out.push(`${where}: ${unit.path}/wrangler.jsonc does not exist.`);
      continue;
    }
    if (unit.config.name !== unit.worker) out.push(`${where}: worker is ${unit.config.name} in its wrangler.jsonc, not ${unit.worker}.`);
    byWorker.set(unit.worker, unit);
    const dbs = (unit.config.d1_databases ?? []).filter((db) => db.migrations_dir);
    const d1 = dbs[0] ? { database: dbs[0].database_name, migrations: dbs[0].migrations_dir } : null;
    if (dbs.length > 1) out.push(`${where}: more than one D1 database with migrations; the deploy tool applies one per unit.`);
    if (JSON.stringify(d1) !== JSON.stringify(unit.d1 ?? null)) {
      out.push(`${where}: d1 is ${JSON.stringify(d1)} in its wrangler.jsonc, not ${JSON.stringify(unit.d1 ?? null)}.`);
    }
    const building = unit.config.build?.command ?? "";
    if (unit.kind === "rust-worker" && !building.includes("scripts/build-rust-worker.mjs")) {
      out.push(`${where}: a Rust worker builds with node ../../scripts/build-rust-worker.mjs, not "${building}".`);
    }
    if (unit.kind !== "rust-worker" && building) out.push(`${where}: only Rust workers have a build command; ${unit.kind} builds in the deploy tool.`);
    for (const id of (unit.config.kv_namespaces ?? []).map((kv) => kv.id)) {
      if (!stack.resources.kv?.[id]) out.push(`${where}: KV namespace ${id} has no name under resources.kv.`);
    }
    const hasImage = (unit.config.containers ?? []).some((c) => !String(c.image).includes("registry"));
    if (hasImage !== Boolean(unit.image)) out.push(`${where}: image is set exactly when its wrangler.jsonc builds a Containers image.`);
  }
  const listed = new Set(stack.units.map((u) => posix(join(u.path, "wrangler.jsonc"))));
  for (const config of wranglerConfigs) {
    if (!listed.has(config)) out.push(`${config} is not in ${STACK_FILE}: add its unit.`);
  }
  // Stage order follows bindings: a unit binds only to units that ship in
  // its stage or before it.
  for (const unit of stack.units) {
    for (const target of unit.bindsTo) {
      const other = byWorker.get(target);
      if (!other) {
        out.push(`Unit ${unit.id} binds to ${target}, which no unit deploys.`);
      } else if (stages.indexOf(other.stage) > stages.indexOf(unit.stage)) {
        out.push(`Unit ${unit.id} (${unit.stage}) binds to ${other.id} (${other.stage}), which ships after it.`);
      }
    }
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", "target", ".git", "build", "dist", ".wrangler", ".generated", ".astro"]);

/** Every wrangler.jsonc or wrangler.toml checked into the repository. */
export function findWranglerConfigs(root = ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const path = dir ? `${dir}/${name}` : name;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (/^wrangler\.(jsonc?|toml)$/.test(name)) found.push(path);
    }
  };
  walk("");
  return found.sort();
}

/**
 * Relative imports in a unit's non-test sources that leave its folder:
 * each { file, target }. The manifest must cover each one, through a
 * workspace dependency or `inputs`.
 */
export function outsideImports(root, unit) {
  const found = [];
  const pattern = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const path = `${dir}/${name}`;
      if (statSync(join(root, path)).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(m?[jt]sx?|astro)$/.test(name) || /\.test\.[jt]sx?$/.test(name) || name.endsWith(".d.ts")) continue;
      const text = readFileSync(join(root, path), "utf8");
      for (const match of text.matchAll(pattern)) {
        const target = posix(join(dirname(path), match[1]));
        if (!under(target, unit.path)) found.push({ file: path, target });
      }
    }
  };
  walk(unit.path);
  return found;
}

/**
 * How a unit with a Containers image rolls its sandboxes over: `immediate`
 * when what they run changed (the image, or the container settings in its
 * wrangler.jsonc, such as the instance type), else `none`. Cloudflare's
 * default rollout goes in steps over wall-clock time, so with deploys
 * often apart a new version never reached every sandbox; `immediate`
 * replaces the idle ones at once, and `rollout_active_grace_period` still
 * keeps a sandbox in the middle of a job from being stopped. An urgent
 * deploy always rolls over (its config gives busy ones no grace).
 */
export function containersRollout(unit, decision, { rebuildImage = false, rebuildBase = false, urgent = false } = {}) {
  const config = (file) => file.startsWith(`${unit.path}/`) && /wrangler\.jsonc?$/.test(file);
  const changed = urgent || rebuildImage || rebuildBase || decision.image || (decision.files ?? []).some(config);
  return changed ? "immediate" : "none";
}

/**
 * npm ci of only what the units need: Wrangler alone for Rust workers,
 * and each npm-built unit's workspace with the packages it uses. A CI job
 * that deploys three Rust workers does not install the site's toolchain.
 * --prefer-offline reads npm's cache first, which the deploy's jobs keep
 * between runs, so a registry connection dropped mid-install rarely
 * fails a stage.
 */
export function npmCiArgs(units, npm) {
  const workspaces = new Set();
  for (const unit of units) {
    if (!unit.pkg) continue;
    const stack = [unit.pkg];
    while (stack.length) {
      const name = stack.pop();
      if (workspaces.has(name)) continue;
      workspaces.add(name);
      stack.push(...(npm.get(name)?.deps ?? []));
    }
  }
  const base = ["ci", "--prefer-offline", "--no-audit", "--no-fund"];
  if (!workspaces.size) return [...base, "--workspaces=false"];
  return [...base, "--include-workspace-root", ...[...workspaces].sort().flatMap((name) => ["-w", name])];
}
