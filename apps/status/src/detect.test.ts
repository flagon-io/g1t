import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COOLDOWN_MS,
  DEPLOY_GRACE_MS,
  DEPLOY_MAX_MS,
  DETECT_BAD,
  DETECT_WINDOW,
  RECOVER_AFTER,
  RECOVERED_FOR_MS,
  SLOW_SUSTAIN_MS,
  STALE_AFTER_MS,
  STALE_EVERY_MS,
  WORSE_FACTOR,
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
  quietUntil,
  recoverySentence,
  reopenText,
  settleDrafts,
  staleDrafts,
  staleText,
  troubleSentence,
  troubledNow,
  upgradeStreak,
  worseThan,
} from "./detect.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute));

type State = "up" | "degraded" | "down";

/** Runs rounds of checks through detection, carrying the streaks along. */
function run(
  rounds: Record<string, State>[],
  open: { id: string; components: string[] }[] = [],
  maintenance = new Set<string>(),
  quiet: (minute: number) => boolean = () => false,
  start = new Map<string, Streak>(),
) {
  let streaks = start;
  const results = rounds.map((round, minute) => {
    const found = detect(
      streaks,
      Object.entries(round).map(([component, state]) => ({ component, state })),
      open,
      maintenance,
      at(minute),
      { quiet: quiet(minute) },
    );
    streaks = new Map(found.streaks.map((s) => [s.component, s]));
    return found;
  });
  return results;
}

/** One part's states as rounds: "x" down, "s" slow, "." up. */
const rounds = (key: string, pattern: string): Record<string, State>[] =>
  [...pattern].map((c) => ({ [key]: c === "x" ? "down" : c === "s" ? "degraded" : "up" }));

test(`a draft at ${DETECT_BAD} bad of the last ${DETECT_WINDOW} checks, once`, () => {
  assert.deepEqual([DETECT_BAD, DETECT_WINDOW, RECOVER_AFTER], [4, 5, 3]);
  const found = run(rounds("api", "xxxxx"));
  assert.deepEqual(
    found.map((r) => r.draft.length),
    [0, 0, 0, 1, 0],
  );
  assert.deepEqual(found[3]!.draft[0], { key: "api", state: "down", since: at(0).toISOString(), checks: 4, of: 4 });
});

test("N of M: a good check between does not hide trouble that keeps coming", () => {
  // Three in a row used to be the line, and one good check reset it: down, down, up, down, down was never drafted.
  const found = run(rounds("api", "xx.xx"));
  assert.deepEqual(
    found.map((r) => r.draft.length),
    [0, 0, 0, 0, 1],
  );
  assert.deepEqual(found[4]!.draft[0], { key: "api", state: "down", since: at(0).toISOString(), checks: 4, of: 5 });
});

test("a blip is not an incident: three bad of five is under the line, and three good checks end the run", () => {
  const flapping = run(rounds("api", "x.x.x.x"));
  assert.ok(
    flapping.every((r) => r.draft.length === 0),
    "half the checks failing, alternately, is not four of five",
  );
  const blip = run(rounds("api", "xx...xx"));
  assert.ok(blip.every((r) => r.draft.length === 0));
  assert.equal(blip[4]!.streaks.length, 0, "three good checks in a row end the run");
  assert.deepEqual(blip[6]!.streaks[0], { component: "api", state: "down", count: 2, checks: 2, recent: "xx", since: at(5).toISOString(), alerted: false });
});

test("slow then failing is one run, at its worst", () => {
  const found = run(rounds("docs", "sxss"));
  assert.deepEqual(found[3]!.draft, [{ key: "docs", state: "down", since: at(0).toISOString(), checks: 4, of: 4 }]);
});

test("parts failing together share one draft", () => {
  const found = run(Array.from({ length: 4 }, () => ({ api: "down" as const, git: "down" as const })));
  assert.deepEqual(
    found[3]!.draft.map((d) => d.key),
    ["api", "git"],
  );
});

