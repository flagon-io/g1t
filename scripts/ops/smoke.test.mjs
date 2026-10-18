import assert from "node:assert/strict";
import { test } from "node:test";

import { CHECKS, pageText, verdict } from "./smoke.mjs";

test("a page's text leaves out scripts, styles and tags", () => {
  const html = `<html><style>.a{}</style><script>var x="Create account"</script><h1>Create your&nbsp;<b>account</b></h1></html>`;
  assert.equal(pageText(html), "Create your account");
  assert.equal(pageText("<p>Don&#x27;t</p>"), "Don't");
});

test("a check passes on its status with every phrase on the page", () => {
  const check = { path: "/register", expect: ["Create your account", "Create account"] };
  assert.equal(verdict(check, 200, "<h1>Create your account</h1><button>Create account</button>"), null);
  assert.equal(verdict(check, 500, ""), "answered 500, expected 200");
  assert.equal(verdict(check, 200, "<h1>Create your account</h1>"), 'missing "Create account"');
});

test("a phrase only inside a script does not count", () => {
  const check = { path: "/", expect: ["Create account"] };
  assert.equal(verdict(check, 200, `<script>"Create account"</script>`), 'missing "Create account"');
});

test("the sign-up check sends an address identity refuses before writing or counting", () => {
  const signUp = CHECKS.find((check) => check.form);
  assert.ok(signUp);
  assert.equal(signUp.path, "/register");
  assert.ok(!signUp.form.email.includes("@"), "never a real-looking address, so nothing is kept");
  assert.equal(signUp.status, 422);
  assert.ok(!("cf-turnstile-response" in signUp.form), "never answers the person check");
  // Turnstile off: identity refuses the address. On: the site refuses the form first.
  assert.equal(verdict(signUp, 422, "<p>Enter a valid email address.</p>"), null);
  assert.equal(
    verdict(signUp, 422, "<p>We could not tell that a person sent this form. Wait for the check above the button to finish, then try again.</p>"),
    null,
  );
  assert.match(verdict(signUp, 422, "<p>Something else</p>"), /missing one of/);
  assert.equal(verdict(signUp, 200, "<p>Enter a valid email address.</p>"), "answered 200, expected 422");
});
