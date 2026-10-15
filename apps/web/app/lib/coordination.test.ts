import assert from "node:assert/strict";
import { test } from "node:test";

import type { Claim, Decision, G1tEvent, WorkSession } from "@g1t/contracts";

import {
  ENDED_BY_HAND,
  checkHref,
  endReasonText,
  evidenceOf,
  expiresIn,
  feedLine,
  harnessName,
  intentTitle,
  awakeAndIdle,
  liveByIssue,
  sessionTitle,
  duration,
  mayEndSession,
  mergeSessions,
  numberedParts,
  parseBlockedBy,
  pendingLines,
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

test("Live now lists sessions heard from lately and folds away the idle, the latest first", () => {
  const { awake, idle } = awakeAndIdle([
    session("ses_a", { state: "active" }),
    session("ses_b", { state: "idle", title: "Tidy the README", lastSeenAt: "2026-10-12T10:00:00Z" }),
    session("ses_c", { state: "idle", lastSeenAt: "2026-10-12T10:10:00Z" }),
  ]);
  assert.deepEqual(awake.map((one) => one.id), ["ses_a"]);
  assert.deepEqual(idle.map((one) => one.id), ["ses_c", "ses_b"]);
  // A tab opened and never typed in is in neither; once it says what it is for, it shows.
  const opened = session("ses_d", { state: "active", title: null, startedAt: "2026-10-12T10:00:00Z", lastSeenAt: "2026-10-12T10:00:00Z" });
  assert.deepEqual(awakeAndIdle([opened]), { awake: [], idle: [] });
  assert.equal(awakeAndIdle([{ ...opened, lastSeenAt: "2026-10-12T10:00:05Z" }]).awake.length, 1);
  assert.equal(awakeAndIdle([{ ...opened, title: "Fix the build" }]).awake.length, 1);
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

test("sessions on no issue are grouped by pull request, then by a branch of their own, then the rest together", () => {
  const seen = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, "0")}:00Z`;
  const { issues, groups, loose } = liveByIssue(
    [],
    [
      session("ses_main", { branch: "main", lastSeenAt: seen(50) }),
      session("ses_fix1", { branch: "fix-previews", lastSeenAt: seen(10) }),
      session("ses_pr", { pull: 12, branch: "tidy-readme", lastSeenAt: seen(20) }),
      session("ses_fix2", { branch: "fix-previews", lastSeenAt: seen(40) }),
      session("ses_none", { lastSeenAt: seen(30) }),
      session("ses_issue", { issue: 3, branch: "3-x", lastSeenAt: seen(5) }),
    ],
    "main",
  );
  assert.deepEqual(issues.map((group) => group.issue), [3]);
  assert.deepEqual(
    groups.map((group) => [group.kind === "pull" ? `#${group.pull}` : group.kind === "branch" ? group.branch : "none", group.sessions.map((one) => one.id)]),
    [
      // The most recently heard from first; the rest, on no branch of their own (the default branch is none), last.
      ["fix-previews", ["ses_fix2", "ses_fix1"]],
      ["#12", ["ses_pr"]],
      ["none", ["ses_main", "ses_none"]],
    ],
  );
  assert.deepEqual(loose.map((one) => one.id), ["ses_fix2", "ses_fix1", "ses_pr", "ses_main", "ses_none"]);
  // Without the default branch known, its sessions are a branch's.
  assert.equal(liveByIssue([], [session("ses_main", { branch: "main" })]).groups[0].kind, "branch");
});

test("a session is never title-less: its title, its first prompt's intent, its branch, or untitled", () => {
  assert.equal(sessionTitle({ title: "Rewrite the auth flow", branch: "auth", firstPrompt: "fix it" }), "Rewrite the auth flow");
  // A title that is only a pasted block's tag reads as none: the first prompt's words title it.
  assert.equal(sessionTitle({ title: '<pasted_content id="5c50">', branch: "main", firstPrompt: '<pasted_content id="5c50">\nlog\n</pasted_content>\nship the runner setup' }), "Ship the runner setup");
  assert.equal(sessionTitle({ title: '<pasted_content id="5c50">', branch: "main", firstPrompt: null }), "Session on main");
  assert.equal(sessionTitle({ title: null, branch: "auth", firstPrompt: "fix the login redirect. It loops." }), "Fix the login redirect");
  assert.equal(sessionTitle({ title: "  ", branch: "auth", firstPrompt: "/clear" }), "Session on auth");
  assert.equal(sessionTitle({ title: null, branch: null }), "Untitled session");
  assert.equal(sessionTitle({ title: null, branch: null }, "look at the CI"), "Look at the CI", "a first prompt given stands in");
});

