import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FALLBACK_FOCUS_MS,
  FALLBACK_POLL_MS,
  LIVE_DEBOUNCE_MS,
  LIVE_HOLD_CHECK_MS,
  LIVE_MAX_WAIT_MS,
  LIVE_MIN_GAP_MS,
  type RepoChange,
  atBottom,
  branchOf,
  fallbackDue,
  gate,
  isTyping,
  newCommits,
  repoPages,
  tagOf,
} from "./repo-live.ts";

const AT = "2026-10-11T10:00:00Z";
const NOW = Date.parse(AT);

function change(kind: string, more: Partial<RepoChange> = {}): RepoChange {
  return { repo_id: "rep_1", repo: "acme/rocket", kind, at: AT, ...more };
}

const push = (branch: string, commits?: number) => change("git.push", { ref: `refs/heads/${branch}`, sha: "abc", commits: commits ?? null });

test("refs name their branch or tag", () => {
  assert.equal(branchOf("refs/heads/feature/x"), "feature/x");
  assert.equal(branchOf("refs/tags/v1"), null);
  assert.equal(tagOf("refs/tags/v1.2"), "v1.2");
  assert.equal(tagOf(null), null);
});

test("a project's overview follows what it runs, who is working on it and what may need someone, not every push", () => {
  const overview = repoPages.overview();
  for (const c of [
    change("deployment_status.created"),
    change("status.created", { sha: "abc" }),
    change("release.published"),
    change("work.claimed", { number: 3 }),
    change("session.started"),
    change("session.progressed"),
    change("pull.ready", { number: 4 }),
    change("review.completed", { number: 4 }),
  ]) {
    assert.equal(overview(c), true, c.kind);
  }
  assert.equal(overview(push("feature")), false);
  assert.equal(overview(change("comment.created", { number: 3 })), false);
});

test("the overview hears its own commit's checks, and every pull request's finished ones", () => {
  const overview = repoPages.overview("abc");
  assert.equal(overview(change("status.created", { sha: "abc" })), true);
  assert.equal(overview(change("run.updated", { sha: "abc", run: "run_1" })), true);
  assert.equal(overview(change("status.created", { sha: "f00d" })), false, "another commit's");
  assert.equal(overview(change("run.updated", { sha: "f00d", run: "run_2" })), false);
  assert.equal(overview(change("checks.completed", { sha: "f00d", number: 4 })), true, "how often checks pass");
  assert.equal(overview(change("status.created")), true, "a check that names no commit may be its");
});

test("the files page follows refs, checks, releases and deployments", () => {
  const files = repoPages.files();
  for (const c of [push("main"), push("other"), change("git.deleted", { ref: "refs/heads/old" }), change("status.created", { sha: "abc" }), change("release.published"), change("deployment_status.created")]) {
    assert.equal(files(c), true, c.kind);
  }
  assert.equal(files(change("issue.opened", { number: 3 })), false);
  assert.equal(files(change("comment.created", { number: 3 })), false);
});

test("a page of files hears its own branch and its commit's checks, not every branch's", () => {
  const files = repoPages.files({ branch: "main", branches: ["main", "feature"], sha: "abc" });
  assert.equal(files(push("main")), true, "its files and latest commit");
  assert.equal(files(push("feature")), false, "another branch moving changes nothing here");
  assert.equal(files(push("brand-new")), true, "a new branch: the menu and count");
  assert.equal(files(change("git.deleted", { ref: "refs/heads/feature" })), true, "one of the menu's gone");
  assert.equal(files(change("git.deleted", { ref: "refs/heads/never-listed" })), false);
  assert.equal(files(change("git.push", { ref: "refs/tags/v2" })), true, "the About's tags");
  assert.equal(files(change("branch.renamed", { ref: "refs/heads/feature" })), true);
  assert.equal(files(change("repo.default_branch_changed")), true);
  assert.equal(files(change("status.created", { sha: "abc" })), true, "its latest commit's checks");
  assert.equal(files(change("check_run.completed", { sha: "f00d" })), false, "another commit's checks");
  assert.equal(files(change("run.updated", { run: "run_1" })), true, "a check that names no commit may be its");
  assert.equal(files(change("deployment_status.created")), true);
  assert.equal(files(change("release.published")), true);
  // A tag or a commit shown: no branch of its own moves it.
  const tag = repoPages.files({ branch: null, branches: ["main"], sha: "abc" });
  assert.equal(tag(push("main")), false);
  // Without the branches, any branch may be new: only its own and deletions count.
  const unknown = repoPages.files({ branch: "main", branches: null, sha: "abc" });
  assert.equal(unknown(push("other")), false);
  assert.equal(unknown(change("git.deleted", { ref: "refs/heads/other" })), true);
});

