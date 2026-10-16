import assert from "node:assert/strict";
import { test } from "node:test";
import { archivedAssetKey, serveArchivedAsset } from "./asset-archive.ts";

test("archive keys cannot read releases, source maps or private objects", () => {
  assert.equal(archivedAssetKey("/assets/app-old12345.css"), "web-assets/assets/app-old12345.css");
  for (const path of ["/downloads/runner", "/assets/../secret.js", "/assets/a.js.map", "/assets/%2e%2e/secret.js", "/assets/nested/a.js"]) assert.equal(archivedAssetKey(path), null);
});

test("a stylesheet removed from the new build stays available with its MIME type", async () => {
  const bucket = { get: async (key: string) => {
    assert.equal(key, "web-assets/assets/app-old12345.css");
    return { body: "body{color:red}", size: 15, httpEtag: '"old"', writeHttpMetadata: (headers: Headers) => headers.set("content-type", "text/css") };
  } } as unknown as R2Bucket;
  const url = "https://g1t.sh/assets/app-old12345.css";
  const response = await serveArchivedAsset(new Request(url), bucket);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/css");
  assert.match(response.headers.get("cache-control")!, /immutable/);
  assert.equal(await response.text(), "body{color:red}");
  assert.equal(await (await serveArchivedAsset(new Request(url, { method: "HEAD" }), bucket)).text(), "");
  assert.equal((await serveArchivedAsset(new Request(url, { headers: { "if-none-match": '"old"' } }), bucket)).status, 304);
});

test("missing or unavailable assets never become HTML or cacheable errors", async () => {
  const url = "https://g1t.sh/assets/missing-12345678.js";
  const missing = await serveArchivedAsset(new Request(url), { get: async () => null } as unknown as R2Bucket);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  const down = await serveArchivedAsset(new Request(url), undefined);
  assert.equal(down.status, 503);
  assert.equal(down.headers.get("cache-control"), "no-store");
});
