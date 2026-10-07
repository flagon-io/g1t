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
// With `--s3`, packs are kept in RustFS instead of local R2, as a
// self-hosted installation keeps them (PACK_STORE=s3): it starts RustFS in
// Docker, makes the `g1t-git-packs` bucket with the same lifecycle rule the
// compose file gives it (with the AWS CLI, as the compose file does), and
// checks that what was kept is there, whole, with no upload left
// unfinished.
//
//   node dev/clone-check.mjs --s3
//
// GITSTORE_PORT, REPOS_PORT and S3_PORT move it off 8799, 8791 and 9010.
// RUSTFS_IMAGE and AWS_CLI_IMAGE choose other images.
//
// Needs node, git (with git-http-backend) and the repository's npm
// packages; with `--s3`, Docker too.

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
// The ports, if something on this machine already has the defaults.
const STORE_PORT = process.env.GITSTORE_PORT ?? "8799";
const REPOS_PORT = process.env.REPOS_PORT ?? "8791";
const STORE = `http://localhost:${STORE_PORT}`;
const REPOS = `http://localhost:${REPOS_PORT}`;
// dev/artifacts.jsonc, pointed at this run's git store.
const ARTIFACTS_CONFIG = join(work, "artifacts.json");
writeFileSync(
  ARTIFACTS_CONFIG,
  JSON.stringify({
    name: "g1t-artifacts",
    main: join(root, "deploy/self-host/workers/artifacts/index.js"),
    compatibility_date: "2026-09-26",
    vars: { GITSTORE_URL: STORE, GITSTORE_SECRET: SECRET },
  }),
);
const KEY = "acme--rocket";
const children = [];
// --s3: packs in RustFS (see the top). The images are the compose file's.
const S3 = process.argv.includes("--s3");
const STORAGE = "g1t-clone-check-rustfs";
const S3_PORT = process.env.S3_PORT ?? "9010";
const S3_USER = "g1t";
const S3_PASSWORD = "g1t-clone-check-secret";
const RUSTFS_IMAGE = process.env.RUSTFS_IMAGE ?? "rustfs/rustfs:1.0.1";
const AWS_CLI_IMAGE = process.env.AWS_CLI_IMAGE ?? "amazon/aws-cli:2.37.10";
const PACKS_BUCKET = "g1t-git-packs";
/** The AWS CLI's `s3api`, in a container on the store's network, against it. */
const s3api = (args, options = {}) =>
  run("docker", [
    "run", "--rm", "--network", `container:${STORAGE}`,
    "-e", `AWS_ACCESS_KEY_ID=${S3_USER}`, "-e", `AWS_SECRET_ACCESS_KEY=${S3_PASSWORD}`, "-e", "AWS_DEFAULT_REGION=us-east-1",
    AWS_CLI_IMAGE, "--endpoint-url", "http://localhost:9000", "--output", "json", "s3api", ...args,
  ], options);
/** The same, its answer parsed. */
const s3json = (args) => JSON.parse(s3api(args).stdout.trim() || "{}");
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
    env: { ...process.env, GITSTORE_ROOT: join(work, "git"), GITSTORE_SECRET: SECRET, GITSTORE_PORT: STORE_PORT, GITSTORE_URL: STORE },
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

  // RustFS, with the bucket and lifecycle rule deploy/self-host/docker-compose.yml makes.
  const s3Vars = [];
  if (S3) {
    run("docker", ["rm", "-f", STORAGE], { allowFail: true });
    run("docker", [
      "run", "-d", "--rm", "--name", STORAGE, "-p", `${S3_PORT}:9000`,
      "-e", `RUSTFS_ACCESS_KEY=${S3_USER}`, "-e", `RUSTFS_SECRET_KEY=${S3_PASSWORD}`, "-e", "RUSTFS_CONSOLE_ENABLE=false",
      RUSTFS_IMAGE,
    ]);
    await waitFor(`http://localhost:${S3_PORT}/health/ready`, "RustFS");
    s3api(["create-bucket", "--bucket", PACKS_BUCKET]);
    s3api([
      "put-bucket-lifecycle-configuration", "--bucket", PACKS_BUCKET, "--lifecycle-configuration",
      JSON.stringify({
        Rules: [
          { ID: "expire-packs", Status: "Enabled", Filter: { Prefix: "packs/" }, Expiration: { Days: 7 } },
          { ID: "abort-unfinished-uploads", Status: "Enabled", Filter: { Prefix: "" }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
        ],
      }),
    ]);
    for (const [name, value] of Object.entries({
      PACK_STORE: "s3",
      PACK_S3_BUCKET: PACKS_BUCKET,
      S3_ENDPOINT: `http://localhost:${S3_PORT}`,
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: S3_USER,
      S3_SECRET_ACCESS_KEY: S3_PASSWORD,
    })) {
      s3Vars.push("--var", `${name}:${value}`);
    }
  }
  start(
    "node",
    [WRANGLER, "dev", "-c", "dev/repos.jsonc", "-c", ARTIFACTS_CONFIG, "-c", "dev/stubs.jsonc", "--local", "--persist-to", persist, "--port", REPOS_PORT, ...s3Vars],
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

  if (S3) {
    // Fills finish after git has its answer: give the last one a moment.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const listed = s3json(["list-objects-v2", "--bucket", PACKS_BUCKET, "--prefix", "packs/"]).Contents ?? [];
    const sizes = listed.map((entry) => entry.Size);
    // Nine clones: four kinds twice, each kept once, and one more after the refs moved.
    check("the packs are in RustFS, one per distinct clone", listed.length === 5, `${listed.length}: ${sizes.join(", ")}`);
    check("the full clone's pack went up in parts", sizes.some((size) => size > 5 * 1024 * 1024), `largest ${Math.max(...sizes)}`);
    // A multipart object's ETag ends in -<number of parts>.
    check("the large pack is one multipart object", listed.some((entry) => /-\d+"?$/.test(entry.ETag ?? "")), listed.map((entry) => entry.ETag).join(", "));
    const short = listed.filter((entry) => s3json(["head-object", "--bucket", PACKS_BUCKET, "--key", entry.Key]).ContentLength !== entry.Size);
    check("every pack reads back whole", short.length === 0, short.map((entry) => entry.Key).join(", "));
    const incomplete = s3json(["list-multipart-uploads", "--bucket", PACKS_BUCKET]).Uploads ?? [];
    check("no upload is left unfinished", incomplete.length === 0, incomplete.map((upload) => upload.Key).join(", "));
    const rules = s3json(["get-bucket-lifecycle-configuration", "--bucket", PACKS_BUCKET]).Rules ?? [];
    check("the bucket expires packs after 7 days", rules.some((rule) => rule.Expiration?.Days === 7 && rule.Filter?.Prefix === "packs/"), JSON.stringify(rules));
    check("the bucket aborts uploads unfinished after a day", rules.some((rule) => rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 1));
  }
} catch (error) {
  console.error(error);
  checks.push({ what: "ran", ok: false });
} finally {
  for (const child of children) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else child.kill();
  }
  if (S3) run("docker", ["rm", "-f", STORAGE], { allowFail: true });
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} of ${checks.length} checks failed.` : `\nAll ${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