test("with an incident already open on the part: a line on it, no draft; recovery is noted once the run ends", () => {
  const open = [{ id: "inc1", components: ["api"] }];
  const found = run(rounds("api", "xxxx..."), open);
  assert.equal(found[3]!.draft.length, 0);
  assert.deepEqual(found[3]!.failing, [{ incident: "inc1", key: "api", state: "down", since: at(0).toISOString(), checks: 4, of: 4 }]);
  assert.deepEqual(
    found.map((r) => r.recovered.length),
    [0, 0, 0, 0, 0, 0, 1],
    "answering again is noted after three good checks, not the first",
  );
  assert.deepEqual(found[6]!.recovered, [{ incident: "inc1", key: "api", state: "down", since: at(0).toISOString(), checks: 4, of: 4 }]);
  assert.equal(found[6]!.streaks.length, 0);
});

test("a run that never crossed the line is not noted as a recovery", () => {
  const found = run(rounds("api", "xx..."), [{ id: "inc1", components: ["api"] }]);
  assert.ok(found.every((r) => r.recovered.length === 0));
});

test("parts under maintenance and unmonitored parts are left alone", () => {
  const found = run(rounds("api", "xxxxx"), [], new Set(["api"]));
  assert.ok(found.every((r) => r.draft.length === 0 && r.streaks.length === 0));
  const none = detect(new Map(), [{ component: "sandboxes", state: "unmonitored" }], [], new Set(), at(0));
  assert.equal(none.streaks.length, 0);
});

test("the draft says what failed", () => {
  assert.equal(detectedImpact("down"), "major_outage");
  assert.equal(detectedImpact("degraded"), "degraded");
  assert.equal(
    draftTitle([
      { name: "API", state: "down" },
      { name: "Git", state: "down" },
    ]),
    "Detected: API and Git not answering",
  );
  assert.equal(
    draftTitle([
      { name: "API", state: "down" },
      { name: "Git", state: "down" },
      { name: "MCP", state: "down" },
      { name: "Docs", state: "degraded" },
    ]),
    "Detected: API, Git and MCP not answering; Docs slow",
  );
});

test("a run that recovered is over: the next one starts fresh, with its own start", () => {
  // 12:00 and 12:01 slow, then fine; slow again from 12:10.
  const found = run(rounds("git", "ss........ssss"));
  assert.equal(found[4]!.streaks.length, 0);
  assert.equal(found[10]!.streaks[0]!.count, 1);
  assert.equal(found[10]!.streaks[0]!.since, at(10).toISOString());
  assert.equal(found[12]!.draft.length, 0, "three slow checks after a recovery are not four");
  assert.deepEqual(found[13]!.draft, [{ key: "git", state: "degraded", since: at(10).toISOString(), checks: 4, of: 4 }]);
});

test("a run slow for hours, raised long ago, still ends when the checks go healthy", () => {
  // As kept before N of M: 300 slow checks in a row, raised.
  const old = upgradeStreak({ component: "speed", state: "degraded", count: 300, since: at(0).toISOString(), alerted: true });
  assert.deepEqual([old.checks, old.recent], [300, "sssss"]);
  const open = [{ id: "d1", components: ["speed"] }];
  const found = run(rounds("speed", "s.s...."), open, new Set(), () => false, new Map([["speed", old]]));
  assert.ok(
    found.every((r) => r.draft.length === 0 && r.failing.length === 0),
    "already raised: nothing new",
  );
  assert.deepEqual(
    found.map((r) => r.recovered.length),
    [0, 0, 0, 0, 0, 1, 0],
  );
  assert.deepEqual(found[5]!.recovered[0], { incident: "d1", key: "speed", state: "degraded", since: at(0).toISOString(), checks: 302, of: 303 });
  assert.equal(found[5]!.streaks.length, 0);
  // While the run lasts, only a bad latest check holds a draft up (settleDrafts).
  assert.deepEqual(
    found.slice(0, 5).map((r) => r.streaks.filter(troubledNow).length),
    [1, 0, 1, 0, 0],
  );
});

