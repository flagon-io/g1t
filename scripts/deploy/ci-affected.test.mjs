import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKS,
  DESKTOP,
  EVERYTHING,
  NPM_EVERYTHING,
  NPM_READS,
  READS,
  WORKFLOW,
  affected,
  checks,
  CONFORMANCE_WORKSPACES,
  needs,
  npmAffected,
  npmClosure,
  npmGraph,
  npmPlan,
  partCrates,
  queueTested,
  workspace,
} from "./ci-affected.mjs";
import { npmWorkspace } from "./stack.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// contracts <- kit <- api, and work, which also takes rules; sshd alone.
const CRATES = [
  { name: "g1t-contracts", dir: "crates/contracts", deps: [] },
  { name: "g1t-kit", dir: "crates/kit", deps: ["g1t-contracts"] },
  { name: "g1t-rules", dir: "crates/rules", deps: ["g1t-contracts"] },
  { name: "g1t-api", dir: "apps/api", deps: ["g1t-contracts", "g1t-kit"] },
  { name: "g1t-work", dir: "services/work", deps: ["g1t-kit", "g1t-rules"] },
  { name: "g1t-sshd", dir: "crates/sshd", deps: [] },
  { name: "g1t-actions", dir: "crates/actions", deps: [] },
];

test("a crate's change tests it and every crate that depends on it, however far", () => {
  assert.deepEqual(affected(CRATES, ["crates/sshd/src/main.rs"]), ["g1t-sshd"]);
  assert.deepEqual(affected(CRATES, ["crates/kit/src/lib.rs"]), ["g1t-api", "g1t-kit", "g1t-work"]);
  assert.deepEqual(affected(CRATES, ["crates/contracts/src/lib.rs"]), ["g1t-api", "g1t-contracts", "g1t-kit", "g1t-rules", "g1t-work"]);
  assert.deepEqual(affected(CRATES, ["crates/rules/Cargo.toml", "crates/sshd/README.md"]), ["g1t-rules", "g1t-sshd", "g1t-work"]);
  // A folder that only starts like a crate's is not it.
  assert.deepEqual(affected(CRATES, ["crates/kitchen/x.rs"]), []);
});

test("the workspace's own files, the toolchain and this workflow test every crate", () => {
  for (const file of [
    "Cargo.lock",
    "Cargo.toml",
    "rust-toolchain.toml",
    ".cargo/config.toml",
    ".g1t/workflows/ci.yml",
    "scripts/sccache.sh",
    "scripts/deploy/ci-cache.mjs",
  ]) {
    assert.equal(affected(CRATES, ["crates/sshd/src/main.rs", file]), null, file);
  }
  // A crate's own manifest is only the crate's.
  assert.deepEqual(affected(CRATES, ["crates/sshd/Cargo.toml"]), ["g1t-sshd"]);
});

test("a file outside the crates tests those that read it, and nothing when none does", () => {
  assert.deepEqual(affected(CRATES, ["apps/web/src/app.tsx", "docs/notes.md", "services/chat/src/index.ts", "package-lock.json"]), []);
  assert.deepEqual(affected(CRATES, [".g1t/workflows/deploy.yml"]), ["g1t-actions"]);
  assert.deepEqual(affected(CRATES, ["packages/contracts/src/scopes.ts"]), ["g1t-api", "g1t-contracts", "g1t-kit", "g1t-rules", "g1t-work"]);
  assert.deepEqual(affected(CRATES, []), []);
});

test("the desktop job runs for its own files and the build's, and for nothing else", () => {
  for (const file of [
    "apps/desktop/src-tauri/src/main.rs",
    "apps/desktop/package.json",
    "scripts/cli-release.test.mjs",
    "scripts/apt-install.sh",
    ".g1t/workflows/ci.yml",
  ]) {
    assert.equal(needs("desktop", ["crates/kit/src/lib.rs", file]), true, file);
  }
  assert.equal(needs("desktop", ["crates/kit/src/lib.rs", "apps/web/app/root.tsx", "Cargo.lock", "apps/desktopper/x.ts"]), false);
});

