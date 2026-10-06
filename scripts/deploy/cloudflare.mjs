// Wrangler, as the deploy tool uses it: reading which commit each Worker
// runs, D1 migrations, and deploying. Every call runs in the unit's own
// folder, so Wrangler reads that unit's config (and not a .env at the
// repository root, which may hold a token meant for something else).

import { spawn } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "./stack.mjs";

const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
export const ACCOUNT_ID = "1e6f2cffa3f445920836e8ebe446bb58";

/**
 * Headers for Cloudflare's REST and GraphQL APIs, for the ops scripts:
 * CLOUDFLARE_API_TOKEN as a bearer token, or else a global API key
 * (CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL). Null when neither is set.
 */
export function cloudflareAuth(env = process.env) {
  if (env.CLOUDFLARE_API_TOKEN) return { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  if (env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_EMAIL) {
    return { "x-auth-key": env.CLOUDFLARE_API_KEY, "x-auth-email": env.CLOUDFLARE_EMAIL };
  }
  return null;
}

/** What a deploy's version message starts with, followed by the commit. */
export const MESSAGE_PREFIX = "g1t-deploy";

/**
 * The environment Wrangler runs with. In CI (CI=true) it is the job's:
 * CLOUDFLARE_API_TOKEN from the repository's secret. On a laptop it is
 * your `wrangler login`, unless CLOUDFLARE_DEPLOY_TOKEN is set, as
 * scripts/deploy.sh always did: a CLOUDFLARE_API_TOKEN or global API key
 * in your shell is for other tools.
 */
export function wranglerEnv(base = process.env) {
  const env = { ...base, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" };
  env.CLOUDFLARE_ACCOUNT_ID ||= ACCOUNT_ID;
  if (base.CLOUDFLARE_DEPLOY_TOKEN) {
    env.CLOUDFLARE_API_TOKEN = base.CLOUDFLARE_DEPLOY_TOKEN;
  } else if (base.CI !== "true") {
    env.CLOUDFLARE_API_TOKEN = "";
    delete env.CLOUDFLARE_API_KEY;
    delete env.CLOUDFLARE_EMAIL;
  }
  return env;
}

/**
 * Runs a command; resolves with { code, out } (stdout and stderr together,
 * in order). `onLine` sees each line as it comes; `input` is written to
 * its stdin.
 */
export function exec(command, args, { cwd = ROOT, env = process.env, onLine, shell = false, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true });
    if (input !== undefined) child.stdin.end(input);
    let out = "";
    let partial = "";
    const take = (chunk) => {
      const text = chunk.toString();
      out += text;
      if (!onLine) return;
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) onLine(line);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => resolve({ code: 127, out: `${out}${error.message}\n` }));
    child.on("close", (code) => {
      if (onLine && partial) onLine(partial);
      resolve({ code: code ?? 1, out });
    });
  });
}

/** Runs the repository's own Wrangler in `cwd`. */
export function wrangler(args, { cwd, env = wranglerEnv(), onLine } = {}) {
  return exec(process.execPath, [WRANGLER, ...args], { cwd, env, onLine });
}

/** The first JSON value in Wrangler's output (it may print notices first). */
export function jsonFrom(out) {
  const start = out.search(/^[[{]/m);
  if (start < 0) throw new Error(`no JSON in: ${out.slice(0, 300)}`);
  return JSON.parse(out.slice(start));
}

/** The message and tag a deploy of `sha` is annotated with. */
export function annotation(sha, subject = "") {
  const message = `${MESSAGE_PREFIX} ${sha} ${subject}`.trim().slice(0, 100);
  return { message, tag: `g1t-${sha.slice(0, 12)}` };
}

/** The commit a version message names, or null. Dirty deploys name none. */
export function commitFrom(message) {
  const match = new RegExp(`^${MESSAGE_PREFIX} ([0-9a-f]{40})(?:\\s|$)`).exec(message ?? "");
  return match ? match[1] : null;
}

/**
 * Which commit a Worker's live version was deployed from, given Wrangler's
 * `deployments status --json` and `versions list --json`. A version made by
 * `wrangler secret put` keeps the code of the one before it, so those are
 * looked through. Anything else without our message (a deploy by hand, a
 * dashboard edit) leaves the commit unknown, and the unit is deployed again.
 */
export function liveCommit(status, versions) {
  const live = [...(status.versions ?? [])].sort((a, b) => b.percentage - a.percentage);
  if (!live.length) return { sha: null, why: "no live version" };
  const split = live.length > 1 && live[1].percentage > 0;
  const byNumber = [...versions].sort((a, b) => b.number - a.number);
  let index = byNumber.findIndex((v) => v.id === live[0].version_id);
  if (index < 0) return { sha: null, why: "its live version is not among the recent ones", version: live[0].version_id };
  const version = byNumber[index];
  while (index < byNumber.length) {
    const candidate = byNumber[index];
    const sha = commitFrom(candidate.annotations?.["workers/message"]);
    if (sha) {
      return {
        sha,
        version: version.id,
        at: candidate.metadata?.created_on ?? null,
        by: candidate.metadata?.author_email ?? null,
        split,
        why: split ? "a gradual deployment is in progress; its main version is used" : null,
      };
    }
    if (candidate.annotations?.["workers/triggered_by"] !== "secret") break;
    index++;
  }
  return { sha: null, version: version.id, why: "its live version was not deployed by scripts/deploy.mjs" };
}

/** Reads the commit a unit's Worker runs. Never throws. */
export async function readLive(unit) {
  const cwd = join(ROOT, unit.path);
  const [status, versions] = await Promise.all([
    wrangler(["deployments", "status", "--name", unit.worker, "--json"], { cwd }),
    wrangler(["versions", "list", "--name", unit.worker, "--json"], { cwd }),
  ]);
  if (status.code !== 0) {
    if (/not found|does not exist|10007/i.test(status.out)) return { sha: null, missing: true, why: "never deployed" };
    return { sha: null, error: lastLines(status.out) };
  }
  try {
    return liveCommit(jsonFrom(status.out), versions.code === 0 ? jsonFrom(versions.out) : []);
  } catch (error) {
    return { sha: null, error: String(error.message ?? error) };
  }
}

/** Migration files Wrangler lists as not yet applied. */
export function pendingFrom(out) {
  if (/No migrations to apply/i.test(out)) return [];
  const names = [...out.matchAll(/([\w.-]+\.sql)\b/g)].map((m) => m[1]);
  return [...new Set(names)];
}

/** Pending migrations of a unit's database: { pending } or { error }. */
export async function pendingMigrations(unit) {
  const found = await wrangler(["d1", "migrations", "list", unit.d1.database, "--remote"], { cwd: join(ROOT, unit.path) });
  if (found.code !== 0) return { error: lastLines(found.out) };
  return { pending: pendingFrom(found.out) };
}

export function applyMigrations(unit, onLine) {
  return wrangler(["d1", "migrations", "apply", unit.d1.database, "--remote"], { cwd: join(ROOT, unit.path), onLine });
}

/** The version a deploy made, from Wrangler's output. */
export function versionFrom(out) {
  return /Current Version ID:\s*([0-9a-f-]{36})/i.exec(out)?.[1] ?? null;
}

/** Whether Docker can build here (for a Containers image). */
export async function dockerAvailable() {
  const found = await exec("docker", ["info", "--format", "{{.ServerVersion}}"]);
  return found.code === 0;
}

export function lastLines(text, count = 12) {
  return text.trim().split(/\r?\n/).slice(-count).join("\n");
}
