import assert from "node:assert/strict";
import { test } from "node:test";

import { mayChangeComment } from "./comments.ts";

const ana = { id: "usr_1" };

test("its author edits and deletes their own comment", () => {
  const comment = { kind: "comment" as const, verdict: null, author: ana };
  assert.deepEqual(mayChangeComment(comment, "usr_1", false), { edit: true, delete: true });
  assert.deepEqual(mayChangeComment(comment, "usr_2", false), { edit: false, delete: false });
  assert.deepEqual(mayChangeComment(comment, null, true), { edit: false, delete: false });
});

test("a maintainer edits and deletes anyone's", () => {
  const comment = { kind: "comment" as const, verdict: null, author: ana };
  assert.deepEqual(mayChangeComment(comment, "usr_2", true), { edit: true, delete: true });
});

test("a review is edited but never deleted, and a note is never changed", () => {
  const review = { kind: "comment" as const, verdict: "approve" as const, author: ana };
  assert.deepEqual(mayChangeComment(review, "usr_1", true), { edit: true, delete: false });
  const note = { kind: "event" as const, verdict: null, author: ana };
  assert.deepEqual(mayChangeComment(note, "usr_1", true), { edit: false, delete: false });
});
