import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  type AccessSettings,
  authorize,
  clearKeyCache,
  isSameOrigin,
  isStaff,
  parseServiceTokens,
  parseStaff,
  readSettings,
  verifyAccessJwt,
} from "./access.ts";

const TEAM = "g1t.cloudflareaccess.com";
const AUD = "a".repeat(64);
const CLIENT = "434297ede60761875e84742d0486cf27.access";
const SETTINGS: AccessSettings = { teamDomain: TEAM, aud: AUD, staff: ["owner@g1t.sh"], services: new Map([[CLIENT, "claude"]]) };
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW / 1000);
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

async function rsaKey() {
  return crypto.subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
}

const signing = await rsaKey();
const stranger = await rsaKey();
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", signing.publicKey)), kid: "key-1", alg: "RS256", use: "sig" };

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(
  claims: Record<string, unknown>,
  { key = signing.privateKey, kid = "key-1", alg = "RS256" }: { key?: CryptoKey; kid?: string; alg?: string } = {},
): Promise<string> {
  const body = `${b64url(JSON.stringify({ alg, kid, typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const signature = new Uint8Array(await crypto.subtle.sign(RSA, key, new TextEncoder().encode(body)));
  return `${body}.${b64url(signature)}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `https://${TEAM}`,
    aud: [AUD],
    email: "owner@g1t.sh",
    sub: "user-1",
    iat: NOW_SECONDS - 60,
    nbf: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3600,
    ...overrides,
  };
}

let fetches: string[] = [];
async function fetcher(url: string): Promise<Response> {
  fetches.push(url);
  return Response.json({ keys: [publicJwk], public_cert: { kid: "key-1", cert: "" } });
}

function request(token?: string): Request {
  return new Request("https://sudo.g1t.sh/", {
    headers: token ? { "cf-access-jwt-assertion": token } : {},
  });
}

beforeEach(() => {
  clearKeyCache();
  fetches = [];
});

test("a valid token from staff is let in, by its email", async () => {
  const result = await authorize(request(await sign(claims())), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: true, email: "owner@g1t.sh" });
  assert.deepEqual(fetches, [`https://${TEAM}/cdn-cgi/access/certs`]);
});

test("an audience given as a string is accepted too", async () => {
  const result = await verifyAccessJwt(await sign(claims({ aud: AUD })), SETTINGS, { fetcher, now: NOW });
  assert.equal(result.ok, true);
});

test("a token for another Access application is refused", async () => {
  const result = await verifyAccessJwt(await sign(claims({ aud: ["b".repeat(64)] })), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "wrong audience" });
});

test("a token from another team is refused", async () => {
  const result = await verifyAccessJwt(
    await sign(claims({ iss: "https://evil.cloudflareaccess.com" })),
    SETTINGS,
    { fetcher, now: NOW },
  );
  assert.deepEqual(result, { ok: false, reason: "wrong issuer" });
});

test("an expired token is refused", async () => {
  const result = await verifyAccessJwt(await sign(claims({ exp: NOW_SECONDS - 3600 })), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "expired" });
});

test("a token without an expiry is refused", async () => {
  const result = await verifyAccessJwt(await sign(claims({ exp: undefined })), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "no expiry" });
});

test("a token not valid yet is refused", async () => {
  const result = await verifyAccessJwt(await sign(claims({ nbf: NOW_SECONDS + 3600 })), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "not yet valid" });
});

test("a token signed by another key under a known key id is refused", async () => {
  const result = await verifyAccessJwt(await sign(claims(), { key: stranger.privateKey }), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "bad signature" });
});

test("a token whose claims were changed after signing is refused", async () => {
  const token = await sign(claims({ email: "intern@g1t.sh" }));
  const [header, , signature] = token.split(".");
  const forged = `${header}.${b64url(JSON.stringify(claims()))}.${signature}`;
  const result = await authorize(request(forged), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "bad signature" });
});

test("a token signed by a key the team does not publish is refused", async () => {
  const result = await verifyAccessJwt(await sign(claims(), { kid: "key-9" }), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "unknown signing key" });
});

test("alg none and HS256 are refused before any key is fetched", async () => {
  for (const alg of ["none", "HS256"]) {
    const result = await verifyAccessJwt(await sign(claims(), { alg }), SETTINGS, { fetcher, now: NOW });
    assert.deepEqual(result, { ok: false, reason: "unexpected algorithm" });
  }
  assert.deepEqual(fetches, []);
});

test("a valid token whose email is not staff is refused", async () => {
  const result = await authorize(request(await sign(claims({ email: "someone@example.com" }))), SETTINGS, {
    fetcher,
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: "not staff", email: "someone@example.com" });
});

test("a token with neither an email nor a client id is refused", async () => {
  const result = await authorize(request(await sign(claims({ email: undefined }))), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "token has no email" });
});

test("a listed service token is let in as its name at service.g1t.sh", async () => {
  const token = await sign(claims({ email: undefined, sub: "", common_name: CLIENT }));
  const result = await authorize(request(token), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: true, email: "claude@service.g1t.sh" });
});

test("a service token not listed is refused", async () => {
  const token = await sign(claims({ email: undefined, common_name: "ffffffffffffffffffffffffffffffff.access" }));
  const result = await authorize(request(token), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "service token not staff" });
});

