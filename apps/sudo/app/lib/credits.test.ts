import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIRM_OVER_MICROS, CREDIT_PRESETS, grantSummary, parseCreditAmount, parseCreditForm, parseExpiry, parseMonth, shortDay } from "./credits.ts";
import { usd } from "./money.ts";

const NOW = new Date("2026-10-07T12:00:00Z");

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

test("the presets are $10, $20, $25, $50 and $100, each one step", () => {
  assert.deepEqual([...CREDIT_PRESETS], [10, 20, 25, 50, 100]);
  for (const dollars of CREDIT_PRESETS) {
    assert.deepEqual(parseCreditAmount(String(dollars), ""), { ok: true, value: dollars * 1_000_000 });
    assert.ok(dollars * 1_000_000 <= CONFIRM_OVER_MICROS, "no preset needs the slug typed");
  }
  // Only the presets offered; anything else is Custom.
  assert.equal(parseCreditAmount("15", "").ok, false);
  assert.deepEqual(parseCreditAmount("custom", "$12.40"), { ok: true, value: 12_400_000 });
  assert.equal(parseCreditAmount("custom", "").ok, false);
  assert.equal(parseCreditAmount("custom", "0").ok, false);
  assert.equal(parseCreditAmount("custom", "10000.01").ok, false);
  assert.deepEqual(parseCreditAmount("custom", "10,000"), { ok: true, value: 10_000_000_000 });
});

test("an expiry is never, 30, 90 or 365 days, or the end of a chosen day", () => {
  assert.deepEqual(parseExpiry("none", "", NOW), { ok: true, value: null });
  assert.deepEqual(parseExpiry("", "", NOW), { ok: true, value: null });
  assert.deepEqual(parseExpiry("30", "", NOW), { ok: true, value: "2026-11-06T23:59:59Z" });
  assert.deepEqual(parseExpiry("90", "", NOW), { ok: true, value: "2027-01-05T23:59:59Z" });
  assert.deepEqual(parseExpiry("365", "", NOW), { ok: true, value: "2027-10-07T23:59:59Z" });
  assert.deepEqual(parseExpiry("date", "2027-01-05", NOW), { ok: true, value: "2027-01-05T23:59:59Z" });
  assert.equal(parseExpiry("date", "", NOW).ok, false);
  assert.equal(parseExpiry("date", "2026-10-01", NOW).ok, false);
  assert.equal(parseExpiry("date", "2040-01-01", NOW).ok, false);
  assert.equal(parseExpiry("7", "", NOW).ok, false);
});

test("a small credit is one step; over $100 the slug is typed out", () => {
  const small = parseCreditForm(form({ preset: "25", kind: "promotional", expires: "90", note: "Welcome to g1t" }), "acme", NOW);
  assert.deepEqual(small, {
    ok: true,
    value: { amountMicros: 25_000_000, kind: "promotional", expiresAt: "2027-01-05T23:59:59Z", refundFor: null, refundDay: null, note: "Welcome to g1t" },
  });
  // $100 is still one step.
  assert.ok(parseCreditForm(form({ preset: "100", kind: "goodwill", note: "Sorry" }), "acme", NOW).ok);
  const big = form({ preset: "custom", amount: "250", kind: "goodwill", note: "Sorry about the outage" });
  const refused = parseCreditForm(big, "acme", NOW);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /type the workspace's slug, acme/);
  big.set("confirmation", "acme");
  assert.equal(parseCreditForm(big, "acme", NOW).ok, true);
});

test("a credit needs a kind and a note", () => {
  assert.equal(parseCreditForm(form({ preset: "10", note: "x" }), "acme", NOW).ok, false);
  assert.equal(parseCreditForm(form({ preset: "10", kind: "gift", note: "x" }), "acme", NOW).ok, false);
  assert.equal(parseCreditForm(form({ preset: "10", kind: "goodwill" }), "acme", NOW).ok, false);
});

test("a refund says what it is for, never expires, and refunds a day that was", () => {
  const refund = parseCreditForm(
    form({ preset: "20", kind: "refund", refundFor: "the failed  runs on Oct 2", refundDay: "2026-10-02", expires: "30", note: "Sorry" }),
    "acme",
    NOW,
  );
  // The expiry chosen before switching to Refund is ignored.
  assert.deepEqual(refund, {
    ok: true,
    value: { amountMicros: 20_000_000, kind: "refund", expiresAt: null, refundFor: "the failed runs on Oct 2", refundDay: "2026-10-02", note: "Sorry" },
  });
  assert.equal(parseCreditForm(form({ preset: "20", kind: "refund", note: "Sorry" }), "acme", NOW).ok, false);
  assert.equal(parseCreditForm(form({ preset: "20", kind: "refund", refundFor: "x", refundDay: "2026-10-09", note: "Sorry" }), "acme", NOW).ok, false);
  assert.equal(parseCreditForm(form({ preset: "20", kind: "refund", refundFor: "x", refundDay: "2026-02-30", note: "Sorry" }), "acme", NOW).ok, false);
});

test("a grant reads in a line, as the Billing page says it", () => {
  const open = { amountMicros: 25_000_000, leftMicros: 12_400_000, expiresAt: "2027-01-05T23:59:59Z", state: "open" as const };
  assert.equal(grantSummary(open, usd, NOW), "$25.00 credit, $12.40 left, expires Jan 5, 2027");
  assert.equal(grantSummary({ ...open, expiresAt: "2026-11-05T23:59:59Z" }, usd, NOW), "$25.00 credit, $12.40 left, expires Nov 5");
  assert.equal(grantSummary({ ...open, expiresAt: null }, usd), "$25.00 credit, $12.40 left");
  assert.equal(grantSummary({ ...open, state: "used", leftMicros: 0 }, usd), "$25.00 credit, all used");
  assert.equal(grantSummary({ ...open, state: "expired", leftMicros: 0 }, usd), "$25.00 credit, expired");
  assert.equal(shortDay("2026-11-05T23:59:59Z", NOW), "Nov 5");
});

test("a month filter is a month", () => {
  assert.equal(parseMonth("2026-10"), "2026-10");
  assert.equal(parseMonth("2026-13"), null);
  assert.equal(parseMonth(null), null);
});
