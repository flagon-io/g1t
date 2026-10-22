import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT,
  builtWorkerName,
  changedFiles,
  check,
  fromThisRepository,
  previewAlias,
  previewReason,
  previewUnit,
  previewUrl,
  statusBody,
  upload,
  uploadResult,
} from "./preview.mjs";

const REPO = "flagon-io/g1t";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function event({ head = REPO, number = 42 } = {}) {
  return {
    number,
    pull_request: { number, head: { sha: SHA, repo: { full_name: head } }, base: { repo: { full_name: REPO } } },
    repository: { full_name: REPO },
  };
}

function runEnv(payload, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "g1t-preview-"));
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify(payload));
  const out = join(dir, "output");
  const summary = join(dir, "summary");
  writeFileSync(out, "");
  writeFileSync(summary, "");
  return {
    dir,
    env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, ...extra },
    outputs: () =>
      Object.fromEntries(
        readFileSync(out, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(/=(.*)/s).slice(0, 2)),
      ),
    summary: () => readFileSync(summary, "utf8"),
  };
}

/** A built site as the Cloudflare plugin leaves it: the redirect and the Worker's config. */
function builtSite(dir, name = "g1t") {
  mkdirSync(join(dir, ".wrangler/deploy"), { recursive: true });
  mkdirSync(join(dir, "build/server"), { recursive: true });
  writeFileSync(join(dir, ".wrangler/deploy/config.json"), JSON.stringify({ configPath: "../../build/server/wrangler.json" }));
  writeFileSync(join(dir, "build/server/wrangler.json"), JSON.stringify({ name }));
  return dir;
}

const site = { id: "web", path: "apps/web", worker: "g1t", dependsOn: ["packages/contracts", "packages/theme"] };

test("a pull request's alias is pr-<number>", () => {
  assert.equal(previewAlias(373), "pr-373");
  assert.equal(previewAlias("12"), "pr-12");
  for (const bad of [0, -1, 1.5, "12a", "", null, undefined, " 7", "007"]) assert.throws(() => previewAlias(bad), /Not a pull request number/);
});

test("the preview's address is the alias, the Worker and the account's workers.dev subdomain", () => {
  assert.equal(previewUrl({ alias: "pr-373", worker: "g1t", subdomain: "flagon" }), "https://pr-373-g1t.flagon.workers.dev");
  // One DNS label: 63 characters at most, lowercase.
  assert.throws(() => previewUrl({ alias: `pr-${"9".repeat(60)}`, worker: "g1t", subdomain: "flagon" }), /at most 63/);
  assert.throws(() => previewUrl({ alias: "PR-1", worker: "g1t", subdomain: "flagon" }), /host name/);
  assert.throws(() => previewUrl({ alias: "pr-1", worker: "g1t", subdomain: "" }), /subdomain/);
});

test("Wrangler's output gives the version and both of its addresses", () => {
  const out = [
    "Total Upload: 5012.11 KiB / gzip: 1003.20 KiB",
    "Worker Startup Time: 41 ms",
    "Uploaded g1t (12.34 sec)",
    "Worker Version ID: 5f2a7c3e-1b2d-4e5f-8a9b-0c1d2e3f4a5b",
    "Version Preview URL: https://5f2a7c3e-g1t.flagon.workers.dev",
    "Version Preview Alias URL: https://pr-373-g1t.flagon.workers.dev",
  ].join("\n");
  assert.deepEqual(uploadResult(out), {
    version: "5f2a7c3e-1b2d-4e5f-8a9b-0c1d2e3f4a5b",
    versionUrl: "https://5f2a7c3e-g1t.flagon.workers.dev",
    aliasUrl: "https://pr-373-g1t.flagon.workers.dev",
  });
  // Preview URLs off on the Worker: Wrangler prints neither.
  assert.deepEqual(uploadResult("Worker Version ID: 5f2a7c3e-1b2d-4e5f-8a9b-0c1d2e3f4a5b\n"), {
    version: "5f2a7c3e-1b2d-4e5f-8a9b-0c1d2e3f4a5b",
    versionUrl: null,
    aliasUrl: null,
  });
});

