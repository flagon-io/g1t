import assert from "node:assert/strict";
import { test } from "node:test";

import { agentStatus, budgetBlock, chargedMicros, costMicros, dayKey, monthKey, personBlock, personLimit, replyCapMicros, spendSpan, totalTokens } from "./budget.ts";

const OCT_8 = new Date("2026-10-08T15:00:00Z");
const none = { monthly_micros: null, daily_micros: null, task_micros: null };

test("spend rolls up by UTC month and day", () => {
  assert.equal(monthKey(OCT_8), "2026-10");
  assert.equal(dayKey(OCT_8), "2026-10-08");
  assert.equal(dayKey(new Date("2026-10-31T23:59:59Z")), "2026-10-31");
});

test("a breakdown's span: this month by default, last month whole, or the last 7 or 30 days", () => {
  assert.deepEqual(spendSpan(null, OCT_8), { span: "month", from: "2026-10-01", until: "2026-10-08", period: "2026-10" });
  assert.deepEqual(spendSpan("nonsense", OCT_8), spendSpan("month", OCT_8));
  assert.deepEqual(spendSpan("last_month", OCT_8), { span: "last_month", from: "2026-09-01", until: "2026-09-30", period: "2026-09" });
  assert.deepEqual(spendSpan("last_month", new Date("2026-01-15T00:00:00Z")), { span: "last_month", from: "2025-12-01", until: "2025-12-31", period: "2025-12" });
  assert.deepEqual(spendSpan("7d", OCT_8), { span: "7d", from: "2026-10-02", until: "2026-10-08", period: "2026-10" });
  assert.deepEqual(spendSpan("30d", OCT_8), { span: "30d", from: "2026-09-09", until: "2026-10-08", period: "2026-10" });
});

test("a person's own budget wins over the default; 0 of their own is no budget at all", () => {
  assert.equal(personLimit(null, null), null);
  assert.equal(personLimit(20_000_000, null), 20_000_000);
  assert.equal(personLimit(20_000_000, 50_000_000), 50_000_000);
  assert.equal(personLimit(20_000_000, 0), null);
  assert.equal(personLimit(0, null), null);
});

test("a person's budget blocks at 100%, naming them and where it is raised", () => {
  assert.equal(personBlock("ana", null, 9e9, OCT_8), null);
  assert.equal(personBlock("ana", 10_000_000, 9_999_999, OCT_8), null);
  assert.equal(
    personBlock("ana", 10_000_000, 10_000_000, OCT_8),
    "@ana has used their agent budget for October. An owner can raise it under Workspace → Spend.",
  );
});

test("no caps, no block; a cap of zero is no cap", () => {
  assert.equal(budgetBlock(none, { month: 9e9, day: 9e9 }, OCT_8), null);
  assert.equal(budgetBlock({ ...none, monthly_micros: 0 }, { month: 9e9, day: 0 }, OCT_8), null);
});

test("the monthly cap blocks at 100%, and says so in plain words", () => {
  const budget = { ...none, monthly_micros: 5_000_000 };
  assert.equal(budgetBlock(budget, { month: 4_999_999, day: 0 }, OCT_8), null);
  const blocked = budgetBlock(budget, { month: 5_000_000, day: 0 }, OCT_8);
  assert.equal(blocked?.cap, "month");
  assert.equal(blocked?.message, "I'm out of budget for October. An owner can raise my monthly limit on my profile.");
});

test("the daily cap blocks too, after the monthly one is checked", () => {
  const budget = { ...none, monthly_micros: 5_000_000, daily_micros: 1_000_000 };
  assert.equal(budgetBlock(budget, { month: 2_000_000, day: 1_000_000 }, OCT_8)?.cap, "day");
  assert.equal(budgetBlock(budget, { month: 5_000_000, day: 1_000_000 }, OCT_8)?.cap, "month");
});

test("a reply's cap is the lowest of what is left and the per-task and plan caps", () => {
  assert.equal(replyCapMicros(none, { month: 0, day: 0 }, null), null);
  assert.equal(replyCapMicros({ ...none, monthly_micros: 1_000_000 }, { month: 900_000, day: 0 }, null), 100_000);
  assert.equal(replyCapMicros({ ...none, monthly_micros: 1_000_000, task_micros: 50_000 }, { month: 0, day: 0 }, 2_000_000), 50_000);
  assert.equal(replyCapMicros(none, { month: 0, day: 0 }, 30_000), 30_000, "the plan's per-run cap");
  assert.equal(replyCapMicros({ ...none, daily_micros: 10 }, { month: 0, day: 50 }, null), 1, "never read as no cap");
});

test("cost is tokens at the provider's price per million, rounded up to a micro-dollar", () => {
  const price = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
  const tokens = { input: 2_000, output: 300, cacheRead: 1_000, cacheWrite: 0 };
  // 2000*0.1 + 300*0.5 + 1000*0.01 = 200 + 150 + 10
  assert.equal(costMicros(tokens, price), 360);
  assert.equal(costMicros(tokens, null), 0, "an unpriced model costs g1t nothing here");
  assert.equal(totalTokens(tokens), 3_300);
});

test("what a reply counts: the model with its margin on g1t's models, the agent rate always", () => {
  // $0.25 per million tokens is 250,000 micros per million.
  assert.equal(chargedMicros({ costMicros: 1_000, hosted: true, marginPercent: 0, ratePerMillionMicros: 250_000, tokens: 4_000 }), 2_000);
  assert.equal(chargedMicros({ costMicros: 1_000, hosted: true, marginPercent: 20, ratePerMillionMicros: 0, tokens: 4_000 }), 1_200);
  assert.equal(chargedMicros({ costMicros: 1_000, hosted: false, marginPercent: 20, ratePerMillionMicros: 250_000, tokens: 4_000 }), 1_000, "own provider: the agent rate only");
});

test("status: working while a reply is in flight, out of budget when capped, else idle", () => {
  const later = new Date(OCT_8.getTime() + 60_000).toISOString();
  const earlier = new Date(OCT_8.getTime() - 60_000).toISOString();
  assert.equal(agentStatus({ busyUntil: later, now: OCT_8, blocked: true }), "working");
  assert.equal(agentStatus({ busyUntil: earlier, now: OCT_8, blocked: false }), "idle", "a desk that died is not working forever");
  assert.equal(agentStatus({ busyUntil: null, now: OCT_8, blocked: true }), "out_of_budget");
});
