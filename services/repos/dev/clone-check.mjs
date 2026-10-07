#!/usr/bin/env node
// Clones a repository through the repos service twice, full and shallow,
// over protocol v2 and v0, and checks that the second clone of each came
// from the pack cache (src/pack_cache.rs) and matches the first. Then
// moves the repository's refs version and checks the next clone misses.
//
// Runs everything on this machine: the self-hosted git store, and
// `wrangler dev` with dev/repos.jsonc, dev/artifacts.jsonc and
// dev/stubs.jsonc, state kept in a temporary folder. Build first:
//
//   cd services/repos && node ../../scripts/build-rust-worker.mjs
//   node dev/clone-check.mjs
//
// Needs node, git (with git-http-backend) and the repository's npm packages.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const service = resolve(here, "..");
const root = resolve(service, "../..");
const work = mkdtempSync(join(tmpdir(), "g1t-clone-check-"));
const persist = join(work, "state");
const SECRET = "dev-gitstore-secret-0123";
const STORE = "http://localhost:8799";
const REPOS = "http://localhost:8791";
const KEY = "acme--rocket";
const children = [];
// Wrangler from the repository's packages, run with node: no shell to quote for.
const WRANGLER = join(dirname(createRequire(join(service, "package.json")).resolve("wrangler/package.json")), "bin/wrangler.js");

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { encoding: "utf8", ...options });
  if (done.status !== 0 && !options.allowFail) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${done.stdout}\n${done.stderr}`);
  }
  return done;
}

const git = (args, cwd = work, env = {}) => run("git", args, { cwd, env: { ...process.env, ...env } });

function start(command, args, options) {
  const child = spawn(command, args, { ...options });
  children.push(child);
  return child;
}

async function waitFor(url, what) {
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} did not start`);
}

const sql = (command) =>
  run("node", [WRANGLER, "d1", "execute", "g1t-repos", "--local", "--persist-to", persist, "-c", "dev/repos.jsonc", "--command", command], {
    cwd: service,
    env: { ...process.env, CI: "1" },
  });

/** Clones with `args`, and says how the pack was found and what came. */
function clone(name, args) {
  const dir = join(work, name);
  const done = git(["clone", ...args, `${REPOS}/acme/rocket.git`, dir], work, { GIT_TRACE_CURL: "1", GIT_TRACE_CURL_NO_DATA: "1" });
  const timings = done.stderr.split("\n").filter((line) => /server-timing:/i.test(line) && /pack;desc=/.test(line));
  const pack = timings.map((line) => /pack;desc=(\w+)/.exec(line)[1]);
  const head = git(["rev-parse", "HEAD"], dir).stdout.trim();
  const files = git(["ls-tree", "-r", "HEAD"], dir).stdout;
  const count = git(["rev-list", "--count", "HEAD"], dir).stdout.trim();
  git(["fsck", "--no-progress"], dir);
  return { pack, head, files, count };
}

const checks = [];
function check(what, ok, detail = "") {
  checks.push({ what, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` (${detail})` : ""}`);
}

function twice(label, args, depth) {
  const first = clone(`${label}-1`, args);
  const second = clone(`${label}-2`, args);
  check(`${label}: the first clone misses`, first.pack.includes("miss"), first.pack.join(","));
  check(`${label}: the second clone hits`, second.pack.includes("hit"), second.pack.join(","));
  check(`${label}: both clones are the same`, first.head === second.head && first.files === second.files && first.count === second.count);
  if (depth) check(`${label}: ${depth} commit(s) of history`, second.count === String(depth), second.count);
  return second;
}

try {
  // The git store, with a repository of a few commits.
  start("node", [join(root, "deploy/self-host/gitstore/server.mjs")], {
    env: { ...process.env, GITSTORE_ROOT: join(work, "git"), GITSTORE_SECRET: SECRET, GITSTORE_PORT: "8799", GITSTORE_URL: STORE },
    stdio: "inherit",
  });
  await waitFor(`${STORE}/healthz`, "the git store");
  const api = (path, body) =>
    fetch(`${STORE}/api/repos${path}`, {
      method: "POST",
      headers: { "x-gitstore-secret": SECRET, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => response.json());
  await api("", { name: KEY, defaultBranch: "main" });
  const token = (await api(`/${KEY}/tokens`, { scope: "write" })).plaintext;
  const seed = join(work, "seed");
  git(["init", "-q", "-b", "main", seed]);
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(seed, `file-${i}.txt`), `${"line\n".repeat(200 * i)}${i}\n`);
    // 12 MB that does not compress, so a pack goes up in multipart parts.
    if (i === 5) writeFileSync(join(seed, "noise.bin"), randomBytes(12 * 1024 * 1024));
    git(["add", "."], seed);
    git(["-c", "user.name=dev", "-c", "user.email=dev@example.com", "commit", "-q", "-m", `commit ${i}`], seed);
  }
  git(["-c", `http.extraHeader=Authorization: Bearer ${token}`, "push", "-q", `${STORE}/git/${KEY}.git`, "main"], seed);

  // The repos service, its database with the repository in it.
  run("node", [WRANGLER, "d1", "migrations", "apply", "g1t-repos", "--local", "--persist-to", persist, "-c", "dev/repos.jsonc"], {
    cwd: service,
    env: { ...process.env, CI: "1" },
  });
  sql("INSERT INTO repos (id, namespace, name, is_private, owner_id, default_branch, refs_version) VALUES ('rep_rocket', 'acme', 'rocket', 0, 'usr_dev', 'main', 1)");
  start(
    "node",
    [WRANGLER, "dev", "-c", "dev/repos.jsonc", "-c", "dev/artifacts.jsonc", "-c", "dev/stubs.jsonc", "--local", "--persist-to", persist, "--port", "8791"],
    { cwd: service, env: { ...process.env, CI: "1" }, stdio: ["ignore", "inherit", "inherit"] },
  );
  await waitFor(`${REPOS}/acme/rocket.git/info/refs?service=git-upload-pack`, "wrangler dev");

  twice("full, v2", [], 5);
  twice("shallow, v2", ["--depth=1"], 1);
  twice("full, v0", ["-c", "protocol.version=0"], 5);
  twice("shallow, v0", ["-c", "protocol.version=0", "--depth=1"], 1);

  // A change to the refs: the next clone goes to the store.
  sql("UPDATE repos SET refs_version = refs_version + 1 WHERE id = 'rep_rocket'");
  // The service keeps a row it read a moment ago for the same clone's next request.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const after = clone("after-refs", ["--depth=1"]);
  check("after the refs version moves, a clone misses", after.pack.includes("miss"), after.pack.join(","));
} catch (error) {
  console.error(error);
  checks.push({ what: "ran", ok: false });
} finally {
  for (const child of children) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else child.kill();
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} of ${checks.length} checks failed.` : `\nAll ${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