test("during a deploy, trouble is counted but not drafted; it is drafted once it outlasts the window", () => {
  // Quiet for minutes 0-4 (a deploy and its grace).
  const quiet = (m: number) => m <= 4;
  const blip = run(rounds("api", "xxxxx..."), [], new Set(), quiet);
  assert.ok(
    blip.every((r) => r.draft.length === 0),
    "a restart that recovers inside the window is never drafted",
  );
  assert.deepEqual(blip[3]!.held, ["api"]);
  const lasting = run(rounds("api", "xxxxxx"), [], new Set(), quiet);
  assert.deepEqual(
    lasting.map((r) => r.draft.length),
    [0, 0, 0, 0, 0, 1],
  );
  assert.deepEqual(lasting[5]!.draft[0], { key: "api", state: "down", since: at(0).toISOString(), checks: 6, of: 6 }, "the draft keeps the run's true start");
});

test("during a deploy, an incident already open still hears about its parts", () => {
  const found = run(rounds("api", "xxxx"), [{ id: "inc1", components: ["api"] }], new Set(), () => true);
  assert.equal(found[3]!.failing.length, 1);
});

test("the deploy window: running, finished plus grace, and a start that never finished", () => {
  const t = (minute: number) => new Date(Date.UTC(2026, 9, 6, 7, minute));
  assert.equal(deployQuiet(null, t(0)), false);
  const running: DeployWindow = deployChange(null, "started", "abc", t(20));
  assert.deepEqual(running, { id: "abc", started_at: t(20).toISOString(), finished_at: null, running: 1, last_started_at: t(20).toISOString() });
  assert.equal(deployQuiet(running, t(25)), true);
  assert.equal(deployQuiet(running, t(10)), false, "trouble before the deploy is not forgiven");
  assert.equal(deployQuiet(running, new Date(t(20).getTime() + DEPLOY_MAX_MS)), false, "a deploy that never said it finished stops counting");
  const finished = deployChange(running, "finished", null, t(26));
  assert.deepEqual(finished, {
    id: "abc",
    started_at: t(20).toISOString(),
    finished_at: t(26).toISOString(),
    running: 0,
    last_started_at: t(20).toISOString(),
  });
  assert.equal(deployQuiet(finished, new Date(t(26).getTime() + DEPLOY_GRACE_MS - 1)), true);
  assert.equal(deployQuiet(finished, new Date(t(26).getTime() + DEPLOY_GRACE_MS)), false);
  assert.equal(quietUntil(finished), new Date(t(26).getTime() + DEPLOY_GRACE_MS).toISOString());
  // A new start after the window closed begins a new window.
  assert.equal(deployChange(finished, "started", "def", t(40)).started_at, t(40).toISOString());
});

test("deploys that overlap are one window, finished when the last one is", () => {
  const t = (minute: number) => new Date(Date.UTC(2026, 9, 6, 7, minute));
  // Two jobs of a stage start; the first finishes early.
  let w = deployChange(null, "started", "abc", t(0));
  w = deployChange(w, "started", "abc", t(1));
  assert.equal(w.running, 2);
  w = deployChange(w, "finished", "abc", t(4));
  assert.deepEqual([w.finished_at, w.running], [null, 1], "one still running: not finished");
  assert.equal(deployQuiet(w, t(12)), true, "the other job's restarts at 12 minutes are still forgiven");
  w = deployChange(w, "finished", "abc", t(14));
  assert.deepEqual([w.started_at, w.finished_at, w.running], [t(0).toISOString(), t(14).toISOString(), 0]);
  // The next stage starts inside the grace period: the same window, from its first start.
  w = deployChange(w, "started", "abc", t(15));
  assert.deepEqual([w.started_at, w.finished_at, w.running], [t(0).toISOString(), null, 1]);
  // The 30-minute cap counts from the latest start, not the first.
  assert.equal(deployQuiet(w, t(40)), true);
  assert.equal(deployQuiet(w, new Date(t(15).getTime() + DEPLOY_MAX_MS)), false);
});