test("the rustfmt job runs for any Rust file and for what decides its formatting", () => {
  for (const file of ["crates/kit/src/lib.rs", "apps/desktop/src-tauri/src/main.rs", "rustfmt.toml", "rust-toolchain.toml", ".g1t/workflows/ci.yml"]) {
    assert.equal(needs("rustfmt", ["apps/web/app/root.tsx", file]), true, file);
  }
  assert.equal(needs("rustfmt", ["apps/web/app/root.tsx", "Cargo.lock", "crates/kit/Cargo.toml", "docs/rust.md"]), false);
  assert.equal(needs("rustfmt", []), false);
});

// contracts <- web, sudo, docs, mobile, runner, og; theme <- web, sudo, docs.
const NPM = [
  { name: "@g1t/contracts", dir: "packages/contracts", deps: [], scripts: { typecheck: "tsc", test: "node --test" } },
  { name: "@g1t/theme", dir: "packages/theme", deps: [], scripts: {} },
  { name: "@g1t/web", dir: "apps/web", deps: ["@g1t/contracts", "@g1t/theme"], scripts: { typecheck: "tsc", test: "node --test" } },
  { name: "@g1t/sudo", dir: "apps/sudo", deps: ["@g1t/contracts", "@g1t/theme"], scripts: { typecheck: "tsc", test: "node --test" } },
  { name: "@g1t/docs", dir: "apps/docs", deps: ["@g1t/contracts", "@g1t/theme"], scripts: { test: "node --test" } },
  { name: "@g1t/mobile", dir: "apps/mobile", deps: ["@g1t/contracts"], scripts: { typecheck: "tsc", test: "node --test" } },
  { name: "@g1t/runner", dir: "services/runner", deps: ["@g1t/contracts"], scripts: { typecheck: "tsc", test: "node --test" } },
  { name: "@g1t/og", dir: "services/og", deps: ["@g1t/contracts"], scripts: { typecheck: "tsc", test: "node --test" } },
  { name: "@g1t/desktop", dir: "apps/desktop", deps: [], scripts: {} },
  { name: "@g1t/artifacts", dir: "services/artifacts", deps: ["@g1t/contracts"], scripts: {} },
];
const ALL = NPM.map((w) => w.name).sort();

test("the site, sudo and the docs build when a change reaches their workspaces or the tool that builds them", () => {
  assert.equal(needs("build", ["crates/kit/src/lib.rs", "services/work/src/items.rs"], NPM), false);
  // Rust's manifests and the services' TypeScript are none of theirs.
  assert.equal(needs("build", ["crates/kit/src/lib.rs", "crates/kit/Cargo.toml", "Cargo.lock"], NPM), false);
  assert.equal(needs("build", ["services/runner/src/index.ts", "apps/mobile/app/index.tsx"], NPM), false);
  assert.equal(needs("build", ["apps/docs/src/content/docs/index.md"], NPM), true);
  assert.equal(needs("build", ["apps/web/app/root.tsx"], NPM), true);
  // What they depend on, and what every workspace shares.
  assert.equal(needs("build", ["packages/theme/tokens.css"], NPM), true);
  assert.equal(needs("build", ["packages/contracts/src/work.ts"], NPM), true);
  assert.equal(needs("build", ["package-lock.json"], NPM), true);
  assert.equal(needs("build", ["scripts/deploy.mjs"], NPM), true);
  assert.equal(needs("build", ["deploy/stack.jsonc"], NPM), true);
  assert.equal(needs("build", [], NPM), false);
});

