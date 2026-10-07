#!/usr/bin/env node
// The restore drill for nightly backups (docs/ARTIFACTS.md, R11;
// services/repos/src/backups.rs). Picks a repository, downloads its
// manifest and bundle chain from the g1t-backups bucket, rebuilds the
// repository from them in a temporary directory, and compares every ref
// with the live repository. Exits 1 on any difference, 2 when it could not
// run.
//
// Read-only: SELECTs against the g1t-repos database, reads of the bucket,
// and `git ls-remote` of the live repository. Nothing is written anywhere
// but the temporary directory, which is removed unless you pass --keep.
//
//   node scripts/ops/backup-restore-drill.mjs                 # a repository unchanged since its last backup
//   node scripts/ops/backup-restore-drill.mjs --repo acme/rocket
//   node scripts/ops/backup-restore-drill.mjs --repo-id repo_... --bundles ./copy --live /srv/git/acme--rocket.git
//
// Options:
//   --repo <workspace/name>  the repository; default: one picked at random
//                            among those whose refs have not moved since
//                            their last backup, so any difference is the
//                            backup's.
//   --repo-id <id>           the repository by id (no database needed with --bundles).
//   --bundles <dir>          read the bucket from a local copy (`backups/<id>/...`
//                            under it, as `mc mirror` or `rclone copy` leave it)
//                            instead of R2, e.g. a self-hosted MinIO's.
//   --live <url or path>     the live repository to compare with; default
//                            https://g1t.sh/<workspace>/<name>.git.
//   --keep                   keep the temporary directory, and say where it is.
//
// The live repository is read as G1T_USER with G1T_TOKEN (an access token
// with code:read) when they are set, which private repositories need. The
// database and the bucket are read through Wrangler, as you are logged in
// (`npx wrangler login`), or with CLOUDFLARE_DEPLOY_TOKEN when that is set.

import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exec, jsonFrom, wranglerEnv } from "../deploy/cloudflare.mjs";
import { ROOT } from "../deploy/stack.mjs";

const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const DATABASE = "g1t-repos";
const BUCKET = process.env.BACKUP_BUCKET || "g1t-backups";
const MANIFEST_VERSION = 1;
const STAGING = "refs/drill-staging";

/** Runs git; resolves with its output, or throws with what it said. */
async function git(args, { cwd, input } = {}) {
  const { code, out } = await exec("git", args, { cwd, input });
  if (code !== 0) throw new Error(`git ${args.find((arg) => !arg.startsWith("-")) ?? ""} failed: ${out.trim().slice(-600)}`);
  return out.trim();
}

/** A file's SHA-256, read as a stream: a bundle can be a gigabyte. */
async function sha256Of(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** `<hash> <name>` lines (for-each-ref) or `<hash>\t<name>` (ls-remote), as a map. Peeled tags are left out. */
export function parseRefs(listing) {
  const refs = {};
  for (const line of listing.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(line.trim());
    if (!match || match[2].endsWith("^{}")) continue;
    refs[match[2]] = match[1];
  }
  return refs;
}

/** Every ref of the repository in `dir`, and HEAD. */
async function refsOf(dir) {
  const refs = parseRefs(await git(["for-each-ref", "--format=%(objectname) %(refname)"], { cwd: dir }));
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: dir }).catch(() => "");
  if (head) refs.HEAD = head;
  return refs;
}

/** The refs that differ between `want` and `have`: [{ ref, want, have }], `null` for absent. */
export function compareRefs(want, have) {
  const names = [...new Set([...Object.keys(want), ...Object.keys(have)])].sort();
  return names
    .filter((ref) => want[ref] !== have[ref])
    .map((ref) => ({ ref, want: want[ref] ?? null, have: have[ref] ?? null }));
}

