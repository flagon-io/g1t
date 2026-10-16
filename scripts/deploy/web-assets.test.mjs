import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { archiveAsset, archiveLiveAssets, assetReferences, publishWebAssets, readArchiveManifest, retryingFetch, verifyWebAssets } from "./web-assets.mjs";

test("discover actual hashed assets without archiving icons, source maps or library defaults", () => {
  assert.deepEqual(assetReferences('<link href="/assets/app-12345678.css"><img src="/apple-touch-icon.png"> import "./chunk-abcdefgh.js"; import "./elk-worker.min.js"; url(/assets/font-12345678.woff2)'), ["app-12345678.css", "chunk-abcdefgh.js", "font-12345678.woff2"]);
});

test("archive the old release's transitive chunks before replacing it", async () => {
  const responses = {
    "/": '<link href="/assets/app-12345678.css"><script src="/assets/entry-12345678.js"></script>',
    "/assets/app-12345678.css": "body{color:red}",
    "/assets/entry-12345678.js": 'import "./lazy-12345678.js"; import "./lazy-12345678.js"',
    "/assets/lazy-12345678.js": 'import "./entry-12345678.js"',
  };
  const saved = [];
  const total = await archiveLiveAssets("https://example.com", async (name) => saved.push(name), async (url) => new Response(responses[new URL(url).pathname]));
  assert.equal(total, 3);
  assert.deepEqual(saved.sort(), ["app-12345678.css", "entry-12345678.js", "lazy-12345678.js"]);
});

test("archive failures block cutover and immutable filename collisions are refused", async () => {
  const args = { name: "app-12345678.css", bytes: Buffer.from("body{}"), account: "account", bucket: "bucket", headers: {} };
  const calls = [];
  await assert.rejects(archiveAsset({ ...args, fetchImpl: async (_url, init) => {
    calls.push(init.method ?? "GET");
    return new Response(null, { status: init.method === "PUT" ? 503 : 404 });
  } }), /upload failed/);
  assert.deepEqual(calls, ["GET", "PUT"]);
  await assert.rejects(archiveAsset({ ...args, fetchImpl: async (_url, init) => init.method === "PUT" ? Response.json({ success: true, result: { etag: "incorrect" } }) : new Response(null, { status: 404 }) }), /checksum mismatch/);
  await assert.rejects(archiveAsset({ ...args, fetchImpl: async () => new Response(null, { headers: { etag: '"different"' } }) }), /collision/);
  const etag = `"${createHash("md5").update(args.bytes).digest("hex")}"`;
  await archiveAsset({ ...args, fetchImpl: async (_url, init) => {
    assert.notEqual(init.method, "PUT");
    return new Response(null, { headers: { etag } });
  } });
});

test("a missing live asset aborts the archive instead of saving an HTML error as CSS", async () => {
  await assert.rejects(archiveLiveAssets("https://example.com", async () => assert.fail(), async (url) => new URL(url).pathname === "/"
    ? new Response('/assets/app-12345678.css /assets/entry-12345678.js')
    : new Response("not found", { headers: { "content-type": "text/html" } })), /unavailable/);
});

test("a release manifest skips unchanged uploads without scanning deployment history", async () => {
  const bytes = Buffer.from("body{}");
  const etag = createHash("md5").update(bytes).digest("hex");
  const index = await readArchiveManifest("https://provider/manifest", {}, async () => Response.json({ version: 1, assets: [["web-assets/assets/app-12345678.css", `"${etag}"`]] }));
  await archiveAsset({ name: "app-12345678.css", bytes, account: "a", bucket: "b", headers: {}, index, fetchImpl: async () => assert.fail("unchanged asset should not be uploaded") });
  await assert.rejects(archiveAsset({ name: "app-12345678.css", bytes: Buffer.from("different"), account: "a", bucket: "b", headers: {}, index }), /collision/);
});

