/**
 * Web Push, with nothing but WebCrypto: VAPID (RFC 8292), an ES256 JWT
 * that tells the push service who is sending, and the message encrypted
 * for the browser that subscribed (RFC 8291, the `aes128gcm` content
 * coding of RFC 8188). One record, padded to nothing.
 *
 * Keys travel base64url-encoded as browsers give them: a public key is the
 * 65-byte uncompressed P-256 point, a private key its 32-byte scalar.
 */

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A copy as a plain ArrayBuffer, which every WebCrypto call takes. */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A P-256 private key from its scalar and public point, for `usage`. */
export async function importPrivateKey(privateB64: string, publicB64: string, usage: "sign" | "ecdh"): Promise<CryptoKey> {
  const point = fromB64url(publicB64);
  if (point.length !== 65 || point[0] !== 4) throw new Error("A P-256 public key is 65 bytes, starting 0x04.");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: privateB64,
    x: b64url(point.slice(1, 33)),
    y: b64url(point.slice(33, 65)),
    ext: true,
  };
  return usage === "sign"
    ? crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
    : crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

export type Vapid = { publicKey: string; privateKey: string; subject: string };

/**
 * The VAPID JWT for a push service: `aud` its origin, `exp` at most a day
 * off (12 hours here), `sub` how to reach the sender. Signed ES256, whose
 * signature is the raw r‖s WebCrypto gives.
 */
export async function vapidJwt(endpoint: string, vapid: Vapid, now = Date.now()): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })),
  );
  const key = await importPrivateKey(vapid.privateKey, vapid.publicKey, "sign");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(new Uint8Array(signature))}`;
}

/** The `Authorization` header a push carries. */
export async function vapidAuthorization(endpoint: string, vapid: Vapid, now = Date.now()): Promise<string> {
  return `vapid t=${await vapidJwt(endpoint, vapid, now)}, k=${vapid.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) }, key, bytes * 8);
  return new Uint8Array(bits);
}

/** The content key and nonce of RFC 8291 §3.4, from both sides' keys and the auth secret. */
async function keys(input: { ecdhSecret: Uint8Array; auth: Uint8Array; uaPublic: Uint8Array; asPublic: Uint8Array; salt: Uint8Array }) {
  const keyInfo = concat(enc.encode("WebPush: info\0"), input.uaPublic, input.asPublic);
  const ikm = await hkdf(input.auth, input.ecdhSecret, keyInfo, 32);
  const cek = await hkdf(input.salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(input.salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  return { cek, nonce };
}

/** The record size written in the header: one record holds the whole message. */
const RECORD_SIZE = 4096;

/** Sender's own key pair and salt, given only by tests to reproduce a known vector. */
export type Fixed = { asPrivate: string; asPublic: string; salt: Uint8Array };

/**
 * `plaintext` encrypted for a subscription's `p256dh` and `auth`, as the
 * body of a push: salt (16) ‖ record size (4) ‖ key id length (1) ‖ the
 * sender's public key (65) ‖ the one record.
 */
export async function encrypt(plaintext: Uint8Array, subscription: { p256dh: string; auth: string }, fixed?: Fixed): Promise<Uint8Array> {
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error("A push holds at most about 3,990 bytes.");
  const uaPublic = fromB64url(subscription.p256dh);
  const auth = fromB64url(subscription.auth);
  let asPrivateKey: CryptoKey;
  let asPublic: Uint8Array;
  if (fixed) {
    asPrivateKey = await importPrivateKey(fixed.asPrivate, fixed.asPublic, "ecdh");
    asPublic = fromB64url(fixed.asPublic);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivateKey = pair.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey("raw", buf(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asPrivateKey, 256));
  const { cek, nonce } = await keys({ ecdhSecret, auth, uaPublic, asPublic, salt });
  const aes = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["encrypt"]);
  // The last (and only) record ends with the delimiter 0x02.
  const record = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, aes, buf(concat(plaintext, new Uint8Array([2])))),
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, record);
}

/** The other way, as a browser does it: for tests, with the subscriber's private key. */
export async function decrypt(body: Uint8Array, subscriber: { privateKey: string; publicKey: string; auth: string }): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idLength = body[20];
  const asPublic = body.slice(21, 21 + idLength);
  const record = body.slice(21 + idLength);
  const uaPrivate = await importPrivateKey(subscriber.privateKey, subscriber.publicKey, "ecdh");
  const asKey = await crypto.subtle.importKey("raw", buf(asPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, uaPrivate, 256));
  const { cek, nonce } = await keys({ ecdhSecret, auth: fromB64url(subscriber.auth), uaPublic: fromB64url(subscriber.publicKey), asPublic, salt });
  const aes = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(nonce) }, aes, buf(record)));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error("Not the last record.");
  return padded.slice(0, end);
}

export type PushResult = { endpoint: string; status: number; gone: boolean };

/**
 * Sends one push. A 404 or 410 means the subscription is gone for good:
 * the caller drops it. `topic` lets a newer push replace one still waiting
 * (at most 32 URL-safe characters).
 */
export async function sendPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: object,
  options: { vapid: Vapid; ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string },
  fetcher: typeof fetch = fetch,
): Promise<PushResult> {
  const body = await encrypt(enc.encode(JSON.stringify(payload)), subscription);
  const headers: Record<string, string> = {
    authorization: await vapidAuthorization(subscription.endpoint, options.vapid),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(options.ttl ?? 24 * 3600),
    urgency: options.urgency ?? "normal",
  };
  const topic = options.topic?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  if (topic) headers.topic = topic;
  const response = await fetcher(subscription.endpoint, { method: "POST", headers, body: buf(body) });
  return { endpoint: subscription.endpoint, status: response.status, gone: response.status === 404 || response.status === 410 };
}

/** A new VAPID key pair, base64url: what scripts/ops/vapid-keys.mjs prints. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { publicKey: b64url(raw), privateKey: jwk.d! };
}
