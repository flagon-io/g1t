import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_ALIAS_NOTE, parseNewAlias, parseRemovalReason } from "./aliases.ts";

test("an alias, its workspace and why are read as identity takes them", () => {
  assert.deepEqual(parseNewAlias(" G1T ", " Flagon-IO ", " The product's name, for Flagon, Inc. "), {
    ok: true,
    value: { alias: "g1t", workspace: "flagon-io", note: "The product's name, for Flagon, Inc." },
  });
});

test("a malformed alias or workspace, or no reason, is refused before identity is asked", () => {
  for (const [alias, workspace, note] of [
    ["g--1t", "flagon-io", "x"],
    ["-g1t", "flagon-io", "x"],
    ["g1t_inc", "flagon-io", "x"],
    ["g1t", "", "x"],
    ["g1t", "flagon io", "x"],
    ["g1t", "flagon-io", "  "],
    ["flagon-io", "flagon-io", "x"],
    ["g1t", "flagon-io", "x".repeat(MAX_ALIAS_NOTE + 1)],
  ]) {
    assert.equal(parseNewAlias(alias!, workspace!, note!).ok, false, `${alias} ${workspace}`);
  }
});

test("removing an alias needs a reason", () => {
  assert.deepEqual(parseRemovalReason(" Flagon renamed the product "), { ok: true, value: "Flagon renamed the product" });
  assert.equal(parseRemovalReason("").ok, false);
  assert.equal(parseRemovalReason("x".repeat(MAX_ALIAS_NOTE + 1)).ok, false);
});
