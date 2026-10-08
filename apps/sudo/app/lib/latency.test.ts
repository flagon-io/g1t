import assert from "node:assert/strict";
import { test } from "node:test";

import type { CheckSample } from "@g1t/contracts";

import { latencyPlot, latencySummary, msWords, summaryWords } from "./latency.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 8, 7, minute)).toISOString();
const sample = (minute: number, ms: number | null, outcome: CheckSample["outcome"], extra: Partial<CheckSample> = {}): CheckSample => ({
  component: "speed",
  at: at(minute),
  ms,
  outcome,
  colo: "IAD",
  first_ms: null,
  ...extra,
});

test("the chart: answered checks as a line, broken by failures and gaps; slow ones dotted; the slow line drawn", () => {
  const samples = [
    sample(0, 300, "up"),
    sample(1, 1200, "degraded", { first_ms: 2400 }),
    sample(2, 5000, "down"),
    sample(3, 400, "up"),
    // Five minutes with no check: a gap.
    sample(9, 500, "up"),
    sample(10, 450, "up"),
  ];
  const p = latencyPlot({ key: "speed", slow_ms: 800, from: at(0), to: at(10), samples }, { width: 640, height: 120 });
  assert.equal(p.max, 1500, "half again over the slow line, or the slowest answer, rounded up; a failure's time is not a speed");
  // Three segments: 0-1, 3, and 9-10.
  assert.equal(p.line.match(/M/g)!.length, 3);
  assert.equal(p.line.match(/L/g)!.length, 2);
  assert.equal(p.slow.length, 1);
  assert.equal(p.down.length, 1);
  assert.ok(p.slowY! > p.plot.y && p.slowY! < p.plot.y + p.plot.height);
  // The first check is at the left edge, the last at the right.
  assert.ok(p.line.startsWith(`M${p.plot.x} `));
  assert.ok(p.line.includes(`L${p.plot.x + p.plot.width} `));
  assert.deepEqual(p.ticks.map((t) => t.label), ["0", "750 ms", "1.5 s"]);
});

test("the chart's scale leaves room over the slow line when every check was fast", () => {
  const p = latencyPlot({ key: "api", slow_ms: 1500, from: at(0), to: at(1), samples: [sample(0, 90, "up")] });
  assert.equal(p.max, 2500);
  const none = latencyPlot({ key: "api", slow_ms: null, from: at(0), to: at(1), samples: [] });
  assert.equal(none.line, "");
  assert.equal(none.slowY, null);
});

test("the summary over the chart", () => {
  const s = latencySummary([
    sample(0, 300, "up"),
    sample(1, 1200, "degraded", { first_ms: 2400 }),
    sample(2, 5000, "down", { colo: "EWR" }),
    sample(3, 400, "up"),
  ]);
  assert.deepEqual(s, { checks: 4, slow: 1, down: 1, median_ms: 400, slowest_ms: 1200, asked_again: 1, colos: ["IAD", "EWR"] });
  assert.equal(summaryWords(s), "4 checks · 1 slow · 1 not answering · median 400 ms · slowest 1.2 s · 1 asked again · from IAD, EWR");
  assert.equal(msWords(800), "800 ms");
  assert.equal(msWords(1500), "1.5 s");
});
