import assert from "node:assert/strict";
import { test } from "node:test";

import type { CostDay, PlatformGuard, SpendCaps } from "@g1t/contracts";

import {
  count,
  daySeries,
  daysBetween,
  marginOnPrice,
  marginPercent,
  marginTone,
  parseBucket,
  parseCostSettings,
  parseMapping,
  parsePauseLevel,
  pauseBanner,
  parseRange,
  percentLabel,
  proposalOutcome,
  spendBanner,
  spendRows,
  subscriptionsOver,
  thresholdShare,
  unitDollars,
  versionCells,
  whoPaid,
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

test("charged without real money is what it cost g1t, never its price", () => {
  const { rows } = spendRows(caps({ monthBuckets: [{ bucket: "unpaid", title: "Charged without real money", micros: 7_610_000 }] }));
  assert.match(rows[0]!.note, /what it cost g1t, not what was charged/);
});

test("margins are a share of the price: cost plus 20% is 16.7%", () => {
  assert.equal(percentLabel(marginOnPrice(20)), "16.7%");
  assert.equal(marginOnPrice(0), 0);
  // As By product showed it: $2.99 charged for models that cost $2.49.
  assert.equal(percentLabel(marginPercent(2_988_000, 2_490_000)), "16.7%");
});

test("who g1t paid is the statement's all-in cost, subscriptions included", () => {
  const subscriptions = subscriptionsOver(30_000_000, 30);
  const paid = whoPaid({ costMicros: 2_490_000, cloudflareCostMicros: 0, modelsCostMicros: 2_490_000 }, subscriptions);
  assert.deepEqual(paid, { totalMicros: 32_490_000, cloudflareMicros: 0, subscriptionsMicros: 30_000_000, modelsMicros: 2_490_000 });
  assert.equal(subscriptionsOver(30_000_000, 7), 7_000_000);
  // From older billing, Cloudflare's part is the rest.
  assert.equal(whoPaid({ costMicros: 3_000_000, modelsCostMicros: 1_000_000 }, 0).cloudflareMicros, 2_000_000);
});

test("a rate g1t sets shows no cost, and a weight is no money", () => {
  assert.deepEqual(versionCells({ costMicros: 250_000, priceMicros: 250_000, basis: "rate" }), {
    cost: "—",
    price: "$0.250",
    note: "g1t's own rate: no cost behind it",
  });
  assert.equal(versionCells({ costMicros: 100_000, priceMicros: 100_000, basis: "weight" }).price, "×0.1");
  assert.deepEqual(versionCells({ costMicros: 16.44, priceMicros: 19.73, basis: "cost" }), { cost: unitDollars(16.44), price: unitDollars(19.73), note: null });
  // Older billing sends no basis: a cost.
  assert.equal(versionCells({ costMicros: 1_000_000, priceMicros: 1_200_000 }).cost, "$1.00");
});

test("a rise replaced before its date says so, rather than missing its date", () => {
  assert.equal(
    proposalOutcome({ status: "superseded", decidedBy: "guardrail", effectiveAt: null }),
    "applied by guardrail, then replaced by a later measurement before it took effect; nothing was charged at it",
  );
  // From before billing marked them superseded.
  assert.match(proposalOutcome({ status: "applied", decidedBy: "guardrail", effectiveAt: null }) ?? "", /replaced by a later measurement/);
  assert.equal(proposalOutcome({ status: "applied", decidedBy: "guardrail", effectiveAt: "2026-10-22T04:18:12.571Z" }), "applied by guardrail");
  assert.equal(proposalOutcome({ status: "superseded", decidedBy: null, effectiveAt: null }), "replaced by a later measurement");
  assert.equal(proposalOutcome({ status: "open", decidedBy: null, effectiveAt: null }), null);
});

test("the pause banner names every paused level, and who paused it when it was not a person", () => {
  const level = (name: "compute" | "schedules" | "indexing" | "renders", paused: boolean, auto = false) => ({
    level: name,
    paused,
    note: null,
    set_by: null,
    set_at: null,
    auto,
  });
  const guard = (levels: ReturnType<typeof level>[]): PlatformGuard => ({
    levels,
    hour: null,
    last_hour: [],
    month: "2026-10",
    month_to_date: [],
    breaches: [],
    can_read: true,
    auto_pause: ["schedules", "indexing"],
  });
  assert.equal(pauseBanner(guard([level("compute", false), level("renders", false)])), null);
  assert.equal(pauseBanner(guard([level("schedules", true, true)])), "Paused across g1t: schedules (by the usage watcher).");
  assert.equal(
    pauseBanner(guard([level("compute", true), level("schedules", true), level("indexing", true, true)])),
    "Paused across g1t: compute, schedules and indexing (by the usage watcher).",
  );
  assert.equal(parsePauseLevel("renders"), "renders");
  assert.equal(parsePauseLevel("everything"), null);
  assert.equal(count(240_000), "240k");
  assert.equal(count(2_000_000_000), "2.0B");
  assert.equal(thresholdShare(240_000, 200_000), 120);
  assert.equal(thresholdShare(5, 0), null);
});
