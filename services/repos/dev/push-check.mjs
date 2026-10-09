#!/usr/bin/env node
// Pushes through the repos service with real git and checks that git sends
// a pack without outside bases: the receive-pack advertisement says
// `no-thin` (src/git_http.rs `with_no_thin`), git runs pack-objects without
// `--thin`, and the service says the pack came whole (`thin;desc=no` in
// Server-Timing) and read no bases from the store. Then the same into an
// empty repository, whose advertisement is a `capabilities^{}` line.
//
// Runs everything on this machine, as clone-check.mjs does: the self-hosted
// git store, and `wrangler dev` with dev/repos.jsonc, dev/artifacts.jsonc
// and dev/stubs.jsonc (whose identity stub knows `dev`, the pusher). Build
// first:
//
//   cd services/repos && node ../../scripts/build-rust-worker.mjs
//   node dev/push-check.mjs
//
// GITSTORE_PORT and REPOS_PORT move it off 8799 and 8791. Needs node, git
// (with git-http-backend) and the repository's npm packages.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const service = resolve(here, "..");
const root = resolve(service, "../..");
const work = mkdtempSync(join(tmpdir(), "g1t-push-check-"));
const persist = join(work, "state");
const SECRET = "dev-gitstore-secret-0123";
const STORE_PORT = process.env.GITSTORE_PORT ?? "8799";
const REPOS_PORT = process.env.REPOS_PORT ?? "8791";
const STORE = `http://localhost:${STORE_PORT}`;
const REPOS = `http://localhost:${REPOS_PORT}`;
// The pusher the identity stub knows (dev/stubs.js).
const PUSHER = "dev:dev-push-secret";
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
const children = [];
const WRANGLER = join(dirname(createRequire(join(service, "package.json")).resolve("wrangler/package.json")), "bin/wrangler.js");

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { encoding: "utf8", ...options });
  if (done.status !== 0 && !options.allowFail) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${done.stdout}\n${done.stderr}`);
  }
  return done;
}

const git = (args, cwd = work, env = {}) => run("git", args, { cwd, env: { ...process.env, ...env } });
const identity = ["-c", "user.name=dev", "-c", "user.email=dev@example.com"];

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

const checks = [];
function check(what, ok, detail = "") {
  checks.push({ what, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` (${detail})` : ""}`);
}

/** Pushes `dir`'s main through the service, with git's traces. */
function push(label, dir, name) {
  const trace = join(work, `${label}.trace`);
  const done = git(["push", `http://${PUSHER}@localhost:${REPOS_PORT}/acme/${name}.git`, "main"], dir, {
    GIT_TRACE: trace,
    GIT_TRACE_PACKET: trace,
    GIT_TRACE_CURL: trace,
    GIT_TRACE_CURL_NO_DATA: "1",
  });
  const lines = readFileSync(trace, "utf8").split("\n");
  // The first ref line, with the capabilities after its NUL (`\0` in the trace).
  const advertised = lines.find((line) => /packet:.*< [0-9a-f]{40} \S+\\0/.test(line)) ?? "";
  if (!advertised) console.log(lines.filter((line) => /report-status/.test(line)).slice(0, 3).join("\n"));
  const packing = lines.find((line) => /run_command: git pack-objects/.test(line)) ?? "";
  const timing = lines.filter((line) => /server-timing:/i.test(line) && /recv;dur=/.test(line)).join(" ");
  check(`${label}: the advertisement says no-thin`, /\bno-thin\b/.test(advertised), `...${advertised.slice(-48)}`);
  check(`${label}: git packs without --thin`, packing !== "" && !/--thin\b/.test(packing), packing.replace(/.*run_command: /, ""));
  check(`${label}: the service says the pack came whole`, /thin;desc=no/.test(timing), (/thin;desc=\w+/.exec(timing) ?? ["no thin note"])[0]);
  check(`${label}: no base was read`, /read;dur=\d+/.test(timing) && !/thin;desc=yes/.test(timing), (/read;dur=\d+/.exec(timing) ?? [""])[0]);
  return done;
}

