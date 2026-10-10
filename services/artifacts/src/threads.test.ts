import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { applyThreadAction, bodyMentions, bodyText, listThreads } from "./threads.ts";

const body = (text: string, mention?: { kind: string; id: string; name: string }) => [
  {
    type: "paragraph",
    content: [{ type: "text", text, styles: {} }, ...(mention ? [{ type: "mention", props: mention }] : [])],
    children: [],
  },
];

test("threads are kept in the shape the editor reads", () => {
  const doc = new Y.Doc();
  const made = applyThreadAction(doc, "user:u1", "comment", { op: "create", body: body("Is this right? ", { kind: "user", id: "u2", name: "bo" }) }, 1000);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  assert.deepEqual(made.mentions, ["user:u2"]);
  const thread = doc.getMap<Y.Map<unknown>>("threads").get(made.thread_id!)!;
  assert.equal(thread.get("resolved"), false);
  const comment = (thread.get("comments") as Y.Array<Y.Map<unknown>>).get(0);
  assert.equal(comment.get("userId"), "user:u1");
  assert.equal(comment.get("createdAt"), 1000);
  assert.ok(comment.get("reactionsByUser") instanceof Y.Map);
});

test("viewers can't comment; only authors edit; editors delete others' comments and threads", () => {
  const doc = new Y.Doc();
  assert.equal(applyThreadAction(doc, "user:u1", "view", { op: "create", body: body("x") }).ok, false);
  const made = applyThreadAction(doc, "user:u1", "comment", { op: "create", body: body("x") });
  assert.ok(made.ok);
  const threadId = made.ok ? made.thread_id! : "";
  const commentId = String(((doc.getMap<Y.Map<unknown>>("threads").get(threadId)!.get("comments") as Y.Array<Y.Map<unknown>>).get(0)).get("id"));
  assert.equal(applyThreadAction(doc, "user:u2", "edit", { op: "edit_comment", thread_id: threadId, comment_id: commentId, body: body("y") }).ok, false);
  assert.equal(applyThreadAction(doc, "user:u1", "comment", { op: "edit_comment", thread_id: threadId, comment_id: commentId, body: body("y") }).ok, true);
  assert.equal(applyThreadAction(doc, "user:u2", "comment", { op: "delete_comment", thread_id: threadId, comment_id: commentId }).ok, false);
  assert.equal(applyThreadAction(doc, "user:u2", "comment", { op: "delete_thread", thread_id: threadId }).ok, false);
  assert.equal(applyThreadAction(doc, "user:u2", "edit", { op: "delete_thread", thread_id: threadId }).ok, true);
  assert.equal(doc.getMap("threads").size, 0);
});

test("replies, resolving and reactions", () => {
  const doc = new Y.Doc();
  const made = applyThreadAction(doc, "user:u1", "comment", { op: "create", body: body("first"), page_level: true });
  const threadId = made.ok ? made.thread_id! : "";
  const reply = applyThreadAction(doc, "agent:a1", "comment", { op: "comment", thread_id: threadId, body: body("an answer") });
  assert.ok(reply.ok);
  const replyId = reply.ok ? String((reply.value as { id: string }).id) : "";
  applyThreadAction(doc, "user:u2", "comment", { op: "react", thread_id: threadId, comment_id: replyId, emoji: "👍" });
  applyThreadAction(doc, "user:u2", "comment", { op: "react", thread_id: threadId, comment_id: replyId, emoji: "👍" });
  applyThreadAction(doc, "user:u1", "comment", { op: "resolve", thread_id: threadId });
  const [listed] = listThreads(doc);
  assert.equal(listed!.resolved, true);
  assert.equal(listed!.quote, null);
  assert.deepEqual(
    listed!.comments.map((c) => [c.author, c.text]),
    [
      ["user:u1", "first"],
      ["agent:a1", "an answer"],
    ],
  );
  const reactions = ((doc.getMap<Y.Map<unknown>>("threads").get(threadId)!.get("comments") as Y.Array<Y.Map<unknown>>).get(1).get("reactionsByUser") as Y.Map<unknown>);
  assert.equal(reactions.size, 1);
});

test("a comment's text and mentions come from its blocks", () => {
  assert.equal(bodyText(body("hi ", { kind: "agent", id: "a1", name: "inky" })), "hi @inky");
  assert.deepEqual(bodyMentions(body("x", { kind: "page", id: "p", name: "Plan" })), []);
});
