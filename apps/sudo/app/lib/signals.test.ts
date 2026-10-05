import assert from "node:assert/strict";
import { test } from "node:test";

import type { Signal } from "@g1t/contracts";

import { bySignalUrgency, countByKind, filterSignals, followUpsDue, isFollowUpDue, isSignalKind, parseWho, reachOutHref, signalMeta, stageMeta, today } from "./signals.ts";

function signal(workspace: string, kind: string, valueMicros = 0, owner: string | null = null): Signal {
  return { workspace, kind: kind as Signal["kind"], detail: `${workspace} ${kind}`, valueMicros, stage: null, owner };
}

test("most urgent first: by kind, then the larger figure, else as billing sent them", () => {
  const sorted = bySignalUrgency([
    signal("a", "growing", 10),
    signal("b", "first_payment", 99),
    signal("c", "near_ceiling", 5),
    signal("d", "at_limit", 1),
    signal("e", "near_ceiling", 50),
    signal("f", "something_new", 1000),
    signal("g", "declined", 0),
    signal("h", "growing", 10),
  ]);
  assert.deepEqual(
    sorted.map((s) => s.workspace),
    ["d", "g", "e", "c", "a", "h", "b", "f"],
  );
});

test("sorting leaves the input alone", () => {
  const input = [signal("a", "growing"), signal("b", "at_limit")];
  bySignalUrgency(input);
  assert.equal(input[0].workspace, "a");
});

test("filter by kind, and by whose they are", () => {
  const all = [
    signal("a", "at_limit", 0, "Me@g1t.sh"),
    signal("b", "at_limit", 0, null),
    signal("c", "growing", 0, "other@g1t.sh"),
    signal("d", "growing", 0, ""),
  ];
  const me = "me@g1t.sh";
  assert.deepEqual(filterSignals(all, { kind: null, who: "all", me }).map((s) => s.workspace), ["a", "b", "c", "d"]);
  assert.deepEqual(filterSignals(all, { kind: "at_limit", who: "all", me }).map((s) => s.workspace), ["a", "b"]);
  assert.deepEqual(filterSignals(all, { kind: null, who: "unassigned", me }).map((s) => s.workspace), ["b", "d"]);
  assert.deepEqual(filterSignals(all, { kind: null, who: "mine", me }).map((s) => s.workspace), ["a"]);
  assert.deepEqual(filterSignals(all, { kind: "growing", who: "mine", me }), []);
});

test("counts by kind", () => {
  assert.deepEqual(countByKind([signal("a", "at_limit"), signal("b", "at_limit"), signal("c", "growing")]), { at_limit: 2, growing: 1 });
});

test("query values are checked", () => {
  assert.equal(parseWho("mine"), "mine");
  assert.equal(parseWho("unassigned"), "unassigned");
  assert.equal(parseWho("everyone"), "all");
  assert.equal(parseWho(null), "all");
  assert.ok(isSignalKind("near_ceiling"));
  assert.ok(!isSignalKind("nearly"));
  assert.ok(!isSignalKind(null));
});

test("links into the queue leave out the defaults", () => {
  assert.equal(reachOutHref({}), "/reach-out");
  assert.equal(reachOutHref({ kind: "at_limit" }), "/reach-out?kind=at_limit");
  assert.equal(reachOutHref({ kind: "declined", who: "mine" }), "/reach-out?kind=declined&who=mine");
  assert.equal(reachOutHref({ kind: null, who: "all" }), "/reach-out");
});

test("names for kinds and stages, and for ones sudo does not know", () => {
  assert.equal(signalMeta("at_limit").label, "At limit");
  assert.equal(signalMeta("at_limit").tone, "danger");
  assert.equal(signalMeta("brand_new").label, "brand new");
  assert.equal(stageMeta(null).label, "No stage");
  assert.equal(stageMeta("churn_risk").label, "Churn risk");
  assert.equal(stageMeta("odd").label, "odd");
});

test("follow-ups due: today or earlier, open deals only, one per workspace, oldest first", () => {
  const s = (workspace: string, nextAt: string | null, stage: string | null = "contacted", kind = "growing"): Signal => ({
    ...signal(workspace, kind),
    nextAt,
    stage,
    nextStep: nextAt ? "Call" : null,
  });
  const on = "2026-10-04";
  assert.ok(isFollowUpDue(s("a", "2026-10-04"), on));
  assert.ok(isFollowUpDue(s("a", "2026-10-01"), on));
  assert.ok(!isFollowUpDue(s("a", "2026-10-05"), on));
  assert.ok(!isFollowUpDue(s("a", null), on));
  assert.ok(!isFollowUpDue(s("a", "2026-10-01", "won"), on));
  assert.ok(!isFollowUpDue(s("a", "2026-10-01", "lost"), on));
  assert.ok(isFollowUpDue(s("a", "2026-10-01", null), on));
  const due = followUpsDue([s("b", "2026-10-03"), s("a", "2026-09-30", "contacted", "at_limit"), s("a", "2026-09-30", "contacted", "high_spend"), s("c", "2026-10-09")], on);
  assert.deepEqual(due.map((x) => `${x.workspace}:${x.kind}`), ["a:at_limit", "b:growing"]);
  assert.equal(today(new Date("2026-10-04T23:59:00Z")), "2026-10-04");
  assert.equal(reachOutHref({ due: true }), "/reach-out?due=1");
  assert.equal(reachOutHref({ due: true, who: "mine" }), "/reach-out?due=1&who=mine");
});