try {
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
  // acme/rocket: a large file, many versions of it, so a push changing one
  // line of it would be a delta on the version the store has.
  await api("", { name: "acme--rocket", defaultBranch: "main" });
  await api("", { name: "acme--empty", defaultBranch: "main" });
  const token = (await api("/acme--rocket/tokens", { scope: "write" })).plaintext;
  const seed = join(work, "seed");
  git(["init", "-q", "-b", "main", seed]);
  const lines = Array.from({ length: 4000 }, (_, at) => `line ${at} of a file that changes a little at a time\n`);
  for (let i = 1; i <= 3; i++) {
    lines[i * 100] = `changed in commit ${i}\n`;
    writeFileSync(join(seed, "big.txt"), lines.join(""));
    git(["add", "."], seed);
    git([...identity, "commit", "-q", "-m", `commit ${i}`], seed);
  }
  git(["-c", `http.extraHeader=Authorization: Bearer ${token}`, "push", "-q", `${STORE}/git/acme--rocket.git`, "main"], seed);
  // The control: the store's own advertisement, without g1t in front,
  // gets a thin pack for the same kind of change.
  {
    lines[3000] = "changed straight in the store\n";
    writeFileSync(join(seed, "big.txt"), lines.join(""));
    git([...identity, "commit", "-q", "-am", "straight"], seed);
    const trace = join(work, "control.trace");
    git(["-c", `http.extraHeader=Authorization: Bearer ${token}`, "push", "-q", `${STORE}/git/acme--rocket.git`, "main"], seed, { GIT_TRACE: trace });
    const packing = readFileSync(trace, "utf8").split("\n").find((line) => /run_command: git pack-objects/.test(line)) ?? "";
    check("control: straight to the store, git packs with --thin", /--thin\b/.test(packing), packing.replace(/.*run_command: /, ""));
  }

  run("node", [WRANGLER, "d1", "migrations", "apply", "g1t-repos", "--local", "--persist-to", persist, "-c", "dev/repos.jsonc"], {
    cwd: service,
    env: { ...process.env, CI: "1" },
  });
  sql(
    "INSERT INTO repos (id, namespace, name, is_private, owner_id, default_branch, refs_version) VALUES " +
      "('rep_rocket', 'acme', 'rocket', 0, 'usr_dev', 'main', 1), ('rep_empty', 'acme', 'empty', 0, 'usr_dev', 'main', 1)",
  );
  start(
    "node",
    [WRANGLER, "dev", "-c", "dev/repos.jsonc", "-c", ARTIFACTS_CONFIG, "-c", "dev/stubs.jsonc", "--local", "--persist-to", persist, "--port", REPOS_PORT],
    { cwd: service, env: { ...process.env, CI: "1" }, stdio: ["ignore", "inherit", "inherit"] },
  );
  await waitFor(`${REPOS}/acme/rocket.git/info/refs?service=git-upload-pack`, "wrangler dev");

  // One line of the big file changed: thin, the pack would be a small
  // delta on the store's copy; whole, it carries the file.
  const clone = join(work, "clone");
  git(["clone", "-q", `${REPOS}/acme/rocket.git`, clone]);
  lines[2000] = "changed by the push\n";
  writeFileSync(join(clone, "big.txt"), lines.join(""));
  git([...identity, "commit", "-q", "-am", "one line"], clone);
  push("existing repository", clone, "rocket");
  const pushed = git(["ls-remote", `${STORE}/git/acme--rocket.git`, "refs/heads/main"], work, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  }).stdout.split(/\s/)[0];
  const local = git(["rev-parse", "HEAD"], clone).stdout.trim();
  check("existing repository: the store has the pushed commit", pushed === local, `${pushed} / ${local}`);

  // An empty repository advertises `capabilities^{}`.
  push("empty repository", clone, "empty");
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
