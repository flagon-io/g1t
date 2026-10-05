import assert from "node:assert/strict";
import { test } from "node:test";

import { axisDollars, barPath, change, marginOf, monthBars, monthLong, monthShort, niceCeiling, shares, ticks } from "./chart.ts";

const M = 1_000_000;
const month = (m: string, charged: number, cost: number) => ({ month: m, chargedMicros: charged, costMicros: cost, paidMicros: 0 });

test("niceCeiling rounds up to 1, 2, 2.5 or 5 times a power of ten", () => {
  assert.equal(niceCeiling(0), 1 * M);
  assert.equal(niceCeiling(1 * M), 1 * M);
  assert.equal(niceCeiling(1.2 * M), 2 * M);
  assert.equal(niceCeiling(2.2 * M), 2.5 * M);
  assert.equal(niceCeiling(3 * M), 5 * M);
  assert.equal(niceCeiling(7 * M), 10 * M);
  assert.equal(niceCeiling(420 * M), 500 * M);
  assert.equal(niceCeiling(10_001 * M), 20_000 * M);
});

test("ticks run from zero to the top", () => {
  assert.deepEqual(ticks(100, 4), [0, 25, 50, 75, 100]);
});

test("months are named", () => {
  assert.equal(monthShort("2026-10"), "Oct");
  assert.equal(monthShort("2026-01"), "Jan");
  assert.equal(monthShort("soon"), "soon");
  assert.equal(monthLong("2026-10"), "October 2026");
  assert.equal(monthLong("2026-13"), "2026-13");
});

test("margin and change", () => {
  assert.deepEqual(marginOf(100 * M, 80 * M), { micros: 20 * M, percent: 20 });
  assert.deepEqual(marginOf(0, 5 * M), { micros: -5 * M, percent: null });
  assert.equal(change(100, 150), 50);
  assert.equal(change(0, 150), null);
  assert.equal(change(200, 100), -50);
});

test("monthBars scales both series to one axis from zero", () => {
  const chart = monthBars([month("2026-09", 400 * M, 300 * M), month("2026-10", 100 * M, 0)], { width: 300, height: 120, left: 40, right: 0, top: 0, bottom: 20 });
  assert.equal(chart.top, 500 * M);
  assert.deepEqual(chart.plot, { x: 40, y: 0, width: 260, height: 100 });
  const [sep, oct] = chart.bars;
  assert.equal(sep.label, "Sep");
  // 400 of 500 is 80 of the plot's 100.
  assert.equal(Math.round(sep.charged.height), 80);
  assert.equal(Math.round(sep.charged.y), 20);
  assert.equal(Math.round(sep.cost.height), 60);
  // Bars stand on the baseline.
  assert.equal(sep.charged.y + sep.charged.height, 100);
  assert.equal(oct.cost.height, 0);
  // Charged on the left, cost on the right, 2px apart, inside the slot.
  assert.equal(Math.round((sep.cost.x - (sep.charged.x + sep.charged.width)) * 100) / 100, 2);
  assert.ok(sep.charged.x >= sep.slot.x && sep.cost.x + sep.cost.width <= sep.slot.x + sep.slot.width);
  assert.equal(chart.ticks[0].y, 100);
  assert.equal(chart.ticks.at(-1)?.y, 0);
});

test("a tiny month still shows, and an empty chart has an axis", () => {
  const chart = monthBars([month("2026-09", 1000 * M, 0), month("2026-10", 1, 0)]);
  assert.ok(chart.bars[1].charged.height >= 1.5);
  const empty = monthBars([month("2026-10", 0, 0)]);
  assert.equal(empty.top, 1 * M);
  assert.equal(empty.bars[0].charged.height, 0);
  assert.equal(monthBars([]).bars.length, 0);
});

test("negative figures draw nothing below the baseline", () => {
  const chart = monthBars([month("2026-10", -5 * M, 2 * M)]);
  assert.equal(chart.bars[0].charged.height, 0);
});

test("barPath rounds the top and keeps the foot square", () => {
  assert.equal(barPath({ x: 0, y: 0, width: 10, height: 20 }), "M0 20 V4 Q0 0 4 0 H6 Q10 0 10 4 V20 Z");
  assert.equal(barPath({ x: 0, y: 0, width: 10, height: 0 }), "");
  // Never rounder than the bar is tall.
  assert.equal(barPath({ x: 0, y: 9, width: 10, height: 1 }), "M0 10 V10 Q0 9 1 9 H9 Q10 9 10 10 V10 Z");
});

test("axis labels are short", () => {
  assert.equal(axisDollars(0), "$0");
  assert.equal(axisDollars(250 * M), "$250");
  assert.equal(axisDollars(1500 * M), "$1.5k");
  assert.equal(axisDollars(20_000 * M), "$20k");
  assert.equal(axisDollars(1_200_000 * M), "$1.2M");
  assert.equal(axisDollars(0.25 * M), "$0.25");
});

test("shares are against the largest", () => {
  assert.deepEqual(shares([50, 100, 0, -5]), [0.5, 1, 0, 0]);
  assert.deepEqual(shares([0, 0]), [0, 0]);
});
