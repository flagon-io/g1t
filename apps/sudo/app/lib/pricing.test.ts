import assert from "node:assert/strict";
import { test } from "node:test";

import {
  absorbedMicros,
  age,
  answerDueAt,
  givenLabel,
  givenParts,
  givenTotal,
  goodwillLine,
  goodwillNeedsReason,
  goodwillWarning,
  goodwillChoices,
  moneyApart,
  isFast,
  marginOfMonth,
  parseRequestStatus,
  ratioLabel,
  requestsHref,
  revenueOf,
  span,
  waiting,
} from "./pricing.ts";

test("the request filter is open unless another status is named", () => {
  assert.equal(parseRequestStatus(null), "open");
  assert.equal(parseRequestStatus("declined"), "declined");
  assert.equal(parseRequestStatus("all"), "all");
  assert.equal(parseRequestStatus("closed"), "open");
  assert.equal(requestsHref("open"), "/requests");
  assert.equal(requestsHref("approved"), "/requests?status=approved");
});

test("an answer is due one business day after the request", () => {
  // Tuesday → Wednesday, same time.
  assert.equal(answerDueAt("2026-10-06T15:00:00Z").toISOString(), "2026-10-07T15:00:00.000Z");
  // Friday → Monday, same time.
  assert.equal(answerDueAt("2026-10-09T15:00:00Z").toISOString(), "2026-10-12T15:00:00.000Z");
  // Saturday or Sunday → the end of Monday.
  assert.equal(answerDueAt("2026-10-10T09:00:00Z").toISOString(), "2026-10-12T23:59:59.000Z");
  assert.equal(answerDueAt("2026-10-11T23:00:00Z").toISOString(), "2026-10-12T23:59:59.000Z");
});

test("how long a request has waited, and whether it is overdue", () => {
  const asked = "2026-10-06T15:00:00Z";
  assert.deepEqual(
    { label: waiting(asked, new Date("2026-10-06T18:30:00Z")).label, overdue: waiting(asked, new Date("2026-10-06T18:30:00Z")).overdue },
    { label: "3 h", overdue: false },
  );
  const late = waiting(asked, new Date("2026-10-07T19:00:00Z"));
  assert.equal(late.label, "1 d 4 h");
  assert.equal(late.overdue, true);
  assert.equal(waiting("nonsense").label, "—");
  assert.equal(span(25 * 60_000), "25 min");
  assert.equal(span(48 * 3_600_000), "2 d");
});

test("a workspace's age in its largest whole unit", () => {
  const now = new Date("2026-10-05T00:00:00Z");
  assert.equal(age("2026-10-04T12:00:00Z", now), "less than a day");
  assert.equal(age("2026-09-23T00:00:00Z", now), "12 days");
  assert.equal(age("2026-01-05T00:00:00Z", now), "9 months");
  assert.equal(age("2023-10-05T00:00:00Z", now), "3 years");
  assert.equal(age(null, now), null);
});

test("goodwill: g1t absorbs only what is past its margin", () => {
  assert.equal(absorbedMicros(30_000_000, 8_000_000), 22_000_000);
  assert.equal(absorbedMicros(5_000_000, 8_000_000), 0);
  assert.equal(absorbedMicros(5_000_000, -1), 5_000_000);
});

