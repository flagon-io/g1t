import assert from "node:assert/strict";
import { test } from "node:test";

import type { FeatureState, LedgerEntry } from "@g1t/contracts";

import { planReturnNotice, prepaymentSettled } from "./billing-return.ts";

const plan = (on: boolean, status: "active" | "past_due" | null): FeatureState => ({
  plan: { feature: "plan", title: "g1t", monthlyCents: 2000, includes: [], overage: "" },
  subscription: status ? { feature: "plan", status, periodEnd: null, startedBy: "ada", startedAt: "2026-10-01T00:00:00Z" } : null,
  on,
});

test("a plan that is on says so", () => {
  assert.equal(planReturnNotice(plan(true, "active"), "subscribed"), "The g1t plan is on.");
});

test("a plan whose payment has not cleared says it is pending, never that it is on", () => {
  const notice = planReturnNotice(plan(false, null), "subscribed");
  assert.match(notice, /^Payment pending\. The g1t plan starts once the payment clears/);
  assert.match(planReturnNotice(null, "security_on"), /^Payment pending\. Security and quality starts/);
});

test("a failed payment points at Update payment method", () => {
  assert.match(planReturnNotice(plan(false, "past_due"), "subscribed"), /did not go through.*Update payment method/);
});

const topUp = (createdAt: string, amountMicros = 25_000_000): LedgerEntry => ({
  id: "l1",
  kind: "top_up",
  amountMicros,
  description: "Paid in advance",
  repo: null,
  number: null,
  task: null,
  model: null,
  billedTo: "workspace",
  createdBy: "ada",
  createdAt,
});

test("a prepayment is settled when the balance rose or it was just entered", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  assert.equal(prepaymentSettled(0, 25_000_000, null, now), true);
  assert.equal(prepaymentSettled(25_000_000, 25_000_000, [topUp("2026-10-13T11:55:00Z")], now), true);
});

test("a bank transfer still on its way is pending", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  assert.equal(prepaymentSettled(10, 10, [], now), false);
  assert.equal(prepaymentSettled(10, 10, [topUp("2026-10-01T00:00:00Z")], now), false);
  assert.equal(prepaymentSettled(null, 10, null, now), false);
});
