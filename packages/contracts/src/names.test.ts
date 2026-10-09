import assert from "node:assert/strict";
import { test } from "node:test";

import { USERNAME_PATTERN, canonicalUsername, isReservedName, isValidNamespace, isValidUsername, shownUsername } from "./names.ts";

test("usernames take letters of either case, digits and single hyphens, up to 39", () => {
  for (const good of ["ana", "Ana", "ANA-Lopez", "a", "A1", "x".repeat(39)]) assert.ok(isValidUsername(good), good);
  for (const bad of ["", "-Ana", "Ana-", "An--a", "An_a", "Ana.B", "Ana B", "x".repeat(40), "Ána"]) assert.ok(!isValidUsername(bad), bad);
});

test("reserved names are reserved in any case", () => {
  for (const name of ["G1T", "G1t-Agent", "Ghost", "Settings", "API"]) {
    assert.ok(isReservedName(name), name);
    assert.ok(!isValidUsername(name), name);
  }
});

test("a username is found lowercased and shown as written", () => {
  assert.equal(canonicalUsername(" Ana-Lopez "), "ana-lopez");
  assert.equal(shownUsername({ username: "ana", display_username: "Ana" }), "Ana");
  assert.equal(shownUsername({ username: "ana", displayUsername: "ANA" }), "ANA");
  assert.equal(shownUsername({ username: "ana" }), "ana");
  // A display form that is some other name is never shown.
  assert.equal(shownUsername({ username: "ana", display_username: "Bob" }), "ana");
  // Workspace slugs stay lowercase.
  assert.ok(!isValidNamespace("Acme"));
});

test("the form's pattern says what the rule says", () => {
  const pattern = new RegExp(`^(?:${USERNAME_PATTERN})$`);
  for (const name of ["Ana", "ana-lopez", "A1"]) assert.ok(pattern.test(name), name);
  for (const name of ["-ana", "ana-", "an--a", "an_a"]) assert.ok(!pattern.test(name), name);
});
