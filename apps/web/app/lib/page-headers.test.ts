import assert from "node:assert/strict";
import { test } from "node:test";

import { makeNonce, pagePolicy, withSiteHeaders } from "./page-headers.ts";

test("a page runs only its own scripts and is never framed", () => {
  const nonce = makeNonce();
  assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/);
  assert.notEqual(nonce, makeNonce());
  const policy = pagePolicy(nonce);
  assert.ok(policy.includes(`script-src 'self' 'nonce-${nonce}'`));
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'self'/);
  // Pictures in a README come from anywhere on HTTPS.
  assert.match(policy, /img-src 'self' https: data: blob:/);
});

test("every answer gains nosniff and a referrer policy; pages are not framed", () => {
  const page = withSiteHeaders(new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }));
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const data = withSiteHeaders(new Response("{}", { headers: { "content-type": "application/json" } }));
  assert.equal(data.headers.get("x-content-type-options"), "nosniff");
  assert.equal(data.headers.get("x-frame-options"), null);

  // A redirect's headers are fixed; the answer is copied, status and all.
  const moved = withSiteHeaders(Response.redirect("https://docs.g1t.sh/", 301));
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get("location"), "https://docs.g1t.sh/");
  assert.equal(moved.headers.get("referrer-policy"), "strict-origin-when-cross-origin");

  const own = withSiteHeaders(new Response("", { headers: { "referrer-policy": "no-referrer" } }));
  assert.equal(own.headers.get("referrer-policy"), "no-referrer");
});
