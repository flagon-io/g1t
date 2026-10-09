// The restore drill against a chain of real bundles: a full one and an
// incremental one, cut the way the runner's backup mode cuts them
// (crates/runner/src/backup.rs), from a local copy of the bucket.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compareRefs, headBranch, parseRefs, readManifest, restore } from "./backup-restore-drill.mjs";

const DRILL = fileURLToPath(new URL("./backup-restore-drill.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function commit(dir, file, text) {
  writeFileSync(join(dir, file), text);
  git(dir, "add", "--all");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", text);
}

function refsOf(dir) {
  const refs = parseRefs(git(dir, "for-each-ref", "--format=%(objectname) %(refname)"));
  refs.HEAD = git(dir, "rev-parse", "HEAD");
  return refs;
}

/** A bundle of the mirror, leaving out `prerequisites`, as the runner cuts one. */
function cut(mirror, prerequisites, out) {
  for (const hash of prerequisites) git(mirror, "update-ref", `refs/g1t-backup-prerequisites/${hash}`, hash);
  const not = prerequisites.length ? ["--not", "--glob=refs/g1t-backup-prerequisites/*"] : [];
  git(mirror, "bundle", "create", "--quiet", out, "--exclude=refs/g1t-backup-prerequisites/*", "--all", ...not);
  for (const hash of prerequisites) git(mirror, "update-ref", "-d", `refs/g1t-backup-prerequisites/${hash}`);
}

function entry(id, kind, key, file, refs, prerequisites) {
  return {
    id,
    kind,
    key,
    created_at: "2026-10-06T02:53:00.000Z",
    refs_version: 1,
    refs,
    prerequisites,
    size: statSync(file).size,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

test("refs, HEAD and differences are read as git writes them", () => {
  const a = "c71546fcd893ef8b0f57388b65e620d759705dda";
  const b = "4807077b296e6edbf410d55e72749d3e1170c291";
  assert.deepEqual(parseRefs(`${a}\tHEAD\n${a}\trefs/heads/main\n${b}\trefs/tags/v1\n${a}\trefs/tags/v1^{}\n`), {
    HEAD: a,
    "refs/heads/main": a,
    "refs/tags/v1": b,
  });
  assert.equal(headBranch({ HEAD: a, "refs/heads/dev": a, "refs/heads/main": a }), "refs/heads/main");
  assert.equal(headBranch({ HEAD: a, "refs/heads/dev": a }), "refs/heads/dev");
  assert.deepEqual(compareRefs({ x: a, y: b }, { x: a, z: b }), [
    { ref: "y", want: b, have: null },
    { ref: "z", want: null, have: b },
  ]);
  assert.throws(() => readManifest(JSON.stringify({ version: 2, chain: [] })), /version 2/);
  assert.throws(() => readManifest(JSON.stringify({ version: 1, chain: [{ kind: "incremental" }] })), /full/);
});

test("a chain restores every ref, and the drill fails once the live repository differs", () => {
  const root = mkdtempSync(join(tmpdir(), "g1t-drill-test-"));
  try {
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    commit(origin, "a.txt", "one");
    git(origin, "tag", "-a", "v1", "-m", "v1");
    const mirror = join(root, "mirror.git");
    const bucket = join(root, "bucket");
    const dir = join(bucket, "backups", "repo_1");
    mkdirSync(dir, { recursive: true });

    git(root, "clone", "--mirror", "--quiet", origin, mirror);
    const fullRefs = refsOf(mirror);
    cut(mirror, [], join(dir, "1-full.bundle"));
    const full = entry("1", "full", "backups/repo_1/1-full.bundle", join(dir, "1-full.bundle"), fullRefs, []);

    commit(origin, "b.txt", "two");
    git(origin, "branch", "feature");
    git(origin, "tag", "-d", "v1");
    rmSync(mirror, { recursive: true, force: true });
    git(root, "clone", "--mirror", "--quiet", origin, mirror);
    const prerequisites = [...new Set(Object.values(fullRefs))].sort();
    cut(mirror, prerequisites, join(dir, "2-incr.bundle"));
    const incr = entry("2", "incremental", "backups/repo_1/2-incr.bundle", join(dir, "2-incr.bundle"), refsOf(mirror), prerequisites);

    const manifest = { version: 1, repo_id: "repo_1", store_key: "acme--rocket", path: null, updated_at: "", chain: [full, incr], previous: [] };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

    const run = () =>
      spawnSync(process.execPath, [DRILL, "--repo-id", "repo_1", "--bundles", bucket, "--live", origin], { encoding: "utf8" });
    const passed = run();
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /every ref matches the live repository/);

    commit(origin, "c.txt", "three");
    const failed = run();
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /refs differ from the live repository/);

    // A bundle that is not what the manifest says is refused.
    writeFileSync(join(dir, "2-incr.bundle"), "not a bundle");
    const broken = run();
    assert.equal(broken.status, 2, broken.stdout + broken.stderr);
    assert.match(broken.stderr, /bytes, the manifest says|SHA-256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore keeps only the refs the last entry names", async () => {
  const root = mkdtempSync(join(tmpdir(), "g1t-drill-restore-"));
  try {
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    commit(origin, "a.txt", "one");
    git(origin, "branch", "gone");
    const mirror = join(root, "mirror.git");
    git(root, "clone", "--mirror", "--quiet", origin, mirror);
    const bundle = join(root, "1-full.bundle");
    cut(mirror, [], bundle);
    const refs = refsOf(mirror);
    delete refs["refs/heads/gone"];
    const manifest = { version: 1, chain: [entry("1", "full", "k", bundle, refs, [])] };
    const restored = await restore(manifest, async () => bundle, join(root, "restored.git"), root);
    assert.deepEqual(compareRefs(refs, restored), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