test("provider rate limits wait and retry; persistent failure remains a failure", async () => {
  const waits = [];
  let calls = 0;
  const response = await retryingFetch(async () => new Response(null, { status: ++calls < 3 ? 429 : 200, headers: { "retry-after": "2" } }), async (ms) => waits.push(ms))("https://provider");
  assert.equal(response.status, 200);
  assert.deepEqual(waits, [2000, 2000]);
  calls = 0;
  assert.equal((await retryingFetch(async () => { calls++; return new Response(null, { status: 503 }); }, async () => {})("https://provider")).status, 503);
  assert.equal(calls, 7);
});

test("cutover verifies old and new assets and rejects HTML fallback or wrong build", async () => {
  const css = "body{}";
  const release = { origin: "https://example.com", manifest: "manifest-12345678.js", samples: [["web-assets/assets/app-old12345.css", `"${createHash("md5").update(css).digest("hex")}"`]] };
  const page = '<link href="/assets/app-12345678.css"><script src="/assets/manifest-12345678.js"></script>';
  await verifyWebAssets(release, async (url) => new Response(new URL(url).pathname === "/" ? page : css));
  await assert.rejects(verifyWebAssets(release, async (url) => new Response(new URL(url).pathname === "/" ? page : "error", { headers: { "content-type": "text/html" } })), /asset check failed/);
  await assert.rejects(verifyWebAssets(release, async () => new Response(page.replaceAll("12345678", "87654321"))), /expected build/);
});

test("1000 successive releases keep old tabs' assets and perform bounded incremental archive work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "g1t-web-releases-"));
  const directory = join(cwd, "build/client/assets");
  await mkdir(directory, { recursive: true });
  await mkdir(join(cwd, "build/server"), { recursive: true });
  await writeFile(join(cwd, "build/server/wrangler.json"), JSON.stringify({ account_id: "a", r2_buckets: [{ binding: "DOWNLOADS", bucket_name: "b" }], routes: [{ custom_domain: true, pattern: "example.com" }] }));
  const objects = new Map();
  const shared = 'export const shared = true;';
  let live = null;
  let apiCalls = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === "example.com") {
      assert.equal(url.pathname, "/", "already protected releases must not crawl all live chunks again");
      return new Response(`/assets/${live} /assets/app-12345678.css`);
    }
    apiCalls++;
    assert.ok(url.pathname.includes("/objects/"), "must not list all previous releases");
    const key = url.pathname.split("/objects/")[1];
    if (init.method === "PUT") {
      objects.set(key, Buffer.from(init.body));
      return Response.json({ success: true, result: { etag: createHash("md5").update(init.body).digest("hex") } });
    }
    const bytes = objects.get(key);
    return bytes ? new Response(bytes, { headers: { etag: `"${createHash("md5").update(bytes).digest("hex")}"` } }) : new Response(null, { status: 404 });
  };
  try {
    await writeFile(join(directory, "app-12345678.css"), "body{}");
    await writeFile(join(directory, "shared-12345678.js"), shared);
    for (let i = 0; i < 1000; i++) {
      const manifest = `manifest-${i.toString(16).padStart(8, "0")}.js`;
      if (live) await rm(join(directory, live));
      await writeFile(join(directory, manifest), `window.manifest=${i}`);
      apiCalls = 0;
      await publishWebAssets(cwd, { auth: { authorization: "test" }, fetchImpl, seedLive: i > 0, onLine: () => {} });
      assert.equal(apiCalls, i === 0 ? 7 : 4, `release ${i} should upload only its changed file and manifest`);
      live = manifest;
    }
    assert.equal(objects.get("web-assets/assets/shared-12345678.js").toString(), shared);
    assert.equal(objects.get("web-assets/assets/manifest-00000000.js").toString(), "window.manifest=0");
    assert.equal(objects.get("web-assets/assets/manifest-000003e7.js").toString(), "window.manifest=999");
  } finally {
    assert.equal(dirname(resolve(cwd)), resolve(tmpdir()));
    await rm(cwd, { recursive: true, force: true });
  }
});