test("a workspace's change checks it and every workspace that depends on it, however far", () => {
  // A contracts change reaches the apps and the services.
  assert.deepEqual(npmAffected(NPM, ["packages/contracts/src/work.ts"]), [
    "@g1t/artifacts",
    "@g1t/contracts",
    "@g1t/docs",
    "@g1t/mobile",
    "@g1t/og",
    "@g1t/runner",
    "@g1t/sudo",
    "@g1t/web",
  ]);
  // The site's own change, only the site.
  assert.deepEqual(npmAffected(NPM, ["apps/web/app/root.tsx", "apps/web/package.json"]), ["@g1t/web"]);
  assert.deepEqual(npmAffected(NPM, ["packages/theme/tokens.css"]), ["@g1t/docs", "@g1t/sudo", "@g1t/theme", "@g1t/web"]);
  assert.deepEqual(npmAffected(NPM, ["services/runner/src/index.ts"]), ["@g1t/runner"]);
  // A file another workspace reads by its path (NPM_READS).
  assert.deepEqual(npmAffected(NPM, ["apps/web/app/lib/roadmap.ts"]), ["@g1t/og", "@g1t/web"]);
  assert.deepEqual(npmAffected(NPM, ["README.md"]), ["@g1t/web"]);
  // Rust, the docs folder and a folder that only starts like a workspace's reach none.
  assert.deepEqual(npmAffected(NPM, ["crates/kit/src/lib.rs", "services/work/src/items.rs", "docs/notes.md", "apps/webby/x.ts"]), []);
  assert.deepEqual(npmAffected(NPM, []), []);
});

test("the install, the shared TypeScript options and this workflow check every workspace", () => {
  for (const file of [
    "package-lock.json",
    "package.json",
    "tsconfig.base.json",
    ".npmrc",
    ".g1t/workflows/ci.yml",
    "scripts/deploy/ci-affected.mjs",
    "scripts/deploy/ci-workspaces.mjs",
  ]) {
    assert.equal(npmAffected(NPM, ["apps/web/app/root.tsx", file]), null, file);
  }
  // A workspace's own manifest is only that workspace's.
  assert.deepEqual(npmAffected(NPM, ["services/og/package.json"]), ["@g1t/og"]);
});

test("the TypeScript job type checks, tests and installs only what a change reaches", () => {
  const plan = (files, tested = false) => npmPlan(NPM, { reached: npmAffected(NPM, files), checks: checks(files), tested });
  // The site: it, and what it depends on to install.
  const web = plan(["apps/web/app/root.tsx"]);
  assert.deepEqual(web.typecheck, ["@g1t/web"]);
  assert.deepEqual(web.test, ["@g1t/web"]);
  assert.deepEqual(web.checks, []);
  assert.equal(web.install, "--include-workspace-root -w @g1t/contracts -w @g1t/theme -w @g1t/web");
  assert.equal(web.whole, false);
  // The contracts: every workspace with the script.
  const contracts = plan(["packages/contracts/src/work.ts"]);
  assert.deepEqual(contracts.typecheck, ["@g1t/contracts", "@g1t/web", "@g1t/sudo", "@g1t/mobile", "@g1t/runner", "@g1t/og"]);
  assert.deepEqual(contracts.test, ["@g1t/contracts", "@g1t/web", "@g1t/sudo", "@g1t/docs", "@g1t/mobile", "@g1t/runner", "@g1t/og"]);
  // The lockfile: everything, installed whole.
  const lock = plan(["package-lock.json"]);
  assert.equal(lock.install, "all");
  assert.equal(lock.whole, true);
  assert.deepEqual(lock.checks, Object.keys(CHECKS));
  assert.equal(lock.typecheck.length, NPM.filter((w) => w.scripts.typecheck).length);
  // Rust alone: nothing to check or install...
  const rust = plan(["crates/kit/src/lib.rs"]);
  assert.deepEqual([rust.typecheck, rust.test, rust.checks, rust.install], [[], [], [], "none"]);
  // ...but a Rust service the conformance suite runs installs the root's
  // packages (Miniflare) and the TypeScript services the suite bundles,
  // with what they depend on (#391: a change to services/actions alone
  // failed, 'yjs' and '@g1t/contracts' not installed).
  const billing = plan(["services/billing/src/ledger.rs"]);
  assert.deepEqual(billing.checks, ["conformance", "ops"]);
  assert.deepEqual(billing.typecheck, []);
  assert.equal(billing.install, "--include-workspace-root -w @g1t/artifacts -w @g1t/contracts");
  // A push the merge queue tested only type checks what it reaches...
  const landedWeb = plan(["apps/web/app/root.tsx"], true);
  assert.deepEqual([landedWeb.typecheck, landedWeb.test, landedWeb.checks], [["@g1t/web"], [], []]);
  assert.equal(landedWeb.whole, false);
  assert.deepEqual(plan(["crates/kit/src/lib.rs"], true).typecheck, []);
  // ...and every workspace when what it changes is not known.
  const landed = npmPlan(NPM, { reached: null, checks: checks(null), tested: true });
  assert.deepEqual([landed.test, landed.checks, landed.install, landed.whole], [[], [], "all", true]);
  assert.equal(landed.typecheck.length, NPM.filter((w) => w.scripts.typecheck).length);
  assert.deepEqual(ALL, [...npmClosure(NPM, ALL)]);
});

