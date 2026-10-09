#!/usr/bin/env node
// A new VAPID key pair for browser push (services/notify). Stores nothing.
//
//   node scripts/ops/vapid-keys.mjs
//     prints both halves, base64url, for you to put where they go.
//
//   node scripts/ops/vapid-keys.mjs --pipe | (cd services/notify && npx wrangler secret put VAPID_PRIVATE_KEY)
//     writes only the private half to stdout, straight into the secret,
//     and the public half to stderr, for VAPID_PUBLIC_KEY in
//     services/notify/wrangler.jsonc. The private half never touches disk.
//
// A new pair invalidates every browser subscribed with the old one: they
// subscribe again the next time the person opens g1t with notifications on.
import { webcrypto } from "node:crypto";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = b64url(new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey)));
const privateKey = (await webcrypto.subtle.exportKey("jwk", pair.privateKey)).d;

if (process.argv.includes("--pipe")) {
  process.stderr.write(`VAPID_PUBLIC_KEY=${publicKey}\n`);
  process.stdout.write(privateKey);
} else {
  console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
  console.log("\nThe private half is a secret: npx wrangler secret put VAPID_PRIVATE_KEY (in services/notify). Keep it nowhere else.");
}
