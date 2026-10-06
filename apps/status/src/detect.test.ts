import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEPLOY_GRACE_MS,
  DEPLOY_MAX_MS,
  DETECT_AFTER,
  RECOVERED_FOR_MS,
  type DeployWindow,
  type Streak,
  autoDismissText,
  deployChange,
  deployQuiet,
  detect,
  detectedImpact,
  draftTitle,
  limitWords,
  minutesWords,
  recoverySentence,
  settleDrafts,
  troubleSentence,
} from "./detect.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute));

/** Runs rounds of checks through detection, carrying the streaks along. */
function run(
  rounds: Record<string, "up" | "degraded" | "down">[],
  open: { id: string; components: string[] }[] = [],
  maintenance = new Set<string>(),
  quiet: (minute: number) => boolean = () => false,
) {
  let streaks = new Map<string, Streak>();
  const results = rounds.map((round, minute) => {
    const found = detect(streaks, Object.entries(round).map(([component, state]) => ({ component, state })), open, maintenance, at(minute), { quiet: quiet(minute) });
    streaks = new Map(found.streaks.map((s) => [s.component, s]));
    return found;
  });
  return results;
}

test(`a draft after ${DETECT_AFTER} failed checks in a row, once`, () => {
  assert.equal(DETECT_AFTER, 3);
  const rounds = run([{ api: "down" }, { api: "down" }, { api: "down" }, { api: "down" }]);
  assert.deepEqual(rounds.map((r) => r.draft.length), [0, 0, 1, 0]);
  assert.deepEqual(rounds[2]!.draft[0], { key: "api", state: "down", since: at(0).toISOString(), checks: 3 });
});

test("a blip is not an incident: a good check resets the run", () => {
  const rounds = run([{ api: "down" }, { api: "down" }, { api: "up" }, { api: "down" }, { api: "down" }]);
  assert.ok(rounds.every((r) => r.draft.length === 0));
  assert.equal(rounds[4]!.streaks[0]!.count, 2);
});

test("slow then failing is one run, at its worst", () => {
  const rounds = run([{ docs: "degraded" }, { docs: "down" }, { docs: "degraded" }]);
  assert.deepEqual(rounds[2]!.draft, [{ key: "docs", state: "down", since: at(0).toISOString(), checks: 3 }]);
});

test("parts failing together share one draft", () => {
  const rounds = run([{ api: "down", git: "down" }, { api: "down", git: "down" }, { api: "down", git: "down" }]);
  assert.deepEqual(rounds[2]!.draft.map((d) => d.key), ["api", "git"]);
});