test("a prompt's intent is its first line or sentence, plain, clipped on a word", () => {
  assert.equal(intentTitle("Make preview builds faster. They time out on big repositories."), "Make preview builds faster");
  // What an editor puts ahead of the prompt is not the prompt.
  assert.equal(intentTitle("<ide_opened_file>The user opened a.ts in the IDE.</ide_opened_file>\nWhy is the page crashing?"), "Why is the page crashing?");
  assert.equal(intentTitle("Why does `src/app.ts` fail? It worked yesterday."), "Why does src/app.ts fail?");
  assert.equal(intentTitle("```js\nconst a = 1;\n```\n## Clean **this** up\nmore"), "Clean this up");
  assert.equal(intentTitle("\n\n- look at [the docs](https://docs.g1t.sh) for g1t.mjs"), "Look at the docs for g1t.mjs");
  const long = intentTitle("Tidy up the README and then look at the CI pipeline, which keeps failing on the Windows runners every night")!;
  assert.ok(long.length <= 80 && long.endsWith("…") && !long.endsWith(" …"), long);
  for (const prompt of ["/clear", "/g1t:status 4", "<command-name>/clear</command-name>", "```\ncode only\n```", "?", "", null]) {
    assert.equal(intentTitle(prompt), null, String(prompt));
  }
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

test("a session is ended by hand by whoever runs it, or by anyone who can write", () => {
  const live = session("ses_a");
  assert.equal(mayEndSession(live, bo.id, false), true);
  assert.equal(mayEndSession(live, ana.id, false), false);
  assert.equal(mayEndSession(live, ana.id, true), true);
  assert.equal(mayEndSession(session("ses_b", { state: "idle" }), ana.id, true), true);
  // Ended already, or nobody signed in: nothing to offer.
  assert.equal(mayEndSession(session("ses_c", { state: "ended" }), bo.id, true), false);
  assert.equal(mayEndSession(live, null, true), false);
  // One g1t runs is stopped from its page, which stops the run too.
  assert.equal(mayEndSession(session("ses_d", { harness: "claude_managed_agents" }), bo.id, true), false);
  assert.equal(endReasonText("timed_out"), "timed out");
  assert.equal(endReasonText(`${ENDED_BY_HAND}ana`), "ended by hand by @ana");
  assert.equal(endReasonText(null), null);
});

test("a session ended by hand says who ended it in the feed", () => {
  const own = feedLine(event("session.ended", { repoId: "rep_1", session: session("ses_a", { issue: 2, state: "ended", endReason: `${ENDED_BY_HAND}bo` }) }))!;
  assert.equal(own.who, "bo");
  assert.equal(own.text, "ended a session on #2 by hand");
  const theirs = feedLine(event("session.ended", { repoId: "rep_1", session: session("ses_a", { state: "ended", endReason: `${ENDED_BY_HAND}ana` }) }))!;
  assert.equal(theirs.who, "ana");
  assert.equal(theirs.harness, null);
  assert.equal(theirs.text, "ended bo's session by hand");
  const timedOut = feedLine(event("session.ended", { repoId: "rep_1", session: session("ses_a", { state: "ended", endReason: "timed_out" }) }))!;
  assert.equal(timedOut.text, "ended a session (timed out)");
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

test("a session's pending updates read as the feed does, leaving out what it does not show", () => {
  const lines = pendingLines([
    { id: "upd_1", kind: "work.claimed", at: "2026-10-14T10:00:00Z", data: { repoId: "rep_1", number: 4, issue: 4, claim: claim(4, { actor: bo, harness: "codex" }) } },
    { id: "upd_2", kind: "session.progressed", at: "2026-10-14T10:00:01Z", data: {} },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, "upd_1");
  assert.equal(lines[0].who, "bo");
  assert.match(lines[0].text, /claimed #4/);
});