test("goodwill needs a reason past the one-click credit, or a second time in 12 months", () => {
  const credit = 40_000_000;
  assert.equal(goodwillNeedsReason(null, credit, null), false);
  assert.equal(goodwillNeedsReason(40_000_000, credit, null), false);
  assert.equal(goodwillNeedsReason(20_000_000, credit, null), false);
  assert.equal(goodwillNeedsReason(40_000_001, credit, null), true);
  assert.equal(goodwillNeedsReason(null, credit, "2026-03-01T00:00:00Z"), true);
  assert.deepEqual(goodwillWarning(100_000_000, { creditMicros: credit, marginMicros: 8_000_000 }, null), {
    needsReason: true,
    absorbedMicros: 92_000_000,
    overCap: true,
  });
  assert.deepEqual(goodwillWarning(null, { creditMicros: credit, marginMicros: 8_000_000 }, null), {
    needsReason: false,
    absorbedMicros: 32_000_000,
    overCap: false,
  });
  // Past the cap only when what g1t absorbs is more than it.
  assert.equal(goodwillWarning(58_000_000, { creditMicros: credit, marginMicros: 8_000_000 }, null).overCap, false);
  assert.equal(goodwillWarning(58_000_001, { creditMicros: credit, marginMicros: 8_000_000 }, null).overCap, true);
  assert.equal(goodwillWarning(20_000_000, { creditMicros: credit, marginMicros: 8_000_000 }, null, 10_000_000).overCap, true);
  assert.deepEqual(goodwillChoices({ overageMicros: 100_000_000, creditMicros: credit }), [
    { label: "One-click credit", micros: null },
    { label: "The whole overage", micros: 100_000_000 },
  ]);
  assert.deepEqual(goodwillChoices({ overageMicros: 10_000_000, creditMicros: 10_000_000 }), [{ label: "One-click credit", micros: null }]);
  assert.equal(goodwillLine("2026-10-03"), "Credit from g1t: accidental usage on 2026-10-03");
});

test("velocity: five times the usual hour is fast", () => {
  assert.equal(isFast(5), true);
  assert.equal(isFast(4.99), false);
  assert.equal(isFast(Number.NaN), false);
  assert.equal(ratioLabel(7.24, 1_000_000), "7.2×");
  assert.equal(ratioLabel(12.6, 1_000_000), "13×");
  assert.equal(ratioLabel(0, 0), "new");
});

test("margin counts the plan's price and never what g1t gave", () => {
  const month = { chargedMicros: 300_000_000, plansMicros: 200_000_000, costMicros: 250_000_000, givenMicros: 90_000_000 };
  assert.equal(revenueOf(month), 500_000_000);
  assert.deepEqual(marginOfMonth(month), { micros: 250_000_000, percent: 50 });
  assert.deepEqual(marginOfMonth({ chargedMicros: 0, costMicros: 1_000_000 }), { micros: -1_000_000, percent: null });
});

test("given: labelled by source, totalled at price and at cost", () => {
  assert.equal(givenLabel({ source: "oss_pool", label: "" }), "Open-source pool");
  assert.equal(givenLabel({ source: "internal", label: "Internal (g1t's own)" }), "Internal (g1t's own)");
  assert.equal(givenLabel({ source: "new_thing", label: "" }), "new_thing");
  assert.deepEqual(
    givenTotal([
      { micros: 10_000_000, costMicros: 8_000_000 },
      { micros: 5_000_000, costMicros: 4_000_000 },
    ]),
    { micros: 15_000_000, costMicros: 12_000_000 },
  );
  assert.deepEqual(givenParts({ trialMicros: 1_000_000, ossMicros: 0 }), [{ label: "Trial", micros: 1_000_000 }]);
  assert.deepEqual(givenParts({}), []);
});

test("margin on what was sold leaves out the cost of what g1t gave", () => {
  const month = { chargedMicros: 120_000_000, plansMicros: 200_000_000, costMicros: 160_000_000 };
  assert.deepEqual(moneyApart(month, 60_000_000), {
    revenueMicros: 320_000_000,
    soldCostMicros: 100_000_000,
    marginMicros: 220_000_000,
    marginPercent: 69,
    netMicros: 160_000_000,
  });
  // Everything given, nothing sold: no margin percent, and net is the loss.
  assert.deepEqual(moneyApart({ chargedMicros: 0, costMicros: 5_000_000 }, 5_000_000), {
    revenueMicros: 0,
    soldCostMicros: 0,
    marginMicros: 0,
    marginPercent: null,
    netMicros: -5_000_000,
  });
});
