#!/usr/bin/env node
// Rebuilds repositories from the nightly backups into a git store, the cold
// fallback for an Artifacts outage (docs/ARTIFACTS.md, R12), and afterwards
// sends back what was pushed to it while it served.
//
// The store is deploy/self-host/gitstore: bare repositories under a root,
// one directory per Artifacts namespace, `<root>/<namespace>/<name>.git`.
// The repos service reads them through GIT_FALLBACK_URL once a namespace
// is switched to it (services/repos/src/fallback.rs).
//
//   node scripts/ops/restore-to-gitstore.mjs index > index.json
//   node scripts/ops/restore-to-gitstore.mjs restore --into /srv/gitstore --bundles /srv/backups
//   node scripts/ops/restore-to-gitstore.mjs restore --gitstore https://gitstore.example   # GITSTORE_SECRET
//   node scripts/ops/restore-to-gitstore.mjs changed --into /srv/gitstore
//   node scripts/ops/restore-to-gitstore.mjs reconcile --into /srv/gitstore
//
// Commands:
//   index      Every repository with a backup, its id and store key, from
//              the g1t-repos database (read-only), as JSON. Keep a recent
//              one on the fallback host: `restore --index` needs no database.
//   restore    Each repository's chain, verified as the restore drill
//              verifies it (scripts/ops/backup-restore-drill.mjs), into the
//              store. One already restored from the same last backup is
//              left alone, so a second run only does what changed.
//   changed    The restored repositories whose refs moved since they were
//              restored: pushes the fallback took (GIT_FALLBACK_WRITES=allow).
//   reconcile  Sends those back to Artifacts. A ref that Artifacts still has
//              as it was backed up is moved to what the fallback has; one
//              that moved on both sides is kept beside it, as
//              refs/fallback/<the rest of its name>, for its owners to merge.
//              Then each one's refs_version is moved in the database, so
//              nothing kept from before is served.
//
// Options:
//   --into <root>        the git store's root on this machine (GITSTORE_ROOT).
//   --gitstore <url>     a git store reached over HTTP instead, with
//                        GITSTORE_SECRET; it must not be read-only while
//                        restoring. `changed` and `reconcile` need --into.
//   --bundles <dir>      read the bucket from a local copy (`backups/<id>/...`,
//                        as `rclone copy r2:g1t-backups <dir>` leaves it);
//                        without it each object is read through Wrangler.
//   --index <file>       the repositories from `index`'s output, not the database.
//   --namespace <name>   only repositories in this Artifacts namespace.
//   --repo <id>          only this repository (repeatable).
//   --default-namespace  the namespace keys without one are in (default g1t).
//   --jobs <n>           repositories at once (default 4).
//   --live-root <dir>    reconcile into bare repositories here
//                        (`<dir>/<namespace>/<name>.git`), for drills and tests,
//                        instead of Artifacts.
//   --no-bump            reconcile without moving refs_version.
//
// Artifacts is reached for `reconcile` with CLOUDFLARE_API_TOKEN (Artifacts
// edit), or CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL; the database and the
// bucket through Wrangler, as the restore drill does.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cloudflareAuth, exec, jsonFrom, wranglerEnv } from "../deploy/cloudflare.mjs";
import { ROOT } from "../deploy/stack.mjs";
import { compareRefs, parseRefs, readManifest, restore } from "./backup-restore-drill.mjs";

const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const DATABASE = "g1t-repos";
const BUCKET = process.env.BACKUP_BUCKET || "g1t-backups";
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "1e6f2cffa3f445920836e8ebe446bb58";
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/;
/** Where refs that moved on both sides are kept. */
export const CONFLICT_PREFIX = "refs/fallback/";

async function git(args, { cwd, input } = {}) {
  const { code, out } = await exec("git", args, { cwd, input });
  if (code !== 0) throw new Error(`git ${args.find((arg) => !arg.startsWith("-")) ?? ""} failed: ${out.trim().slice(-600)}`);
  return out.trim();
}

/** A store key's Artifacts namespace and name: `g1t-us-1/acme--rocket`, or the default's. */
export function locate(store, defaultNamespace = "g1t") {
  const at = store.indexOf("/");
  const [namespace, name] = at >= 0 ? [store.slice(0, at), store.slice(at + 1)] : [defaultNamespace, store];
  if (!NAME.test(namespace) || !NAME.test(name)) throw new Error(`not a store key: ${store}`);
  return { namespace, name };
}

/** Where a repository lives under the git store's root. */
export function repoDir(root, namespace, name) {
  return join(root, namespace, `${name}.git`);
}

