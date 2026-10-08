import assert from "node:assert/strict";
import { test } from "node:test";

import { CHECKS, pageText, verdict } from "./smoke.mjs";

test("a page's text leaves out scripts, styles and tags", () => {
  const html = `<html><style>.a{}</style><script>var x="Request access"</script><h1>Have an&nbsp;<b>invite?</b></h1></html>`;
  assert.equal(pageText(html), "Have an invite?");
  assert.equal(pageText("<p>Don&#x27;t</p>"), "Don't");
});

test("a check passes on its status with every phrase on the page", () => {
  const check = { path: "/register", expect: ["Have an invite?", "Request access"] };
  assert.equal(verdict(check, 200, "<p>Have an invite?</p><button>Request access</button>"), null);
  assert.equal(verdict(check, 500, ""), "answered 500, expected 200");
  assert.equal(verdict(check, 200, "<p>Have an invite?</p>"), 'missing "Request access"');
});

test("a phrase only inside a script does not count", () => {
  const check = { path: "/", expect: ["Request access"] };
  assert.equal(verdict(check, 200, `<script>"Request access"</script>`), 'missing "Request access"');
});

test("the waitlist check sends an address identity refuses before writing", () => {
  const waitlist = CHECKS.find((check) => check.form);
  assert.ok(waitlist);
  assert.equal(waitlist.form.intent, "request-access");
  assert.ok(!waitlist.form.email.includes("@"), "never a real-looking address, so nothing is kept");
  assert.equal(waitlist.status, 422);
  assert.equal(verdict(waitlist, 422, "<p>Enter a valid email address.</p>"), null);
});