test("the commits page hears pushes to its own branch only", () => {
  const commits = repoPages.commits("main");
  assert.equal(commits(push("main")), true);
  assert.equal(commits(push("feature")), false);
  assert.equal(commits(change("git.push", { ref: "refs/tags/v1" })), false);
  assert.equal(commits(change("workflow.completed", { sha: "abc", run: "run_1" })), true, "checks on its commits");
  assert.equal(commits(change("pull.opened", { number: 1 })), false);
  const shown = repoPages.commits("main", ["abc", "def"]);
  assert.equal(shown(change("status.created", { sha: "def" })), true, "checks on a commit it lists");
  assert.equal(shown(change("status.created", { sha: "f00d" })), false, "not on one it does not");
});

test("branches, tags, and the lists of pull requests and issues", () => {
  assert.equal(repoPages.refs()(push("x")), true);
  assert.equal(repoPages.refs()(change("pull.opened", { number: 1 })), true);
  assert.equal(repoPages.refs()(change("issue.opened", { number: 1 })), false);
  assert.equal(repoPages.tags()(change("git.push", { ref: "refs/tags/v2" })), true);
  assert.equal(repoPages.tags()(push("main")), false);
  assert.equal(repoPages.tags()(change("release.published")), true);
  assert.equal(repoPages.pulls()(change("pull.updated", { number: 4 })), true);
  assert.equal(repoPages.pulls()(change("review.completed", { number: 4 })), true);
  assert.equal(repoPages.pulls()(change("issue.opened", { number: 5 })), false);
  assert.equal(repoPages.issues()(change("issue.closed", { number: 5 })), true);
  assert.equal(repoPages.issues()(change("comment.created", { number: 5 })), true);
  assert.equal(repoPages.issues()(change("pull.merged", { number: 6 })), true, "a merge may close issues");
  assert.equal(repoPages.issues()(push("main")), false);
});

test("a pull request hears its own changes, its head branch and its head's checks", () => {
  const pull = repoPages.pull(7, { branch: "feature", sha: "f00d" });
  assert.equal(pull(change("pull.updated", { number: 7 })), true);
  assert.equal(pull(change("comment.created", { number: 7 })), true);
  assert.equal(pull(change("review.completed", { number: 7 })), true);
  assert.equal(pull(change("checks.completed", { number: 7, sha: "f00d" })), true);
  assert.equal(pull(change("pull.merged", { number: 7 })), true);
  assert.equal(pull(push("feature")), true, "new commits");
  assert.equal(pull(change("status.created", { sha: "f00d" })), true);
  assert.equal(pull(change("run.updated", { run: "run_1", number: 7 })), true, "a run for it");
  assert.equal(pull(change("comment.created", { number: 8 })), false);
  assert.equal(pull(push("main")), false);
  assert.equal(pull(change("status.created", { sha: "beef" })), false);
});

test("an issue hears its own changes and its linked pull requests", () => {
  const issue = repoPages.issue(3, [9]);
  assert.equal(issue(change("comment.created", { number: 3 })), true);
  assert.equal(issue(change("issue.closed", { number: 3 })), true);
  assert.equal(issue(change("pull.merged", { number: 9 })), true);
  assert.equal(issue(change("comment.created", { number: 4 })), false);
  assert.equal(issue(push("main")), false);
});

test("the Work page hears claims, sessions starting and ending, what the queue finds, and merges", () => {
  const page = repoPages.work();
  for (const kind of ["work.claimed", "work.claim_expired", "session.started", "session.ended", "dependency.changed", "overlap.detected", "integration.failed", "decision.recorded", "queue.changed", "pull.merged"]) {
    assert.equal(page(change(kind, { number: 3 })), true, kind);
  }
  assert.equal(page(change("session.progressed")), true, "a session going on");
  assert.equal(page(change("session.appended", { number: 3 })), false);
  assert.equal(page(change("comment.created", { number: 3 })), false);
  assert.equal(page(push("main")), false);
  // An issue hears coordination about itself and its pull requests by number.
  assert.equal(repoPages.issue(3, [9])(change("integration.failed", { number: 9 })), true);
});

