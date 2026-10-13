import assert from "node:assert/strict";
import { test } from "node:test";

import type { Claim, Decision, G1tEvent, WorkSession } from "@g1t/contracts";

import {
  checkHref,
  evidenceOf,
  expiresIn,
  feedLine,
  harnessName,
  liveByIssue,
  duration,
  mergeSessions,
  numberedParts,
  parseBlockedBy,
  resolutionOf,
  sessionTree,
  span,
  standingFailure,
  touchedByKind,
  treeSize,
  viaLabel,
} from "./coordination.ts";

const ana = { id: "usr_ana", username: "ana" };
const bo = { id: "usr_bo", username: "bo" };

function claim(issue: number, over: Partial<Claim> = {}): Claim {
  return {
    id: `clm_${issue}_${over.actor?.username ?? "ana"}`,
    repoId: "rep_1",
    issue,
    sessionId: null,
    actor: ana,
    harness: "claude_code",
    note: null,
    state: "active",
    createdAt: "2026-10-12T10:00:00Z",
    expiresAt: "2026-10-12T10:30:00Z",
    endedAt: null,
    endReason: null,
    handoffTo: null,
    ...over,
  };
}

function session(id: string, over: Partial<WorkSession> = {}): WorkSession {
  return {
    id,
    repoId: "rep_1",
    issue: null,
    pull: null,
    branch: null,
    actor: bo,
    harness: "codex",
    harnessSessionId: null,
    title: null,
    state: "active",
    headCommit: null,
    startedAt: "2026-10-12T10:00:00Z",
    lastSeenAt: "2026-10-12T10:05:00Z",
    endedAt: null,
    endReason: null,
    ...over,
  };
}

function decision(kind: Decision["kind"], at: string, over: Partial<Decision> = {}): Decision {
  return {
    id: `dec_${kind}_${at}`,
    issue: 2,
    pull: 5,
    sessionId: null,
    actor: null,
    kind,
    confidence: "tested",
    summary: kind,
    evidence: {},
    createdAt: at,
    ...over,
  };
}

const event = (type: string, data: unknown): G1tEvent =>
  ({ id: `evt_${type}`, type, source: "work", time: "2026-10-12T10:00:00Z", repoId: "rep_1", actor: "usr_ana", data }) as G1tEvent;

test("harnesses are named as people know them", () => {
  assert.equal(harnessName("claude_code"), "Claude Code");
  assert.equal(harnessName("codex"), "Codex");
  assert.equal(harnessName("claude_managed_agents"), "Claude Managed Agents");
  assert.equal(harnessName(null), null);
});

test("a claim says when it lapses; one that ended says nothing", () => {
  const now = Date.parse("2026-10-12T10:07:00Z");
  assert.equal(expiresIn(claim(1), now), "expires in 23m");
  assert.equal(expiresIn(claim(1, { expiresAt: "2026-10-12T12:00:00Z" }), now), "expires in 1h 53m");
  assert.equal(expiresIn(claim(1, { expiresAt: "2026-10-12T10:00:00Z" }), now), "expiring now");
  assert.equal(expiresIn(claim(1, { state: "released" }), now), null);
  assert.equal(span(30_000), "less than a minute");
  assert.equal(span(2 * 3_600_000), "2h");
});

test("live work is grouped by issue, most recent first, with sessions on no issue apart", () => {
  const { issues, loose } = liveByIssue(
    [claim(1), claim(2, { createdAt: "2026-10-12T10:20:00Z" }), claim(2, { actor: bo })],
    [session("ses_a", { issue: 1, lastSeenAt: "2026-10-12T10:30:00Z" }), session("ses_b")],
  );
  assert.deepEqual(
    issues.map((group) => [group.issue, group.claims.length, group.sessions.length]),
    [
      [1, 1, 1],
      [2, 2, 0],
    ],
  );
  assert.deepEqual(loose.map((one) => one.id), ["ses_b"]);
});

