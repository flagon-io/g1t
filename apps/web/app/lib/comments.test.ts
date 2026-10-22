import assert from "node:assert/strict";
import { test } from "node:test";

import { interleave, mayChangeComment } from "./comments.ts";

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

test("an agent's comment is answered for by whoever it acted for; its review is never deleted", () => {
  const margo = { id: "agt_1" };
  const comment = { kind: "comment" as const, verdict: null, author: margo, actingFor: ana };
  assert.deepEqual(mayChangeComment(comment, "usr_1", false), { edit: true, delete: true });
  assert.deepEqual(mayChangeComment(comment, "agt_1", false), { edit: false, delete: false });
  const review = { ...comment, advisory: true };
  assert.deepEqual(mayChangeComment(review, "usr_1", false), { edit: true, delete: false });
});

test("a conversation interleaves its sessions and claims where each happened, oldest first", () => {
  const comments = [
    { id: "c1", createdAt: "2026-10-01T10:00:00Z" },
    { id: "c2", createdAt: "2026-10-01T12:00:00Z" },
  ];
  const extras = [
    { id: "late", at: "2026-10-02T09:00:00Z" },
    { id: "between", at: "2026-10-01T11:00:00Z" },
    { id: "first", at: "2026-10-01T09:00:00Z" },
    { id: "same", at: "2026-10-01T12:00:00Z" },
  ];
  const order = interleave(comments, extras).map((one) => (one.comment ? one.comment.id : one.extra.id));
  assert.deepEqual(order, ["first", "c1", "between", "same", "c2", "late"]);
  assert.deepEqual(
    interleave([], extras.slice(0, 1)).map((one) => one.extra?.id),
    ["late"],
  );
});