test("with an incident already open on the part: a line on it, no draft; recovery is noted", () => {
  const open = [{ id: "inc1", components: ["api"] }];
  const rounds = run([{ api: "down" }, { api: "down" }, { api: "down" }, { api: "up" }], open);
  assert.equal(rounds[2]!.draft.length, 0);
  assert.deepEqual(rounds[2]!.failing, [{ incident: "inc1", key: "api", state: "down", since: at(0).toISOString(), checks: 3 }]);
  assert.deepEqual(rounds[3]!.recovered, [{ incident: "inc1", key: "api", state: "down", since: at(0).toISOString(), checks: 3 }]);
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

test("a run that recovered is over: the next one starts fresh, with its own start", () => {
  // 12:00 and 12:01 slow, 12:02 fine; then slow again from 12:10.
  const rounds = run([
    { git: "degraded" },
    { git: "degraded" },
    { git: "up" },
    ...Array.from({ length: 7 }, () => ({ git: "up" as const })),
    { git: "degraded" },
    { git: "degraded" },
    { git: "degraded" },
  ]);
  assert.equal(rounds[2]!.streaks.length, 0);
  assert.equal(rounds[10]!.streaks[0]!.count, 1);
  assert.equal(rounds[10]!.streaks[0]!.since, at(10).toISOString());
  assert.equal(rounds[11]!.draft.length, 0, "two slow checks after a recovery are not three");
  assert.deepEqual(rounds[12]!.draft, [{ key: "git", state: "degraded", since: at(10).toISOString(), checks: 3 }]);
});

test("during a deploy, trouble is counted but not drafted; it is drafted once it outlasts the window", () => {
  // Quiet for minutes 0-3 (a deploy and its grace).
  const quiet = (m: number) => m <= 3;
  const blip = run([{ api: "down" }, { api: "down" }, { api: "down" }, { api: "down" }, { api: "up" }, { api: "up" }], [], new Set(), quiet);
  assert.ok(blip.every((r) => r.draft.length === 0), "a restart that recovers inside the window is never drafted");
  assert.deepEqual(blip[2]!.held, ["api"]);
  const lasting = run([{ api: "down" }, { api: "down" }, { api: "down" }, { api: "down" }, { api: "down" }], [], new Set(), quiet);
  assert.deepEqual(lasting.map((r) => r.draft.length), [0, 0, 0, 0, 1]);
  assert.deepEqual(lasting[4]!.draft[0], { key: "api", state: "down", since: at(0).toISOString(), checks: 5 }, "the draft keeps the run's true start");
});

test("during a deploy, an incident already open still hears about its parts", () => {
  const rounds = run([{ api: "down" }, { api: "down" }, { api: "down" }], [{ id: "inc1", components: ["api"] }], new Set(), () => true);
  assert.equal(rounds[2]!.failing.length, 1);
});

test("the deploy window: running, finished plus grace, and a start that never finished", () => {
  const t = (minute: number) => new Date(Date.UTC(2026, 9, 6, 7, minute));
  assert.equal(deployQuiet(null, t(0)), false);
  const running: DeployWindow = deployChange(null, "started", "abc", t(20));
  assert.deepEqual(running, { id: "abc", started_at: t(20).toISOString(), finished_at: null });
  assert.equal(deployQuiet(running, t(25)), true);
  assert.equal(deployQuiet(running, t(10)), false, "trouble before the deploy is not forgiven");
  assert.equal(deployQuiet(running, new Date(t(20).getTime() + DEPLOY_MAX_MS)), false, "a deploy that never said it finished stops counting");
  const finished = deployChange(running, "finished", null, t(26));
  assert.deepEqual(finished, { id: "abc", started_at: t(20).toISOString(), finished_at: t(26).toISOString() });
  assert.equal(deployQuiet(finished, new Date(t(26).getTime() + DEPLOY_GRACE_MS - 1)), true);
  assert.equal(deployQuiet(finished, new Date(t(26).getTime() + DEPLOY_GRACE_MS)), false);
  // A second start while one runs keeps the first start.
  assert.equal(deployChange(running, "started", "def", t(22)).started_at, t(20).toISOString());
  // A new start after one finished begins a new window.
  assert.equal(deployChange(finished, "started", "def", t(40)).started_at, t(40).toISOString());
});

test("a detected draft that recovers and stays healthy is dismissed; trouble in between starts the wait again", () => {
  const draft = { id: "d1", title: "Detected: Git slow", components: ["git"], started_at: at(0).toISOString(), healthy_since: null as string | null };
  const minute = 60_000;
  // Still slow: not healthy.
  assert.deepEqual(settleDrafts([draft], new Set(["git"]), at(3)), { healthy: [{ id: "d1", since: null }], dismiss: [] });
  // Healthy from 12:04.
  const first = settleDrafts([draft], new Set(), at(4));
  assert.deepEqual(first.healthy, [{ id: "d1", since: at(4).toISOString() }]);
  const waiting = { ...draft, healthy_since: at(4).toISOString() };
  assert.equal(settleDrafts([waiting], new Set(), new Date(at(4).getTime() + RECOVERED_FOR_MS - minute)).dismiss.length, 0);
  // A slow check in between: the wait starts again.
  assert.deepEqual(settleDrafts([waiting], new Set(["git"]), at(8)).healthy, [{ id: "d1", since: null }]);
  // Healthy long enough: dismissed, resolved when it recovered, lasting 4 minutes.
  const done = settleDrafts([waiting], new Set(), new Date(at(4).getTime() + RECOVERED_FOR_MS));
  assert.deepEqual(done.dismiss, [{ id: "d1", title: "Detected: Git slow", recovered_at: at(4).toISOString(), lasted_ms: 4 * minute }]);
  assert.equal(done.healthy.length, 0);
  // Other parts in trouble do not hold it up.
  assert.equal(settleDrafts([waiting], new Set(["api"]), new Date(at(4).getTime() + RECOVERED_FOR_MS)).dismiss.length, 1);
});

test("slow and down are said apart, with the run's own start", () => {
  assert.equal(limitWords(1500), "1.5 s");
  assert.equal(limitWords(800), "800 ms");
  assert.equal(
    troubleSentence("Git and repositories", { state: "degraded", checks: 3 }, "6 Oct 07:25 UTC", 1500),
    "Git and repositories has been slow — over 1.5 s — on 3 checks in a row since 6 Oct 07:25 UTC.",
  );
  assert.equal(troubleSentence("API", { state: "down", checks: 3 }, "6 Oct 07:25 UTC", 1500), "API has not answered on 3 checks in a row since 6 Oct 07:25 UTC.");
  assert.match(recoverySentence("Git", { state: "degraded", checks: 4 }, "6 Oct 07:25 UTC"), /^Git is back to normal speed, after being slow on 4 checks/);
  assert.match(recoverySentence("API", { state: "down", checks: 4 }, "6 Oct 07:25 UTC"), /^API is answering again, after not answering on 4 checks/);
  assert.equal(minutesWords(30_000), "1 minute");
  assert.equal(minutesWords(4 * 60_000), "4 minutes");
  assert.equal(minutesWords(125 * 60_000), "2h 05m");
  assert.equal(
    autoDismissText(4 * 60_000, "6 Oct 07:29 UTC"),
    "Recovered after 4 minutes, at 6 Oct 07:29 UTC, and stayed healthy for 10 minutes; dismissed automatically. It never appeared on the status page.",
  );
});