test("each of the job's other checks runs when its files change", () => {
  assert.deepEqual(checks(["apps/web/app/root.tsx", "crates/kit/src/lib.rs", "docs/notes.md"]), []);
  assert.deepEqual(checks(["apps/web/wrangler.jsonc"]), ["deploy", "manifest"]);
  assert.deepEqual(checks(["deploy/stack.jsonc"]), ["deploy", "manifest"]);
  assert.deepEqual(checks(["scripts/deploy/plan.mjs"]), ["deploy", "ops", "manifest"]);
  assert.deepEqual(checks(["scripts/ops/smoke.mjs"]), ["deploy", "ops"]);
  assert.deepEqual(checks(["conformance/billing.test.mjs"]), ["conformance"]);
  assert.deepEqual(checks(["services/identity/migrations/0001_init.sql"]), ["deploy", "conformance"]);
  assert.deepEqual(checks(["plugins/claude-code/hooks/g1t.mjs"]), ["plugins"]);
  assert.deepEqual(checks(["scripts/plugins-release.mjs"]), ["deploy", "plugins"]);
  assert.deepEqual(checks(["crates/kit/Cargo.toml"]), ["deploy"]);
  assert.deepEqual(checks(["package-lock.json"]), Object.keys(CHECKS));
  assert.deepEqual(checks(null), Object.keys(CHECKS));
});

test("the workflow runs each check on its own output, and the workspaces through ci-workspaces.mjs", () => {
  const ci = readFileSync(join(ROOT, ".g1t/workflows/ci.yml"), "utf8");
  for (const name of Object.keys(CHECKS)) assert.ok(ci.includes(`steps.affected.outputs.${name} == 'true'`), name);
  assert.ok(ci.includes("node scripts/deploy/ci-affected.mjs --npm"));
  assert.ok(ci.includes("node scripts/deploy/ci-workspaces.mjs typecheck ${{ steps.affected.outputs.typecheck }}"));
  assert.ok(ci.includes("node scripts/deploy/ci-workspaces.mjs test ${{ steps.affected.outputs.test }}"));
});

