import assert from "node:assert/strict";
import { test } from "node:test";

import {
  foldTasks,
  gigabytes,
  shownMeters,
  alertText,
  alertTone,
  cardCheckResult,
  creditLine,
  dollars,
  needsAttention,
  usageGlance,
  parseCaps,
  parseLimitRequest,
  parsePrepay,
  parseSpendLimit,
  planStatus,
  readDollars,
  requestStatus,
  share,
  spendPath,
  spendRange,
  wholeDollars,
} from "./billing.ts";

test("a credit from g1t reads in a line, with what is left and when it expires", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const grant = { amountMicros: 25_000_000, leftMicros: 12_400_000, expiresAt: "2027-01-05T23:59:59Z", state: "open" as const };
  assert.equal(creditLine(grant, now), "$25.00 credit, $12.40 left, expires Jan 5, 2027");
  assert.equal(creditLine({ ...grant, expiresAt: "2026-12-05T23:59:59Z" }, now), "$25.00 credit, $12.40 left, expires Dec 5");
  assert.equal(creditLine({ ...grant, expiresAt: null }, now), "$25.00 credit, $12.40 left");
  assert.equal(creditLine({ ...grant, state: "used", leftMicros: 0 }, now), "$25.00 credit, all used");
  assert.equal(creditLine({ ...grant, state: "revoked", leftMicros: 0 }, now), "$25.00 credit, withdrawn");
});

test("money reads as dollars", () => {
  assert.equal(dollars(9_500_000), "$9.50");
  assert.equal(dollars(-1_250_000), "−$1.25");
  assert.equal(wholeDollars(1_000_000_000), "$1,000");
  assert.equal(wholeDollars(100_000), "$0.10");
  assert.equal(readDollars("$1,000"), 1_000_000_000);
  assert.equal(readDollars(""), null);
  assert.equal(readDollars("lots"), null);
});

test("a prepayment is $25 or more, by card up to $10,000, by bank transfer from $1,000", () => {
  assert.deepEqual(parsePrepay({ amount: "100" }), { ok: true, value: { amountCents: 10_000, method: "card" } });
  assert.deepEqual(parsePrepay({ amount: "100", custom: "250" }), {
    ok: true,
    value: { amountCents: 25_000, method: "card" },
  });
  assert.equal(parsePrepay({ custom: "10" }).ok, false);
  assert.equal(parsePrepay({ custom: "20000" }).ok, false);
  assert.equal(parsePrepay({ custom: "500", method: "bank_transfer" }).ok, false);
  assert.deepEqual(parsePrepay({ custom: "20000", method: "bank_transfer" }), {
    ok: true,
    value: { amountCents: 2_000_000, method: "bank_transfer" },
  });
  assert.equal(parsePrepay({}).ok, false);
});

test("caps stay in range, and empty goes back to the default", () => {
  assert.deepEqual(parseCaps({ run: "", issue: "" }), { ok: true, value: { runCapMicros: null, issueCapMicros: null } });
  assert.deepEqual(parseCaps({ run: "0.10", issue: "1000" }), {
    ok: true,
    value: { runCapMicros: 100_000, issueCapMicros: 1_000_000_000 },
  });
  assert.equal(parseCaps({ run: "0.05" }).ok, false);
  assert.equal(parseCaps({ issue: "2000" }).ok, false);
  assert.equal(parseCaps({ run: "two" }).ok, false);
});

test("a limit request needs an amount, a reason and a monthly spend; an overage only a reason", () => {
  assert.deepEqual(parseLimitRequest({ kind: "limit", amount: "5000", reason: " A launch ", expected: "3000" }), {
    ok: true,
    value: { kind: "limit", amountMicros: 5_000_000_000, reason: "A launch", expectedMonthlyMicros: 3_000_000_000 },
  });
  assert.equal(parseLimitRequest({ kind: "limit", amount: "5000", reason: "" , expected: "1" }).ok, false);
  assert.equal(parseLimitRequest({ kind: "limit", reason: "x", expected: "1" }).ok, false);
  assert.deepEqual(parseLimitRequest({ kind: "overage", reason: "A loop ran all night" }), {
    ok: true,
    value: { kind: "overage", amountMicros: 0, reason: "A loop ran all night", expectedMonthlyMicros: 0 },
  });
});

test("a spend limit is automatic, fixed, the full amount available, or the one-time raise", () => {
  assert.deepEqual(parseSpendLimit({ mode: "automatic" }), { ok: true, value: { micros: null, useFull: false, raiseOnce: false } });
  assert.deepEqual(parseSpendLimit({ mode: "fixed", limit: "500" }), {
    ok: true,
    value: { micros: 500_000_000, useFull: false, raiseOnce: false },
  });
  assert.equal(parseSpendLimit({ mode: "fixed", limit: "0.5" }).ok, false);
  assert.deepEqual(parseSpendLimit({ mode: "full" }), { ok: true, value: { micros: null, useFull: true, raiseOnce: false } });
  assert.deepEqual(parseSpendLimit({ mode: "raise" }), { ok: true, value: { micros: null, useFull: false, raiseOnce: true } });
  assert.deepEqual(parseSpendLimit({ mode: "raise", limit: "150" }), {
    ok: true,
    value: { micros: 150_000_000, useFull: false, raiseOnce: true },
  });
});

