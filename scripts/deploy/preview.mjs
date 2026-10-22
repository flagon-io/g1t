// A preview of the site (apps/web) for a pull request: its build uploaded
// to Cloudflare as a version of the `g1t` Worker that takes no production
// traffic, under an alias of the pull request's own, so it is at one
// address for as long as the pull request is open:
//
//   https://pr-<number>-g1t.<the account's subdomain>.workers.dev
//
// .g1t/workflows/preview.yml runs it in two jobs:
//
//   node scripts/deploy/preview.mjs check    whether the pull request needs a
//                                            preview (outputs preview, alias)
//   node scripts/deploy/preview.mjs upload   uploads what the build job made,
//                                            and links it from the pull request
//
// `check` says yes for a pull request from a branch of this repository
// whose change reaches what the site is built from (`reason`); never for
// one from a fork or a working copy, whose code must not run with
// Cloudflare's credentials. `upload` checks the same again before it
// reads the token, uploads with `wrangler versions upload --preview-alias`
// (nothing is deployed, no migration runs, no setting of the Worker
// changes), and sets the commit status `preview / web` on the pull
// request's head, its link the preview's address.
//
// The version has the production Worker's bindings, variables and secrets:
// it reads and writes g1t.sh's real data through the same services. You
// sign in on the preview itself (the session cookie is the preview host's
// alone; g1t.sh's never reaches it). CONTRIBUTING.md, "Previewing a change
// to the site", says what works there and what to set up.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { wrangler, wranglerError } from "./cloudflare.mjs";
import { isScriptTest, loadStack, npmWorkspace, resolveStack } from "./stack.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The unit previewed, as deploy/stack.jsonc names it. */
export const UNIT = "web";

/** The commit status that links a pull request to its preview. */
export const CONTEXT = "preview / web";

/**
 * Files that change how a preview is made, beside what the site is built
 * from: a change to them is previewed, so the pipeline is tried before it
 * merges.
 */
export const PIPELINE = [".g1t/workflows/preview.yml", "scripts/deploy/preview.mjs"];

/**
 * Files at the root the site is built from. The deploy tool's own files
 * and deploy.yml change how production deploys, not what the site is, so
 * they are not here (stack.mjs's `globalInputs` has them for deploys).
 */
export const ROOT_INPUTS = ["package.json", "package-lock.json", "tsconfig.base.json"];

/** The alias of pull request `number`'s preview: `pr-<number>`. */
export function previewAlias(number) {
  const n = Number(number);
  if (!Number.isSafeInteger(n) || n <= 0 || String(number) !== String(n)) {
    throw new Error(`Not a pull request number: ${JSON.stringify(number)}`);
  }
  return `pr-${n}`;
}

/**
 * The preview's address: `https://<alias>-<worker>.<subdomain>.workers.dev`.
 * Its first label is one DNS label, so it is at most 63 characters of
 * lowercase letters, digits and hyphens; Cloudflare makes no alias that
 * breaks this.
 */
export function previewUrl({ alias, worker, subdomain }) {
  const label = `${alias}-${worker}`;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) || label.length > 63) {
    throw new Error(`${label} cannot be a preview's host name: lowercase letters, digits and hyphens, at most 63`);
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain ?? "")) throw new Error(`Not a workers.dev subdomain: ${JSON.stringify(subdomain)}`);
  return `https://${label}.${subdomain}.workers.dev`;
}

/**
 * What `wrangler versions upload` printed: the version's id, its own
 * address and its alias's (each null when not printed).
 */
export function uploadResult(output) {
  const find = (pattern) => pattern.exec(output)?.[1] ?? null;
  return {
    version: find(/Worker Version ID:\s*([0-9a-f-]{36})/i),
    versionUrl: find(/Version Preview URL:\s*(https:\/\/\S+)/i),
    aliasUrl: find(/Version Preview Alias URL:\s*(https:\/\/\S+)/i),
  };
}

/**
 * Whether a `pull_request` event's pull request is from a branch of
 * `repository` itself (not a fork, nor a working copy, which g1t names as
 * the head's repository), into it.
 */
