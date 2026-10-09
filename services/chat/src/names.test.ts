import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_NAME, channelName, dmKey, dmMembers } from "./names.ts";

test("a channel name is kept lowercase, without #, spaces as dashes", () => {
  assert.deepEqual(channelName("General"), { ok: true, name: "general" });
  assert.deepEqual(channelName("  #g1t-core "), { ok: true, name: "g1t-core" });
  assert.deepEqual(channelName("release train"), { ok: true, name: "release-train" });
  assert.deepEqual(channelName("ops_2026"), { ok: true, name: "ops_2026" });
});

test("a channel name uses letters, digits, dashes and underscores, and is not too long", () => {
  assert.equal(channelName("").ok, false);
  assert.equal(channelName("#").ok, false);
  assert.equal(channelName("café").ok, false);
  assert.equal(channelName("a.b").ok, false);
  assert.equal(channelName("@here").ok, false);
  assert.equal(channelName("x".repeat(MAX_NAME)).ok, true);
  assert.equal(channelName("x".repeat(MAX_NAME + 1)).ok, false);
});

test("the site's chat routes are not channel names", () => {
  for (const name of ["dm", "browse", "live", "api", "new", "#New", " API "]) {
    assert.equal(channelName(name).ok, false, name);
  }
  assert.equal(channelName("news").ok, true);
  assert.equal(channelName("api-team").ok, true);
});

test("the same members always make the same direct-message key", () => {
  const a = dmKey(dmMembers("user:b", ["agent:z", "user:a"]));
  const b = dmKey(dmMembers("user:a", ["user:b", "agent:z", "user:b"]));
  assert.equal(a, b);
  assert.equal(a, "agent:z,user:a,user:b");
});

test("a direct message with nobody else, or only yourself, is notes to yourself", () => {
  assert.deepEqual(dmMembers("user:a", []), ["user:a"]);
  assert.deepEqual(dmMembers("user:a", ["user:a"]), ["user:a"]);
  assert.equal(dmKey(dmMembers("user:a", [])), "user:a");
  // Notes are not the same conversation as a direct message with someone.
  assert.notEqual(dmKey(dmMembers("user:a", [])), dmKey(dmMembers("user:a", ["user:b"])));
});
