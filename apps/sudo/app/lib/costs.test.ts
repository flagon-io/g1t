import assert from "node:assert/strict";
import { test } from "node:test";

import type { CostDay, SpendCaps } from "@g1t/contracts";

import {
  daySeries,
  daysBetween,
  marginPercent,
  marginTone,
  parseBucket,
  parseCostSettings,
  parseMapping,
  parseRange,
  percentLabel,
  spendBanner,
  spendRows,
  unitDollars,
} from "./costs.ts";

const day = (d: string, bucket: string, cf: number, own: number, value: number, cash: number): CostDay => ({
  day: d,
  bucket,
  cfCostMicros: cf,
  ownCostMicros: own,
  valueMicros: value,
  cashMicros: cash,
});

test("every day of the range is there, even an empty one", () => {
  assert.deepEqual(daysBetween("2026-09-29", "2026-10-02"), ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  assert.deepEqual(daysBetween("2026-10-02", "2026-10-01"), []);
});

test("all of g1t is money in against every cost; a product is its value against its cost", () => {
  const rows = [
    day("2026-10-01", "sandboxes", 2_000_000, 1_900_000, 2_400_000, 1_000_000),
    day("2026-10-01", "platform", 500_000, 0, 20_000_000, 20_000_000),
    // Models: no Cloudflare bill, g1t's own cost.
    day("2026-10-01", "models", 0, 100_000, 120_000, 120_000),
  ];
  const all = daySeries(rows, "2026-10-01", "2026-10-02", null);
  assert.deepEqual(all, [
    { day: "2026-10-01", revenueMicros: 21_120_000, costMicros: 2_600_000 },
    { day: "2026-10-02", revenueMicros: 0, costMicros: 0 },
  ]);
  const sandboxes = daySeries(rows, "2026-10-01", "2026-10-01", "sandboxes");
  assert.deepEqual(sandboxes, [{ day: "2026-10-01", revenueMicros: 2_400_000, costMicros: 2_000_000 }]);
});

test("margins read against the floor", () => {
  assert.equal(marginPercent(1_200_000, 1_000_000)?.toFixed(2), "16.67");
  assert.equal(marginPercent(0, 10), null);
  assert.equal(marginTone(-3, 10), "danger");
  assert.equal(marginTone(12, 10), "warn");
  assert.equal(marginTone(16.7, 10), "mint");
  assert.equal(marginTone(null, 10), undefined);
  assert.equal(percentLabel(-4), "−4.0%");
  assert.equal(percentLabel(12.34, { signed: true }), "+12.3%");
  assert.equal(percentLabel(null), "—");
});

test("unit costs keep the places they need", () => {
  assert.equal(unitDollars(150_000), "$0.150");
  assert.equal(unitDollars(16.44), "$0.0000164");
  assert.equal(unitDollars(2_500_000), "$2.50");
  assert.equal(unitDollars(0), "$0");
});

test("the range and product come from the address, within bounds", () => {
  assert.equal(parseRange("7"), 7);
  assert.equal(parseRange("365"), 30);
  assert.equal(parseRange(null), 30);
  assert.equal(parseBucket("git", ["git", "sandboxes"]), "git");
  assert.equal(parseBucket("nope", ["git"]), null);
});

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};

test("the guardrails form is checked", () => {
  const good = parseCostSettings(
    form({
      autoApply: "on",
      autoApplyPercent: "25",
      noticeDays: "14",
      marginFloorPercent: "10",
      alertDays: "3",
      anomalyFactor: "1",
      minDailyCost: "0.10",
      anomalyFloor: "1",
    }),
  );
  assert.ok(good.ok);
  assert.equal(good.ok && good.value.minDailyCostMicros, 100_000);
  assert.equal(good.ok && good.value.autoApply, true);
  const off = parseCostSettings(form({ autoApplyPercent: "25", noticeDays: "14", marginFloorPercent: "10", alertDays: "3", anomalyFactor: "1", minDailyCost: "0", anomalyFloor: "1" }));
  assert.ok(off.ok && !off.value.autoApply);
  assert.equal(parseCostSettings(form({ autoApplyPercent: "250" })).ok, false);
  assert.equal(parseCostSettings(form({ autoApplyPercent: "25", noticeDays: "1.5" })).ok, false);
});

test("a mapping names Cloudflare's product and meter and one of g1t's products", () => {
  const mapped = parseMapping(form({ product: "Artifacts", meter: "", bucket: "git", priceMeter: "git_operations", ownMeter: "git_operations", scaleToOwn: "on", driftPercent: "15" }));
  assert.deepEqual(mapped, {
    ok: true,
    value: { product: "artifacts", meter: "*", bucket: "git", priceMeter: "git_operations", ownMeter: "git_operations", scaleToOwn: true, driftPercent: 15, note: "" },
  });
  assert.deepEqual(parseMapping(form({ product: "r2", meter: "class_a", remove: "1" })), { ok: true, value: { product: "r2", meter: "class_a", remove: true } });
  assert.equal(parseMapping(form({ product: "r2", meter: "x y", bucket: "git" })).ok, false);
  assert.equal(parseMapping(form({ product: "r2", meter: "*", bucket: "" })).ok, false);
  assert.equal(parseMapping(form({ product: "r2", meter: "*", bucket: "git", driftPercent: "-1" })).ok, false);
});

const caps = (over: Partial<SpendCaps> = {}): SpendCaps => ({
  day: "2026-10-06",
  month: "2026-10",
  todayMicros: 20_000_000,
  dailyCapMicros: 75_000_000,
  tripped: false,
  trippedAt: null,
  liftedBy: null,
  liftedAt: null,
  liftNote: null,
  monthBuckets: [
    { bucket: "comped", title: "Comped (g1t's own)", micros: 40_000_000 },
    { bucket: "trial", title: "Trial pool", micros: 5_000_000 },
  ],
  comped: [{ account: "ws_flagon-io", name: "flagon-io", usedMicros: 40_000_000, ceilingMicros: 150_000_000, defaultCeiling: true, level: 0 }],
  freeTierMicros: 1_000_000,
  fixedMonthlyMicros: 30_000_000,
  revenueMicros: 0,
  ...over,
});

test("the spend bar shows only when a cap stops work", () => {
  assert.equal(spendBanner(caps()), null);
  assert.ok((spendBanner(caps({ tripped: true, todayMicros: 80_000_000 })) ?? "").startsWith("The daily breaker is open ($80.00 of $75.00 today)"));
  const usedUp = caps({ comped: [{ account: "ws_flagon-io", name: "flagon-io", usedMicros: 150_000_000, ceilingMicros: 150_000_000, defaultCeiling: true, level: 100 }] });
  assert.ok((spendBanner(usedUp) ?? "").startsWith("Flagon-io used its $150.00 monthly budget"));
  // No budget set to zero is ever "used up".
  assert.equal(spendBanner(caps({ comped: [{ account: "a", name: "a", usedMicros: 9, ceilingMicros: 0, defaultCeiling: false, level: 0 }] })), null);
});

test("what g1t paid this month adds every bucket, the free tier and subscriptions", () => {
  const { rows, totalMicros } = spendRows(caps());
  assert.deepEqual(rows.map((r) => r.key), ["comped", "trial", "free", "fixed"]);
  assert.equal(totalMicros, 76_000_000);
});
