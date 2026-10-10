import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEffortCosts } from "@g1t/contracts";

import { readEffort } from "./agent-form.ts";
import { acceptedLabel, costAt, costLine, effortSetting, savingLabel, totalSaving } from "./effort.ts";

const costs: AgentEffortCosts = {
  handle: "reviewer",
  effort: "high",
  window_days: 28,
  levels: [
    { effort: "low", sessions: 0, typical_micros: null, accepted_share: null },
    { effort: "medium", sessions: 1, typical_micros: 210_000, accepted_share: 1 },
    { effort: "high", sessions: 14, typical_micros: 480_000, accepted_share: 13 / 14 },
    { effort: "max", sessions: 0, typical_micros: null, accepted_share: null },
  ],
};

test("a level's cost is what its sessions measured, and none where it never ran", () => {
  assert.equal(costLine(costs, "high"), "$0.48 a typical task, from 14 sessions in the last 28 days");
  assert.equal(costLine(costs, "medium"), "$0.21 a typical task, from 1 session in the last 28 days");
  assert.equal(costLine(costs, "low"), "No sessions at Low in the last 28 days, so no figure yet.");
  assert.equal(costLine(costs, "auto"), "$0.21 a typical task at Medium, from 1 session in the last 28 days");
  assert.equal(costLine(null, "high"), "Costs couldn't be read right now.");
  assert.equal(costAt(costs, "max"), null);
  assert.equal(acceptedLabel(costAt(costs, "high")), "93%");
});

test("the setting reads from routing and the form, Auto when absent or unknown", () => {
  assert.equal(effortSetting({ effort: "max" }), "max");
  assert.equal(effortSetting({}), "auto");
  assert.equal(effortSetting(null), "auto");
  assert.equal(readEffort("low"), "low");
  assert.equal(readEffort("turbo"), null);
});

test("savings add up from the open suggestions only", () => {
  const rec = (status: "open" | "thin", saving: number | null) => ({ status, saving_month_micros: saving }) as never;
  assert.equal(totalSaving({ checked_at: null, window_days: 28, open: [rec("open", 31_000_000), rec("open", 4_000_000)], thin: [rec("thin", null)], resolved: [] }), 35_000_000);
  assert.equal(totalSaving(null), 0);
  assert.equal(savingLabel({ saving_month_micros: 31_000_000 }), "About $31.00 a month");
  assert.equal(savingLabel({ saving_month_micros: null }), "");
});
