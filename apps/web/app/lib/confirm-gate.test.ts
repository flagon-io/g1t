import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CONFIRM_PATH, afterConfirming, confirmGate, confirmedLine, openWhilePending, pageOf } from "./confirm-gate.ts";

const pending = { verified: false };
const confirmed = { verified: true };

test("a pending account is sent to confirm its address from every app page", () => {
  assert.equal(confirmGate("/", "", pending), CONFIRM_PATH);
  assert.equal(confirmGate("/acme", "", pending), `${CONFIRM_PATH}?next=%2Facme`);
  assert.equal(confirmGate("/workspaces/new", "?next=/x", pending), `${CONFIRM_PATH}?next=%2Fworkspaces%2Fnew%3Fnext%3D%252Fx`);
  assert.equal(confirmGate("/settings/tokens", "", pending), `${CONFIRM_PATH}?next=%2Fsettings%2Ftokens`);
  assert.equal(confirmGate("/invite/g1t-abcd", "", pending), `${CONFIRM_PATH}?next=%2Finvite%2Fg1t-abcd`);
  assert.equal(confirmGate("/acme/rocket/pulls", "?state=open", pending), `${CONFIRM_PATH}?next=%2Facme%2Frocket%2Fpulls%3Fstate%3Dopen`);
});

test("client navigations are gated as the page they load", () => {
  assert.equal(pageOf("/acme.data"), "/acme");
  assert.equal(pageOf("/_root.data"), "/");
  assert.equal(confirmGate("/acme/rocket.data", "?_routes=routes%2Frepo%2Flayout", pending), `${CONFIRM_PATH}?next=%2Facme%2Frocket`);
  assert.equal(confirmGate("/_root.data", "", pending), CONFIRM_PATH);
  assert.equal(confirmGate("/confirm-email.data", "", pending), null);
});

test("the pages confirming needs, and the public pages about g1t, stay open", () => {
  for (const path of [
    "/confirm-email",
    "/verify",
    "/logout",
    "/login",
    "/login/two-factor",
    "/register",
    "/forgot",
    "/reset",
    "/policies",
    "/policies/terms",
    "/security",
    "/support",
    "/status",
    "/pricing",
    "/auth/github/callback",
    "/.well-known/security.txt",
  ]) {
    assert.equal(openWhilePending(path), true, path);
    assert.equal(confirmGate(path, "", pending), null, path);
  }
  for (const path of ["/", "/explore", "/search", "/settings", "/settings/emails", "/device", "/oauth/authorize", "/new", "/inbox"]) {
    assert.equal(openWhilePending(path), false, path);
  }
});

test("confirmed accounts, visitors and non-people are never gated", () => {
  assert.equal(confirmGate("/acme", "", confirmed), null);
  assert.equal(confirmGate("/acme", "", null), null);
  assert.equal(confirmGate("/acme", "", { kind: "workspace", verified: false }), null);
  assert.equal(confirmGate("/acme", "", { kind: "user" }), `${CONFIRM_PATH}?next=%2Facme`);
});

test("what the page says once confirmed, and where it goes", () => {
  assert.equal(confirmedLine({}), "Your email address is confirmed.");
  assert.equal(confirmedLine({ joined: "acme" }), "Your email address is confirmed, and you have joined acme.");
  assert.match(confirmedLine({ inviteLapsed: "Your email address is confirmed. The invite … was revoked" }), /revoked/);
  assert.equal(afterConfirming("/", "acme"), "/acme");
  assert.equal(afterConfirming("/acme/rocket", "acme"), "/acme/rocket");
  assert.equal(afterConfirming("", null), "/");
});

test("confirming an account whose invite names a workspace goes on to accept or decline it", () => {
  assert.match(confirmedLine({ invitedTo: "flagon-io" }), /invited to join flagon-io: accept or decline/);
  assert.equal(afterConfirming("/flagon-io", null, "flagon-io"), "/invitations");
  assert.equal(afterConfirming("/", null, null), "/");
});

test("the code field is a one-time code typed with a number pad", () => {
  const page = readFileSync(new URL("../routes/confirm-email.tsx", import.meta.url), "utf8");
  const input = /<Input[\s\S]*?name="code"[\s\S]*?\/>/.exec(page)?.[0] ?? "";
  assert.match(input, /autoComplete="one-time-code"/);
  assert.match(input, /inputMode="numeric"/);
  assert.match(input, /pattern="\[0-9 -\]\*"/);
  // Either route: the page says the link in the email works too.
  assert.match(page, /link in the email/);
});