/** What the git store keeps beside a repository (gitstore/server.mjs `g1t.json`), with what it was restored from. */
export function metaFor(target, manifest, now = new Date().toISOString(), existing = {}) {
  const last = manifest.chain.at(-1);
  return {
    id: existing.id ?? randomUUID(),
    description: existing.description ?? null,
    createdAt: existing.createdAt ?? now,
    readOnly: false,
    source: null,
    restored: {
      repo_id: target.id,
      entry: last.id,
      backed_up_at: last.created_at,
      restored_at: now,
      refs: Object.fromEntries(Object.entries(last.refs).filter(([ref]) => ref !== "HEAD")),
    },
  };
}

function readMeta(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "g1t.json"), "utf8"));
  } catch {
    return {};
  }
}

/** As the git store configures a repository it makes. */
async function configure(dir) {
  await git(["config", "http.receivepack", "true"], { cwd: dir });
  await git(["config", "receive.denyNonFastForwards", "false"], { cwd: dir });
  await git(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: dir });
}

/** Every ref of a bare repository but HEAD. */
async function refsIn(dir) {
  return parseRefs(await git(["for-each-ref", "--format=%(objectname) %(refname)"], { cwd: dir }));
}

/**
 * What changed in a restored repository since it was restored: the refs
 * pushed to or deleted from it, each with the restored value (`base`) and
 * what it has now (`now`), `null` for absent.
 */
export function changedSince(restoredRefs, current) {
  return compareRefs(restoredRefs, current).map(({ ref, want, have }) => ({ ref, base: want, now: have }));
}

/**
 * How each changed ref goes back to the live repository, which has `live`
 * now: `move` (the live ref is still what was backed up, so it takes the
 * fallback's value, or is deleted), `same` (it has it already), or
 * `conflict` (it moved too: the fallback's value goes beside it, under
 * CONFLICT_PREFIX).
 */
