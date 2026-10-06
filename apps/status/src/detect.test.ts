import assert from "node:assert/strict";
import { test } from "node:test";

import { DETECT_AFTER, type Streak, detect, detectedImpact, draftTitle } from "./detect.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute));

/** Runs rounds of checks through detection, carrying the streaks along. */
function run(rounds: Record<string, "up" | "degraded" | "down">[], open: { id: string; components: string[] }[] = [], maintenance = new Set<string>()) {
  let streaks = new Map<string, Streak>();
  const results = rounds.map((round, minute) => {
    const found = detect(streaks, Object.entries(round).map(([component, state]) => ({ component, state })), open, maintenance, at(minute));
    streaks = new Map(found.streaks.map((s) => [s.component, s]));
    return found;
  });
  return results;
}

test(`a draft after ${DETECT_AFTER} failed checks in a row, once`, () => {
  assert.equal(DETECT_AFTER, 3);
  const rounds = run([{ api: "down" }, { api: "down" }, { api: "down" }, { api: "down" }]);
  assert.deepEqual(rounds.map((r) => r.draft.length), [0, 0, 1, 0]);
  assert.deepEqual(rounds[2]!.draft[0], { key: "api", state: "down", since: at(0).toISOString() });
});

test("a blip is not an incident: a good check resets the run", () => {
  const rounds = run([{ api: "down" }, { api: "down" }, { api: "up" }, { api: "down" }, { api: "down" }]);
  assert.ok(rounds.every((r) => r.draft.length === 0));
  assert.equal(rounds[4]!.streaks[0]!.count, 2);
});

test("slow then failing is one run, at its worst", () => {
  const rounds = run([{ docs: "degraded" }, { docs: "down" }, { docs: "degraded" }]);
  assert.deepEqual(rounds[2]!.draft, [{ key: "docs", state: "down", since: at(0).toISOString() }]);
});

test("parts failing together share one draft", () => {
  const rounds = run([{ api: "down", git: "down" }, { api: "down", git: "down" }, { api: "down", git: "down" }]);
  assert.deepEqual(rounds[2]!.draft.map((d) => d.key), ["api", "git"]);
});

test("with an incident already open on the part: a line on it, no draft; recovery is noted", () => {
  const open = [{ id: "inc1", components: ["api"] }];
  const rounds = run([{ api: "down" }, { api: "down" }, { api: "down" }, { api: "up" }], open);
  assert.equal(rounds[2]!.draft.length, 0);
  assert.deepEqual(rounds[2]!.failing, [{ incident: "inc1", key: "api", state: "down", since: at(0).toISOString() }]);
  assert.deepEqual(rounds[3]!.recovered, [{ incident: "inc1", key: "api", since: at(0).toISOString(), checks: 3 }]);
  assert.equal(rounds[3]!.streaks.length, 0);
});

test("a short blip that never crossed the line is not noted as a recovery", () => {
  const rounds = run([{ api: "down" }, { api: "up" }], [{ id: "inc1", components: ["api"] }]);
  assert.equal(rounds[1]!.recovered.length, 0);
});

test("parts under maintenance and unmonitored parts are left alone", () => {
  const rounds = run([{ api: "down" }, { api: "down" }, { api: "down" }], [], new Set(["api"]));
  assert.ok(rounds.every((r) => r.draft.length === 0 && r.streaks.length === 0));
  const none = detect(new Map(), [{ component: "sandboxes", state: "unmonitored" }], [], new Set(), at(0));
  assert.equal(none.streaks.length, 0);
});

test("the draft says what failed", () => {
  assert.equal(detectedImpact("down"), "major_outage");
  assert.equal(detectedImpact("degraded"), "degraded");
  assert.equal(draftTitle([{ name: "API", state: "down" }, { name: "Git", state: "down" }]), "Detected: API and Git not answering");
  assert.equal(
    draftTitle([{ name: "API", state: "down" }, { name: "Git", state: "down" }, { name: "MCP", state: "down" }, { name: "Docs", state: "degraded" }]),
    "Detected: API, Git and MCP not answering; Docs slow",
  );
});
