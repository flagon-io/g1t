import assert from "node:assert/strict";
import { test } from "node:test";

import { checkHandle } from "./handle.ts";

const handle = (value: unknown) => {
  const checked = checkHandle(value);
  return checked.ok ? checked.handle : null;
};

test("a handle is 2 to 32 lowercase letters, digits and single hyphens", () => {
  assert.equal(handle("ship"), "ship");
  assert.equal(handle("on-call-2"), "on-call-2");
  assert.equal(handle("ab"), "ab");
  assert.equal(handle("a".repeat(32)), "a".repeat(32));
  assert.equal(handle("a"), null, "too short");
  assert.equal(handle("a".repeat(33)), null, "too long");
  assert.equal(handle("-ship"), null, "no leading hyphen");
  assert.equal(handle("ship-"), null, "no trailing hyphen");
  assert.equal(handle("on--call"), null, "no doubled hyphen");
  assert.equal(handle("re_view"), null, "no underscores");
  assert.equal(handle("rev.iew"), null, "no dots");
  assert.equal(handle(42), null, "only text");
});

test("a handle is read the way people type it", () => {
  assert.equal(handle("  @Ship "), "ship", "trimmed, lowercased, the @ dropped");
});

test("g1t's own names and routes are reserved", () => {
  for (const name of ["g1t", "G1T", "g1t-agent", "settings", "admin", "inbox", "new", "templates", "runs", "fleet"]) {
    const checked = checkHandle(name);
    assert.equal(checked.ok, false, name);
    if (!checked.ok) assert.match(checked.message, /reserved/);
  }
});
