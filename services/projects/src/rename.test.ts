import { test } from "node:test";
import assert from "node:assert/strict";

import { renameStatements } from "./rename.ts";

test("each statement is bound with as many values as it asks for", () => {
  for (const { sql, params } of renameStatements(["acme", "acme-inc"], "acme-co")) {
    assert.equal(sql.split("?").length - 1, params.length, sql);
  }
});

test("only stale slugs move, to the current one", () => {
  const statements = renameStatements(["acme"], "acme-co");
  assert.ok(statements.length > 0);
  for (const { params } of statements) {
    assert.ok(params.at(-1) === "acme");
    assert.ok(!params.slice(0, -1).some((value) => value !== "acme-co"));
  }
  assert.deepEqual(renameStatements([], "acme-co"), []);
});
