import assert from "node:assert/strict";
import { test } from "node:test";

import { pagePolicy } from "./page-headers.ts";
import { TURNSTILE_SCRIPT, turnstilePassed, turnstileSettings } from "./turnstile.ts";

test("Turnstile is on only with both its site key and its secret", () => {
  assert.equal(turnstileSettings(undefined, undefined), null);
  assert.equal(turnstileSettings("0x4AAA", ""), null);
  assert.equal(turnstileSettings("", "0x4BBB"), null);
  assert.deepEqual(turnstileSettings(" 0x4AAA ", "0x4BBB"), { siteKey: "0x4AAA", secret: "0x4BBB" });
});

test("only Cloudflare's success counts as a pass", () => {
  assert.equal(turnstilePassed({ success: true }), true);
  assert.equal(turnstilePassed({ success: false, "error-codes": ["invalid-input-response"] }), false);
  assert.equal(turnstilePassed({ success: "true" }), false);
  assert.equal(turnstilePassed(null), false);
});

test("the page's policy lets the widget's script and frame load, and nothing else framed", () => {
  const policy = pagePolicy("n0nce");
  const origin = new URL(TURNSTILE_SCRIPT).origin;
  assert.match(policy, new RegExp(`script-src [^;]*${origin.replace(/\./g, "\\.")}`));
  assert.match(policy, new RegExp(`frame-src ${origin.replace(/\./g, "\\.")};`));
  assert.match(policy, /frame-ancestors 'none'/);
});
