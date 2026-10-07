// The fallback path end to end (docs/ARTIFACTS.md, R12): bundles cut as the
// runner cuts them, restored into a git store's root, served by the git
// store itself (deploy/self-host/gitstore/server.mjs, read-only), pushed to
// while it serves, and reconciled back into the "live" repository.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseRefs } from "./backup-restore-drill.mjs";
import { CONFLICT_PREFIX, changedSince, locate, metaFor, reconcilePlan, repoDir } from "./restore-to-gitstore.mjs";

const TOOL = fileURLToPath(new URL("./restore-to-gitstore.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../../deploy/self-host/gitstore/server.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const tool = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });

function commit(dir, file, text) {
  writeFileSync(join(dir, file), text);
  git(dir, "add", "--all");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", text);
}

function refsOf(dir) {
  const refs = parseRefs(git(dir, "for-each-ref", "--format=%(objectname) %(refname)"));
  refs.HEAD = git(dir, "rev-parse", "HEAD");
  return refs;
}

/** A bucket holding one full backup of `origin` as `repo_1`, as the runner and repos service leave it. */
function backUp(root, origin, id, storeKey) {
  const mirror = join(root, `${id}-mirror.git`);
  git(root, "clone", "--mirror", "--quiet", origin, mirror);
  const dir = join(root, "bucket", "backups", id);
  mkdirSync(dir, { recursive: true });
  const bundle = join(dir, "1-full.bundle");
  git(mirror, "bundle", "create", "--quiet", bundle, "--all");
  const entry = {
    id: "20261006T025300Z",
    kind: "full",
    key: `backups/${id}/1-full.bundle`,
    created_at: "2026-10-06T02:53:00.000Z",
    refs_version: 1,
    refs: refsOf(mirror),
    prerequisites: [],
    size: statSync(bundle).size,
    sha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"),
  };
  const manifest = { version: 1, repo_id: id, store_key: storeKey, path: { namespace: "acme", name: "rocket" }, updated_at: "", chain: [entry], previous: [] };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return join(root, "bucket");
}

/** The git store, serving `root`, until `stop()`. */
async function serve(root, { readOnly }) {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const secret = "0123456789abcdef0123456789abcdef";
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, GITSTORE_ROOT: root, GITSTORE_PORT: String(port), GITSTORE_SECRET: secret, GITSTORE_URL: `http://127.0.0.1:${port}`, GITSTORE_READ_ONLY: readOnly ? "1" : "" },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let tries = 0; tries < 100; tries++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const api = async (method, path, body) => {
    const response = await fetch(`${url}/api/repos${path}`, {
      method,
      headers: { "x-gitstore-secret": secret, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => ({})) };
  };
  return { url, secret, api, stop: () => child.kill() };
}

test("keys, plans and what a restore records", () => {
  assert.deepEqual(locate("acme--rocket"), { namespace: "g1t", name: "acme--rocket" });
  assert.deepEqual(locate("g1t-us-1/pulls--pul_1"), { namespace: "g1t-us-1", name: "pulls--pul_1" });
  assert.throws(() => locate("../x"), /not a store key/);
  assert.equal(repoDir("/srv", "g1t", "acme--rocket").replaceAll("\\", "/"), "/srv/g1t/acme--rocket.git");
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const c = "c".repeat(40);
  const changes = changedSince({ "refs/heads/main": a, "refs/heads/old": a }, { "refs/heads/main": b, "refs/heads/new": c });
  assert.deepEqual(changes, [
    { ref: "refs/heads/main", base: a, now: b },
    { ref: "refs/heads/new", base: null, now: c },
    { ref: "refs/heads/old", base: a, now: null },
  ]);
  // Live still as backed up: moved. Live has it: nothing. Live moved too: kept beside.
  assert.deepEqual(
    reconcilePlan(changes, { "refs/heads/main": a, "refs/heads/old": c }).map((step) => [step.ref, step.action, step.kept ?? null]),
    [
      ["refs/heads/main", "move", null],
      ["refs/heads/new", "move", null],
      ["refs/heads/old", "conflict", null],
    ],
  );
  assert.equal(reconcilePlan(changes, { "refs/heads/main": c })[0].kept, `${CONFLICT_PREFIX}heads/main`);
  assert.equal(reconcilePlan(changes, { "refs/heads/main": b })[0].action, "same");
  const manifest = { chain: [{ id: "e1", created_at: "t", refs: { HEAD: a, "refs/heads/main": a } }] };
  const meta = metaFor({ id: "repo_1" }, manifest, "now", { id: "kept", createdAt: "then" });
  assert.equal(meta.id, "kept");
  assert.deepEqual(meta.restored.refs, { "refs/heads/main": a });
  assert.equal(meta.restored.entry, "e1");
});

test("restored repositories are served read-only, and pushes taken later are reconciled", async () => {
  const root = mkdtempSync(join(tmpdir(), "g1t-fallback-test-"));
  let server = null;
  try {
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    commit(origin, "a.txt", "one");
    git(origin, "tag", "-a", "v1", "-m", "v1");
    const bucket = backUp(root, origin, "repo_1", "g1t-us-1/acme--rocket");
    const index = join(root, "index.json");
    writeFileSync(index, JSON.stringify([{ id: "repo_1", store: "g1t-us-1/acme--rocket", path: "acme/rocket" }, { id: "repo_2", store: "acme--gone", path: "acme/gone" }]));
    const store = join(root, "store");

    const first = tool("restore", "--into", store, "--bundles", bucket, "--index", index);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /1 restored, 0 already current, 1 without a backup/);
    const dir = repoDir(store, "g1t-us-1", "acme--rocket");
    assert.ok(existsSync(join(dir, "g1t.json")));
    assert.equal(git(dir, "rev-parse", "refs/heads/main"), git(origin, "rev-parse", "main"));
    // Again: nothing to do.
    const again = tool("restore", "--into", store, "--bundles", bucket, "--index", index);
    assert.match(again.stdout, /0 restored, 1 already current/);
    // Only a namespace asked for.
    assert.match(tool("restore", "--into", store, "--bundles", bucket, "--index", index, "--namespace", "g1t-eu").stdout, /^0 repositories/m);

    // Served as the repos service reads it: a namespaced key, a token, git.
    server = await serve(store, { readOnly: true });
    const key = encodeURIComponent("g1t-us-1/acme--rocket");
    const info = await server.api("GET", `/${key}`);
    assert.equal(info.status, 200);
    assert.equal(info.json.remote, `${server.url}/git/g1t-us-1/acme--rocket.git`);
    const read = await server.api("POST", `/${key}/tokens`, { scope: "read", ttl: 600 });
    assert.equal(read.status, 200);
    const header = `http.extraHeader=Authorization: Bearer ${read.json.plaintext}`;
    const clone = join(root, "clone");
    git(root, "-c", header, "clone", "--quiet", info.json.remote, clone);
    assert.equal(git(clone, "rev-parse", "HEAD"), git(origin, "rev-parse", "main"));
    // Read-only: no write token, no new repository.
    assert.equal((await server.api("POST", `/${key}/tokens`, { scope: "write" })).json.code, "READ_ONLY");
    assert.equal((await server.api("POST", "", { name: "g1t-us-1/new" })).json.code, "READ_ONLY");
    assert.equal((await server.api("GET", `/${encodeURIComponent("../etc")}`)).json.code, "INVALID_REPO_NAME");
    server.stop();
    server = null;

    // While it served with writes allowed, a push came in.
    assert.match(tool("changed", "--into", store).stdout, /^0 repositories/m);
    commit(clone, "b.txt", "pushed to the fallback");
    git(clone, "push", "--quiet", dir, "HEAD:refs/heads/main", "HEAD:refs/heads/during");
    const changed = tool("changed", "--into", store);
    assert.match(changed.stdout, /g1t-us-1\/acme--rocket \(repo_1\)/);
    assert.match(changed.stdout, /refs\/heads\/during/);

    // The live repository still as backed up: the push goes back as it is.
    const live = join(root, "live");
    mkdirSync(join(live, "g1t-us-1"), { recursive: true });
    git(root, "clone", "--bare", "--quiet", origin, repoDir(live, "g1t-us-1", "acme--rocket"));
    const reconciled = tool("reconcile", "--into", store, "--live-root", live, "--no-bump");
    assert.equal(reconciled.status, 0, reconciled.stdout + reconciled.stderr);
    const liveDir = repoDir(live, "g1t-us-1", "acme--rocket");
    assert.equal(git(liveDir, "rev-parse", "refs/heads/main"), git(clone, "rev-parse", "HEAD"));
    assert.equal(git(liveDir, "rev-parse", "refs/heads/during"), git(clone, "rev-parse", "HEAD"));

    // Moved on both sides: the live one stays, the fallback's goes beside it.
    rmSync(liveDir, { recursive: true, force: true });
    commit(origin, "c.txt", "pushed to Artifacts before the outage, after the backup");
    git(root, "clone", "--bare", "--quiet", origin, liveDir);
    const conflicted = tool("reconcile", "--into", store, "--live-root", live, "--no-bump");
    assert.equal(conflicted.status, 3, conflicted.stdout + conflicted.stderr);
    assert.match(conflicted.stdout, /moved on both sides/);
    assert.equal(git(liveDir, "rev-parse", "refs/heads/main"), git(origin, "rev-parse", "main"));
    assert.equal(git(liveDir, "rev-parse", "refs/fallback/heads/main"), git(clone, "rev-parse", "HEAD"));
  } finally {
    server?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a git store over HTTP is restored into through its API", async () => {
  const root = mkdtempSync(join(tmpdir(), "g1t-fallback-http-"));
  let server = null;
  try {
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    commit(origin, "a.txt", "one");
    git(origin, "branch", "dev");
    const bucket = backUp(root, origin, "repo_1", "acme--rocket");
    const index = join(root, "index.json");
    writeFileSync(index, JSON.stringify([{ id: "repo_1", store: "acme--rocket", default_branch: "main" }]));
    server = await serve(join(root, "store"), { readOnly: false });
    const run = spawn(process.execPath, [TOOL, "restore", "--gitstore", server.url, "--bundles", bucket, "--index", index], {
      env: { ...process.env, GITSTORE_SECRET: server.secret },
    });
    let out = "";
    run.stdout.on("data", (chunk) => (out += chunk));
    run.stderr.on("data", (chunk) => (out += chunk));
    const status = await new Promise((resolve) => run.on("close", resolve));
    assert.equal(status, 0, out);
    // The default namespace's repositories are kept under it.
    const dir = repoDir(join(root, "store"), "g1t", "acme--rocket");
    assert.equal(git(dir, "rev-parse", "refs/heads/dev"), git(origin, "rev-parse", "dev"));
  } finally {
    server?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
