import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCommitMessage } from "./commit-message.ts";

test("co-authors leave the body and keep only their names", () => {
  const parsed = parseCommitMessage(
    "Document every option\n\nAdds the missing rows.\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>",
  );
  assert.equal(parsed.subject, "Document every option");
  assert.equal(parsed.body, "Adds the missing rows.");
  assert.deepEqual(parsed.coAuthors, ["Claude Sonnet 5.5"]);
  assert.deepEqual(parsed.trailers, []);
});

test("a message that is only trailers has no body", () => {
  const parsed = parseCommitMessage("Fix it\n\nCo-Authored-By: Ada <ada@example.com>\nG1t-Pull: syntaqx/hello#72");
  assert.equal(parsed.body, "");
  assert.deepEqual(parsed.coAuthors, ["Ada"]);
  assert.deepEqual(parsed.trailers, [{ key: "G1t-Pull", value: "syntaqx/hello#72" }]);
});

test("a trailer shows its name, never an address", () => {
  const parsed = parseCommitMessage("Fix it\n\nSigned-off-by: Ada <ada@private.example>\nReviewed-by: <sam@x.io>");
  assert.deepEqual(parsed.trailers, [{ key: "Signed-off-by", value: "Ada" }]);
});

test("prose that happens to contain a colon stays prose", () => {
  const parsed = parseCommitMessage("Fix it\n\nNote: this also renames a function.\nAnd tidies the tests.");
  assert.equal(parsed.body, "Note: this also renames a function.\nAnd tidies the tests.");
  assert.deepEqual(parsed.coAuthors, []);
});
