// Cloudflare, as the deploy tool uses it: reading which commit each Worker
// runs and which D1 migrations are pending (Cloudflare's REST API when a
// token is set, Wrangler otherwise), applying migrations, and deploying.
// Every Wrangler call runs in the unit's own folder, so Wrangler reads that
// unit's config (and not a .env at the repository root, which may hold a
// token meant for something else).

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
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

// ── Reading production ───────────────────────────────────────────────────
//
// The plan reads Cloudflare's REST API directly when it has a token (always
// in CI): one request per question, all in parallel, where a Wrangler
// process would boot Node and check its login before each. Without one (a
// laptop's `wrangler login`) it asks Wrangler, as it always did. The
// requests are the ones Wrangler makes: `deployments status` prints the
// first of GET .../deployments, `versions list` the items of GET
// .../versions?deployable=true, and `d1 migrations list` compares the names
// in the database's d1_migrations table with the files in its migrations
// folder.

const API = "https://api.cloudflare.com/client/v4";
/** At most this many requests to Cloudflare at once. */
export const API_CONCURRENCY = 16;

/**
 * The token and account the plan reads Cloudflare's API with: the token
 * Wrangler would be given (see wranglerEnv), or null, and then Wrangler is
 * asked instead, with your `wrangler login`.
 */
export function apiAuth(base = process.env) {
  const env = wranglerEnv(base);
  if (!env.CLOUDFLARE_API_TOKEN) return null;
  return { token: env.CLOUDFLARE_API_TOKEN, account: env.CLOUDFLARE_ACCOUNT_ID };
}

let inFlight = 0;
const waiting = [];
async function limited(task) {
  while (inFlight >= API_CONCURRENCY) await new Promise((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await task();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

/** Cloudflare's errors in an answer, as one line. */
export function apiError(status, body) {
  const errors = (body?.errors ?? []).map((e) => (e.code ? `${e.message} (${e.code})` : e.message)).filter(Boolean);
  return `Cloudflare API ${status || "request"} failed${errors.length ? `: ${errors.join("; ")}` : ""}`;
}

/**
 * One request to Cloudflare's API. Resolves with { status, result } or
 * { status, error, codes }; never throws. Retried once after a refusal
 * that may pass (a 403 while a token propagates, 429, 5xx, the network).
 */
export async function cloudflareApi(auth, path, { method = "GET", body, fetchImpl = fetch, retries = 1, timeoutMs = 30_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let data = null;
    let error = null;
    try {
      const response = await limited(async () => {
        const res = await fetchImpl(`${API}${path}`, {
          method,
          headers: { authorization: `Bearer ${auth.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: res.status, text: await res.text() };
      });
      status = response.status;
      try {
        data = JSON.parse(response.text);
      } catch {
        error = `Cloudflare API ${status}: ${response.text.trim().slice(0, 300) || "an empty answer"}`;
      }
    } catch (failure) {
      error = `Cloudflare API request failed: ${failure?.message ?? failure}`;
    }
    if (!error && status < 400 && data?.success !== false) return { status, result: data?.result ?? null };
    error ??= apiError(status, data);
    const codes = (data?.errors ?? []).map((e) => e.code);
    const mayPass = status === 0 || status === 403 || status === 429 || status >= 500;
    if (attempt >= retries || !mayPass) return { status, error, codes };
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
}

/** Cloudflare's code for a Worker that does not exist. */
const SCRIPT_NOT_FOUND = 10007;

/**
 * The live commit from the API's answers: `deployments` is the result of
 * GET .../deployments ({ deployments: [newest first] }), `versions` that of
 * GET .../versions?deployable=true ({ items }), or null if it could not be
 * read. `wrangler deployments status --json` prints the first deployment,
 * and `versions list --json` those items.
 */
export function liveFromApi(worker, deployments, versions) {
  const latest = deployments?.deployments?.[0];
  if (!latest) return { sha: null, error: `The Worker ${worker} has no deployments.` };
  return liveCommit(latest, versions?.items ?? []);
}

/** Reads the commit a unit's Worker runs. Never throws. */
export async function readLive(unit, { auth = apiAuth(), fetchImpl = fetch } = {}) {
  if (!auth) return readLiveWithWrangler(unit);
  const script = `/accounts/${auth.account}/workers/scripts/${encodeURIComponent(unit.worker)}`;
  const [deployments, versions] = await Promise.all([
    cloudflareApi(auth, `${script}/deployments`, { fetchImpl }),
    cloudflareApi(auth, `${script}/versions?deployable=true`, { fetchImpl }),
  ]);
  if (deployments.error) {
    if (deployments.status === 404 || deployments.codes.includes(SCRIPT_NOT_FOUND)) return { sha: null, missing: true, why: "never deployed" };
    return { sha: null, error: deployments.error };
  }
  try {
    return liveFromApi(unit.worker, deployments.result, versions.error ? null : versions.result);
  } catch (error) {
    return { sha: null, error: String(error.message ?? error) };
  }
}

/** readLive through Wrangler: `deployments status` and `versions list`. */
async function readLiveWithWrangler(unit) {
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

/** Wrangler's default name for the table of applied migrations. */
export const MIGRATIONS_TABLE = "d1_migrations";

/**
 * A unit's database as its wrangler.jsonc names it: { id, table, dir }
 * (dir relative to the repository), or null.
 */
export function databaseOf(unit) {
  const db = (unit.config?.d1_databases ?? []).find((d) => d.database_name === unit.d1?.database);
  if (!db?.database_id) return null;
  return { id: db.database_id, table: db.migrations_table || MIGRATIONS_TABLE, dir: join(unit.path, unit.d1.migrations) };
}

/** The migration files in a folder, as Wrangler finds them: its *.sql files. */
export function migrationFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * The files not yet applied, in the files' order, given the D1 query API's
 * result for `SELECT name FROM d1_migrations` ([{ results: [{ name }] }]).
 */
export function pendingAgainst(files, result) {
  const applied = new Set((result?.[0]?.results ?? []).map((row) => row.name));
  return files.filter((file) => !applied.has(file));
}

const quoteIdentifier = (name) => `"${name.replaceAll('"', '""')}"`;

/** Pending migrations of a unit's database: { pending } or { error }. Never throws. */
export async function pendingMigrations(unit, { auth = apiAuth(), fetchImpl = fetch, root = ROOT } = {}) {
  const db = databaseOf(unit);
  if (!auth || !db) return pendingMigrationsWithWrangler(unit);
  let files;
  try {
    files = migrationFiles(join(root, db.dir));
  } catch (error) {
    return { error: `Could not read ${db.dir}: ${error.message ?? error}` };
  }
  const answer = await cloudflareApi(auth, `/accounts/${auth.account}/d1/database/${db.id}/query`, {
    method: "POST",
    body: { sql: `SELECT name FROM ${quoteIdentifier(db.table)} ORDER BY id` },
    fetchImpl,
  });
  if (answer.error) {
    // A database no migration was ever applied to has no table yet.
    if (/no such table/i.test(answer.error)) return { pending: files };
    return { error: answer.error };
  }
  return { pending: pendingAgainst(files, answer.result) };
}

/** pendingMigrations through Wrangler: `d1 migrations list --remote`. */
async function pendingMigrationsWithWrangler(unit) {
  const list = () => wrangler(["d1", "migrations", "list", unit.d1.database, "--remote"], { cwd: join(ROOT, unit.path) });
  // Once more after a failure: Cloudflare's API sometimes answers 403
  // while Wrangler's login refreshes (seen on 2026-10-06).
  let found = await list();
  if (found.code !== 0) found = await list();
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