test("only a pull request from a branch of the repository itself is previewed", () => {
  assert.equal(fromThisRepository(event(), REPO), true);
  assert.equal(fromThisRepository(event(), "Flagon-IO/G1T"), true);
  // A fork, or a g1t working copy (named as the head's repository).
  assert.equal(fromThisRepository(event({ head: "someone/g1t" }), REPO), false);
  assert.equal(fromThisRepository(event({ head: "syntaqx/g1t-wc-42" }), REPO), false);
  assert.equal(fromThisRepository({ pull_request: { number: 1, head: {}, base: { repo: { full_name: REPO } } } }, REPO), false);
  assert.equal(fromThisRepository({}, REPO), false);
  assert.equal(fromThisRepository(event(), ""), false);
});

test("what the site is built from is previewed; deploy tooling, other units, docs and tests are not", () => {
  const why = (files) => previewReason(site, files);
  assert.deepEqual(why(["apps/web/app/routes/home.tsx"]), { file: "apps/web/app/routes/home.tsx", via: "its own folder" });
  assert.deepEqual(why(["apps/web/wrangler.jsonc"]), { file: "apps/web/wrangler.jsonc", via: "its own folder" });
  assert.deepEqual(why(["packages/contracts/src/work.ts"]), { file: "packages/contracts/src/work.ts", via: "packages/contracts" });
  assert.deepEqual(why(["package-lock.json"]), { file: "package-lock.json", via: "package-lock.json" });
  assert.deepEqual(why([".g1t/workflows/preview.yml"]), { file: ".g1t/workflows/preview.yml", via: "the preview pipeline" });
  assert.deepEqual(why(["scripts/deploy/preview.mjs"]), { file: "scripts/deploy/preview.mjs", via: "the preview pipeline" });
  for (const files of [
    [],
    ["services/work/src/queue.rs"],
    ["apps/docs/src/content/docs/guides/actions.md", "CONTRIBUTING.md"],
    ["apps/web/app/lib/addresses.test.ts"],
    ["scripts/deploy/preview.test.mjs"],
    ["scripts/deploy.mjs", "deploy/stack.jsonc", ".g1t/workflows/deploy.yml", "scripts/deploy/cloudflare.mjs"],
    ["apps/sudo/app/root.tsx", "packages/contractsx/a.ts"],
  ]) {
    assert.equal(why(files), null, files.join(", "));
  }
  // A change that could not be read is previewed.
  assert.deepEqual(why(null), { file: null, via: "the change could not be read, so it is previewed" });
});

test("the site's unit is resolved from the manifest, with the packages it uses", () => {
  const unit = previewUnit();
  assert.equal(unit.worker, "g1t");
  assert.equal(unit.path, "apps/web");
  assert.ok(unit.dependsOn.includes("packages/contracts"), unit.dependsOn.join(", "));
  assert.equal(previewReason(unit, ["packages/contracts/src/index.ts"])?.via, "packages/contracts");
});

test("the change is the test merge against its first parent, or unknown when HEAD is not a merge", () => {
  const calls = [];
  const git = (answers) => (args) => {
    calls.push(args.join(" "));
    return answers[args[0]] ?? null;
  };
  assert.deepEqual(changedFiles(git({ "rev-list": "m p1 p2", diff: "apps/web/a.ts\nREADME.md\n" })), ["apps/web/a.ts", "README.md"]);
  assert.ok(calls.includes("diff --name-only --no-renames HEAD^1 HEAD"));
  assert.equal(changedFiles(git({ "rev-list": "head parent" })), null);
  assert.equal(changedFiles(git({})), null);
  assert.equal(changedFiles(git({ "rev-list": "m p1 p2" })), null);
});

test("check writes whether to preview, and never previews a fork", () => {
  const unit = () => site;
  const changed = runEnv(event());
  assert.deepEqual(check(changed.env, { files: () => ["apps/web/app/root.tsx"], unit }), { preview: true, alias: "pr-42" });
  assert.deepEqual(changed.outputs(), { preview: "true", alias: "pr-42" });

  const elsewhere = runEnv(event());
  check(elsewhere.env, { files: () => ["services/work/src/lib.rs"], unit });
  assert.equal(elsewhere.outputs().preview, "false");

  const fork = runEnv(event({ head: "someone/g1t" }));
  check(fork.env, { files: () => ["apps/web/app/root.tsx"], unit });
  assert.equal(fork.outputs().preview, "false");

  assert.throws(() => check({ ...changed.env, GITHUB_EVENT_NAME: "pull_request_target" }, { files: () => [], unit }), /pull_request runs/);
});