/** The repository's npm workspaces, as the job reads them. */
function repoNpm() {
  return npmGraph(npmWorkspace(ROOT), (dir) => JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")).scripts ?? {});
}

test("the repository's workspaces: the site and the services depend on the contracts", () => {
  const graph = repoNpm();
  const at = (dir) => graph.find((w) => w.dir === dir);
  assert.ok(at("apps/web").deps.includes("@g1t/contracts"));
  assert.ok(at("services/runner").deps.includes("@g1t/contracts"));
  assert.ok(at("apps/web").scripts.typecheck);
  const reached = npmAffected(graph, ["packages/contracts/src/index.ts"]);
  for (const dir of ["apps/web", "apps/sudo", "services/runner", "services/og"]) assert.ok(reached.includes(at(dir).name), dir);
  assert.deepEqual(npmAffected(graph, ["apps/web/app/root.tsx"]), ["@g1t/web"]);
  // What NPM_READS and NPM_EVERYTHING name is there, read by workspaces.
  const dirs = new Set(graph.map((w) => w.dir));
  for (const [path, readers] of NPM_READS) {
    assert.ok(existsSync(join(ROOT, path)), path);
    for (const dir of readers) assert.ok(dirs.has(dir), `${path}: ${dir}`);
  }
  for (const path of NPM_EVERYTHING.filter((p) => p !== ".nvmrc" && p !== ".npmrc")) assert.ok(existsSync(join(ROOT, path)), path);
});

/** A workspace's source files: code, configs and styles, not what is built or installed. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", "target", "src-tauri", "android", "ios"].includes(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(m?[jt]sx?|jsonc?|css)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("every path a workspace's source names outside its own folder checks that workspace when it changes", () => {
  const graph = repoNpm();
  let checked = 0;
  for (const w of graph) {
    const at = join(ROOT, w.dir);
    for (const file of sourceFiles(at)) {
      for (const [, path] of readFileSync(file, "utf8").matchAll(/["'`]((?:\.\.\/)+[^"'`\s$]*)["'`]/g)) {
        const target = resolve(dirname(file), path);
        const rel = relative(ROOT, target).split(sep).join("/");
        // Inside the workspace, outside the repository, or installed.
        if (!relative(at, target).startsWith("..") || rel.startsWith("..") || rel.startsWith("node_modules/")) continue;
        // The repository's root: markdown-tree.test.ts reads named files
        // under it, in NPM_READS by hand.
        if (!rel) {
          assert.ok(
            NPM_READS.some(([, readers]) => readers.includes(w.dir)),
            `${relative(ROOT, file)} reads the repository's root: add what it reads to NPM_READS`,
          );
          continue;
        }
        if (!existsSync(target)) continue;
        const changed = statSync(target).isDirectory() ? `${rel}/x` : rel;
        const reached = npmAffected(graph, [changed]);
        assert.ok(
          reached === null || reached.includes(w.name),
          `${relative(ROOT, file)} reads ${rel}: add it to NPM_READS for ${w.dir}, or depend on its package`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked >= 10, `${checked}`);
});

test("every repository path the checks' tests name runs that check when it changes", () => {
  const tests = {
    // This file reads the whole repository, and runs on every change (ci.yml).
    deploy: readdirSync(join(ROOT, "scripts/deploy"))
      .filter((f) => f.endsWith(".test.mjs") && f !== "ci-affected.test.mjs")
      .map((f) => `scripts/deploy/${f}`),
    conformance: readdirSync(join(ROOT, "conformance"))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => `conformance/${f}`),
    ops: readdirSync(join(ROOT, "scripts/ops"))
      .filter((f) => f.endsWith(".test.mjs"))
      .map((f) => `scripts/ops/${f}`),
    plugins: ["plugins/claude-code/test/hooks.test.mjs", "scripts/plugins-release.test.mjs"],
  };
  let checked = 0;
  for (const [name, files] of Object.entries(tests)) {
    assert.ok(files.length, name);
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      const named = [
        // join(ROOT, "a", "b") and join(ROOT, "a/b"), all strings (one
        // with a name computed is CHECKS's by hand, as services/*/migrations/).
        ...[...source.matchAll(/join\(ROOT,((?:\s*"[^"]+"\s*,?)+)\)/g)].map((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((p) => p[1]).join("/")),
        // new URL("../a", import.meta.url), up to an interpolation.
        ...[...source.matchAll(/URL\(\s*[`"]((?:\.\.?\/)+[^`"$]*)/g)].map((m) =>
          relative(ROOT, resolve(dirname(join(ROOT, file)), m[1]))
            .split(sep)
            .join("/"),
        ),
      ];
      for (const path of named) {
        if (!path || path.startsWith("..")) continue;
        const changed = existsSync(join(ROOT, path)) && statSync(join(ROOT, path)).isDirectory() ? `${path.replace(/\/$/, "")}/x` : path;
        assert.ok(checks([changed]).includes(name), `${file} reads ${path}: add it to CHECKS.${name}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 15, `${checked}`);
});

test("every file the desktop job names is there", () => {
  // The toolchain's files, like EVERYTHING's, are there only when pinned.
  for (const entry of DESKTOP.filter((e) => !EVERYTHING.includes(e))) assert.ok(existsSync(join(ROOT, entry)), entry);
  // Its tests run each release script's test file.
  const ci = readFileSync(join(ROOT, ".g1t/workflows/ci.yml"), "utf8");
  const tests = ci.match(/node --test scripts\/desktop-release\.test\.mjs.*/)[0];
  for (const test of tests.match(/scripts\/[\w-]+\.test\.mjs/g)) assert.ok(DESKTOP.includes(test), test);
  // Outside the workspace, with no path dependency on it.
  assert.doesNotMatch(readFileSync(join(ROOT, "apps/desktop/src-tauri/Cargo.toml"), "utf8"), /\bpath\s*=/);
});

test("a push is the merge queue's only when CI's merge_group run passed on that very commit", () => {
  const sha = "a".repeat(40);
  const run = { event: "merge_group", sha, conclusion: "success", path: `.g1t/workflows/${WORKFLOW}` };
  // g1t's answer is a list; GitHub's has workflow_runs, with head_sha.
  assert.equal(queueTested([run], sha), true);
  assert.equal(queueTested({ workflow_runs: [{ event: "merge_group", head_sha: sha, conclusion: "success" }] }, sha), true);
  // Any other run never vouches for it, whatever the query asked for.
  assert.equal(queueTested([], sha), false);
  assert.equal(queueTested([{ ...run, event: "push" }], sha), false);
  assert.equal(queueTested([{ ...run, event: "pull_request" }], sha), false);
  assert.equal(queueTested([{ ...run, sha: "b".repeat(40) }], sha), false);
  assert.equal(queueTested([{ ...run, conclusion: "failure" }], sha), false);
  assert.equal(queueTested([{ ...run, conclusion: null }], sha), false);
  assert.equal(queueTested([{ ...run, path: ".g1t/workflows/deploy.yml" }], sha), false);
  assert.equal(queueTested(null, sha), false);
  assert.equal(queueTested([{ ...run, event: "push" }, run], sha), true);
});

test("a part's crates are read from its -p arguments", () => {
  assert.deepEqual(partCrates(["-p", "g1t-kit", "-p", "g1t"]), ["g1t-kit", "g1t"]);
  assert.throws(() => partCrates(["-p", "g1t-kit", "g1t"]));
  assert.throws(() => partCrates(["--workspace"]));
});

test("the workspace comes from cargo metadata: its members, their folders and their path dependencies", () => {
  const root = join(ROOT, "w");
  const pkg = (name, dir, deps) => ({
    id: `path+file://${name}`,
    name,
    manifest_path: join(root, dir, "Cargo.toml"),
    dependencies: deps.map(([dep, path]) => ({ name: dep, kind: path === "dev" ? "dev" : null, ...(path ? { path: join(root, "x") } : {}) })),
  });
  const metadata = {
    workspace_root: root,
    workspace_members: ["path+file://g1t-kit", "path+file://g1t-api"],
    packages: [
      pkg("g1t-kit", "crates/kit", [["serde"]]),
      pkg("g1t-api", "apps/api", [
        ["g1t-kit", true],
        ["g1t-kit", "dev"],
        ["outside", true],
      ]),
      pkg("outside", "apps/desktop/src-tauri", []),
    ],
  };
  assert.deepEqual(workspace(metadata), [
    { name: "g1t-kit", dir: "crates/kit", deps: [] },
    { name: "g1t-api", dir: "apps/api", deps: ["g1t-kit"] },
  ]);
});

/** The real workspace's crates, from Cargo.toml's members: names and folders. */
function members() {
  const manifest = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
  const line = manifest.split("\n").find((l) => l.trimStart().startsWith("members"));
  const dirs = [];
  for (const member of [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
    if (member.endsWith("/*")) {
      const parent = member.slice(0, -2);
      for (const name of readdirSync(join(ROOT, parent)).sort()) if (existsSync(join(ROOT, parent, name, "Cargo.toml"))) dirs.push(`${parent}/${name}`);
    } else dirs.push(member);
  }
  return dirs.map((dir) => ({ name: readFileSync(join(ROOT, dir, "Cargo.toml"), "utf8").match(/^name = "([^"]+)"/m)[1], dir, deps: [] }));
}

function rustFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "target" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...rustFiles(path));
    else if (name.endsWith(".rs")) out.push(path);
  }
  return out;
}

test("every file a crate names outside its own folder tests that crate when it changes", () => {
  const crates = members();
  // include_str!/include_bytes! from the file's folder; CARGO_MANIFEST_DIR
  // joined or concatenated, and other joins, from the crate's.
  const named = [
    [/include_(?:str|bytes)!\(\s*"([^"]+)"/g, "file"],
    [/CARGO_MANIFEST_DIR"\),\s*"\/?([^"]+)"/g, "crate"],
    [/\.join\(\s*"(\.\.[^"]*)"/g, "crate"],
  ];
  let checked = 0;
  for (const crate of crates) {
    const at = join(ROOT, crate.dir);
    for (const file of rustFiles(at)) {
      const source = readFileSync(file, "utf8");
      for (const [pattern, from] of named) {
        for (const [, path] of source.matchAll(pattern)) {
          const target = resolve(from === "file" ? dirname(file) : at, path);
          const rel = relative(ROOT, target).split(sep).join("/");
          // Inside the crate, missing, or the whole repository (docs.rs
          // walks named folders under it, in READS by hand).
          if (!rel || rel.startsWith("..") || !relative(at, target).startsWith("..") || !existsSync(target)) continue;
          const changed = statSync(target).isDirectory() ? `${rel}/x` : rel;
          const tested = affected(crates, [changed]);
          assert.ok(tested === null || tested.includes(crate.name), `${relative(ROOT, file)} reads ${rel}: add it to READS for ${crate.name}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked >= 20, `${checked}`);
});

test("what READS and EVERYTHING name is there, and read by crates of the workspace", () => {
  const names = new Set(members().map((c) => c.name));
  for (const [path, readers] of READS) {
    assert.ok(existsSync(join(ROOT, path)), path);
    for (const name of readers) assert.ok(names.has(name), `${path}: ${name}`);
  }
  for (const path of EVERYTHING) {
    if (/^(rust-toolchain|\.cargo\/)/.test(path)) continue;
    assert.ok(existsSync(join(ROOT, path)), path);
  }
});

test("the conformance check installs every TypeScript service a conformance test bundles", () => {
  const graph = repoNpm().map((w) => w.name);
  const bundled = new Set();
  for (const file of readdirSync(join(ROOT, "conformance")).filter((f) => f.endsWith(".mjs"))) {
    for (const [, service] of readFileSync(join(ROOT, "conformance", file), "utf8").matchAll(/services\/([a-z-]+)\/src\/[\w-]+\.ts/g))
      bundled.add(`@g1t/${service}`);
  }
  assert.ok(bundled.size > 0);
  for (const name of bundled) {
    assert.ok(graph.includes(name), `${name} is not an npm workspace`);
    assert.ok(CONFORMANCE_WORKSPACES.includes(name), `conformance reads ${name}'s source: add it to CONFORMANCE_WORKSPACES`);
  }
});
