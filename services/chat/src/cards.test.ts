import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanCard } from "./cards.ts";

test("a card needs a kind and a title", () => {
  assert.equal(cleanCard(null), null);
  assert.equal(cleanCard("card"), null);
  assert.equal(cleanCard({ kind: "session" }), null);
  assert.equal(cleanCard({ title: "Fix the login" }), null);
  assert.deepEqual(cleanCard({ kind: " session ", title: " Fix the login " }), {
    kind: "session",
    title: "Fix the login",
    detail: null,
    state: null,
    href: null,
  });
});

test("links stay on the site", () => {
  assert.equal(cleanCard({ kind: "pull", title: "x", href: "/acme/web/pull/1" })?.href, "/acme/web/pull/1");
  assert.equal(cleanCard({ kind: "pull", title: "x", href: "https://evil.example" })?.href, null);
  assert.equal(cleanCard({ kind: "pull", title: "x", href: "//evil.example" })?.href, null);
});

test("fields keep labelled values and drop the rest", () => {
  const card = cleanCard({
    kind: "draft_issue",
    title: "x",
    fields: [{ label: "Repository", value: "acme/web" }, { label: "Labels" }, { value: "orphan" }, "nope", null, { label: " ", value: "x" }],
  });
  assert.deepEqual(card?.fields, [{ label: "Repository", value: "acme/web" }]);
  assert.equal(cleanCard({ kind: "x", title: "x", fields: [] })?.fields, undefined);
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, value: "v" }));
  assert.equal(cleanCard({ kind: "x", title: "x", fields: many })?.fields?.length, 8);
});

test("actions keep valid ones, normalised, and drop invalid ones and outside links", () => {
  const card = cleanCard({
    kind: "session",
    title: "x",
    owner: "agents",
    ref: "ses_1",
    actions: [
      { id: "approve", label: "Approve more", style: "primary", input: { kind: "money", label: "Amount", initial: "2.00" } },
      { id: "stop", label: "Stop", style: "danger", confirm: "Stop this session?" },
      { id: "message", label: "Message", style: "loud", input: { kind: "voice", label: "x" } },
      { id: "Bad Id", label: "x" },
      { id: "nolabel" },
      { id: "open", label: "Open", href: "https://elsewhere.example" },
      "nope",
    ],
  });
  assert.equal(card?.owner, "agents");
  assert.equal(card?.ref, "ses_1");
  assert.deepEqual(card?.actions, [
    { id: "approve", label: "Approve more", style: "primary", confirm: null, input: { kind: "money", label: "Amount", placeholder: null, initial: "2.00" }, href: null },
    { id: "stop", label: "Stop", style: "danger", confirm: "Stop this session?", input: null, href: null },
    { id: "message", label: "Message", style: "default", confirm: null, input: null, href: null },
  ]);
});

test("without an owner only link actions are kept", () => {
  const card = cleanCard({
    kind: "pull",
    title: "x",
    owner: "github",
    actions: [
      { id: "merge", label: "Merge", style: "primary" },
      { id: "open", label: "Open", href: "/acme/web/pull/1" },
    ],
  });
  assert.equal(card?.owner, undefined);
  assert.equal(card?.ref, undefined);
  assert.deepEqual(card?.actions, [{ id: "open", label: "Open", style: "default", confirm: null, input: null, href: "/acme/web/pull/1" }]);
});

test("a card offers at most five actions", () => {
  const actions = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: `A${i}` }));
  assert.equal(cleanCard({ kind: "x", title: "x", owner: "agents", actions })?.actions?.length, 5);
});