/** The branch HEAD should name: one at HEAD's commit, `main` or `master` first. */
export function headBranch(refs) {
  if (!refs.HEAD) return null;
  const branches = Object.keys(refs).filter((ref) => ref.startsWith("refs/heads/") && refs[ref] === refs.HEAD);
  return ["refs/heads/main", "refs/heads/master"].find((ref) => branches.includes(ref)) ?? branches.sort()[0] ?? null;
}

/** Whether a manifest can be read by this drill. */
export function readManifest(text) {
  const manifest = JSON.parse(text);
  if (manifest.version !== MANIFEST_VERSION) throw new Error(`manifest version ${manifest.version}; this drill reads ${MANIFEST_VERSION}`);
  if (!Array.isArray(manifest.chain) || manifest.chain.length === 0) throw new Error("the manifest lists no backups");
  if (manifest.chain[0].kind !== "full") throw new Error("the chain does not start with a full backup");
  return manifest;
}

/**
 * Rebuilds the repository the manifest's chain describes into `dir`, a
 * new bare repository: each bundle in order, checked against its size and
 * SHA-256 and verified by git, fetched without following tags; then every
 * ref set to what the last entry says, and nothing else kept. `fetchObject`
 * saves one object of the bucket to a file and resolves with its path.
 */
export async function restore(manifest, fetchObject, dir, work) {
  await git(["init", "--quiet", "--bare", dir]);
  for (const entry of manifest.chain) {
    if (!entry.key) continue;
    const file = await fetchObject(entry.key, join(work, `${entry.id}.bundle`));
    const size = statSync(file).size;
    if (size !== entry.size) throw new Error(`${entry.key}: ${size} bytes, the manifest says ${entry.size}`);
    if (entry.sha256) {
      const sha256 = await sha256Of(file);
      if (sha256 !== entry.sha256) throw new Error(`${entry.key}: SHA-256 ${sha256}, the manifest says ${entry.sha256}`);
    }
    await git(["bundle", "verify", "--quiet", file], { cwd: dir });
    await git(["fetch", "--quiet", "--no-tags", file, `+refs/*:${STAGING}/${entry.id}/*`], { cwd: dir });
  }
  const last = manifest.chain.at(-1).refs;
  const updates = Object.entries(last)
    .filter(([ref]) => ref !== "HEAD")
    .map(([ref, hash]) => `update ${ref} ${hash}\n`)
    .join("");
  const staged = await git(["for-each-ref", "--format=delete %(refname)", `${STAGING}/`], { cwd: dir });
  const commands = [updates.trimEnd(), staged].filter(Boolean).join("\n");
  if (commands) await git(["update-ref", "--stdin"], { cwd: dir, input: `${commands}\n` });
  const head = headBranch(last);
  if (head) await git(["symbolic-ref", "HEAD", head], { cwd: dir });
  // Every object every ref reaches is there.
  await git(["fsck", "--no-progress", "--connectivity-only"], { cwd: dir });
  return refsOf(dir);
}

// ---------------------------------------------------------------------

async function d1(sql) {
  const env = wranglerEnv();
  const { code, out } = await exec(process.execPath, [WRANGLER, "d1", "execute", DATABASE, "--remote", "--json", "--command", sql], {
    cwd: join(ROOT, "services/repos"),
    env,
  });
  if (code !== 0) throw new Error(out.slice(-600));
  return jsonFrom(out)[0]?.results ?? [];
}

const quoted = (text) => `'${String(text).replaceAll("'", "''")}'`;

