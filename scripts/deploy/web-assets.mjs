// Public, fingerprinted files outlive a Worker release. Upload before cutover;
// never delete or overwrite a filename with different bytes.
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { archivedAssetKey } from "../../apps/web/app/lib/asset-archive.ts";
import { cloudflareAuth, jsonFrom, wrangler, wranglerEnv } from "./cloudflare.mjs";

const TYPES = { js: "text/javascript", css: "text/css", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", wasm: "application/wasm" };

export function assetReferences(text) {
  return [...new Set([...text.matchAll(/(?:\/?assets\/|["'(]\.\/)([a-zA-Z0-9_.~-]+\.(?:js|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico|wasm))\b/g)].map((match) => match[1]))]
    // Vite's emitted filenames have an eight-character content hash.
    // Libraries can also contain unused relative defaults like elk-worker.min.js.
    .filter((name) => /-[a-zA-Z0-9_-]{8}\.[a-z0-9]+$/.test(name));
}

async function together(items, run) {
  let index = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(6, items.length) }, async () => {
    for (let i = index++; i < items.length; i = index++) await run(items[i]);
  }));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

/** Bounded provider retries: archive trouble delays cutover, never skips it. */
export function retryingFetch(fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  return async (url, options = {}) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(60_000) });
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 6) return response;
      const seconds = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      await wait(response.status === 429 ? Math.min(60_000, Math.max(1000, seconds * 1000 || 60_000)) : Math.min(1000 * 2 ** attempt, 30_000));
    }
  };
}

const checksum = (bytes) => `"${createHash("md5").update(bytes).digest("hex")}"`;
const objectUrl = (account, bucket, key) => `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects/${key}`;
const manifestName = (names) => names.find((name) => /^manifest-[a-zA-Z0-9_-]{8}\.js$/.test(name));

async function confirmUpload(response, bytes, label) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Asset archive upload failed (${response.status}): ${label}`); }
  let receipt;
  try { receipt = await response.json(); } catch { throw new Error(`Invalid asset upload receipt: ${label}`); }
  if (receipt.success !== true || `"${receipt.result?.etag?.replaceAll('"', "")}"` !== checksum(bytes)) throw new Error(`Asset upload checksum mismatch: ${label}`);
}

/** One manifest per release: work never grows with the number of old releases. */
export async function readArchiveManifest(url, headers, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers });
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) throw new Error(`Cannot read archived build (${response.status})`);
  const data = await response.json();
  if (data.version !== 1 || !Array.isArray(data.assets) || !data.assets.length || data.assets.some((row) => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || archivedAssetKey(row[0].replace(/^web-assets/, "")) !== row[0] || !/^"[a-f0-9]{32}"$/.test(row[1]))) throw new Error("Invalid archived build manifest");
  return new Map(data.assets);
}

export async function archiveAsset({ name, bytes, account, bucket, headers, index, fetchImpl = fetch }) {
  const key = archivedAssetKey(`/assets/${name}`);
  if (!key) throw new Error(`Not a public build asset: ${name}`);
  const url = objectUrl(account, bucket, key);
  const expected = checksum(bytes);
  if (index?.has(key)) {
    if (index.get(key) !== expected) throw new Error(`Asset filename collision: ${name}`);
    return;
  }
  // Cloudflare's R2 REST gateway does not implement HEAD. Range avoids
  // downloading unchanged files; cancel the body even if Range is ignored.
  const existing = await fetchImpl(url, { headers: { ...headers, range: "bytes=0-0" }, signal: AbortSignal.timeout(30_000) });
  if (existing.ok) {
    await existing.body?.cancel();
    if (existing.headers.get("etag") !== expected) throw new Error(`Asset filename collision: ${name}`);
    index?.set(key, expected);
    return;
  }
  await existing.body?.cancel();
  if (existing.status !== 404) throw new Error(`Asset archive lookup failed (${existing.status}): ${name}`);
  const uploaded = await fetchImpl(url, {
    method: "PUT", headers: { ...headers, "content-type": TYPES[name.split(".").at(-1)], "cache-control": "public, max-age=31536000, immutable" },
    body: bytes, signal: AbortSignal.timeout(60_000),
  });
  await confirmUpload(uploaded, bytes, name);
  index?.set(key, expected);
}

/** Seed the currently live build too, so the first protected release saves existing tabs. */
async function liveReferences(origin, fetchImpl) {
  const pageUrl = new URL(origin);
  // The application's public HTML cache may still contain a previous release.
  pageUrl.searchParams.set("_g1t_archive", randomUUID());
  const page = await fetchImpl(pageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!page.ok) throw new Error(`Cannot read the current site before cutover (${page.status})`);
  const pending = assetReferences(await page.text());
  if (!pending.some((name) => name.endsWith(".js")) || !pending.some((name) => name.endsWith(".css"))) throw new Error("Current site did not expose its JS and CSS assets; refusing an unprotected cutover");
  return pending;
}

