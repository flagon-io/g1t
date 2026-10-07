// g1t's git store for self-hosting: plain bare repositories on disk.
//
// Hosted g1t keeps repositories in Cloudflare Artifacts. This server does
// the same job with nothing but git: one bare repository per store key
// under GITSTORE_ROOT, git's own smart HTTP (git http-backend) for clones,
// fetches and pushes, and a small JSON API for the reads the repos service
// makes (commits, trees, blobs, files) and for creating and forking.
//
// It is reached only by the Artifacts-compatible shim (workers/artifacts),
// which the repos service is bound to in place of the Artifacts binding, and
// by the repos service itself for git's smart HTTP. Nothing else should be
// able to reach it: the API takes a shared secret, and git requests a
// short-lived token the shim minted with the same secret.
//
// A key is a repository's name (`acme--rocket`), or a namespace and a name
// (`g1t/acme--rocket`): hosted g1t's fallback store (docs/ARTIFACTS.md, R12)
// keeps each Artifacts namespace's repositories in a directory of their
// own, so a remote reads `<GITSTORE_URL>/git/<namespace>/<name>.git`, the
// shape Artifacts gives remotes.
//
// GITSTORE_READ_ONLY=1 refuses everything that writes: pushes, creating,
// forking, deleting, and minting write tokens. As a fallback the store
// serves reads until told otherwise; the repos service refuses writes too.
//
// No dependencies beyond Node and git.

import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = process.env.GITSTORE_ROOT ?? "/data/git";
const PORT = Number(process.env.GITSTORE_PORT ?? 8080);
const SECRET = loadSecret();
// How the repos service reaches this server; it becomes each repository's
// `remote`, exactly as Artifacts hands one out.
const PUBLIC_URL = (process.env.GITSTORE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const READ_ONLY = ["1", "true", "yes"].includes(String(process.env.GITSTORE_READ_ONLY ?? "").toLowerCase());

/**
 * The secret shared with the Artifacts shim: GITSTORE_SECRET, or else the
 * one in GITSTORE_SECRET_FILE, made on first start. The compose file shares
 * that file with the g1t container, so nobody has to choose one.
 */
function loadSecret() {
  if (process.env.GITSTORE_SECRET) return process.env.GITSTORE_SECRET;
  const file = process.env.GITSTORE_SECRET_FILE;
  if (!file) return "";
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(file, "utf8").trim();
}

if (SECRET.length < 16) {
  console.error("Set GITSTORE_SECRET (16 characters or more) or GITSTORE_SECRET_FILE.");
  process.exit(1);
}
mkdirSync(ROOT, { recursive: true });

const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/;
const HASH = /^[0-9a-f]{40}$/;

class StoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Whether `key` is a name, or a namespace and a name. */
function validKey(key) {
  if (typeof key !== "string" || key.includes("..")) return false;
  const parts = key.split("/");
  return parts.length <= 2 && parts.every((part) => NAME.test(part));
}

function repoDir(key) {
  if (!validKey(key)) {
    throw new StoreError("INVALID_REPO_NAME", `invalid repository name: ${key}`);
  }
  return join(ROOT, `${key}.git`);
}

function refuseWrites(what) {
  if (READ_ONLY) throw new StoreError("READ_ONLY", `the git store is read-only: ${what} is refused`, 403);
}

function exists(key) {
  return existsSync(join(repoDir(key), "HEAD"));
}

function requireRepo(key) {
  if (!exists(key)) throw new StoreError("NOT_FOUND", `no repository ${key}`, 404);
  return repoDir(key);
}

/** Runs git and resolves with its stdout as a Buffer. */
function git(args, { cwd, input, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !allowFail) {
        reject(new StoreError("INTERNAL_ERROR", `git ${args[0]} failed: ${Buffer.concat(err)}`, 500));
      } else {
        resolve({ code, stdout: Buffer.concat(out) });
      }
    });
    child.stdin.end(input ?? undefined);
  });
}

// ── Metadata kept beside each repository ────────────────────────────────

function metaPath(key) {
  return join(repoDir(key), "g1t.json");
}

function readMeta(key) {
  try {
    return JSON.parse(readFileSync(metaPath(key), "utf8"));
  } catch {
    return {};
  }
}

function writeMeta(key, meta) {
  writeFileSync(metaPath(key), JSON.stringify(meta, null, 2));
}