/** The repository to drill, and whether its refs moved since its last backup. */
async function pick({ repo, repoId }) {
  const select = `SELECT r.id, r.namespace, r.name, r.refs_version, b.refs_version AS backed_version,
      coalesce(r.refs_open_until, 0) > coalesce(b.backed_up_ms, 0) AS opened
    FROM repo_backups b JOIN repos r ON r.id = b.repo_id
    WHERE b.last_entry IS NOT NULL AND r.deleted_at IS NULL`;
  let rows;
  if (repoId) rows = await d1(`${select} AND r.id = ${quoted(repoId)}`);
  else if (repo) {
    const [namespace, name] = repo.toLowerCase().split("/");
    rows = await d1(`${select} AND r.namespace = ${quoted(namespace)} AND r.name = ${quoted(name)}`);
  } else {
    rows = await d1(`${select} AND b.refs_version = r.refs_version AND coalesce(r.refs_open_until, 0) <= coalesce(b.backed_up_ms, 0)
      ORDER BY random() LIMIT 1`);
  }
  const row = rows[0];
  if (!row) throw new Error(repo || repoId ? `no backup of ${repo ?? repoId}` : "no repository has a backup yet");
  return {
    id: row.id,
    path: `${row.namespace}/${row.name}`,
    moved: row.refs_version !== row.backed_version || Boolean(row.opened),
  };
}

/** Saves one object of the bucket to `file`. */
function bucketReader(localCopy) {
  if (localCopy) return async (key) => join(localCopy, key);
  return async (key, file) => {
    const env = wranglerEnv();
    const { code, out } = await exec(process.execPath, [WRANGLER, "r2", "object", "get", `${BUCKET}/${key}`, "--remote", "--file", file], { env });
    if (code !== 0) throw new Error(`${key} could not be read: ${out.slice(-400)}`);
    return file;
  };
}

/** The live repository's refs, as a clone would see them. */
async function liveRefs(live) {
  const args = [];
  if (process.env.G1T_TOKEN && /^https?:/.test(live)) {
    const user = process.env.G1T_USER || "g1t";
    const basic = Buffer.from(`${user}:${process.env.G1T_TOKEN}`).toString("base64");
    args.push("-c", `http.extraHeader=Authorization: Basic ${basic}`);
  }
  return parseRefs(await git([...args, "ls-remote", live]));
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const keep = args.includes("--keep");
  const localCopy = option("--bundles");
  const target =
    localCopy && option("--repo-id")
      ? { id: option("--repo-id"), path: option("--repo") ?? null, moved: false }
      : await pick({ repo: option("--repo"), repoId: option("--repo-id") });
  const live = option("--live") ?? (target.path ? `https://g1t.sh/${target.path}.git` : null);
  if (!live) throw new Error("say which live repository to compare with: --live, or --repo");

  const work = mkdtempSync(join(tmpdir(), "g1t-drill-"));
  try {
    const read = bucketReader(localCopy);
    const manifest = readManifest(readFileSync(await read(`backups/${target.id}/manifest.json`, join(work, "manifest.json")), "utf8"));
    const started = Date.now();
    const restored = await restore(manifest, read, join(work, "restored.git"), work);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const last = manifest.chain.at(-1);
    const bytes = manifest.chain.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    console.log(`${target.path ?? target.id}: ${manifest.chain.length} backups (${bytes} bytes), the last ${last.created_at}, restored in ${seconds}s`);

    const fromChain = compareRefs(last.refs, restored);
    const fromLive = compareRefs(await liveRefs(live), restored);
    for (const [what, differences] of [
      ["the manifest", fromChain],
      ["the live repository", fromLive],
    ]) {
      if (differences.length === 0) {
        console.log(`  every ref matches ${what} (${Object.keys(restored).length} refs)`);
        continue;
      }
      console.log(`  ${differences.length} refs differ from ${what}:`);
      for (const { ref, want, have } of differences) console.log(`    ${ref}: ${what} ${want ?? "(none)"}, restored ${have ?? "(none)"}`);
    }
    if (target.moved && fromLive.length > 0) {
      console.log("  The repository's refs moved since its last backup, so differences from it may be new work, not a fault.");
    }
    if (keep) console.log(`  kept: ${work}`);
    return fromChain.length === 0 && fromLive.length === 0 ? 0 : 1;
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/ops/backup-restore-drill.mjs")) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`drill: ${error.message}`);
      process.exit(2);
    },
  );
}
