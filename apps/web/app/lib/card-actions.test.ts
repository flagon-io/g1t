import assert from "node:assert/strict";
import { test } from "node:test";

import type { CardAction } from "@g1t/contracts";

import { cardChip, foldsBody, shownActions } from "./card-actions.ts";

test("a card shows only its links: nothing answers the rest any more", () => {
  const actions: CardAction[] = [
    { id: "file", label: "File issue" },
    { id: "open", label: "Open", href: "/acme/web/issues/1" },
  ];
  assert.deepEqual(shownActions({ actions }).map((a) => a.id), ["open"]);
  assert.deepEqual(shownActions({}), []);
});

test("a draft issue's chip says where it is", () => {
  assert.deepEqual(cardChip({ kind: "draft_work_item", state: "Draft" }), { tone: "accent", live: false, outline: true });
  assert.equal(cardChip({ kind: "draft_work_item", state: "Filed" })?.tone, "success");
  assert.equal(cardChip({ kind: "draft_work_item", state: "Discarded" })?.tone, "neutral");
  assert.equal(cardChip({ kind: "draft_work_item", state: "Something new" })?.tone, "neutral");
  assert.equal(cardChip({ kind: "draft_work_item", state: null }), null);
  assert.equal(cardChip({ kind: "pull", state: "Merged" }), null);
});

test("a long body starts folded", () => {
  assert.equal(foldsBody("one\ntwo\nthree"), false);
  assert.equal(foldsBody(Array.from({ length: 12 }, () => "line").join("\n")), true);
  assert.equal(foldsBody("x".repeat(900)), true);
});