export function fromThisRepository(event, repository) {
  const pull = event?.pull_request;
  if (!pull || !repository) return false;
  const head = pull.head?.repo?.full_name;
  const base = pull.base?.repo?.full_name ?? event.repository?.full_name;
  return typeof head === "string" && head.toLowerCase() === repository.toLowerCase() && base?.toLowerCase() === repository.toLowerCase();
}

/** The previewed unit, resolved against the npm workspace (it is a site: no Cargo). */
export function previewUnit(root = ROOT) {
  const stack = resolveStack(loadStack(root), { cargo: new Map(), npm: npmWorkspace(root) });
  const unit = stack.units.find((u) => u.id === UNIT);
  if (!unit) throw new Error(`deploy/stack.jsonc has no unit ${UNIT}`);
  return unit;
}

const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);

/**
 * Why changed files (repository-relative, `/`-separated) need a preview:
 * the first that does, and through what; null when none does. `null` for
 * the files (they could not be told) needs one. Tests do not.
 */
export function previewReason(unit, files) {
  if (files === null) return { file: null, via: "the change could not be read, so it is previewed" };
  for (const file of files) {
    if (PIPELINE.includes(file)) return { file, via: "the preview pipeline" };
  }
  const built = files.filter((file) => !isScriptTest(file));
  for (const file of built) {
    if (under(file, unit.path)) return { file, via: "its own folder" };
  }
  for (const file of built) {
    const dir = unit.dependsOn.find((d) => under(file, d));
    if (dir) return { file, via: dir };
    if (ROOT_INPUTS.includes(file)) return { file, via: file };
  }
  return null;
}

/**
 * The files a pull request's run changes: its test merge commit against
 * the first parent, the base branch's tip (as scripts/deploy/ci-affected.mjs
 * reads them). Null when HEAD is not a merge (g1t could not make one and
 * the run builds the head) or git fails.
 */
export function changedFiles(git = runGit) {
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]);
  if (parents === null || parents.split(/\s+/).filter(Boolean).length !== 3) return null;
  const diff = git(["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"]);
  return diff === null ? null : diff.split("\n").filter(Boolean);
}

function runGit(args) {
  const run = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : null;
}

/** The body of the commit status that links the preview. */
export function statusBody(url) {
  return { state: "success", context: CONTEXT, description: "The site as this pull request makes it", target_url: url };
}

/**
 * The Worker's name in the config the site's build wrote, which Wrangler
 * reads through `.wrangler/deploy/config.json`.
 */
export function builtWorkerName(dir) {
  const redirect = join(dir, ".wrangler/deploy/config.json");
  if (!existsSync(redirect)) throw new Error(`${redirect} is missing: build the site first`);
  const { configPath } = JSON.parse(readFileSync(redirect, "utf8"));
  const config = JSON.parse(readFileSync(resolve(dirname(redirect), configPath), "utf8"));
  return config.name;
}

/** The account's workers.dev subdomain, from Cloudflare's API. */
export async function workersSubdomain({ account, token, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  const subdomain = body?.result?.subdomain;
  if (!response.ok || !subdomain) throw new Error(`Could not read the account's workers.dev subdomain (${response.status})`);
  return subdomain;
}

/** Sets the commit status on `sha` through g1t's GitHub-compatible API. */
export async function setStatus({ api, repository, sha, token, url, fetchImpl = fetch }) {
  const response = await fetchImpl(`${api}/repos/${repository}/statuses/${sha}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify(statusBody(url)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Setting the commit status failed (${response.status}): ${await response.text().catch(() => "")}`);
}

function readEvent(env) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") throw new Error(`Previews are for pull_request runs, not ${env.GITHUB_EVENT_NAME || "this"}`);
  return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
}

function output(env, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));
}

function summary(env, text) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

