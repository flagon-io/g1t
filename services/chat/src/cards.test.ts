import { test } from "node:test";
import assert from "node:assert/strict";

import { shownCard } from "./cards.ts";

test("an old card keeps its links and drops actions nobody answers any more", () => {
  const card = shownCard({
    kind: "session",
    title: "Fix the login",
    detail: null,
    state: "working",
    href: "/acme/web/pull/1",
    owner: "agents",
    ref: "ses_1",
    actions: [
      { id: "approve", label: "Approve more", style: "primary", confirm: null, input: null, href: null },
      { id: "open", label: "Open", style: "default", confirm: null, input: null, href: "/acme/web/pull/1" },
    ],
  });
  assert.equal(card.owner, undefined);
  assert.equal(card.ref, undefined);
  assert.deepEqual(
    card.actions?.map((a) => a.id),
    ["open"],
  );
});

test("g1t's card for a session started from its conversation keeps the session id the site follows", () => {
  const card = { kind: "session", title: "Why is CI slow?", detail: null, state: "Working", href: "/acme/-/chat/sessions/ses_01ab", ref: "ses_01ab" };
  assert.equal(shownCard(card).ref, "ses_01ab");
  assert.equal(shownCard({ ...card, owner: "agents" }).ref, undefined, "an old agent's card does not");
  assert.equal(shownCard({ ...card, href: "/acme/web/pull/1" }).ref, undefined, "nor one linked elsewhere");
});

test("a card with nothing left to press has no actions", () => {
  const card = shownCard({
    kind: "x",
    title: "x",
    detail: null,
    state: null,
    href: null,
    owner: "agents",
    actions: [{ id: "stop", label: "Stop", style: "danger", confirm: null, input: null, href: null }],
  });
  assert.equal("actions" in card, false);
  assert.deepEqual(shownCard({ kind: "x", title: "x", detail: null, state: null, href: null }), {
    kind: "x",
    title: "x",
    detail: null,
    state: null,
    href: null,
  });
});