export function reconcilePlan(changes, live) {
  return changes.map(({ ref, base, now }) => {
    const current = live[ref] ?? null;
    if (current === now) return { ref, action: "same", from: current, to: now };
    if (current === base) return { ref, action: "move", from: current, to: now };
    return { ref, action: "conflict", from: current, to: now, kept: now ? CONFLICT_PREFIX + ref.replace(/^refs\//, "") : null };
  });
}

// ---------------------------------------------------------------------

async function d1(sql) {
  const { code, out } = await exec(process.execPath, [WRANGLER, "d1", "execute", DATABASE, "--remote", "--json", "--command", sql], {
    cwd: join(ROOT, "services/repos"),
    env: wranglerEnv(),
  });
  if (code !== 0) throw new Error(out.slice(-600));
  return jsonFrom(out)[0]?.results ?? [];
}

const quoted = (text) => `'${String(text).replaceAll("'", "''")}'`;

/** Every live repository with a backup: id, store key, path. */
async function indexFromDatabase() {
  const rows = await d1(`SELECT r.id, coalesce(r.store, r.namespace || '--' || r.name) AS store, r.namespace AS workspace, r.name,
      r.default_branch, b.last_entry
    FROM repos r JOIN repo_backups b ON b.repo_id = r.id
    WHERE r.deleted_at IS NULL AND r.fork_of IS NULL AND b.last_entry IS NOT NULL
    ORDER BY r.id`);
  return rows.map((row) => ({ id: row.id, store: row.store, path: `${row.workspace}/${row.name}`, default_branch: row.default_branch }));
}

/** Without a database: what each manifest in a local copy of the bucket says. */
function indexFromBundles(bundles) {
  const base = join(bundles, "backups");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((id) => existsSync(join(base, id, "manifest.json")))
    .map((id) => {
      const manifest = JSON.parse(readFileSync(join(base, id, "manifest.json"), "utf8"));
      const path = manifest.path ? `${manifest.path.namespace}/${manifest.path.name}` : null;
      return { id, store: manifest.store_key, path };
    });
}

function bucketReader(localCopy) {
  if (localCopy) return async (key) => join(localCopy, key);
  return async (key, file) => {
    const { code, out } = await exec(process.execPath, [WRANGLER, "r2", "object", "get", `${BUCKET}/${key}`, "--remote", "--file", file], {
      env: wranglerEnv(),
    });
    if (code !== 0) throw new Error(`${key} could not be read: ${out.slice(-400)}`);
    return file;
  };
}

/** Runs `work` over `items`, `jobs` at a time. */
async function pool(items, jobs, work) {
  const results = [];
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await work(items[at]);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** The git store's API, over HTTP. */
function gitstoreApi(url, secret) {
  const base = url.replace(/\/$/, "");
  return async (method, path, body) => {
    const response = await fetch(`${base}/api/repos${path}`, {
      method,
      headers: { "x-gitstore-secret": secret, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  };
}

/**
 * Restores one repository. Returns what happened: `restored`, `current`
 * (already restored from the same last backup), or `missing` (no backup).
 */
export async function restoreOne(target, { read, into, gitstore, defaultNamespace = "g1t", work }) {
  const { namespace, name } = locate(target.store, defaultNamespace);
  const scratch = await mkdtemp(join(work ?? tmpdir(), "g1t-restore-"));
  try {
    let manifestFile;
    try {
      manifestFile = await read(`backups/${target.id}/manifest.json`, join(scratch, "manifest.json"));
    } catch {
      return { id: target.id, namespace, name, result: "missing" };
    }
    if (!existsSync(manifestFile)) return { id: target.id, namespace, name, result: "missing" };
    const manifest = readManifest(readFileSync(manifestFile, "utf8"));
    const last = manifest.chain.at(-1);
    if (into) {
      const dir = repoDir(into, namespace, name);
      const existing = readMeta(dir);
      if (existing.restored?.entry === last.id && existing.restored?.repo_id === target.id) {
        return { id: target.id, namespace, name, result: "current" };
      }
      // Built beside it, then put in place, so a reader never sees half.
      const building = `${dir}.restoring-${process.pid}`;
      rmSync(building, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      const refs = await restore(manifest, read, building, scratch);
      await configure(building);
      writeFileSync(join(building, "g1t.json"), JSON.stringify(metaFor(target, manifest, undefined, existing), null, 2));
      rmSync(dir, { recursive: true, force: true });
      renameSync(building, dir);
      return { id: target.id, namespace, name, result: "restored", refs: Object.keys(refs).length };
    }
    // Over HTTP: rebuilt here, then pushed as a mirror.
    const local = join(scratch, "restored.git");
    const refs = await restore(manifest, read, local, scratch);
    const key = `${namespace}/${name}`;
    const made = await gitstore.api("POST", "", { name: key, defaultBranch: target.default_branch ?? "main" });
    if (made.status !== 200 && made.json.code !== "ALREADY_EXISTS") throw new Error(`${key}: ${made.json.message ?? made.status}`);
    const token = await gitstore.api("POST", `/${encodeURIComponent(key)}/tokens`, { scope: "write", ttl: 3600 });
    if (token.status !== 200) throw new Error(`${key}: ${token.json.message ?? token.status}`);
    const remote = `${gitstore.url.replace(/\/$/, "")}/git/${key}.git`;
    await git(["-c", `http.extraHeader=Authorization: Bearer ${token.json.plaintext}`, "push", "--quiet", "--mirror", remote], { cwd: local });
    return { id: target.id, namespace, name, result: "restored", refs: Object.keys(refs).length };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The restored repositories under `root`, with what each was restored from. */
function restoredUnder(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const namespace of readdirSync(root)) {
    const dir = join(root, namespace);
    if (!NAME.test(namespace) || !existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".git")) continue;
      const meta = readMeta(join(dir, entry));
      if (meta.restored) out.push({ namespace, name: entry.slice(0, -4), dir: join(dir, entry), restored: meta.restored });
    }
  }
  return out;
}

/** Repositories that took pushes since they were restored. */
export async function changedRepos(root) {
  const out = [];
  for (const repo of restoredUnder(root)) {
    const changes = changedSince(repo.restored.refs, await refsIn(repo.dir));
    if (changes.length) out.push({ ...repo, changes });
  }
  return out;
}

/** Where to push a repository back to: Artifacts, or a bare repository under `--live-root`. */
function liveRemote(liveRoot) {
  if (liveRoot) return async (namespace, name) => ({ url: repoDir(liveRoot, namespace, name), args: [] });
  const auth = cloudflareAuth();
  if (!auth) throw new Error("set CLOUDFLARE_API_TOKEN (Artifacts edit), or CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL, or --live-root");
  const api = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/artifacts/namespaces`;
  return async (namespace, name) => {
    const at = `${api}/${namespace}/repos/${encodeURIComponent(name)}`;
    const info = await (await fetch(at, { headers: auth })).json().catch(() => ({}));
    const minted = await (
      await fetch(`${at}/tokens`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ scope: "write", ttl: 3600 }) })
    )
      .json()
      .catch(() => ({}));
    const token = minted.result?.plaintext ?? minted.result?.token;
    if (!token) throw new Error(`${namespace}/${name}: Artifacts gave no write token (${JSON.stringify(minted.errors ?? minted).slice(0, 300)})`);
    const url = info.result?.remote ?? `https://${ACCOUNT_ID}.artifacts.cloudflare.net/git/${namespace}/${name}.git`;
    // The token as Artifacts gives it, `?expires=` and all, as g1t sends it.
    return { url, args: ["-c", `http.extraHeader=Authorization: Bearer ${token}`] };
  };
}

/** Sends one repository's changes back; what was done with each ref. */
export async function reconcileOne(repo, remoteFor) {
  const { url, args } = await remoteFor(repo.namespace, repo.name);
  const live = parseRefs(await git([...args, "ls-remote", url], { cwd: repo.dir }));
  const plan = reconcilePlan(repo.changes, live);
  const specs = [];
  for (const step of plan) {
    if (step.action === "move") {
      const lease = `--force-with-lease=${step.ref}:${step.from ?? ""}`;
      specs.push({ lease, spec: step.to ? `+${step.to}:${step.ref}` : `:${step.ref}` });
    } else if (step.action === "conflict" && step.kept) {
      specs.push({ lease: null, spec: `+${step.to}:${step.kept}` });
    }
  }
  if (specs.length) {
    // Not --atomic: whether Artifacts takes it is not documented (docs/ARTIFACTS.md, Q6).
    // Each move is leased on the value read above, so one that moved since is refused, not overwritten.
    const leases = specs.map((one) => one.lease).filter(Boolean);
    await git([...args, "push", "--quiet", ...leases, url, ...specs.map((one) => one.spec)], { cwd: repo.dir });
  }
  return plan;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const option = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const many = (name) => argv.flatMap((arg, at) => (arg === name && argv[at + 1] ? [argv[at + 1]] : []));
  const defaultNamespace = option("--default-namespace") ?? "g1t";
  const into = option("--into");

  if (command === "index") {
    console.log(JSON.stringify(await indexFromDatabase(), null, 2));
    return 0;
  }

  if (command === "restore") {
    const url = option("--gitstore");
    if (!into && !url) throw new Error("say where to restore to: --into <root> or --gitstore <url>");
    const gitstore = url ? { url, api: gitstoreApi(url, process.env.GITSTORE_SECRET ?? "") } : null;
    const bundles = option("--bundles");
    let targets = option("--index")
      ? JSON.parse(readFileSync(option("--index"), "utf8"))
      : bundles && argv.includes("--offline")
        ? indexFromBundles(bundles)
        : await indexFromDatabase();
    const only = many("--repo");
    if (only.length) targets = targets.filter((target) => only.includes(target.id));
    const namespace = option("--namespace");
    if (namespace) targets = targets.filter((target) => locate(target.store, defaultNamespace).namespace === namespace);
    const read = bucketReader(bundles);
    const started = Date.now();
    const counts = { restored: 0, current: 0, missing: 0, failed: 0 };
    await pool(targets, Number(option("--jobs") ?? 4), async (target) => {
      try {
        const done = await restoreOne(target, { read, into, gitstore, defaultNamespace });
        counts[done.result] += 1;
        if (done.result !== "current") console.log(`${done.result.padEnd(8)} ${done.namespace}/${done.name} (${target.path ?? target.id})`);
      } catch (error) {
        counts.failed += 1;
        console.error(`failed   ${target.store} (${target.id}): ${error.message}`);
      }
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `${targets.length} repositories in ${seconds}s: ${counts.restored} restored, ${counts.current} already current, ${counts.missing} without a backup, ${counts.failed} failed`,
    );
    return counts.failed ? 1 : 0;
  }

  if (command === "changed" || command === "reconcile") {
    if (!into) throw new Error(`${command} reads the git store's root: --into <root>`);
    const changed = await changedRepos(into);
    if (command === "changed") {
      for (const repo of changed) {
        console.log(`${repo.namespace}/${repo.name} (${repo.restored.repo_id})`);
        for (const { ref, base, now } of repo.changes) console.log(`  ${ref}: ${base ?? "(none)"} -> ${now ?? "(deleted)"}`);
      }
      console.log(`${changed.length} repositories took pushes since they were restored`);
      return 0;
    }
    const remoteFor = liveRemote(option("--live-root"));
    const bumped = [];
    let conflicts = 0;
    let failed = 0;
    for (const repo of changed) {
      try {
        const plan = await reconcileOne(repo, remoteFor);
        bumped.push(repo.restored.repo_id);
        for (const step of plan) {
          if (step.action === "conflict") conflicts += 1;
          const what = step.action === "conflict" ? `moved on both sides; the fallback's kept as ${step.kept ?? "(it deleted it)"}` : step.action;
          console.log(`${repo.namespace}/${repo.name} ${step.ref}: ${what}`);
        }
      } catch (error) {
        failed += 1;
        console.error(`${repo.namespace}/${repo.name}: ${error.message}`);
      }
    }
    if (bumped.length && !argv.includes("--no-bump")) {
      await d1(`UPDATE repos SET refs_version = coalesce(refs_version, 0) + 1 WHERE id IN (${bumped.map(quoted).join(", ")})`);
    }
    console.log(`${changed.length} repositories reconciled: ${conflicts} refs kept beside a newer one, ${failed} failed`);
    return failed ? 1 : conflicts ? 3 : 0;
  }

  console.error("usage: restore-to-gitstore.mjs index | restore | changed | reconcile (see the top of the file)");
  return 2;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/ops/restore-to-gitstore.mjs")) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`restore: ${error.message}`);
      process.exit(2);
    },
  );
}