test("upload makes a version under the alias, never a deploy, and links it from the head commit", async () => {
  const run = runEnv(event({ number: 373 }), {
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    GITHUB_API_URL: "https://api.g1t.sh",
    GITHUB_TOKEN: "job-token",
  });
  const dir = builtSite(join(run.dir, "web"));
  const calls = [];
  const wrangler = async (args, options) => {
    calls.push({ args, cwd: options.cwd });
    return { code: 0, out: "Worker Version ID: 5f2a7c3e-1b2d-4e5f-8a9b-0c1d2e3f4a5b\nVersion Preview Alias URL: https://pr-373-g1t.flagon.workers.dev\n" };
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response("{}", { status: 201 });
  };
  const result = await upload(run.env, { run: wrangler, fetchImpl, unit: () => site, dir });
  assert.equal(result.url, "https://pr-373-g1t.flagon.workers.dev");
  assert.equal(calls.length, 1);
  const [{ args, cwd }] = calls;
  assert.equal(cwd, dir);
  assert.deepEqual(args.slice(0, 4), ["versions", "upload", "--preview-alias", "pr-373"]);
  assert.ok(!args.includes("deploy"), args.join(" "));
  // The deploy's plan reads `g1t-deploy <sha>` messages as live commits.
  const message = args[args.indexOf("--message") + 1];
  assert.ok(message.startsWith("g1t-preview pr-373 "), message);
  assert.equal(args[args.indexOf("--tag") + 1], "pr-373-0123456");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://api.g1t.sh/repos/${REPO}/statuses/${SHA}`);
  assert.equal(requests[0].init.headers.authorization, "Bearer job-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), statusBody("https://pr-373-g1t.flagon.workers.dev"));
  assert.equal(JSON.parse(requests[0].init.body).context, CONTEXT);
  assert.equal(run.outputs().url, "https://pr-373-g1t.flagon.workers.dev");
  assert.match(run.summary(), /pr-373-g1t\.flagon\.workers\.dev/);
});

test("upload derives the address when Wrangler does not print it", async () => {
  const run = runEnv(event({ number: 7 }), { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acct" });
  const dir = builtSite(join(run.dir, "web"));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return Response.json({ success: true, result: { subdomain: "flagon" } });
  };
  const result = await upload(run.env, { run: async () => ({ code: 0, out: "Uploaded g1t\n" }), fetchImpl, unit: () => site, dir });
  assert.equal(result.url, "https://pr-7-g1t.flagon.workers.dev");
  assert.deepEqual(urls, ["https://api.cloudflare.com/client/v4/accounts/acct/workers/subdomain"]);
});

test("upload refuses a fork, another Worker's build, and skips without a token", async () => {
  const never = async () => assert.fail("wrangler must not run");
  const fork = runEnv(event({ head: "someone/g1t" }), { CLOUDFLARE_API_TOKEN: "cf-token" });
  await assert.rejects(upload(fork.env, { run: never, unit: () => site, dir: builtSite(join(fork.dir, "web")) }), /not from a branch of this repository/);

  const other = runEnv(event(), { CLOUDFLARE_API_TOKEN: "cf-token" });
  await assert.rejects(upload(other.env, { run: never, unit: () => site, dir: builtSite(join(other.dir, "web"), "g1t-identity") }), /refusing to upload/);

  const tokenless = runEnv(event());
  assert.deepEqual(await upload(tokenless.env, { run: never, unit: () => site, dir: builtSite(join(tokenless.dir, "web")) }), { url: null, skipped: true });
  assert.equal(tokenless.outputs().url, "");

  const failed = runEnv(event(), { CLOUDFLARE_API_TOKEN: "cf-token" });
  await assert.rejects(
    upload(failed.env, { run: async () => ({ code: 1, out: "✘ [ERROR] Authentication error\n" }), unit: () => site, dir: builtSite(join(failed.dir, "web")) }),
    /versions upload failed/,
  );
});

test("the built Worker's name is read through the Cloudflare plugin's redirect", () => {
  const dir = builtSite(mkdtempSync(join(tmpdir(), "g1t-preview-site-")), "g1t");
  assert.equal(builtWorkerName(dir), "g1t");
  assert.throws(() => builtWorkerName(mkdtempSync(join(tmpdir(), "g1t-preview-empty-"))), /build the site first/);
});
