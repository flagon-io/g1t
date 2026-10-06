// The runner's Containers images, as the deploy tool builds and ships them
// (docs/DEPLOYING.md, "The runner's images"):
//
//   base    g1t-runner:base-<date>-<inputs>   services/runner/base/Dockerfile:
//           the OS, toolchains and the Claude Code CLI. Rebuilt only when
//           its folder changes, or weekly (.g1t/workflows/runner-base.yml),
//           and recorded in services/runner/base.json.
//   runner  g1t-runner:<content>              services/runner/Dockerfile: the
//           base plus the runner binary (scripts/build-runner.mjs). Its tag
//           is a hash of everything it is built from, so the same source
//           always names the same image, and an image already in the
//           registry is never built again.
//
// Both live in one repository of Cloudflare's registry, so pushing the
// runner uploads only its one new layer. `wrangler deploy` is given the
// runner's registry reference (a generated config), so a deploy never
// builds an image itself.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ACCOUNT_ID, exec, jsonFrom, lastLines, wrangler } from "./cloudflare.mjs";
import { parseCargoLock } from "./lockfiles.mjs";
import { ROOT, parseJsonc } from "./stack.mjs";

export const REGISTRY = "registry.cloudflare.com";

/** The generated config a runner deploy uses, beside its wrangler.jsonc. */
export const DEPLOY_CONFIG = "wrangler.deploy.json";

const posix = (path) => path.replaceAll("\\", "/");

/** Tracked and untracked (not ignored) files under `paths`, sorted. */
export function filesUnder(paths, root = ROOT) {
  if (!paths.length) return [];
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z", "--", ...paths], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  return [...new Set(out.split("\0").filter(Boolean).map(posix))].filter((file) => existsSync(join(root, file))).sort();
}

/**
 * A hash of files' paths and contents, line endings made LF so a Windows
 * checkout and a Linux one agree.
 */
export function contentHash(files, root = ROOT, read = (file) => readFileSync(join(root, file))) {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    const bytes = read(file);
    const text = bytes.includes(0) ? bytes : Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
    hash.update(`${file}\0${text.length}\0`);
    hash.update(text);
  }
  return hash.digest("hex");
}

/** The repository both images are pushed to, for an account. */
export function repositoryOf(unit, account = ACCOUNT_ID) {
  return `${REGISTRY}/${account}/${unit.image.repository}`;
}

/** What services/runner/base.json says, or null. */
export function readBaseLock(unit, root = ROOT) {
  const file = join(root, unit.image.base.lock);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** A hash of everything the base is built from: its folder. */
export function baseInputs(unit, root = ROOT) {
  return contentHash(filesUnder([unit.image.base.context], root), root);
}

/** The base's tag for its inputs, built on `date`. */
export function baseTag(inputs, date = new Date()) {
  return `base-${date.toISOString().slice(0, 10).replaceAll("-", "")}-${inputs.slice(0, 12)}`;
}

/**
 * Whether the base recorded in base.json is the one its folder builds:
 * { lock, inputs, current, pushed, ref } where `ref` is what the runner's
 * image is built FROM (by digest, once pushed).
 */
export function baseState(unit, root = ROOT) {
  const lock = readBaseLock(unit, root);
  const inputs = baseInputs(unit, root);
  // Pinned by digest once pushed, so the tag moving cannot change what is built.
  const ref = lock ? (lock.pushed && lock.digest ? `${lock.image}@${lock.digest}` : lock.image) : null;
  return { lock, inputs, current: Boolean(lock && lock.inputs === inputs), pushed: Boolean(lock?.pushed), ref };
}

/**
 * The runner image's tag: a hash of its Dockerfile, the base it is built
 * on, and every file the binary is built from (the crates in
 * `unit.image.dirs`, the workspace's Cargo files, the build script).
 */
export function runnerTag(unit, root = ROOT) {
  const base = readBaseLock(unit, root);
  // Cargo.lock counts only for the packages the binary is built from, so a
  // dependency bumped for another service names the same image.
  const files = filesUnder([...unit.image.dirs, ...unit.image.files.filter((f) => f !== unit.image.base.lock && f !== "Cargo.lock")], root);
  const lock = existsSync(join(root, "Cargo.lock")) ? readFileSync(join(root, "Cargo.lock"), "utf8") : "";
  const hash = createHash("sha256");
  hash.update(contentHash(files, root));
  hash.update(`\0lock\0${lockFor(lock, unit.image.crate)}`);
  hash.update(`\0base\0${base?.image ?? ""}\0${base?.digest ?? ""}`);
  return hash.digest("hex").slice(0, 16);
}

/** The Cargo.lock entries `crate` is built from, in a stable order. */
export function lockFor(text, crate) {
  const packages = parseCargoLock(text);
  const seen = new Set();
  const stack = [crate];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const entry of packages.get(name) ?? []) stack.push(...entry.deps);
  }
  return [...seen]
    .sort()
    .map((name) => `${name} ${JSON.stringify((packages.get(name) ?? []).map((e) => [e.version, e.source, e.checksum]))}`)
    .join("\n");
}

