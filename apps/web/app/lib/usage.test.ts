import assert from "node:assert/strict";
import { test } from "node:test";

import { money } from "./money.ts";
import { monthSpan, spanFor } from "./spend.ts";
import { byProject, columns, defaultGrain, isStaff, pendingSentence, quantity, receipt, resolveRange, ticks, usageCsv } from "./usage.ts";

const axisMoney = (micros: number) => money(micros, { compact: true });

const NOW = new Date("2026-10-08T15:00:00Z");

test("periods resolve to whole UTC days, both ends included", () => {
  assert.deepEqual(resolveRange(null, {}, NOW), { period: "cycle", from: "2026-10-01", until: "2026-10-08" });
  // The current cycle is the one "this month" Spend and the top bar ask billing for.
  assert.deepEqual(resolveRange("cycle", {}, NOW), { period: "cycle", ...monthSpan(NOW) });
  assert.deepEqual(spanFor("month", NOW), monthSpan(NOW));
  assert.deepEqual(resolveRange("last_cycle", {}, NOW), { period: "last_cycle", from: "2026-09-01", until: "2026-09-30" });
  assert.deepEqual(resolveRange("7d", {}, NOW), { period: "7d", from: "2026-10-02", until: "2026-10-08" });
  assert.deepEqual(resolveRange("custom", { from: "2026-10-05", until: "2026-09-20" }, NOW), { period: "custom", from: "2026-09-20", until: "2026-10-05" });
  // A custom range that is not days falls back to the cycle.
  assert.equal(resolveRange("custom", { from: "yesterday", until: "2026-10-01" }, NOW).period, "cycle");
  assert.equal(resolveRange("nonsense", {}, NOW).period, "cycle");
});

test("columns cover every day, stack products, and add up when cumulative", () => {
  const days = [
    { day: "2026-10-01", product: "agent", micros: 2_000_000 },
    { day: "2026-10-01", product: "sandboxes", micros: 500_000 },
    { day: "2026-10-03", product: "agent", micros: 1_000_000 },
  ];
  const daily = columns(days, "2026-10-01", "2026-10-03");
  assert.deepEqual(daily.map((c) => c.total), [2_500_000, 0, 1_000_000]);
  assert.equal(daily[0]!.parts.sandboxes, 500_000);
  const running = columns(days, "2026-10-01", "2026-10-03", "day", true);
  assert.deepEqual(running.map((c) => c.total), [2_500_000, 2_500_000, 3_500_000]);
  assert.equal(running[2]!.parts.agent, 3_000_000);
  // Weeks start on Monday: Oct 1 2026 is a Thursday.
  const weekly = columns(days, "2026-10-01", "2026-10-08", "week");
  assert.deepEqual(weekly.map((c) => c.key), ["2026-09-28", "2026-10-05"]);
  assert.equal(weekly[0]!.total, 3_500_000);
  assert.equal(columns(days, "2026-09-15", "2026-10-03", "month").length, 2);
  assert.equal(defaultGrain("2026-10-01", "2026-10-31"), "day");
  assert.equal(defaultGrain("2026-07-01", "2026-10-01"), "week");
});

test("the money axis has clean ticks, never the same label twice", () => {
  assert.deepEqual(ticks(0), [0]);
  const t = ticks(3_320_000);
  assert.equal(t[0], 0);
  assert.ok(t[t.length - 1]! >= 3_320_000);
  const labels = t.map(axisMoney);
  assert.equal(new Set(labels).size, labels.length, labels.join(" "));
  const small = ticks(4_000).map(axisMoney);
  assert.equal(new Set(small).size, small.length, small.join(" "));
  assert.equal(axisMoney(2_000_000), "$2");
  assert.equal(axisMoney(1_500_000_000), "$1.5K");
});

test("quantities read in their units", () => {
  assert.equal(quantity(1_234_567, "tokens"), "1.2M tokens");
  assert.equal(quantity(3_725, "seconds"), "1h 2m");
  assert.equal(quantity(504_000_000, "bytes"), "504 MB");
  assert.equal(quantity(1, "entries"), "1 entry");
});

test("the receipt shows usage at price, then what paid, then what is charged", () => {
  const lines = receipt(
    { priceMicros: 3_320_000, discountMicros: 3_320_000, includedMicros: 0, creditsMicros: 0, chargedMicros: 0, pendingMicros: 0, costMicros: 0 },
    100,
  );
  assert.deepEqual(lines.map((l) => l.label), ["Usage at price", "Discount (100%)", "Charged"]);
});

test("grouping by project adds a project's meters together", () => {
  const meter = (label: string, parts: [string, number][]) => ({
    key: label, label, product: "agent", unit: "entries", quantity: 0, micros: 0, daily: [],
    byProject: parts.map(([project, micros]) => ({ project, micros, quantity: 0 })),
  });
  const rows = byProject({
    products: [{ key: "agent", label: "Agent", micros: 0, meters: [meter("Model tokens", [["acme/web", 300], ["acme/api", 500]]), meter("Agent rate", [["acme/web", 400]])] }],
  });
  assert.deepEqual(rows.map((r) => [r.project, r.micros]), [["acme/web", 700], ["acme/api", 500]]);
});

test("the CSV has a row per day and meter with anything on it", () => {
  const csv = usageCsv({
    from: "2026-10-01",
    until: "2026-10-02",
    products: [{ key: "agent", label: "Agent", micros: 0, meters: [{ key: "agent_models", label: "Model tokens", product: "agent", unit: "tokens", quantity: 0, micros: 0, daily: [0, 1_500_000], byProject: [] }] }],
  });
  assert.equal(csv, "day,product,meter,usd\n2026-10-02,Agent,Model tokens,1.500000\n");
});

test("test-mode hints are for g1t's own people", () => {
  assert.ok(isStaff({ workspaces: [{ slug: "flagon-io" }] }));
  assert.ok(!isStaff({ workspaces: [{ slug: "acme" }] }));
  assert.ok(!isStaff(null));
});

test("the pending note says what the close will charge, with the fraction of a cent that explains a gap", () => {
  // A comped workspace: $0.009 pending, nothing of it charged.
  assert.equal(
    pendingSentence({ pendingMicros: 9_000, pendingChargedMicros: 0 }),
    "$0.009 of it is metered this month and not yet closed; nothing will be charged when the month closes, after your discount and included usage.",
  );
  assert.equal(
    pendingSentence({ pendingMicros: 9_000, pendingChargedMicros: 6_300 }),
    "$0.009 of it is metered this month and not yet closed; $0.0063 of it will be charged when the month closes, after your discount and included usage.",
  );
  assert.equal(
    pendingSentence({ pendingMicros: 1_340_000, pendingChargedMicros: 1_340_000 }),
    "$1.34 of it is metered this month and not yet closed; all of it will be charged when the month closes, after your discount and included usage.",
  );
  // An older billing, with no split yet.
  assert.equal(pendingSentence({ pendingMicros: 9_000 }), "$0.009 of it is metered this month and not yet closed; it is charged when the month closes.");
});
