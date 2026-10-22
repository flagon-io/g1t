import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { forgetPreviewKeys, previewAccessSettings, refusePreview } from "./preview-access.ts";

const settings = { team: "team.cloudflareaccess.com", aud: "aud-of-previews" };
const NOW = 1_800_000_000_000;

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };

let fetches = 0;
const fetchKeys = (async () => {
  fetches++;
  return Response.json({ keys: [publicJwk] });
}) as typeof fetch;

beforeEach(() => {
  forgetPreviewKeys();
  fetches = 0;
});

const b64 = (data: Uint8Array | string) => Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");

async function token(claims: Record<string, unknown>, kid = "k1") {
  const head = b64(JSON.stringify({ alg: "RS256", kid }));
  const body = b64(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(signature))}`;
}

const good = { aud: [settings.aud], iss: `https://${settings.team}`, exp: NOW / 1000 + 600, nbf: NOW / 1000 - 10 };
const preview = (jwt?: string) => new Request("https://pr-12-g1t.example.workers.dev/flagon-io", jwt ? { headers: { "cf-access-jwt-assertion": jwt } } : {});

test("g1t.sh and other custom domains are never checked", async () => {
  assert.equal(await refusePreview(new Request("https://g1t.sh/"), null, fetchKeys, NOW), null);
  assert.equal(fetches, 0);
});

test("a preview with a valid Access token goes on, and the keys are kept", async () => {
  assert.equal(await refusePreview(preview(await token(good)), settings, fetchKeys, NOW), null);
  assert.equal(await refusePreview(preview(await token(good)), settings, fetchKeys, NOW + 1000), null);
  assert.equal(fetches, 1);
});

test("a preview without a token, or with a bad one, is refused", async () => {
  const refused = async (jwt?: string) => (await refusePreview(preview(jwt), settings, fetchKeys, NOW))?.status;
  assert.equal(await refused(), 403);
  assert.equal(await refused("not.a.jwt"), 403);
  assert.equal(await refused(await token({ ...good, aud: ["another-app"] })), 403, "another application's token");
  assert.equal(await refused(await token({ ...good, iss: "https://evil.cloudflareaccess.com" })), 403);
  assert.equal(await refused(await token({ ...good, exp: NOW / 1000 - 1 })), 403, "expired");
  assert.equal(await refused(await token(good, "unknown-kid")), 403);
  const [head, , signature] = (await token(good)).split(".");
  const changed = b64(JSON.stringify({ ...good, aud: [settings.aud, "x"] }));
  assert.equal(await refused(`${head}.${changed}.${signature}`), 403, "a changed body");
});

test("without settings, every preview request is refused", async () => {
  assert.equal(previewAccessSettings({}), null);
  assert.equal((await refusePreview(preview(await token(good)), null, fetchKeys, NOW))?.status, 403);
  assert.deepEqual(previewAccessSettings({ PREVIEW_ACCESS_TEAM: "t", PREVIEW_ACCESS_AUD: "a" }), { team: "t", aud: "a" });
});
