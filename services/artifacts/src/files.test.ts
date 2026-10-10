import assert from "node:assert/strict";
import { test } from "node:test";

import { fileStore, s3FileStore } from "./files.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: Uint8Array | null };

function fake(responses: Response[] = []) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: (init.body as Uint8Array | null) ?? null });
    return responses.shift() ?? new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const config = { endpoint: "https://s3.example.com", bucket: "g1t-docs", region: "us-east-1", access_key_id: "AKID", secret_access_key: "secret" };

test("puts, gets and deletes a file by its key, path style, signed", async () => {
  const { calls, fetcher } = fake([new Response(null, { status: 200 }), new Response("hello", { status: 200, headers: { "content-type": "image/png", "content-length": "5", etag: '"e"' } }), new Response(null, { status: 204 })]);
  const store = s3FileStore(config, fetcher);
  await store.put("docs/ab cd", new TextEncoder().encode("hello"), "image/png");
  const got = await store.get("docs/ab cd");
  await store.delete("docs/ab cd");
  assert.deepEqual(
    calls.map((c) => [c.method, c.url]),
    [
      ["PUT", "https://s3.example.com/g1t-docs/docs/ab%20cd"],
      ["GET", "https://s3.example.com/g1t-docs/docs/ab%20cd"],
      ["DELETE", "https://s3.example.com/g1t-docs/docs/ab%20cd"],
    ],
  );
  assert.match(calls[0]!.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(calls[0]!.headers["x-amz-content-sha256"], "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(calls[0]!.headers.host, undefined);
  assert.equal(got?.content_type, "image/png");
  assert.equal(got?.bytes, 5);
  assert.equal(await new Response(got!.body).text(), "hello");
});

test("a missing file is null", async () => {
  const { fetcher } = fake([new Response("", { status: 404 })]);
  assert.equal(await s3FileStore(config, fetcher).get("docs/x"), null);
});

test("virtual-hosted addresses put the bucket in the host", async () => {
  const { calls, fetcher } = fake();
  await s3FileStore({ ...config, virtual_hosted: true }, fetcher).delete("docs/x");
  assert.equal(calls[0]!.url, "https://g1t-docs.s3.example.com/docs/x");
});

test("the store follows the settings, and says what is missing", () => {
  assert.throws(() => fileStore({ DOCS_FILES: "s3", DOCS_S3_BUCKET: "b" }), /DOCS_S3_ENDPOINT, DOCS_S3_ACCESS_KEY_ID, DOCS_S3_SECRET_ACCESS_KEY/);
  assert.throws(() => fileStore({}), /No file store/);
  assert.ok(fileStore({ DOCS_FILES: "s3", DOCS_S3_ENDPOINT: "http://minio:9000", DOCS_S3_BUCKET: "b", DOCS_S3_ACCESS_KEY_ID: "k", DOCS_S3_SECRET_ACCESS_KEY: "s" }));
});