async function info(key) {
  const dir = requireRepo(key);
  const meta = readMeta(key);
  const head = (await git(["symbolic-ref", "--short", "HEAD"], { cwd: dir, allowFail: true })).stdout
    .toString()
    .trim();
  let lastPushAt = null;
  try {
    lastPushAt = statSync(join(dir, "g1t-pushed")).mtime.toISOString();
  } catch {}
  return {
    id: meta.id ?? key,
    name: key,
    description: meta.description ?? null,
    defaultBranch: head || "main",
    createdAt: meta.createdAt ?? new Date(0).toISOString(),
    updatedAt: lastPushAt ?? meta.createdAt ?? new Date(0).toISOString(),
    lastPushAt,
    source: meta.source ?? null,
    readOnly: Boolean(meta.readOnly),
    remote: `${PUBLIC_URL}/git/${key}.git`,
  };
}

async function create(key, { description, defaultBranch, readOnly, source } = {}) {
  refuseWrites("creating a repository");
  const dir = repoDir(key);
  if (exists(key)) throw new StoreError("ALREADY_EXISTS", `${key} already exists`, 409);
  mkdirSync(dir, { recursive: true });
  await git(["init", "--bare", "--quiet", `--initial-branch=${defaultBranch || "main"}`, dir]);
  await configure(dir);
  writeMeta(key, {
    id: randomUUID(),
    description: description ?? null,
    createdAt: new Date().toISOString(),
    readOnly: Boolean(readOnly),
    source: source ?? null,
  });
  return info(key);
}

async function configure(dir) {
  // Pushes arrive through git http-backend; the token has already been
  // checked, so receive-pack is allowed for every write-scoped request.
  await git(["config", "http.receivepack", "true"], { cwd: dir });
  await git(["config", "receive.denyNonFastForwards", "false"], { cwd: dir });
  await git(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: dir });
}

async function fork(key, target, { description, readOnly, defaultBranchOnly = true } = {}) {
  refuseWrites("forking");
  const source = requireRepo(key);
  const dir = repoDir(target);
  if (exists(target)) throw new StoreError("ALREADY_EXISTS", `${target} already exists`, 409);
  const args = ["clone", "--bare", "--quiet", "--no-tags"];
  if (defaultBranchOnly) args.push("--single-branch");
  // A local clone hard-links the objects: cheap, and independent of the
  // source from then on.
  args.push(source, dir);
  await git(args);
  await git(["remote", "remove", "origin"], { cwd: dir, allowFail: true });
  await configure(dir);
  writeMeta(target, {
    id: randomUUID(),
    description: description ?? readMeta(key).description ?? null,
    createdAt: new Date().toISOString(),
    readOnly: Boolean(readOnly),
    source: `artifacts:${key}`,
  });
  return info(target);
}

// ── Reading objects ─────────────────────────────────────────────────────

async function objectType(dir, spec) {
  const { code, stdout } = await git(["cat-file", "-t", "--", spec], { cwd: dir, allowFail: true });
  return code === 0 ? stdout.toString().trim() : null;
}

function person(line) {
  // `Name <email> 1700000000 +0000`
  const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  return match ? { name: match[1], email: match[2], at: Number(match[3]) } : { name: line, email: "", at: 0 };
}

function parseCommit(hash, raw) {
  const text = raw.toString("utf8");
  const split = text.indexOf("\n\n");
  const headers = (split === -1 ? text : text.slice(0, split)).split("\n");
  let message = split === -1 ? "" : text.slice(split + 2);
  if (message.endsWith("\n")) message = message.slice(0, -1);
  const commit = { hash, treeHash: "", message, parents: [], author: null, committer: null };
  for (const header of headers) {
    const space = header.indexOf(" ");
    const name = header.slice(0, space);
    const value = header.slice(space + 1);
    if (name === "tree") commit.treeHash = value;
    else if (name === "parent") commit.parents.push(value);
    else if (name === "author") commit.author = person(value);
    else if (name === "committer") commit.committer = person(value);
  }
  const author = commit.author ?? { name: "", email: "", at: 0 };
  const committer = commit.committer ?? author;
  return {
    hash,
    treeHash: commit.treeHash,
    message: commit.message,
    author: { name: author.name, email: author.email },
    committer: { name: committer.name, email: committer.email },
    parents: commit.parents,
    authoredAt: author.at,
    committedAt: committer.at,
  };
}

async function readCommit(key, hash) {
  const dir = requireRepo(key);
  if (!HASH.test(hash)) return null;
  if ((await objectType(dir, hash)) !== "commit") return null;
  return parseCommit(hash, (await git(["cat-file", "commit", hash], { cwd: dir })).stdout);
}

