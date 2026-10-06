import { test } from "node:test";
import assert from "node:assert/strict";

import { moveStatements, slugOf, strandedQuery } from "./transfer.ts";

test("each statement is bound with as many values as it asks for", () => {
  for (const [stale, current] of [
    [["syntaqx/g1t"], "flagon-io/g1t"],
    [["flagon-io/g1t"], "flagon-io/forge"],
    [["syntaqx/g1t", "flagon-io/g1t"], "flagon-io/forge"],
  ] as const) {
    for (const { sql, params } of moveStatements([...stale], current, "rep_1")) {
      assert.equal(sql.split("?").length - 1, params.length, sql);
    }
  }
  const stranded = strandedQuery(["syntaqx/g1t"], "flagon-io/g1t", "rep_1")!;
  assert.equal(stranded.sql.split("?").length - 1, stranded.params.length);
});

test("projects move from the workspace the repository left to the one it is in", () => {
  const [move] = moveStatements(["syntaqx/g1t"], "flagon-io/g1t", "rep_1");
  assert.deepEqual(move!.params, ["flagon-io", "flagon-io", "rep_1", "syntaqx"]);
});

test("a delivery after the rows moved moves nothing but the path", () => {
  // Transferred back: only the workspace it is not in now moves.
  const statements = moveStatements(["flagon-io/g1t"], "syntaqx/g1t", "rep_1");
  assert.equal(statements.filter((s) => s.sql.startsWith("UPDATE OR IGNORE")).length, 1);
  assert.equal(strandedQuery([], "syntaqx/g1t", "rep_1"), null);
});

test("a transfer keeps every slug", () => {
  const statements = moveStatements(["syntaqx/g1t"], "flagon-io/g1t", "rep_1");
  assert.ok(!statements.some((s) => s.sql.includes("SET slug")));
  assert.ok(!statements.some((s) => s.sql.includes("SET name")));
});

test("renamed, the repository's own project takes the new name as its slug if it is free", () => {
  const statements = moveStatements(["flagon-io/g1t"], "flagon-io/Forge", "rep_1");
  const slug = statements.find((s) => s.sql.includes("SET slug"))!;
  assert.match(slug.sql, /^UPDATE OR IGNORE/);
  assert.match(slug.sql, /is_primary = 1/);
  assert.deepEqual(slug.params, ["forge", "rep_1", "flagon-io", "g1t"]);
  const name = statements.find((s) => s.sql.includes("SET name"))!;
  assert.deepEqual(name.params, ["Forge", "rep_1", "g1t"]);
  const path = statements.find((s) => s.sql.includes("repo_name"))!;
  assert.deepEqual(path.params, ["flagon-io", "Forge", "rep_1"]);
  // Nothing moves between workspaces.
  assert.equal(statements.filter((s) => s.sql.includes("SET workspace")).length, 0);
  assert.equal(strandedQuery(["flagon-io/g1t"], "flagon-io/Forge", "rep_1"), null);
});

test("a rename of letter case alone keeps the slug", () => {
  const statements = moveStatements(["flagon-io/forge"], "flagon-io/Forge", "rep_1");
  assert.ok(!statements.some((s) => s.sql.includes("SET slug")));
  assert.ok(statements.some((s) => s.sql.includes("SET name")));
});

test("names become slugs as projects spell them", () => {
  assert.equal(slugOf(" My App! "), "my-app");
  assert.equal(slugOf("g1t.sh"), "g1t.sh");
});