/** The runner image's full reference for this checkout. */
export function runnerRef(unit, root = ROOT, account = ACCOUNT_ID) {
  return `${repositoryOf(unit, account)}:${runnerTag(unit, root)}`;
}

// ── The registry ──────────────────────────────────────────────────────────

let creds = null;

/** Short-lived registry credentials, from Wrangler (your login or the token). */
export async function registryCredentials({ push = false } = {}) {
  if (creds && creds.until > Date.now() && (!push || creds.push)) return creds;
  const args = ["containers", "registries", "credentials", REGISTRY, "--pull", "--json", "--expiration-minutes", "60"];
  if (push) args.push("--push");
  // In a unit's folder, not the root, whose .env may hold a token for something else.
  const got = await wrangler(args, { cwd: join(ROOT, "services/runner") });
  if (got.code !== 0) throw new Error(`could not get registry credentials:\n${lastLines(got.out)}`);
  const { username, password } = jsonFrom(got.out);
  creds = { username, password, push, until: Date.now() + 50 * 60 * 1000 };
  return creds;
}

/** Logs Docker in to Cloudflare's registry. */
export async function dockerLogin({ push = false } = {}) {
  const { username, password } = await registryCredentials({ push });
  const done = await exec("docker", ["login", "--username", username, "--password-stdin", REGISTRY], { input: password });
  if (done.code !== 0) throw new Error(`docker login ${REGISTRY} failed:\n${lastLines(done.out)}`);
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Whether `ref` (registry/account/repo:tag) is in the registry. Needs no Docker. */
export async function registryHas(ref, { fetchImpl = fetch, credentials = registryCredentials } = {}) {
  const match = /^([^/]+)\/(.+):([^:/]+)$/.exec(ref);
  if (!match) throw new Error(`not an image reference with a tag: ${ref}`);
  const [, host, name, tag] = match;
  const { username, password } = await credentials();
  const response = await fetchImpl(`https://${host}/v2/${name}/manifests/${tag}`, {
    method: "HEAD",
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, accept: MANIFEST_TYPES },
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`the registry answered ${response.status} for ${ref}`);
  return true;
}

// ── Docker ────────────────────────────────────────────────────────────────

/** Whether Docker has `ref` locally. */
export async function dockerHas(ref) {
  return (await exec("docker", ["image", "inspect", ref, "--format", "{{.Id}}"])).code === 0;
}

/** Bytes of an image as Docker keeps it unpacked, and its layers' compressed total when known. */
export async function imageSize(ref) {
  const found = await exec("docker", ["image", "inspect", ref, "--format", "{{.Size}}"]);
  return found.code === 0 ? Number(found.out.trim()) : null;
}

/**
 * Builds the base. Its cache comes from the base it replaces: the image
 * carries its own build cache (BUILDKIT_INLINE_CACHE), so a machine with
 * none, or one just pruned, pulls the layers that did not change instead
 * of building them again. `--cache-from` an image that cannot be pulled
 * (no login, a first build) is skipped with a warning.
 */
export async function buildBase(unit, { tag, previous, onLine, account = ACCOUNT_ID, noCache = false }) {
  const ref = `${repositoryOf(unit, account)}:${tag}`;
  const args = ["buildx", "build", ...PLAIN_IMAGE, "--progress", "plain", "--load", "--build-arg", "BUILDKIT_INLINE_CACHE=1", "-t", ref];
  if (previous && !noCache) args.push("--cache-from", `type=registry,ref=${previous}`);
  if (noCache) args.push("--no-cache");
  args.push(join(ROOT, unit.image.base.context));
  const built = await exec("docker", args, { onLine });
  if (built.code !== 0) throw new Error(`docker build of the base failed:\n${lastLines(built.out, 30)}`);
  return ref;
}

/** What the base has, for base.json: each toolchain's version. */
export async function baseVersions(ref) {
  const script = [
    'echo "node=$(node --version)"',
    'echo "npm=$(npm --version)"',
    'echo "python=$(python3 --version | cut -d" " -f2)"',
    'echo "go=$(go version | cut -d" " -f3)"',
    'echo "rust=$(rustc --version | cut -d" " -f2)"',
    'echo "git=$(git --version | cut -d" " -f3)"',
    'echo "claude_code=$(claude --version | cut -d" " -f1)"',
    'echo "debian=$(cat /etc/debian_version)"',
  ].join("; ");
  const found = await exec("docker", ["run", "--rm", "--platform", "linux/amd64", "--entrypoint", "bash", ref, "-c", script]);
  if (found.code !== 0) return {};
  return Object.fromEntries(found.out.trim().split(/\r?\n/).map((line) => line.split("=")).filter((pair) => pair.length === 2));
}

/** Pushes `ref`; returns its digest in the registry. */
export async function pushImage(ref, { onLine = () => {}, attempts = 3, run = exec } = {}) {
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const pushed = await run("docker", ["push", ref], { onLine });
    last = pushed.out;
    const digest = pushedDigest(pushed);
    if (digest) return digest;
    // Cloudflare's registry can answer "blob unknown" for a layer it has
    // just taken; pushing again finds the layers there and finishes.
    if (attempt < attempts) onLine(`docker push ${ref} did not finish (attempt ${attempt} of ${attempts}); trying again`);
  }
  throw new Error(`docker push ${ref} failed:\n${lastLines(last)}`);
}

