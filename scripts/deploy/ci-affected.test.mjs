import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EVERYTHING, READS, affected, partCrates, workspace } from "./ci-affected.mjs";

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