test("evidence is read as far as it goes", () => {
  const failed = decision("integration_failure", "2026-10-12T10:00:00Z", {
    evidence: { commit: "abc1234", check: { name: "CI / merge_group", conclusion: "failure", url: "https://g1t.sh/acme/web/actions/runs/run_1" }, combination: [4, 5], suspects: [4], bisected: false },
  });
  assert.deepEqual(evidenceOf(failed), {
    commit: "abc1234",
    check: { name: "CI / merge_group", conclusion: "failure", url: "https://g1t.sh/acme/web/actions/runs/run_1" },
    combination: [4, 5],
    suspects: [4],
    bisected: false,
  });
  assert.deepEqual(evidenceOf(decision("note", "2026-10-12T10:00:00Z", { evidence: { combination: "nope" } })).combination, []);
  assert.equal(checkHref("https://g1t.sh/acme/web/actions/runs/run_1"), "/acme/web/actions/runs/run_1");
  assert.equal(checkHref("https://ci.example.com/build/9"), "https://ci.example.com/build/9");
  assert.equal(checkHref(null), null);
});

test("a failure stands until the pull request passes in the queue or merges, and a fix after it answers it", () => {
  const failed = decision("integration_failure", "2026-10-12T10:00:00Z");
  const fix = decision("fix", "2026-10-12T10:10:00Z", { confidence: "claimed" });
  const passed = decision("integration_passed", "2026-10-12T10:20:00Z");
  assert.equal(standingFailure([failed], 5), failed);
  assert.equal(standingFailure([failed, fix], 5), failed);
  assert.equal(standingFailure([passed, failed], 5), null);
  assert.equal(standingFailure([failed], 6), null);
  assert.deepEqual(resolutionOf([failed, fix, passed], failed), { fix, passed });
  assert.deepEqual(resolutionOf([fix, failed], { ...failed, createdAt: "2026-10-12T10:15:00Z" }), { fix: null, passed: null });
});

test("coordination events read as lines of the feed", () => {
  const claimed = feedLine(event("work.claimed", { repoId: "rep_1", number: 2, issue: 2, claim: claim(2, { actor: bo, harness: "codex" }), others: [claim(2)] }))!;
  assert.equal(claimed.who, "bo");
  assert.equal(claimed.harness, "codex");
  assert.equal(claimed.text, "claimed #2 (ana is on it too)");
  assert.equal(claimed.tone, "warn");

  const failed = feedLine(
    event("integration.failed", {
      repoId: "rep_1", pullId: "pul_5", number: 5, pull: 5, issue: 2, combination: [4, 5],
      check: { name: "CI / merge_group", conclusion: "failure", url: null }, bisected: false, suspects: [4], otherPulls: [4], commit: null,
    }),
  )!;
  assert.equal(failed.who, null);
  assert.equal(failed.text, "#5 failed in the merge queue combined as #4, #5: CI / merge_group; fails with #4");
  assert.equal(failed.tone, "danger");

  const unblocked = feedLine(
    event("dependency.changed", { repoId: "rep_1", number: 2, issue: 2, blockedBy: [1], added: [], removed: [], cleared: [1], remaining: [], mergedPull: 4 }),
  )!;
  assert.equal(unblocked.text, "#2 #1 landed (#4 merged); unblocked");

  const overlap = feedLine(event("overlap.detected", { repoId: "rep_1", number: 5, pull: 5, otherPull: 4, files: ["src/auth.rs"] }))!;
  assert.equal(overlap.text, "#5 and #4 change the same file: src/auth.rs");
  assert.equal(overlap.session, undefined);

  const sessions = feedLine(
    event("overlap.detected", { repoId: "rep_1", sessionId: "ses_a", otherSessionId: "ses_b", otherActor: "bo", files: ["a.rs", "b.rs", "c.rs", "d.rs"], issue: 2 }),
  )!;
  assert.equal(sessions.who, "bo");
  assert.equal(sessions.text, "touched the same files in a session as another session: a.rs, b.rs, c.rs and 1 more");
  assert.equal(sessions.session, "ses_a");
  assert.equal(sessions.number, 2);
  assert.equal(feedLine(event("session.progressed", { repoId: "rep_1", number: 2, sessionId: "ses_a" })), null);

  const started = feedLine(event("session.started", { repoId: "rep_1", session: session("ses_a", { issue: 2 }) }))!;
  assert.equal(started.text, "started a session on #2");
  assert.equal(feedLine(event("session.appended", { repoId: "rep_1", number: 5, pullId: "p", count: 3 })), null);
});