test("the spend limit's range: up to the highest ceiling plus prepaid, then once to twice it, then ask", () => {
  // A first month at $100, nothing prepaid, the raise unused: $100 alone, $200 once.
  const range = spendRange({ availableMicros: 100_000_000, ceilingMicros: 100_000_000, raiseOnceMicros: 200_000_000, raisedAt: null });
  assert.deepEqual(range, { selfServeMicros: 100_000_000, raiseOnceMicros: 200_000_000, raisedAt: null });
  assert.equal(spendPath(80_000_000, range), "self");
  assert.equal(spendPath(100_000_000, range), "self");
  assert.equal(spendPath(150_000_000, range), "raise");
  assert.equal(spendPath(200_000_000, range), "raise");
  assert.equal(spendPath(200_000_001, range), "ask");
  // The raise used: only asking goes further.
  const used = spendRange({ availableMicros: 200_000_000, ceilingMicros: 200_000_000, raiseOnceMicros: null, raisedAt: "2026-10-01T00:00:00Z" });
  assert.equal(used.raiseOnceMicros, null);
  assert.equal(spendPath(300_000_000, used), "ask");
  // No ceiling: anything goes.
  assert.equal(spendPath(1e12, spendRange({ availableMicros: null, ceilingMicros: null, raiseOnceMicros: null })), "self");
  // A raise no higher than what is available is no raise.
  assert.equal(spendRange({ availableMicros: 300_000_000, ceilingMicros: 100_000_000, raiseOnceMicros: 300_000_000 }).raiseOnceMicros, null);
});

test("the plan card says where the workspace stands", () => {
  const free = { plan: "free" as const, trialMicrosLeft: 0, trialVerified: false, firstMonth: false };
  assert.deepEqual(planStatus(null, free), { kind: "free", label: "Free" });
  assert.equal(planStatus(null, { ...free, trialVerified: true, trialMicrosLeft: 5_000_000 }).kind, "trial");
  assert.equal(planStatus(null, { ...free, trialVerified: true }).kind, "free");
  const subscription = { feature: "plan" as const, status: "active" as const, periodEnd: null, startedBy: "a", startedAt: "" };
  assert.deepEqual(planStatus({ on: true, subscription }, { ...free, plan: "paid", firstMonth: true }), {
    kind: "paid",
    label: "On the g1t plan, first month",
  });
  assert.equal(planStatus({ on: true, subscription: { ...subscription, status: "canceling" } }, { ...free, plan: "paid" }).kind, "canceling");
  assert.equal(planStatus({ on: false, subscription: { ...subscription, status: "past_due" } }, free).kind, "past_due");
  assert.equal(planStatus({ on: true, included: true, subscription: null }, free).kind, "comped");
  assert.equal(planStatus(null, { ...free, plan: "internal" }).kind, "comped");
  assert.equal(planStatus(null, { ...free, plan: "enterprise" }).kind, "enterprise");
});

test("the overview's Usage card reads the month by what pays", () => {
  const usage = {
    free: false,
    spentMicros: 14_000_000,
    usedMicros: 11_000_000,
    byTask: [
      { key: "review", micros: 2_000_000, runs: 4 },
      { key: "implement", micros: 12_000_000, runs: 9 },
      { key: "plan", micros: 0, runs: 1 },
    ],
  };
  const entitlements = { includedMicros: 10_000_000, includedUsedMicros: 10_000_000, trialMicrosLeft: 0 };
  const plan = usageGlance({ usage, status: { kind: "paid", label: "" }, entitlements, limit: { spentMicros: 4_000_000, spendLimitMicros: 200_000_000 }, trialMicros: 5_000_000 });
  assert.equal(plan.kind, "plan");
  assert.deepEqual(plan.credit, { label: "Included usage", usedMicros: 10_000_000, ofMicros: 10_000_000 });
  assert.deepEqual(plan.onDemand, { micros: 4_000_000, limitMicros: 200_000_000 });
  // Most first, and nothing that cost nothing.
  assert.deepEqual(plan.lines.map((line) => line.label), ["Making changes", "Reviews"]);
  const trial = usageGlance({ usage, status: { kind: "trial", label: "" }, entitlements: { ...entitlements, trialMicrosLeft: 1_500_000 }, limit: null, trialMicros: 5_000_000 });
  assert.deepEqual(trial.credit, { label: "Trial credit", usedMicros: 3_500_000, ofMicros: 5_000_000 });
  assert.equal(trial.onDemand, null);
  assert.equal(usageGlance({ usage, status: { kind: "comped", label: "" }, entitlements, limit: null, trialMicros: 0 }).kind, "comped");
  assert.equal(usageGlance({ usage, status: { kind: "free", label: "" }, entitlements, limit: null, trialMicros: 0 }).kind, "forge");
  // While g1t charges nothing, usage is shown at cost.
  const beta = usageGlance({ usage: { ...usage, free: true }, status: { kind: "paid", label: "" }, entitlements, limit: null, trialMicros: 0 });
  assert.equal(beta.kind, "beta");
  assert.equal(beta.spentMicros, 11_000_000);
});