export async function archiveLiveAssets(origin, save, fetchImpl = fetch, references) {
  let pending = references ?? await liveReferences(origin, fetchImpl);
  const seen = new Set();
  while (pending.length) {
    const batch = [...new Set(pending)].filter((name) => !seen.has(name));
    pending = [];
    for (const name of batch) seen.add(name);
    if (seen.size > 4000) throw new Error("Current site's asset graph exceeds the archive limit");
    await together(batch, async (name) => {
      const response = await fetchImpl(new URL(`/assets/${name}`, origin), { signal: AbortSignal.timeout(30_000) });
      if (!response.ok || /text\/html/i.test(response.headers.get("content-type") ?? "")) throw new Error(`Current asset is unavailable: ${name}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await save(name, bytes);
      if (/\.(js|css)$/.test(name)) pending.push(...assetReferences(bytes.toString("utf8")));
    });
  }
  return seen.size;
}

export async function publishWebAssets(cwd, { onLine = console.log, fetchImpl = fetch, seedLive = true, auth = cloudflareAuth(wranglerEnv()) } = {}) {
  const config = JSON.parse(await readFile(join(cwd, "build/server/wrangler.json"), "utf8"));
  const bucket = config.r2_buckets.find((binding) => binding.binding === "DOWNLOADS")?.bucket_name;
  if (!bucket || !config.account_id) throw new Error("Web asset archive needs the DOWNLOADS bucket and Cloudflare account");
  let headers = auth;
  if (!headers) {
    // Capture credentials only in memory; never pipe this output to deploy logs.
    const auth = await wrangler(["auth", "token", "--json"], { cwd });
    if (auth.code !== 0) throw new Error("Cannot authenticate the asset archive; run wrangler login");
    let credentials;
    try { credentials = jsonFrom(auth.out); } catch { throw new Error("Cannot read Wrangler credentials for asset archive"); }
    headers = credentials.type === "api_key" ? { "x-auth-key": credentials.key, "x-auth-email": credentials.email } : { authorization: `Bearer ${credentials.token}` };
  }
  const providerFetch = retryingFetch(fetchImpl);
  const manifestUrl = (name) => objectUrl(config.account_id, bucket, `web-assets/manifests/${name}.json`);
  const saveManifest = async (name, assets) => {
    const body = JSON.stringify({ version: 1, assets: [...assets] });
    const response = await providerFetch(manifestUrl(name), { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body });
    await confirmUpload(response, body, name);
  };
  let index = new Map();
  const domain = config.routes?.find((route) => route.custom_domain)?.pattern;
  if (domain && seedLive) {
    const origin = `https://${domain}`;
    const references = await liveReferences(origin, fetchImpl);
    const manifest = manifestName(references);
    if (!manifest) throw new Error("Current site has no versioned route manifest");
    const archived = await readArchiveManifest(manifestUrl(manifest), headers, providerFetch);
    if (archived) {
      index = archived;
      onLine(`Current build is already archived (${index.size} assets)`);
    } else {
      const save = (name, bytes) => archiveAsset({ name, bytes, account: config.account_id, bucket, headers, index, fetchImpl: providerFetch });
      onLine(`Archived ${await archiveLiveAssets(origin, save, fetchImpl, references)} current assets before cutover`);
      await saveManifest(manifest, index);
    }
  }
  const directory = join(cwd, "build/client/assets");
  const previous = new Map(index);
  const names = (await readdir(directory)).filter((name) => archivedAssetKey(`/assets/${name}`));
  const manifest = manifestName(names);
  if (!manifest || !names.some((name) => name.endsWith(".css"))) throw new Error("Web build has no manifest/CSS assets");
  const current = new Map();
  await together(names, async (name) => {
    const bytes = await readFile(join(directory, name));
    await archiveAsset({ name, bytes, account: config.account_id, bucket, headers, index, fetchImpl: providerFetch });
    current.set(archivedAssetKey(`/assets/${name}`), checksum(bytes));
  });
  await saveManifest(manifest, current);
  onLine(`Verified ${names.length} assets for the new build; old filenames remain available`);
  const samples = new Map();
  for (const assets of [previous, current]) {
    for (const pattern of [/\.css$/, /\/entry\.client-.*\.js$/, /\/manifest-.*\.js$/]) {
      const entry = [...assets].find(([key]) => pattern.test(key));
      if (entry) samples.set(...entry);
    }
  }
  return { origin: domain ? `https://${domain}` : null, manifest, samples: [...samples] };
}

/** Check both sides of cutover, including filenames no longer in the new bundle. */
async function verifyWebAssetsOnce(release, fetchImpl) {
  if (!release.origin) return;
  const references = await liveReferences(release.origin, fetchImpl);
  if (!references.includes(release.manifest)) throw new Error(`Web cutover is not serving the expected build (expected ${release.manifest}, observed ${manifestName(references) ?? "no manifest"})`);
  await together(release.samples, async ([key, etag]) => {
    const response = await fetchImpl(new URL(key.replace(/^web-assets/, ""), release.origin), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || /text\/html/i.test(response.headers.get("content-type") ?? "") || checksum(Buffer.from(await response.arrayBuffer())) !== etag) throw new Error(`Web cutover asset check failed: ${key}`);
  });
}

/** Wrangler finishing does not mean every edge is already serving the new version. */
export async function verifyWebAssets(release, fetchImpl = fetch, {
  retryWaits = [1000, 2000, 4000, 8000, 15000, 30000],
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onLine = () => {},
} = {}) {
  const deadline = AbortSignal.timeout(120_000);
  const boundedFetch = (url, options = {}) => fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline });
  for (let attempt = 0; ; attempt++) {
    try {
      await verifyWebAssetsOnce(release, boundedFetch);
      return;
    } catch (error) {
      if (attempt >= retryWaits.length || deadline.aborted) throw error;
      onLine(`Waiting for web cutover (${retryWaits[attempt] / 1000}s): ${error.message}`);
      await wait(retryWaits[attempt]);
      deadline.throwIfAborted();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const release = await publishWebAssets(process.cwd());
  if (process.argv.includes("--deploy")) {
    const deployed = await wrangler(["deploy"], { cwd: process.cwd(), onLine: console.log });
    if (deployed.code !== 0) throw new Error("Web deploy failed");
    await verifyWebAssets(release, fetch, { onLine: console.log });
    console.log("Web cutover verified: current and previous build assets respond");
  }
}
