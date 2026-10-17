import assert from "node:assert/strict";
import { test } from "node:test";

import { ssoAddresses } from "@g1t/contracts/sso";

import { SSO_ERROR_COOKIE, afterSso, errorCookie, readErrorCookie, samlPath } from "./sso.ts";

test("only a workspace's SAML address is answered before React Router", () => {
  assert.equal(samlPath("/auth/sso/acme/saml"), "acme");
  assert.equal(samlPath("/auth/sso/Acme-Co/saml/"), "acme-co");
  assert.equal(samlPath("/auth/sso/acme/callback"), null);
  assert.equal(samlPath("/auth/sso/acme/saml/extra"), null);
  assert.equal(samlPath("/auth/sso/-acme/saml"), null);
  assert.equal(samlPath("/acme/-/sso"), null);
});

test("afterwards it goes on to the workspace, never off the site", () => {
  assert.equal(afterSso({ slug: "acme", next: "/" }), "/acme");
  assert.equal(afterSso({ slug: "acme", next: "/acme/-/sso" }), "/acme/-/sso");
  assert.equal(afterSso({ slug: "acme", next: "//evil.test" }), "/acme");
  assert.equal(afterSso({ slug: "acme", next: "https://evil.test/" }), "/acme");
});

test("why a SAML sign-in failed survives the trip in a cookie", () => {
  const set = errorCookie("The assertion is not for g1t; set the audience = x.");
  assert.match(set, /HttpOnly; Secure; SameSite=Lax; Max-Age=60/);
  const value = set.split(";")[0];
  assert.equal(readErrorCookie(`a=b; ${value}`), "The assertion is not for g1t; set the audience = x.");
  assert.equal(readErrorCookie(`${SSO_ERROR_COOKIE}=%E0%A4%A`), null);
  assert.equal(readErrorCookie(null), null);
});

test("a workspace's provider is pointed at its own addresses", () => {
  assert.deepEqual(ssoAddresses("https://g1t.sh/", "Acme"), {
    entityId: "https://g1t.sh/auth/sso/acme/metadata",
    metadataUrl: "https://g1t.sh/auth/sso/acme/metadata",
    acsUrl: "https://g1t.sh/auth/sso/acme/saml",
    callbackUrl: "https://g1t.sh/auth/sso/acme/callback",
  });
});