test("a detected draft that recovers and stays healthy is dismissed; trouble in between starts the wait again", () => {
  const draft = {
    id: "d1",
    title: "Detected: Git slow",
    components: ["git"],
    started_at: at(0).toISOString(),
    declared_at: at(3).toISOString(),
    healthy_since: null as string | null,
    reminded_at: null,
  };
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

test("a draft nobody acknowledges is raised again after 45 minutes, once, then every 6 hours", () => {
  assert.deepEqual([STALE_AFTER_MS, STALE_EVERY_MS], [45 * 60_000, 6 * 3_600_000]);
  const made = at(0);
  const later = (ms: number) => new Date(made.getTime() + ms);
  const draft = { id: "d1", title: "Detected: Page speed slow", components: ["speed"], declared_at: made.toISOString(), reminded_at: null as string | null };
  const troubled = new Set(["speed"]);
  assert.deepEqual(staleDrafts([draft], troubled, later(STALE_AFTER_MS - 1)), []);
  assert.deepEqual(staleDrafts([draft], troubled, later(STALE_AFTER_MS)), [{ id: "d1", title: draft.title, waiting_ms: STALE_AFTER_MS }]);
  // Raised at 45 minutes: not again the minute after, nor at 90 minutes.
  const reminded = { ...draft, reminded_at: later(STALE_AFTER_MS).toISOString() };
  assert.deepEqual(staleDrafts([reminded], troubled, later(STALE_AFTER_MS + 60_000)), []);
  assert.deepEqual(staleDrafts([reminded], troubled, later(2 * STALE_AFTER_MS)), []);
  assert.deepEqual(staleDrafts([reminded], troubled, later(STALE_AFTER_MS + STALE_EVERY_MS - 1)), []);
  assert.equal(staleDrafts([reminded], troubled, later(STALE_AFTER_MS + STALE_EVERY_MS)).length, 1);
  // Healthy now: it waits quietly to be dismissed, at 45 minutes or after.
  assert.deepEqual(staleDrafts([draft], new Set(["api"]), later(STALE_AFTER_MS)), []);
  assert.deepEqual(staleDrafts([reminded], new Set(), later(STALE_AFTER_MS + STALE_EVERY_MS)), []);
  // Brought back after it was dismissed: 45 minutes from then.
  const back = { ...draft, reopened_at: later(3 * STALE_AFTER_MS).toISOString() };
  assert.deepEqual(staleDrafts([back], troubled, later(4 * STALE_AFTER_MS - 1)), []);
  assert.equal(staleDrafts([back], troubled, later(4 * STALE_AFTER_MS)).length, 1);
  assert.equal(staleText(STALE_AFTER_MS, true), "Unacknowledged for 45 minutes. The alert address was emailed again.");
  assert.equal(staleText(STALE_AFTER_MS + STALE_EVERY_MS, false), "Unacknowledged for 6h 45m.");
});

test(`slowness alone on a part g1t is not down without waits ${SLOW_SUSTAIN_MS / 60_000} minutes; not answering does not`, () => {
  const sustained = (pattern: string, key = "speed", minor = new Set(["speed"])) => {
    let streaks = new Map<string, Streak>();
    return [...pattern].map((c, minute) => {
      const state = c === "x" ? "down" : c === "s" ? "degraded" : "up";
      const found = detect(streaks, [{ component: key, state }], [], new Set(), at(minute), { minor });
      streaks = new Map(found.streaks.map((s) => [s.component, s]));
      return found.draft.length;
    });
  };
  // Slow 4 of 5 at minute 3, drafted only once the run is 15 minutes old, and still slow.
  assert.equal(sustained("s".repeat(20)).indexOf(1), 15);
  // Flapping that never lasts 15 minutes in a run is never drafted.
  assert.equal(sustained("ssss...ssss...ssss...").includes(1), false);
  // Not answering is drafted at once; and a core part's slowness is too.
  assert.equal(sustained("xxxxx").indexOf(1), 3);
  assert.equal(sustained("sssss", "git").indexOf(1), 3);
});

test("the same trouble within two hours of its draft's dismissal brings it back; worse trouble is a new draft", () => {
  assert.deepEqual([COOLDOWN_MS, WORSE_FACTOR], [2 * 3_600_000, 1.5]);
  const cooled = new Map([["git", { incident: "d1", state: "degraded" as const, at: at(0).toISOString() }]]);
  const slowMs = () => 1500;
  const cross = (state: "degraded" | "down", ms: number, minute: number) => {
    const streak: Streak = {
      component: "git",
      state,
      count: 3,
      checks: 3,
      recent: state === "down" ? "xxx" : "sss",
      since: at(minute - 3).toISOString(),
      alerted: false,
    };
    return detect(new Map([["git", streak]]), [{ component: "git", state, ms }], [], new Set(), at(minute), { cooled, slowMs });
  };
  const back = cross("degraded", 1800, 30);
  assert.deepEqual([back.draft.length, back.reopen.map((r) => r.incident)], [0, ["d1"]]);
  assert.equal(back.streaks[0]!.alerted, true, "counted as raised, so it is not raised again each minute");
  // Clearly over the line, or not answering where it was slow: worse, a new draft.
  assert.deepEqual([cross("degraded", 2300, 30).draft.length, cross("down", 5000, 30).draft.length], [1, 1]);
  // After the cooldown: a new draft.
  assert.equal(cross("degraded", 1800, 121).draft.length, 1);
  // Down after a draft about not answering: the same trouble, brought back.
  assert.equal(worseThan({ incident: "d1", state: "down", at: at(0).toISOString() }, { state: "down" }, 1500), false);
  assert.equal(
    reopenText("Git has been slow.", "5 Oct 12:00 UTC", 17 * 60_000),
    "Back 17 minutes after it was dismissed (5 Oct 12:00 UTC): Git has been slow. Brought back rather than drafted again; no alert was sent.",
  );
});

test("slow and down are said apart, with the run's own start", () => {
  assert.equal(limitWords(1500), "1.5 s");
  assert.equal(limitWords(800), "800 ms");
  assert.equal(
    troubleSentence("Git and repositories", { state: "degraded", checks: 4, of: 4 }, "6 Oct 07:25 UTC", 1500),
    "Git and repositories has been slow — over 1.5 s — on 4 checks in a row since 6 Oct 07:25 UTC.",
  );
  assert.equal(
    troubleSentence("API", { state: "down", checks: 4, of: 5 }, "6 Oct 07:25 UTC", 1500),
    "API has not answered on 4 of 5 checks since 6 Oct 07:25 UTC.",
  );
  assert.equal(
    troubleSentence("API", { state: "down", checks: 3 }, "6 Oct 07:25 UTC", 1500),
    "API has not answered on 3 checks in a row since 6 Oct 07:25 UTC.",
  );
  assert.match(
    recoverySentence("Git", { state: "degraded", checks: 4, of: 4 }, "6 Oct 07:25 UTC"),
    /^Git is back to normal speed, after being slow on 4 checks in a row/,
  );
  assert.match(
    recoverySentence("API", { state: "down", checks: 40, of: 42 }, "6 Oct 07:25 UTC"),
    /^API is answering again, after not answering on 40 of 42 checks/,
  );
  assert.equal(minutesWords(30_000), "1 minute");
  assert.equal(minutesWords(4 * 60_000), "4 minutes");
  assert.equal(minutesWords(125 * 60_000), "2h 05m");
  assert.equal(
    autoDismissText(4 * 60_000, "6 Oct 07:29 UTC"),
    "Recovered after 4 minutes, at 6 Oct 07:29 UTC, and stayed healthy for 10 minutes; dismissed automatically. It never appeared on the status page.",
  );
});