async function log(key, { ref = "HEAD", limit = 50, offset = 0 } = {}) {
  const dir = requireRepo(key);
  if (typeof ref !== "string" || ref.startsWith("-")) return [];
  const count = Math.max(1, Math.min(Number(limit) || 50, 1000));
  const skip = Math.max(0, Number(offset) || 0);
  const listed = await git(
    ["rev-list", "--first-parent", `--max-count=${count}`, `--skip=${skip}`, ref, "--"],
    { cwd: dir, allowFail: true },
  );
  if (listed.code !== 0) return [];
  const hashes = listed.stdout.toString().split("\n").filter(Boolean);
  const commits = [];
  for (const hash of hashes) {
    commits.push(parseCommit(hash, (await git(["cat-file", "commit", hash], { cwd: dir })).stdout));
  }
  return commits;
}

const TYPES = { "040000": "tree", "100644": "blob", "100755": "exec", "120000": "symlink", "160000": "gitlink" };

async function readTree(key, hash) {
  const dir = requireRepo(key);
  if (!HASH.test(hash)) return null;
  if ((await objectType(dir, hash)) !== "tree") return null;
  const { stdout } = await git(["ls-tree", "-z", hash], { cwd: dir });
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, , object] = line.slice(0, tab).split(" ");
      return {
        name: line.slice(tab + 1),
        mode: mode === "040000" ? "40000" : mode,
        hash: object,
        type: TYPES[mode] ?? "blob",
      };
    });
}

async function readBlob(key, hash) {
  const dir = requireRepo(key);
  if (!HASH.test(hash)) return null;
  if ((await objectType(dir, hash)) !== "blob") return null;
  return (await git(["cat-file", "blob", hash], { cwd: dir })).stdout;
}

async function readFile(key, ref, path) {
  const dir = requireRepo(key);
  if (!ref || !path || ref.startsWith("-") || ref.includes(":")) return null;
  const spec = `${ref}:${path.replace(/^\/+/, "")}`;
  if ((await objectType(dir, spec)) !== "blob") return null;
  return (await git(["cat-file", "blob", spec], { cwd: dir })).stdout;
}

// ── Tokens for git's smart HTTP ─────────────────────────────────────────

