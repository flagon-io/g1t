import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTENT_SECURITY_POLICY, makeNonce, pagePolicy, secure } from "./guard.ts";

function directives(policy: string): Map<string, string> {
  return new Map(policy.split("; ").map((part) => [part.split(" ")[0]!, part]));
}

test("a page runs only sudo's own scripts, by its nonce", () => {
  const nonce = makeNonce();
  assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/);
  assert.notEqual(nonce, makeNonce());
  const page = directives(pagePolicy(nonce));
  assert.equal(page.get("script-src"), `script-src 'self' 'nonce-${nonce}'`);
  assert.equal(page.get("connect-src"), "connect-src 'self'");
  assert.doesNotMatch(pagePolicy(nonce), /unsafe-|strict-dynamic|https?:|\*/);
  // Everything else as strict as an answer that is not a page.
  const rest = directives(CONTENT_SECURITY_POLICY);
  for (const [name, value] of rest) if (name !== "script-src") assert.equal(page.get(name), value, name);
  assert.deepEqual(
    [...page.keys()].filter((name) => !rest.has(name)),
    ["connect-src"],
  );
});

test("an answer that is not a page runs nothing", () => {
  assert.equal(directives(CONTENT_SECURITY_POLICY).get("script-src"), "script-src 'none'");
  assert.equal(directives(CONTENT_SECURITY_POLICY).get("default-src"), "default-src 'none'");
});

test("a page keeps its own policy; anything else gets the strict one", () => {
  const nonce = makeNonce();
  const page = secure(new Response("<html></html>", { headers: { "content-security-policy": pagePolicy(nonce) } }));
  assert.equal(page.headers.get("content-security-policy"), pagePolicy(nonce));
  assert.equal(page.headers.get("cache-control"), "no-store");
  const data = secure(new Response("{}"));
  assert.equal(data.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
});
