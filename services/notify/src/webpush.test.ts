import assert from "node:assert/strict";
import { test } from "node:test";

import { b64url, decrypt, encrypt, fromB64url, generateVapidKeys, sendPush, vapidAuthorization, vapidJwt } from "./webpush.ts";

// RFC 8291, Appendix A: the worked example, every input and the body.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("encryption reproduces RFC 8291's example byte for byte", async () => {
  const body = await encrypt(new TextEncoder().encode(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
    asPrivate: RFC.asPrivate,
    asPublic: RFC.asPublic,
    salt: fromB64url(RFC.salt),
  });
  assert.equal(b64url(body), RFC.body);
});

test("the example's body decrypts with the subscriber's key", async () => {
  const plain = await decrypt(fromB64url(RFC.body), { privateKey: RFC.uaPrivate, publicKey: RFC.uaPublic, auth: RFC.auth });
  assert.equal(new TextDecoder().decode(plain), RFC.plaintext);
});

test("a fresh key and salt each time, and it still round-trips", async () => {
  const message = new TextEncoder().encode(JSON.stringify({ title: "Ana", body: "ship it? ✨" }));
  const a = await encrypt(message, { p256dh: RFC.uaPublic, auth: RFC.auth });
  const b = await encrypt(message, { p256dh: RFC.uaPublic, auth: RFC.auth });
  assert.notEqual(b64url(a), b64url(b));
  // Header: 16 salt, record size 4096, a 65-byte key id.
  assert.equal(new DataView(a.buffer, a.byteOffset).getUint32(16), 4096);
  assert.equal(a[20], 65);
  assert.equal(a[21], 4);
  const plain = await decrypt(a, { privateKey: RFC.uaPrivate, publicKey: RFC.uaPublic, auth: RFC.auth });
  assert.deepEqual(plain, message);
});

test("too long a message for one record is refused", async () => {
  await assert.rejects(encrypt(new Uint8Array(4000), { p256dh: RFC.uaPublic, auth: RFC.auth }));
});

test("the VAPID JWT: ES256, the push service's origin, a 12-hour expiry, a subject, and a signature that verifies", async () => {
  const keys = await generateVapidKeys();
  assert.equal(fromB64url(keys.publicKey).length, 65);
  assert.equal(fromB64url(keys.privateKey).length, 32);
  const now = Date.UTC(2026, 9, 8, 12);
  const jwt = await vapidJwt("https://fcm.googleapis.com/fcm/send/abc:def", { ...keys, subject: "https://g1t.sh" }, now);
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(header))), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(claims))), {
    aud: "https://fcm.googleapis.com",
    exp: now / 1000 + 12 * 3600,
    sub: "https://g1t.sh",
  });
  // Raw r‖s, as JWS wants, not DER.
  assert.equal(fromB64url(signature).length, 64);
  const point = fromB64url(keys.publicKey);
  const verifier = await crypto.subtle.importKey("raw", point.slice().buffer as ArrayBuffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifier,
    fromB64url(signature).slice().buffer as ArrayBuffer,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  assert.ok(ok);
  const authorization = await vapidAuthorization("https://push.example/x", { ...keys, subject: "https://g1t.sh" }, now);
  assert.match(authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
});

test("a push is posted encrypted with its headers; 404 and 410 mean gone", async () => {
  const keys = await generateVapidKeys();
  const seen: { url: string; init: RequestInit }[] = [];
  const status = { value: 201 };
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(null, { status: status.value });
  }) as unknown as typeof fetch;
  const subscription = { endpoint: "https://push.example/sub/1", p256dh: RFC.uaPublic, auth: RFC.auth };
  const sent = await sendPush(subscription, { title: "hi" }, { vapid: { ...keys, subject: "https://g1t.sh" }, urgency: "high", topic: "chat:chn_1/x" }, fetcher);
  assert.deepEqual(sent, { endpoint: subscription.endpoint, status: 201, gone: false });
  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(headers["content-encoding"], "aes128gcm");
  assert.equal(headers.urgency, "high");
  assert.equal(headers.topic, "chatchn_1x");
  assert.equal(headers.ttl, "86400");
  const body = new Uint8Array(seen[0].init.body as ArrayBuffer);
  const plain = await decrypt(body, { privateKey: RFC.uaPrivate, publicKey: RFC.uaPublic, auth: RFC.auth });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), { title: "hi" });
  for (const code of [404, 410]) {
    status.value = code;
    assert.equal((await sendPush(subscription, {}, { vapid: { ...keys, subject: "https://g1t.sh" } }, fetcher)).gone, true);
  }
  status.value = 429;
  assert.equal((await sendPush(subscription, {}, { vapid: { ...keys, subject: "https://g1t.sh" } }, fetcher)).gone, false);
});
