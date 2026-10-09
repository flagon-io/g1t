import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanHandle, dollarsField, microsFromDollars, readAgentForm } from "./agent-form.ts";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

test("handles are cleaned as typed", () => {
  assert.equal(cleanHandle("@Release Manager!"), "release-manager");
  assert.equal(cleanHandle("--ship--"), "ship");
});

test("the agent form becomes what the service takes, in micro-dollars", () => {
  const read = readAgentForm(
    form({
      display_name: "Ship",
      handle: "",
      role: "Cuts releases",
      instructions: "Cut a release on Tuesdays.",
      personality_preset: "terse",
      floor: "large",
      ceiling: "none",
      providers: "g1t",
      monthly: "40",
      daily: "",
      task: "2.50",
      merge: "never",
      capacity: "2",
    }),
  );
  assert.ok(read.ok);
  assert.equal(read.input.handle, "ship");
  assert.equal(read.input.personality_preset, "terse");
  assert.deepEqual(read.input.routing, { floor: "large", ceiling: null, providers: ["g1t"], pinned: null });
  assert.deepEqual(read.input.budget, { monthly_micros: 40_000_000, daily_micros: null, task_micros: 2_500_000 });
  assert.equal(read.input.autonomy?.merge, "never");
  assert.equal(read.input.autonomy?.open_pull_requests, "alone");
  assert.equal(read.input.capacity, 2);
});

test("the agent form says what to fix", () => {
  const read = readAgentForm(form({ display_name: "", handle: "g1t", floor: "frontier", ceiling: "small", monthly: "lots", capacity: "0" }));
  assert.ok(!read.ok);
  assert.deepEqual(Object.keys(read.errors).sort(), ["capacity", "ceiling", "display_name", "handle", "instructions", "monthly", "role"]);
});

test("dollars and micro-dollars", () => {
  assert.equal(microsFromDollars("$12.50"), 12_500_000);
  assert.equal(microsFromDollars(""), null);
  assert.ok(Number.isNaN(microsFromDollars("lots")));
  assert.equal(dollarsField(2_500_000), "2.50");
  assert.equal(dollarsField(50_000_000), "50");
});
