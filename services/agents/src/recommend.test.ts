import assert from "node:assert/strict";
import { test } from "node:test";

import { MIN_SESSIONS, type SessionOutcome, currentLevel, effortCostsOf, judge, median, wilsonLower, wording } from "./recommend.ts";

/** `n` sessions at a level, `accepted` of them accepted, each costing `micros`. */
function at(effort: SessionOutcome["effort"], n: number, accepted: number, micros: number | ((i: number) => number)): SessionOutcome[] {
  return Array.from({ length: n }, (_, i) => ({ effort, accepted: i < accepted, charged_micros: typeof micros === "function" ? micros(i) : micros }));
}

test("a cheaper level that holds up on the agent's own work is recommended, with the saving from measured costs", () => {
  const outcomes = [...at("high", 20, 19, 480_000), ...at("medium", 12, 12, 210_000)];
  const judged = judge("high", outcomes, 28);
  assert.equal(judged.kind, "recommend");
  if (judged.kind !== "recommend") return;
  assert.equal(judged.to, "medium");
  assert.equal(judged.current.sessions, 20);
  assert.equal(judged.cheaper.accepted, 12);
  // (480,000 - 210,000) × 20 sessions / 28 days × 30 days.
  assert.equal(judged.saving_month_micros, Math.round(270_000 * (20 / 28) * 30));
  const words = wording(judged, "Reviewer");
  assert.equal(words.title, "Run Reviewer at Medium effort");
  assert.match(words.reason, /12 of its 12 sessions .* against 19 of 20 at High; a typical one cost \$0\.21 instead of \$0\.48/);
});

test("too little history says so, and recommends nothing", () => {
  const judged = judge("high", [...at("high", 20, 20, 400_000), ...at("medium", 3, 3, 100_000)]);
  assert.equal(judged.kind, "thin");
  if (judged.kind !== "thin") return;
  const words = wording(judged, "Reviewer");
  assert.match(words.reason, new RegExp(`20 at High and 3 at Medium.*at least ${MIN_SESSIONS} at each`));
  assert.equal(judge("high", at("high", 25, 25, 400_000)).kind, "thin", "never ran cheaper: nothing measured to compare");
});

test("a cheaper level that does worse, or saves too little, is not suggested", () => {
  // Acceptance falls from 95% to 70%.
  assert.equal(judge("high", [...at("high", 20, 19, 480_000), ...at("medium", 20, 14, 200_000)]).kind, "none");
  // Same quality, but a typical session costs 95% as much.
  assert.equal(judge("high", [...at("high", 20, 20, 400_000), ...at("medium", 20, 20, 380_000)]).kind, "none");
});

test("nothing below low, and nothing with no history", () => {
  assert.equal(judge("low", at("low", 30, 30, 10_000)).kind, "none");
  assert.equal(judge("high", []).kind, "none");
});

test("auto is judged at the level most of its sessions ran at", () => {
  const outcomes = [...at("medium", 15, 15, 300_000), ...at("high", 4, 3, 600_000), ...at("low", 11, 11, 90_000)];
  assert.equal(currentLevel("auto", outcomes), "medium");
  const judged = judge("auto", outcomes);
  assert.equal(judged.kind, "recommend");
  if (judged.kind === "recommend") {
    assert.equal(judged.from, "auto");
    assert.equal(judged.to, "low");
  }
});

test("the pessimistic estimate stops a lucky small sample", () => {
  assert.ok(wilsonLower(10, 10) < 1);
  assert.ok(wilsonLower(10, 10) > 0.8);
  assert.equal(wilsonLower(0, 0), 0);
});

test("what each level cost is measured, and empty where it never ran", () => {
  const costs = effortCostsOf("reviewer", "high", [...at("high", 3, 2, (i) => [100, 300, 200][i]), ...at("low", 1, 1, 40)]);
  assert.deepEqual(
    costs.levels.map((l) => [l.effort, l.sessions, l.typical_micros]),
    [
      ["low", 1, 40],
      ["medium", 0, null],
      ["high", 3, 200],
      ["max", 0, null],
    ],
  );
  assert.equal(costs.levels[2].accepted_share, 2 / 3);
  assert.equal(median([1, 2, 3, 4]), 3);
});
