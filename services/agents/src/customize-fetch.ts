/**
 * Reading marketplaces and plugins from where they live
 * (docs.g1t.sh/guides/customize/, "Where plugins come from"): a GitHub
 * repository (public, by its API for the tree and raw files for content),
 * a repository on this g1t (the repos service), a direct link to a
 * `marketplace.json`, or a zip archive. Every read is bounded: at most
 * `MAX_PLUGIN_FILES` files and `MAX_PLUGIN_BYTES` together, and a file over
 * `MAX_FILE_BYTES` is left out and named, since Claude Code on a runner
 * fetches the plugin whole for itself anyway.
 *
 * Pure apart from `fetch` and the repos ports, so it is tested with fakes.
 */
import type { FetchPlan, MarketplaceSource } from "../../../packages/contracts/src/claude-plugin.ts";
import type { SkillFile } from "../../../packages/contracts/src/skill-format.ts";
import { asSkillFile, unzip } from "./skill-zip.ts";

/** The most a plugin read here holds. */
export const MAX_PLUGIN_FILES = 2000;
export const MAX_PLUGIN_BYTES = 24 * 1024 * 1024;
/** A file larger than this is listed but not read. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** How long one fetch may take. */
const TIMEOUT_MS = 20_000;
/** Raw files fetched at once. */
const PARALLEL = 16;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The repos service, as the fetcher needs it: a repository the viewer may read, its files at a ref, and blobs. */
export type RepoPorts = {
  repo(full: string): Promise<{ id: string; default_branch: string } | null>;
  listFiles(repoId: string, ref: string | null): Promise<{ commit: string | null; files: { path: string; hash: string | null }[]; truncated: boolean }>;
  blobs(repoId: string, hashes: string[]): Promise<{ hash: string; data: string | null }[]>;
};

export type FetchDeps = {
  fetchFn?: Fetch;
  /** A GitHub token for the API (optional: the API allows a few reads an hour without one). */
  githubToken?: string | null;
  repos?: RepoPorts | null;
};