function sign(payload) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function mintToken(key, scope = "write", ttl = 86400) {
  if (scope === "write") refuseWrites("a write token");
  const seconds = Math.max(60, Math.min(Number(ttl) || 86400, 31536000));
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const id = randomUUID();
  const payload = Buffer.from(JSON.stringify({ k: key, s: scope, e: expires, i: id })).toString("base64url");
  return {
    id,
    plaintext: `${payload}.${sign(payload)}`,
    scope,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

function checkToken(token, key) {
  const [payload, signature] = String(token ?? "").split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (claims.k !== key || claims.e < Date.now() / 1000) return null;
  return claims;
}

function bearer(request) {
  const header = request.headers.authorization ?? "";
  if (/^bearer /i.test(header)) return header.slice(7).trim();
  if (/^basic /i.test(header)) {
    // A git client given the token as a password: `x:<token>`.
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString();
    return decoded.slice(decoded.indexOf(":") + 1);
  }
  return null;
}

// ── Smart HTTP through git http-backend ─────────────────────────────────

function smartHttp(request, response, key, rest, query) {
  if (!exists(key)) return send(response, 404, "not found");
  const claims = checkToken(bearer(request), key);
  if (!claims) {
    response.writeHead(401, { "www-authenticate": 'Basic realm="g1t-gitstore"' });
    return response.end("unauthorized");
  }
  const service = rest === "info/refs" ? new URLSearchParams(query).get("service") : rest;
  if (service === "git-receive-pack" && claims.s !== "write") return send(response, 403, "read-only token");
  if (service === "git-receive-pack" && READ_ONLY) return send(response, 403, "the git store is read-only");
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return send(response, 404, "not found");

  const env = {
    PATH: process.env.PATH,
    GIT_PROJECT_ROOT: ROOT,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: request.method,
    PATH_INFO: `/${key}.git/${rest}`,
    QUERY_STRING: query,
    CONTENT_TYPE: request.headers["content-type"] ?? "",
    REMOTE_USER: "g1t",
    REMOTE_ADDR: request.socket.remoteAddress ?? "",
  };
  if (request.headers["git-protocol"]) env.GIT_PROTOCOL = request.headers["git-protocol"];
  if (request.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = request.headers["content-encoding"];
  if (request.headers["content-length"]) env.CONTENT_LENGTH = request.headers["content-length"];

  const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
  request.pipe(child.stdin);
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  // CGI: headers, a blank line, then the body.
  let buffered = Buffer.alloc(0);
  let headersDone = false;
  child.stdout.on("data", (chunk) => {
    if (headersDone) return response.write(chunk);
    buffered = Buffer.concat([buffered, chunk]);
    let end = buffered.indexOf("\r\n\r\n");
    let gap = 4;
    if (end === -1) {
      end = buffered.indexOf("\n\n");
      gap = 2;
    }
    if (end === -1) return;
    headersDone = true;
    let status = 200;
    const headers = {};
    for (const line of buffered.slice(0, end).toString().split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "status") status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    response.write(buffered.slice(end + gap));
  });
  child.on("close", (code) => {
    if (!headersDone) {
      send(response, 500, "git http-backend failed");
      return;
    }
    if (service === "git-receive-pack" && request.method === "POST" && code === 0) {
      const marker = join(repoDir(key), "g1t-pushed");
      try {
        utimesSync(marker, new Date(), new Date());
      } catch {
        writeFileSync(marker, "");
      }
    }
    response.end();
  });
}

// ── HTTP ────────────────────────────────────────────────────────────────

function send(response, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer ? body : typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": isBuffer ? "application/octet-stream" : typeof body === "string" ? "text/plain" : "application/json",
    ...headers,
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

function authorized(request) {
  const given = Buffer.from(request.headers["x-gitstore-secret"] ?? "");
  const expected = Buffer.from(SECRET);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function api(request, response, parts, params) {
  if (!authorized(request)) return send(response, 401, { code: "UNAUTHORIZED", message: "bad secret" });
  const method = request.method;
  // POST /api/repos                       create
  if (parts.length === 0 && method === "POST") {
    const body = await readJson(request);
    return send(response, 200, await create(body.name, body));
  }
  const [key, action, arg] = parts;
  if (method === "GET" && !action) return send(response, 200, await info(key));
  // DELETE /api/repos/<key>               delete (a purged repository)
  if (method === "DELETE" && !action) {
    refuseWrites("deleting a repository");
    if (!exists(key)) return send(response, 404, { code: "NOT_FOUND", message: "no such repository" });
    await rm(repoDir(key), { recursive: true, force: true });
    return send(response, 200, { deleted: true });
  }
  if (method === "POST" && action === "tokens") {
    requireRepo(key);
    const body = await readJson(request);
    return send(response, 200, mintToken(key, body.scope, body.ttl));
  }
  if (method === "POST" && action === "fork") {
    const body = await readJson(request);
    return send(response, 200, await fork(key, body.name, body));
  }
  if (method === "GET" && action === "commits") {
    return send(response, 200, await readCommit(key, arg));
  }
  if (method === "GET" && action === "log") {
    return send(response, 200, await log(key, Object.fromEntries(params)));
  }
  if (method === "GET" && action === "trees") {
    return send(response, 200, await readTree(key, arg));
  }
  if (method === "GET" && (action === "blobs" || action === "file")) {
    const bytes =
      action === "blobs" ? await readBlob(key, arg) : await readFile(key, params.get("ref"), params.get("path"));
    return bytes ? send(response, 200, bytes) : send(response, 404, { code: "NOT_FOUND", message: "no such object" });
  }
  return send(response, 404, { code: "NOT_FOUND", message: "no such route" });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://gitstore");
  try {
    if (url.pathname === "/healthz") return send(response, 200, READ_ONLY ? "ok read-only" : "ok");
    const git = /^\/git\/((?:[^/]+\/)?[^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (git) return smartHttp(request, response, decodeURIComponent(git[1]), git[2], url.search.slice(1));
    if (url.pathname === "/api/repos" || url.pathname.startsWith("/api/repos/")) {
      const parts = url.pathname.slice("/api/repos".length).split("/").filter(Boolean).map(decodeURIComponent);
      return await api(request, response, parts, url.searchParams);
    }
    send(response, 404, "not found");
  } catch (error) {
    const status = error instanceof StoreError ? error.status : 500;
    const code = error instanceof StoreError ? error.code : "INTERNAL_ERROR";
    if (status >= 500) console.error(error);
    if (!response.headersSent) send(response, status, { code, message: error.message });
    else response.end();
  }
});

server.listen(PORT, () => {
  console.log(`g1t gitstore: ${ROOT} on :${PORT} (remote ${PUBLIC_URL})${READ_ONLY ? ", read-only" : ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
