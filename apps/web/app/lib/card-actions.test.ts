import assert from "node:assert/strict";
import { test } from "node:test";

import type { CardAction } from "@g1t/contracts";

import { actionMode, cardChip, foldsBody, inputValue, moneyInitial, moneyValue, shownActions, textValue } from "./card-actions.ts";

test("money reads as people type it", () => {
  assert.equal(moneyValue("5"), "5.00");
  assert.equal(moneyValue("$12.5"), "12.50");
  assert.equal(moneyValue(" $ 1,200.05 "), "1200.05");
  assert.equal(moneyValue(".5"), "0.50");
  assert.equal(moneyValue("3."), "3.00");
});

test("what is not an amount is not one", () => {
  for (const bad of ["", "  ", "0", "0.00", "-5", "5.001", "abc", "$", "1e3", "5 dollars", null, undefined]) {
    assert.equal(moneyValue(bad), null, String(bad));
  }
});

test("a money field starts with the suggestion, as an amount", () => {
  assert.equal(moneyInitial("4"), "4.00");
  assert.equal(moneyInitial("4.00"), "4.00");
  assert.equal(moneyInitial(null), "");
  assert.equal(moneyInitial("lots"), "");
});

test("text is trimmed and empty text is nothing", () => {
  assert.equal(textValue("  also check mobile \n"), "also check mobile");
  assert.equal(textValue(" \n "), null);
  assert.equal(textValue(undefined), null);
});

test("an input action sends its kind of value", () => {
  const money: CardAction = { id: "approve", label: "Approve more", input: { kind: "money", label: "New cap" } };
  const text: CardAction = { id: "steer", label: "Message", input: { kind: "text", label: "Tell it" } };
  assert.equal(inputValue(money, "$7"), "7.00");
  assert.equal(inputValue(money, "seven"), null);
  assert.equal(inputValue(text, " go "), "go");
  assert.equal(inputValue({ id: "stop", label: "Stop" }, "x"), null);
});

test("links open, the rest ask first, ask for a value, or run", () => {
  assert.equal(actionMode({ id: "open", label: "Open", href: "/acme/-/agents/s1" }), "link");
  // A link is a link even with a confirm or input on it.
  assert.equal(actionMode({ id: "open", label: "Open", href: "/x", confirm: "Sure?" }), "link");
  assert.equal(actionMode({ id: "stop", label: "Stop", confirm: "Stop it?" }), "confirm");
  assert.equal(actionMode({ id: "steer", label: "Message", input: { kind: "text", label: "Tell it" } }), "input");
  assert.equal(actionMode({ id: "file", label: "File issue" }), "run");
});

test("without an owner a card shows only its links", () => {
  const actions: CardAction[] = [
    { id: "file", label: "File issue" },
    { id: "open", label: "Open", href: "/acme/web/issues/1" },
  ];
  assert.deepEqual(shownActions({ actions, owner: null }).map((a) => a.id), ["open"]);
  assert.deepEqual(shownActions({ actions, owner: "agents" }).map((a) => a.id), ["file", "open"]);
  assert.deepEqual(shownActions({ owner: "agents" }), []);
});

test("a draft issue's chip says where it is", () => {
  assert.deepEqual(cardChip({ kind: "draft_issue", state: "Draft" }), { tone: "accent", live: false, outline: true });
  assert.equal(cardChip({ kind: "draft_issue", state: "Filed" })?.tone, "success");
  assert.equal(cardChip({ kind: "draft_issue", state: "Discarded" })?.tone, "neutral");
  assert.equal(cardChip({ kind: "draft_issue", state: "Something new" })?.tone, "neutral");
  assert.equal(cardChip({ kind: "draft_issue", state: null }), null);
  assert.equal(cardChip({ kind: "pull", state: "Merged" }), null);
});

test("a long body starts folded", () => {
  assert.equal(foldsBody("one\ntwo\nthree"), false);
  assert.equal(foldsBody(Array.from({ length: 12 }, () => "line").join("\n")), true);
  assert.equal(foldsBody("x".repeat(900)), true);
});