test("sessions become trees by their parents; one whose parent is missing is a root", () => {
  const roots = sessionTree([
    session("ses_root"),
    session("ses_a", { parentId: "ses_root" }),
    session("ses_a1", { parentId: "ses_a" }),
    session("ses_b", { parentId: "ses_root" }),
    session("ses_orphan", { parentId: "ses_gone" }),
    session("ses_other"),
  ]);
  const shape = (nodes: ReturnType<typeof sessionTree>): unknown[] => nodes.map((node) => [node.session.id, shape(node.children)]);
  assert.deepEqual(shape(roots), [
    ["ses_root", [["ses_a", [["ses_a1", []]]], ["ses_b", []]]],
    ["ses_orphan", []],
    ["ses_other", []],
  ]);
  assert.equal(treeSize(roots[0]!), 3);
  // A child listed before its parent still lands under it.
  assert.deepEqual(shape(sessionTree([session("ses_c", { parentId: "ses_p" }), session("ses_p")])), [["ses_p", [["ses_c", []]]]]);
  // A cycle does not lose sessions.
  const cycle = sessionTree([session("ses_x", { parentId: "ses_y" }), session("ses_y", { parentId: "ses_x" })]);
  assert.equal(cycle.length + cycle.reduce((n, node) => n + treeSize(node), 0), 2);
  assert.deepEqual(sessionTree([]), []);
  assert.deepEqual(
    mergeSessions([session("ses_a"), session("ses_b")], null, [session("ses_b", { title: "later" }), session("ses_c")]).map((one) => [one.id, one.title]),
    [
      ["ses_a", null],
      ["ses_b", null],
      ["ses_c", null],
    ],
  );
});

test("how a session was tied to its work, what it touched, and how long it ran", () => {
  assert.equal(viaLabel("attached"), "attached");
  assert.equal(viaLabel("claim"), "claimed");
  assert.equal(viaLabel("branch"), "its branch");
  assert.equal(viaLabel("commit"), "its commit");
  assert.equal(viaLabel("trailer"), "commit trailer");
  assert.equal(viaLabel("opened"), "opened it");
  assert.equal(viaLabel("ref"), "named it");
  assert.deepEqual(
    touchedByKind([
      { kind: "commit", value: "abc" },
      { kind: "file", value: "b.rs" },
      { kind: "file", value: "a.rs" },
      { kind: "file", value: "b.rs" },
    ]),
    [
      { kind: "file", values: ["b.rs", "a.rs"] },
      { kind: "commit", values: ["abc"] },
    ],
  );
  const now = Date.parse("2026-10-12T10:30:00Z");
  assert.equal(duration(session("ses_a"), now), "30m");
  assert.equal(duration(session("ses_a", { state: "ended", endedAt: "2026-10-12T10:00:42Z" }), now), "42s");
  assert.equal(duration(session("ses_a", { state: "ended", endedAt: null }), now), "5m");
});

test("numbers in a sentence are found for linking", () => {
  assert.deepEqual(numberedParts("#5 fails with #4."), [5, " fails with ", 4, "."]);
  assert.deepEqual(numberedParts("no numbers"), ["no numbers"]);
});

test("blocked_by is typed as numbers", () => {
  assert.deepEqual(parseBlockedBy("#12, 14 #12"), [12, 14]);
  assert.deepEqual(parseBlockedBy(""), []);
  assert.equal(parseBlockedBy("#12, soon"), null);
  assert.equal(parseBlockedBy("0"), null);
});
