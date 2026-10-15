import assert from "node:assert/strict";
import { test } from "node:test";

import { messageParts, parseCommitMessage } from "./commit-message.ts";

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

test("references split from the text around them", () => {
  assert.deepEqual(messageParts("Fix the login form. Closes #12"), [
    { kind: "text", text: "Fix the login form. Closes " },
    { kind: "ref", text: "#12", repo: null, number: 12 },
  ]);
  assert.deepEqual(messageParts("#3 and acme/web#4."), [
    { kind: "ref", text: "#3", repo: null, number: 3 },
    { kind: "text", text: " and " },
    { kind: "ref", text: "acme/web#4", repo: "acme/web", number: 4 },
    { kind: "text", text: "." },
  ]);
});

test("a full hash is a commit; a short one, a link's fragment or a word's # are text", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(messageParts(`closed this in ${sha}`), [
    { kind: "text", text: "closed this in " },
    { kind: "commit", text: sha, sha },
  ]);
  for (const text of ["see 0123abc", "https://example.com/page#12", "C#12 support", "issue#12", "##12"]) {
    assert.deepEqual(messageParts(text), [{ kind: "text", text }], text);
  }
  assert.deepEqual(messageParts(""), []);
});