test("a meter's share stays between 0 and 1", () => {
  assert.equal(share(5, 10), 0.5);
  assert.equal(share(15, 10), 1);
  assert.equal(share(5, 0), 0);
  assert.equal(share(5, null), 0);
});

test("after a card check the owner reads whether the trial started", () => {
  assert.match(cardCheckResult({ trialVerified: true, trialMicrosLeft: 5_000_000 }, 5_000_000), /[$]5 trial is ready/);
  assert.match(cardCheckResult({ trialVerified: true, trialMicrosLeft: 0 }, 5_000_000), /Prepaid cards can still pay for the plan/);
  assert.match(cardCheckResult({ trialVerified: false, trialMicrosLeft: 0 }, 5_000_000), /did not finish/);
});

test("alerts read as sentences", () => {
  const alert = { meter: "included", level: 90, usedMicros: 9_000_000, limitMicros: 10_000_000, message: "" };
  assert.equal(alertText(alert), "90% of the plan's included usage: $9.00 of $10.00.");
  assert.equal(alertText({ ...alert, meter: "spend_limit", level: 100 }), "All of your spend limit: $9.00 of $10.00.");
  assert.equal(alertTone(50), "ok");
  assert.equal(alertTone(75), "warning");
  assert.equal(alertTone(100), "stopped");
});

test("a workspace needs attention when paused, on a spike, or at 90%", () => {
  assert.equal(needsAttention(null), false);
  assert.equal(needsAttention({ paused: null, spike: null, alerts: [] }), false);
  assert.equal(needsAttention({ paused: "Spend spike", spike: null, alerts: [] }), true);
  const spike = { id: "s", status: "continued", hourMicros: 1, averageMicros: 1, detectedAt: "" };
  assert.equal(needsAttention({ paused: null, spike, alerts: [] }), false);
  assert.equal(needsAttention({ paused: null, spike: { ...spike, status: "open" }, alerts: [] }), true);
  const at = (level: number) => ({ meter: "spend_limit", level, usedMicros: 0, limitMicros: 0, message: "" });
  assert.equal(needsAttention({ paused: null, spike: null, alerts: [at(75)] }), false);
  assert.equal(needsAttention({ paused: null, spike: null, alerts: [at(90)] }), true);
});

test("a request says where it stands", () => {
  const request = {
    id: "r",
    workspace: "acme",
    kind: "limit",
    amountMicros: 1,
    reason: "",
    expectedMonthlyMicros: 0,
    status: "open",
    createdBy: "a",
    createdAt: "",
  };
  assert.equal(requestStatus(request), "Waiting for an answer");
  assert.equal(requestStatus({ ...request, status: "approved", decidedMicros: 2_000_000_000 }), "Approved at $2,000");
  assert.equal(requestStatus({ ...request, status: "declined" }), "Declined");
});

const METERS = [
  { key: "agents", label: "Agents & sandboxes", micros: 1_200_000, quantity: "4 runs" },
  { key: "builds", label: "Builds", micros: 0, quantity: null },
  { key: "requests", label: "Requests & CPU", micros: 0, quantity: null },
  { key: "domains", label: "Custom domains", micros: 120_000, quantity: "1 custom domain" },
  { key: "git_storage", label: "Git operations & storage", micros: 0, quantity: "1,200 git operations" },
  { key: "search_scans", label: "Search & security scans", micros: 3_000, quantity: null },
];

test("the plan shows every meter, with no quota beside any of them", () => {
  const shown = shownMeters(METERS, true);
  assert.deepEqual(
    shown.map((m) => m.key),
    ["agents", "builds", "requests", "domains", "git_storage", "search_scans"],
  );
  for (const meter of shown) assert.ok(!/ of |apps up/i.test(`${meter.label} ${meter.quantity ?? ""}`));
});

test("a free workspace sees only what it can use, and anything it used anyway", () => {
  assert.deepEqual(
    shownMeters(METERS, false).map((m) => m.key),
    ["agents", "domains", "git_storage", "search_scans"],
  );
});

test("storage reads in powers of ten", () => {
  assert.equal(gigabytes(1_000_000_000), "1 GB");
  assert.equal(gigabytes(1_500_000_000), "1.5 GB");
  assert.equal(gigabytes(500_000_000), "500 MB");
});

test("kinds of work without words of their own are one Other, listed once and last", () => {
  const slices = [
    { key: "check", micros: 5, runs: 50 },
    { key: "review", micros: 3, runs: 5 },
    { key: "other", micros: 1, runs: 7 },
    { key: "implement", micros: 9, runs: 4 },
    { key: "answer", micros: 2, runs: 11 },
  ];
  assert.deepEqual(foldTasks(slices), [
    { key: "review", micros: 3, runs: 5 },
    { key: "implement", micros: 9, runs: 4 },
    { key: "other", micros: 8, runs: 68 },
  ]);
  assert.deepEqual(foldTasks([{ key: "plan", micros: 1, runs: 1 }]), [{ key: "plan", micros: 1, runs: 1 }]);
});