export type Fetched = { ok: true; files: SkillFile[]; sha: string | null; omitted: string[] } | { ok: false; message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

async function get(fetchFn: Fetch, url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  try {
    return await fetchFn(url, { headers: { "user-agent": "g1t-customize", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  } catch {
    return null;
  }
}

function githubHeaders(token: string | null | undefined): Record<string, string> {
  return { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

// ── GitHub ───────────────────────────────────────────────────────────────

/** The commit `ref` names (or the default branch's head), as a 40-character sha. */
async function githubCommit(fetchFn: Fetch, token: string | null | undefined, repo: string, ref: string | null): Promise<{ ok: true; sha: string } | { ok: false; message: string }> {
  const response = await get(fetchFn, `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref ?? "HEAD")}`, githubHeaders(token));
  if (!response) return fail(`GitHub couldn't be reached for ${repo}.`);
  if (response.status === 404) return fail(`${repo}${ref ? ` at ${ref}` : ""} isn't on GitHub, or isn't public.`);
  if (response.status === 403 || response.status === 429) return fail("GitHub is limiting how often g1t may read right now. Try again in a little while.");
  if (!response.ok) return fail(`GitHub answered ${response.status} for ${repo}.`);
  const body = (await response.json().catch(() => null)) as { sha?: string } | null;
  return body?.sha && /^[0-9a-f]{40}$/.test(body.sha) ? { ok: true, sha: body.sha } : fail(`GitHub didn't say which commit ${repo} is at.`);
}

/** Every file under `path` at `sha`, from the repository's tree. */
async function githubTree(fetchFn: Fetch, token: string | null | undefined, repo: string, sha: string, path: string): Promise<{ ok: true; files: { path: string; size: number }[]; truncated: boolean } | { ok: false; message: string }> {
  const response = await get(fetchFn, `https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`, githubHeaders(token));
  if (!response) return fail(`GitHub couldn't be reached for ${repo}.`);
  if (response.status === 403 || response.status === 429) return fail("GitHub is limiting how often g1t may read right now. Try again in a little while.");
  if (!response.ok) return fail(`GitHub answered ${response.status} for ${repo}'s files.`);
  const body = (await response.json().catch(() => null)) as { tree?: { path: string; type: string; size?: number }[]; truncated?: boolean } | null;
  if (!body?.tree) return fail(`GitHub didn't list ${repo}'s files.`);
  const prefix = path ? `${path.replace(/\/+$/, "")}/` : "";
  const files = body.tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix)).map((e) => ({ path: e.path.slice(prefix.length), size: e.size ?? 0 }));
  return { ok: true, files, truncated: !!body.truncated };
}

/** Raw files from GitHub, in parallel, each as text or base64. */
async function githubFiles(fetchFn: Fetch, repo: string, sha: string, base: string, files: { path: string; size: number }[]): Promise<{ ok: true; files: SkillFile[]; omitted: string[] } | { ok: false; message: string }> {
  const out: SkillFile[] = [];
  const omitted: string[] = [];
  const prefix = base ? `${base}/` : "";
  const wanted = files.filter((f) => (f.size <= MAX_FILE_BYTES ? true : (omitted.push(f.path), false)));
  for (let i = 0; i < wanted.length; i += PARALLEL) {
    const batch = wanted.slice(i, i + PARALLEL);
    const results = await Promise.all(
      batch.map(async (file) => {
        const response = await get(fetchFn, `https://raw.githubusercontent.com/${repo}/${sha}/${prefix}${file.path.split("/").map(encodeURIComponent).join("/")}`);
        if (!response?.ok) return { file, bytes: null as Uint8Array | null };
        return { file, bytes: new Uint8Array(await response.arrayBuffer()) };
      }),
    );
    for (const { file, bytes } of results) {
      if (!bytes) return fail(`${file.path} in ${repo} couldn't be read from GitHub.`);
      out.push(asSkillFile(file.path, bytes));
    }
  }
  return { ok: true, files: out, omitted };
}

// ── This g1t ─────────────────────────────────────────────────────────────

function blobFile(path: string, data: string): SkillFile {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return asSkillFile(path, bytes);
}

async function g1tFiles(repos: RepoPorts, repo: string, ref: string | null, path: string): Promise<Fetched> {
  const found = await repos.repo(repo).catch(() => null);
  if (!found) return fail(`${repo} isn't a repository here that you can read.`);
  const listing = await repos.listFiles(found.id, ref).catch(() => null);
  if (!listing) return fail(`${repo}${ref ? ` at ${ref}` : ""} couldn't be read.`);
  const prefix = path ? `${path.replace(/\/+$/, "")}/` : "";
  const wanted = listing.files.filter((f): f is { path: string; hash: string } => !!f.hash && f.path.startsWith(prefix));
  if (!wanted.length) return fail(`There are no files in ${path || "the top folder"} of ${repo}.`);
  if (wanted.length > MAX_PLUGIN_FILES) return fail(`${path || repo} has ${wanted.length} files; a plugin holds at most ${MAX_PLUGIN_FILES}.`);
  const data = new Map<string, string | null>();
  const hashes = [...new Set(wanted.map((f) => f.hash))];
  for (let i = 0; i < hashes.length; i += 100) for (const blob of await repos.blobs(found.id, hashes.slice(i, i + 100))) data.set(blob.hash, blob.data);
  const files: SkillFile[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  for (const file of wanted) {
    const content = data.get(file.hash);
    const relative = file.path.slice(prefix.length);
    if (content == null) {
      omitted.push(relative);
      continue;
    }
    const one = blobFile(relative, content);
    bytes += one.encoding === "base64" ? Math.floor((one.content.length * 3) / 4) : new TextEncoder().encode(one.content).length;
    if (bytes > MAX_PLUGIN_BYTES) return fail(`${path || repo} is larger than ${Math.round(MAX_PLUGIN_BYTES / 1024 / 1024)} MB, the most a plugin read here holds.`);
    files.push(one);
  }
  return { ok: true, files, sha: listing.commit, omitted };
}

// ── Archives ─────────────────────────────────────────────────────────────

async function archiveFiles(fetchFn: Fetch, url: string, sha256: string | null): Promise<Fetched> {
  const response = await get(fetchFn, url);
  if (!response?.ok) return fail(`The archive at ${url} couldn't be fetched${response ? ` (${response.status})` : ""}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_PLUGIN_BYTES) return fail(`The archive is larger than ${Math.round(MAX_PLUGIN_BYTES / 1024 / 1024)} MB, the most a plugin read here holds.`);
  if (sha256) {
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (digest !== sha256) return fail("The archive isn't the one the marketplace lists: its checksum differs.");
  }
  const unpacked = await unzip(bytes, { files: MAX_PLUGIN_FILES, bytes: MAX_PLUGIN_BYTES });
  if (!unpacked.ok) return fail(unpacked.message);
  return { ok: true, files: unpacked.files, sha: null, omitted: [] };
}

// ── Plugins ──────────────────────────────────────────────────────────────

/** A plugin's files, read from where its plan says, with the commit they were read at when there is one. */
export async function fetchPlugin(plan: FetchPlan, deps: FetchDeps = {}): Promise<Fetched> {
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
  switch (plan.kind) {
    case "unsupported":
      return fail(plan.why);
    case "archive":
      return archiveFiles(fetchFn, plan.url, plan.sha256);
    case "g1t":
      if (!deps.repos) return fail("Repositories here can't be read just now.");
      return g1tFiles(deps.repos, plan.repo, plan.ref, plan.path);
    case "github": {
      const sha = plan.sha ? { ok: true as const, sha: plan.sha } : await githubCommit(fetchFn, deps.githubToken, plan.repo, plan.ref);
      if (!sha.ok) return sha;
      const tree = await githubTree(fetchFn, deps.githubToken, plan.repo, sha.sha, plan.path);
      if (!tree.ok) return tree;
      if (!tree.files.length) return fail(`There are no files in ${plan.path || "the top folder"} of ${plan.repo}.`);
      if (tree.files.length > MAX_PLUGIN_FILES) return fail(`${plan.path || plan.repo} has ${tree.files.length} files; a plugin holds at most ${MAX_PLUGIN_FILES}.`);
      const total = tree.files.reduce((n, f) => n + Math.min(f.size, MAX_FILE_BYTES), 0);
      if (total > MAX_PLUGIN_BYTES) return fail(`${plan.path || plan.repo} is larger than ${Math.round(MAX_PLUGIN_BYTES / 1024 / 1024)} MB, the most a plugin read here holds.`);
      const files = await githubFiles(fetchFn, plan.repo, sha.sha, plan.path, tree.files);
      if (!files.ok) return files;
      return { ok: true, files: files.files, sha: sha.sha, omitted: [...files.omitted, ...(tree.truncated ? ["(GitHub listed only part of a very large repository)"] : [])] };
    }
  }
}

// ── Marketplaces ─────────────────────────────────────────────────────────

export type FetchedManifest = { ok: true; json: unknown; sha: string | null } | { ok: false; message: string };

const MANIFEST_PATH = ".claude-plugin/marketplace.json";

/** A marketplace's `marketplace.json`, read from where it is. */
export async function fetchMarketplace(source: MarketplaceSource, deps: FetchDeps = {}, host: string | null = null): Promise<FetchedManifest> {
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
  const parse = async (response: Response | null, where: string): Promise<FetchedManifest> => {
    if (!response) return fail(`${where} couldn't be reached.`);
    if (response.status === 404) return fail(`There is no ${MANIFEST_PATH} at ${where}.`);
    if (!response.ok) return fail(`${where} answered ${response.status}.`);
    const text = await response.text().catch(() => "");
    if (text.length > 4 * 1024 * 1024) return fail("That marketplace.json is larger than 4 MB.");
    try {
      return { ok: true, json: JSON.parse(text), sha: null };
    } catch {
      return fail(`${where} didn't give JSON.`);
    }
  };
  switch (source.source) {
    case "builtin":
      return fail("A built-in marketplace is read by its own source.");
    case "url":
      return parse(await get(fetchFn, source.url), source.url);
    case "github": {
      const read = await parse(await get(fetchFn, `https://raw.githubusercontent.com/${source.repo}/${encodeURIComponent(source.ref ?? "HEAD")}/${MANIFEST_PATH}`), `${source.repo} on GitHub`);
      if (!read.ok) return read;
      const sha = await githubCommit(fetchFn, deps.githubToken, source.repo, source.ref ?? null);
      return { ...read, sha: sha.ok ? sha.sha : null };
    }
    case "git": {
      const github = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(source.url);
      if (github) return fetchMarketplace({ source: "github", repo: github[1]!, ...(source.ref ? { ref: source.ref } : {}) }, deps, host);
      const own = host ? new RegExp(`^https?://(?:www\\.)?${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+/[^/]+?)(?:\\.git)?/?$`, "i").exec(source.url) : null;
      if (own) return fetchMarketplace({ source: "g1t", repo: own[1]!, ...(source.ref ? { ref: source.ref } : {}) }, deps, host);
      return fail("g1t reads marketplaces from GitHub, from repositories here, and from a link to their marketplace.json. That git host isn't one of them yet.");
    }
    case "g1t": {
      if (!deps.repos) return fail("Repositories here can't be read just now.");
      const found = await deps.repos.repo(source.repo).catch(() => null);
      if (!found) return fail(`${source.repo} isn't a repository here that you can read.`);
      const listing = await deps.repos.listFiles(found.id, source.ref ?? null).catch(() => null);
      const entry = listing?.files.find((f) => f.path === MANIFEST_PATH);
      if (!listing || !entry?.hash) return fail(`There is no ${MANIFEST_PATH} in ${source.repo}.`);
      const [blob] = await deps.repos.blobs(found.id, [entry.hash]);
      if (!blob?.data) return fail(`${MANIFEST_PATH} in ${source.repo} couldn't be read.`);
      try {
        return { ok: true, json: JSON.parse(atob(blob.data)), sha: listing.commit };
      } catch {
        return fail(`${MANIFEST_PATH} in ${source.repo} isn't JSON.`);
      }
    }
  }
}