test("a session going on reaches the issue and pull request it is on, and no other", () => {
  assert.equal(repoPages.issue(3, [9])(change("session.progressed", { number: 3 })), true);
  assert.equal(repoPages.issue(3, [9])(change("session.progressed", { number: 9 })), true);
  assert.equal(repoPages.issue(3)(change("session.progressed", { number: 4 })), false);
  assert.equal(repoPages.issue(3)(change("session.progressed")), false);
  assert.equal(repoPages.pull(9)(change("session.progressed", { number: 9 })), true);
  assert.equal(repoPages.pull(9)(change("session.progressed", { number: 3 })), false);
  assert.equal(repoPages.pull(9)(change("session.progressed")), false);
});

test("a session's page hears every session, claim and overlap in the repository", () => {
  const page = repoPages.session();
  for (const kind of ["session.started", "session.progressed", "session.ended", "work.claimed", "work.released", "overlap.detected"]) {
    assert.equal(page(change(kind)), true, kind);
  }
  assert.equal(page(change("comment.created", { number: 3 })), false);
  assert.equal(page(change("pull.merged", { number: 3 })), false);
  assert.equal(page(push("main")), false);
});

test("runs, one run, and security", () => {
  assert.equal(repoPages.runs()(change("run.updated", { run: "run_1" })), true);
  assert.equal(repoPages.runs()(change("status.created", { sha: "abc" })), true, "a new run reports pending on its commit");
  assert.equal(repoPages.runs()(change("issue.opened", { number: 1 })), false);
  const run = repoPages.run("run_1", "abc");
  assert.equal(run(change("run.updated", { run: "run_1" })), true);
  assert.equal(run(change("workflow.completed", { run: "run_1" })), true);
  assert.equal(run(change("run.updated", { run: "run_2" })), false);
  assert.equal(run(change("status.created", { sha: "abc" })), true);
  assert.equal(repoPages.security()(change("secret_scanning_alert.created")), true);
  assert.equal(repoPages.security()(change("code_scanning_alert.fixed", { number: 2 })), true);
  assert.equal(repoPages.security()(change("issue.opened", { number: 1 })), false);
});

test("new commits are counted, and uncounted when a push was not", () => {
  assert.equal(newCommits([push("main", 2), push("main", 3), push("other", 9)], "main"), 5);
  assert.equal(newCommits([push("main", 2), push("main")], "main"), null);
  assert.equal(newCommits([change("status.created")], "main"), 0);
});

test("a change waits a second for more, five at most, then refreshes", () => {
  const idle = { now: NOW, visible: true, busy: false, navigating: false };
  assert.deepEqual(gate({ pendingSince: null, lastChangeAt: null, lastRunAt: null }, idle), { action: "idle" });
  assert.deepEqual(gate({ pendingSince: NOW, lastChangeAt: NOW, lastRunAt: null }, idle), { action: "wait", ms: LIVE_DEBOUNCE_MS });
  assert.deepEqual(gate({ pendingSince: NOW, lastChangeAt: NOW, lastRunAt: null }, { ...idle, now: NOW + LIVE_DEBOUNCE_MS }), { action: "run" });
  // A steady stream: refreshed after five seconds anyway.
  const stream = { pendingSince: NOW, lastChangeAt: NOW + LIVE_MAX_WAIT_MS - 100, lastRunAt: null };
  assert.deepEqual(gate(stream, { ...idle, now: NOW + LIVE_MAX_WAIT_MS - 50 }), { action: "wait", ms: 50 });
  assert.deepEqual(gate(stream, { ...idle, now: NOW + LIVE_MAX_WAIT_MS }), { action: "run" });
});

test("never under someone typing, a dialog, or a navigation: it waits for them", () => {
  const due = { pendingSince: NOW - 10_000, lastChangeAt: NOW - 10_000, lastRunAt: null };
  for (const held of [{ busy: true, navigating: false }, { busy: false, navigating: true }]) {
    assert.deepEqual(gate(due, { now: NOW, visible: true, ...held }), { action: "wait", ms: LIVE_HOLD_CHECK_MS });
  }
  assert.deepEqual(gate(due, { now: NOW, visible: true, busy: false, navigating: false }), { action: "run" });
});