/** `check`: whether this run makes a preview. */
export function check(env = process.env, { files = changedFiles, unit = previewUnit } = {}) {
  const event = readEvent(env);
  const number = event.pull_request?.number ?? event.number;
  const alias = previewAlias(number);
  if (!fromThisRepository(event, env.GITHUB_REPOSITORY)) {
    console.log(
      `No preview: ${alias} is not from a branch of ${env.GITHUB_REPOSITORY} (a fork's or a working copy's code never runs with Cloudflare's credentials).`,
    );
    output(env, { preview: "false", alias });
    return { preview: false, alias };
  }
  const why = previewReason(unit(), files());
  if (!why) console.log(`No preview: nothing ${alias} changes reaches the site.`);
  else console.log(`Preview ${alias}: ${why.file ? `${why.file}, through ${why.via}` : why.via}.`);
  output(env, { preview: String(Boolean(why)), alias });
  return { preview: Boolean(why), alias };
}

/** `upload`: uploads the built site as the pull request's preview, and links it. */
export async function upload(env = process.env, { run = wrangler, fetchImpl = fetch, unit = previewUnit, dir = null } = {}) {
  const event = readEvent(env);
  const repository = env.GITHUB_REPOSITORY;
  // Checked again here, beside the job's `if`, before the token is used.
  if (!fromThisRepository(event, repository)) throw new Error("Refusing to upload a preview for a pull request that is not from a branch of this repository.");
  const alias = previewAlias(event.pull_request.number);
  const sha = event.pull_request.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("The event names no head commit.");
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const note = 'No preview: the `preview` environment has no CLOUDFLARE_PREVIEW_TOKEN (CONTRIBUTING.md, "Previewing a change to the site").';
    console.log(`::notice::${note}`);
    summary(env, note);
    output(env, { url: "" });
    return { url: null, skipped: true };
  }
  const site = unit();
  dir ??= join(ROOT, site.path);
  const name = builtWorkerName(dir);
  if (name !== site.worker) throw new Error(`The build is of the Worker ${JSON.stringify(name)}, not ${site.worker}: refusing to upload it.`);
  const args = [
    "versions",
    "upload",
    "--preview-alias",
    alias,
    "--tag",
    `${alias}-${sha.slice(0, 7)}`,
    // Not `g1t-deploy …`: the deploy's plan reads a Worker's live commit
    // from that message (cloudflare.mjs), and this version is never live.
    "--message",
    `g1t-preview ${alias} ${sha}`,
  ];
  const uploaded = await run(args, { cwd: dir, onLine: (line) => console.log(line) });
  if (uploaded.code !== 0) throw new Error(`wrangler versions upload failed:\n${wranglerError(uploaded.out)}`);
  const result = uploadResult(uploaded.out);
  let url = result.aliasUrl;
  if (!url) {
    const subdomain = env.CLOUDFLARE_WORKERS_SUBDOMAIN || (await workersSubdomain({ account: env.CLOUDFLARE_ACCOUNT_ID, token, fetchImpl }));
    url = previewUrl({ alias, worker: site.worker, subdomain });
  }
  console.log(`Preview ${alias}: ${url}${result.version ? ` (version ${result.version})` : ""}`);
  summary(
    env,
    [
      `### Preview of #${event.pull_request.number}`,
      "",
      `[${url}](${url}), at ${sha.slice(0, 7)}${result.versionUrl ? `; this commit alone: ${result.versionUrl}` : ""}.`,
      "",
      "It reads and writes g1t.sh's real data. Sign in on the preview itself, with a password; GitHub and SSO sign-in work only on g1t.sh.",
    ].join("\n"),
  );
  output(env, { url });
  if (env.GITHUB_API_URL && env.GITHUB_TOKEN) {
    await setStatus({ api: env.GITHUB_API_URL, repository, sha, token: env.GITHUB_TOKEN, url, fetchImpl });
  } else {
    console.log("No GITHUB_API_URL or GITHUB_TOKEN: the commit status is not set.");
  }
  return { url, version: result.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const commands = { check, upload };
  if (!commands[command]) {
    console.error("usage: node scripts/deploy/preview.mjs check|upload");
    process.exit(2);
  }
  try {
    await commands[command]();
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}
