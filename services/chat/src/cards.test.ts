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