test("a burst of changes refreshes at most every two seconds", () => {
  const idle = { now: NOW, visible: true, busy: false, navigating: false };
  // Quiet for a second, but the page refreshed half a second ago: it waits out the gap.
  const justRan = { pendingSince: NOW - LIVE_DEBOUNCE_MS, lastChangeAt: NOW - LIVE_DEBOUNCE_MS, lastRunAt: NOW - 500 };
  assert.deepEqual(gate(justRan, idle), { action: "wait", ms: LIVE_MIN_GAP_MS - 500 });
  assert.deepEqual(gate(justRan, { ...idle, now: NOW - 500 + LIVE_MIN_GAP_MS }), { action: "run" });
  // A steady stream after a refresh: one more at most five seconds on, never sooner than the gap.
  const stream = { pendingSince: NOW - LIVE_MAX_WAIT_MS, lastChangeAt: NOW, lastRunAt: NOW - LIVE_MAX_WAIT_MS - 10 };
  assert.deepEqual(gate(stream, idle), { action: "run" });
  // Changes arriving every 100 ms for a minute refresh no more than once per gap.
  let state = { pendingSince: null as number | null, lastChangeAt: null as number | null, lastRunAt: NOW };
  let runs = 0;
  for (let t = NOW; t < NOW + 60_000; t += 100) {
    state = { ...state, pendingSince: state.pendingSince ?? t, lastChangeAt: t };
    if (gate(state, { ...idle, now: t }).action === "run") {
      runs++;
      state = { pendingSince: null, lastChangeAt: null, lastRunAt: t };
    }
  }
  assert.ok(runs <= 60_000 / LIVE_MIN_GAP_MS, `${runs} runs`);
  assert.ok(runs >= 60_000 / LIVE_MAX_WAIT_MS - 1, `${runs} runs: still kept up to date`);
});

test("a tab out of view never refreshes; back in view, it catches up at once", () => {
  const hidden = { now: NOW, visible: false, busy: false, navigating: false };
  const waiting = { pendingSince: NOW - 5000, lastChangeAt: NOW - 5000, lastRunAt: NOW - 20 * 60_000 };
  assert.deepEqual(gate(waiting, hidden), { action: "hold" }, "no timer: coming back asks again");
  assert.deepEqual(gate({ pendingSince: null, lastChangeAt: null, lastRunAt: null }, hidden), { action: "idle" });
  assert.deepEqual(gate(waiting, { ...hidden, visible: true }), { action: "run" });
});

test("without the socket: back in view every 30 s at most, a poll every minute in view, never with it", () => {
  const base = { live: false, visible: true, now: NOW };
  assert.equal(fallbackDue({ ...base, lastRunAt: null, reason: "focus" }), true);
  assert.equal(fallbackDue({ ...base, lastRunAt: NOW - FALLBACK_FOCUS_MS + 1, reason: "focus" }), false);
  assert.equal(fallbackDue({ ...base, lastRunAt: NOW - FALLBACK_FOCUS_MS, reason: "focus" }), true);
  assert.equal(fallbackDue({ ...base, lastRunAt: NOW - FALLBACK_FOCUS_MS, reason: "poll" }), false);
  assert.equal(fallbackDue({ ...base, lastRunAt: NOW - FALLBACK_POLL_MS, reason: "poll" }), true);
  assert.equal(fallbackDue({ ...base, visible: false, lastRunAt: null, reason: "poll" }), false, "a hidden tab is not polled");
  assert.equal(fallbackDue({ ...base, live: true, lastRunAt: null, reason: "focus" }), false);
});

test("typing is in text boxes, text areas and editors", () => {
  assert.equal(isTyping({ tagName: "TEXTAREA" }), true);
  assert.equal(isTyping({ tagName: "input", type: "text" }), true);
  assert.equal(isTyping({ tagName: "INPUT", type: "search" }), true);
  assert.equal(isTyping({ tagName: "INPUT" }), true, "an input is text unless it says otherwise");
  assert.equal(isTyping({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTyping({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTyping({ tagName: "BUTTON" }), false);
  assert.equal(isTyping({ tagName: "TEXTAREA", readOnly: true }), false);
  assert.equal(isTyping(null), false);
});

test("the bottom of the page, with some slack", () => {
  assert.equal(atBottom({ top: 880, height: 2000, viewport: 1000 }), true);
  assert.equal(atBottom({ top: 500, height: 2000, viewport: 1000 }), false);
});