test("a listed service token still needs a valid signature and audience", async () => {
  const forged = await sign(claims({ email: undefined, common_name: CLIENT }), { key: stranger.privateKey });
  assert.deepEqual(await authorize(request(forged), SETTINGS, { fetcher, now: NOW }), { ok: false, reason: "bad signature" });
  const elsewhere = await sign(claims({ email: undefined, common_name: CLIENT, aud: ["b".repeat(64)] }));
  assert.deepEqual(await authorize(request(elsewhere), SETTINGS, { fetcher, now: NOW }), { ok: false, reason: "wrong audience" });
});

test("an email wins over a client id on the same token", async () => {
  const token = await sign(claims({ email: "someone@example.com", common_name: CLIENT }));
  const result = await authorize(request(token), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "not staff", email: "someone@example.com" });
});

test("service tokens are read as client id to name, dropping malformed entries", () => {
  assert.deepEqual(
    parseServiceTokens(` ${CLIENT}=claude , short.access=x, abcdefabcdefabcdef.access=Bad Name, abcdefabcdefabcdef.access=`),
    new Map([[CLIENT, "claude"]]),
  );
  assert.deepEqual(parseServiceTokens(""), new Map());
});

test("staff emails match without regard to case", async () => {
  const result = await authorize(request(await sign(claims({ email: "Owner@G1T.sh" }))), SETTINGS, { fetcher, now: NOW });
  assert.deepEqual(result, { ok: true, email: "owner@g1t.sh" });
});

test("a request without a token is refused", async () => {
  assert.deepEqual(await authorize(request(), SETTINGS, { fetcher, now: NOW }), { ok: false, reason: "no Access token" });
});

test("garbage is refused", async () => {
  for (const token of ["", "a.b", "a.b.c.d", "!!.??.**", "e30.e30.e30"]) {
    const result = await verifyAccessJwt(token, SETTINGS, { fetcher, now: NOW });
    assert.equal(result.ok, false, token);
  }
});

test("the team's keys are fetched once and kept for a few minutes", async () => {
  await verifyAccessJwt(await sign(claims()), SETTINGS, { fetcher, now: NOW });
  await verifyAccessJwt(await sign(claims()), SETTINGS, { fetcher, now: NOW + 60_000 });
  assert.equal(fetches.length, 1);
  await verifyAccessJwt(await sign(claims()), SETTINGS, { fetcher, now: NOW + 10 * 60_000 });
  assert.equal(fetches.length, 2);
});

test("when the keys cannot be fetched, nothing is let in", async () => {
  const down = async () => new Response("no", { status: 503 });
  const result = await verifyAccessJwt(await sign(claims()), SETTINGS, { fetcher: down, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "unknown signing key" });
});

test("sudo is closed until every setting is given", () => {
  const full = { ACCESS_TEAM_DOMAIN: "https://g1t.cloudflareaccess.com/", ACCESS_AUD: AUD, STAFF_EMAILS: "A@g1t.sh, b@g1t.sh" };
  assert.deepEqual(readSettings(full), { teamDomain: TEAM, aud: AUD, staff: ["a@g1t.sh", "b@g1t.sh"], services: new Map() });
  assert.deepEqual(readSettings({ ...full, STAFF_SERVICE_TOKENS: `${CLIENT}=claude` })?.services, new Map([[CLIENT, "claude"]]));
  assert.equal(readSettings({ ...full, ACCESS_AUD: "" }), null);
  assert.equal(readSettings({ ...full, ACCESS_TEAM_DOMAIN: "" }), null);
  assert.equal(readSettings({ ...full, STAFF_EMAILS: " , " }), null);
  assert.equal(readSettings({ ...full, ACCESS_TEAM_DOMAIN: "evil.example.com" }), null);
  assert.equal(readSettings({}), null);
});

test("changes are only taken from sudo's own pages", () => {
  const post = (headers: Record<string, string>) => new Request("https://sudo.g1t.sh/x", { method: "POST", headers });
  assert.equal(isSameOrigin(post({ origin: "https://sudo.g1t.sh" })), true);
  assert.equal(isSameOrigin(post({ referer: "https://sudo.g1t.sh/accounts/x" })), true);
  assert.equal(isSameOrigin(post({ origin: "https://evil.example" })), false);
  assert.equal(isSameOrigin(post({ origin: "null" })), false);
  assert.equal(isSameOrigin(post({ referer: "https://sudo.g1t.sh.evil.example/" })), false);
  assert.equal(isSameOrigin(post({ origin: "https://sudo.g1t.sh", "sec-fetch-site": "cross-site" })), false);
  assert.equal(isSameOrigin(post({})), false);
});

test("everyone at a staff domain is staff, and nobody at a lookalike", () => {
  const staff = parseStaff("syntaqx@gmail.com, @g1t.sh");
  assert.deepEqual(staff, ["syntaqx@gmail.com", "@g1t.sh"]);
  assert.equal(isStaff("syntaqx@gmail.com", staff), true);
  assert.equal(isStaff("ada@g1t.sh", staff), true);
  assert.equal(isStaff("ada@xg1t.sh", staff), false);
  assert.equal(isStaff("ada@g1t.sh.evil.com", staff), false);
  assert.equal(isStaff("someone@gmail.com", staff), false);
  assert.equal(isStaff("@g1t.sh", staff), false);
  assert.equal(isStaff("a@b@g1t.sh", staff), false);
});