/**
 * The digest a `docker push` ended with, or null if it did not end with
 * one, whatever its exit code: an error from the registry is a failure
 * even when Docker exits 0.
 */
export function pushedDigest({ code, out }) {
  if (code !== 0 || /error from registry|blob unknown|unknown blob|denied|unauthorized/i.test(out)) return null;
  return /digest: (sha256:[0-9a-f]{64})/.exec(out)?.[1] ?? null;
}

/**
 * Build flags for an image Cloudflare Containers takes as Wrangler builds
 * it: one manifest for linux/amd64, with no provenance or SBOM attestation,
 * which would make it an index with an `unknown/unknown` manifest.
 */
export const PLAIN_IMAGE = ["--platform", "linux/amd64", "--provenance=false", "--sbom=false"];

/**
 * Builds the runner's image: the base and the binary, from a build
 * context holding only the binary (target/runner-image).
 */
export async function buildRunnerImage(unit, { ref, base, binaryDir, onLine }) {
  const built = await exec(
    "docker",
    ["buildx", "build", ...PLAIN_IMAGE, "--progress", "plain", "--load", "--build-arg", `BASE=${base}`, "-f", join(ROOT, unit.image.dockerfile), "-t", ref, binaryDir],
    { onLine },
  );
  if (built.code !== 0) throw new Error(`docker build of the runner's image failed:\n${lastLines(built.out, 30)}`);
  return ref;
}

// ── The Worker's config ───────────────────────────────────────────────────

/**
 * Writes the config a runner deploy uses: its wrangler.jsonc with every
 * container's image set to `ref`, beside it so its relative paths hold.
 * Returns the file's name (pass it as --config). Remove it after.
 */
export function writeDeployConfig(unit, ref, root = ROOT) {
  const config = parseJsonc(readFileSync(join(root, unit.path, "wrangler.jsonc"), "utf8"));
  delete config.$schema;
  for (const container of config.containers ?? []) {
    container.image = ref;
    delete container.image_build_context;
    delete container.image_vars;
  }
  const file = join(root, unit.path, DEPLOY_CONFIG);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return DEPLOY_CONFIG;
}

export function removeDeployConfig(unit, root = ROOT) {
  rmSync(join(root, unit.path, DEPLOY_CONFIG), { force: true });
}

/** Writes services/runner/base.json. */
export function writeBaseLock(unit, lock, root = ROOT) {
  writeFileSync(join(root, unit.image.base.lock), `${JSON.stringify(lock, null, 2)}\n`);
}
