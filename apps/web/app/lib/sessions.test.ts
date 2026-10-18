import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkSession, WorkspaceSession } from "@g1t/contracts";

import {
  narrowed,
  onItemSessionTitle,
  peopleIn,
  repoName,
  runsIn,
  sessionCost,
  sessionHref,
  sessionsFilters,
  sessionsQuery,
  splitLive,
  workspaceSessionTitle,
} from "./sessions.ts";

function listed(id: string, more: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    kind: "harness",
    id,
    repo: "acme/web",
    repoId: "rep_1",
    title: null,
    actor: "ana",
    harness: "claude_code",
    agent: null,
    branch: "main",
    item: null,
    itemTitle: null,
    pull: null,
    pullTitle: null,
    pullStatus: null,
    state: "active",
    startedAt: "2026-10-17T10:00:00Z",
    lastActivityAt: "2026-10-17T11:00:00Z",
    subagents: 0,
    step: null,
    session: null,
    ...more,
  };
}

const own = (more: Partial<WorkSession> = {}): WorkSession =>
  ({
    id: "ses_1",
    repoId: "rep_1",
    item: null,
    pull: null,
    branch: "fix-it",
    actor: { id: "u", username: "ana" },
    harness: "codex",
    harnessSessionId: null,
    title: null,
    state: "active",
    headCommit: null,
    startedAt: "",
    lastSeenAt: "",
    endedAt: null,
    endReason: null,
    ...more,
  }) as WorkSession;

test("every kind of session opens where it is shown", () => {
  assert.equal(sessionHref("Acme", listed("ses_1")), "/acme/-/work/sessions/ses_1");
  assert.equal(sessionHref("acme", listed("ses_2", { kind: "hosted", harness: "claude_managed_agents" })), "/acme/-/work/sessions/ses_2");
  // g1t's agent and a recorded session are their pull request's Session tab.
  assert.equal(sessionHref("acme", listed("run_1", { kind: "agent", repo: "acme/api", pull: 8 })), "/acme/api/pull/8/session");
  assert.equal(sessionHref("acme", listed("pr_1", { kind: "recorded", pull: 7 })), "/acme/web/pull/7/session");
  assert.equal(sessionHref("acme", listed("run_2", { kind: "agent", pull: null })), null);
});

test("a session is named by its title, its subagent task, its pull request, never nothing", () => {
  assert.equal(workspaceSessionTitle(listed("a", { session: own({ title: "Fix login" }) })), "Fix login");
  assert.equal(workspaceSessionTitle(listed("b", { session: own() })), "Session on fix-it");
  assert.equal(
    workspaceSessionTitle(listed("c", { session: own({ parentId: "ses_0", agentType: "Explore", task: "Find endpoints" }) })),
    "Explore: Find endpoints",
  );
  assert.equal(workspaceSessionTitle(listed("d", { kind: "recorded", pull: 7, pullTitle: "Retry hooks" })), "Retry hooks");
  assert.equal(workspaceSessionTitle(listed("e", { kind: "agent", pull: 7 })), "Pull request #7");
  assert.equal(runsIn(listed("f")), "Claude Code");
  assert.equal(runsIn(listed("g", { kind: "agent", harness: null, agent: "g1t" })), "g1t's agent");
  assert.equal(runsIn(listed("h", { kind: "recorded", harness: null, agent: "cursor" })), "cursor, recorded");
});

test("on a work item's card, a session with no title says what it is on, never a bare pull request number", () => {
  assert.equal(onItemSessionTitle(listed("a", { session: own({ title: "Fix login" }) })), "Fix login");
  assert.equal(onItemSessionTitle(listed("d", { kind: "recorded", pull: 7, pullTitle: "Retry hooks" })), "Retry hooks");
  assert.equal(onItemSessionTitle(listed("e", { kind: "agent", pull: 158 })), "On pull request #158");
  assert.equal(onItemSessionTitle(listed("f", { kind: "agent", pull: null })), "Working on it");
});

test("Sessions keeps its filters in the address and drops what it does not know", () => {
  const filters = sessionsFilters(new URLSearchParams("repo=web&person=@bo&harness=codex&kind=bogus&state=recent"));
  assert.deepEqual(filters, { state: "recent", repo: "web", person: "bo", harness: "codex", kind: null, item: null });
  assert.equal(sessionsQuery(filters), "?state=recent&repo=web&person=bo&harness=codex");
  assert.equal(sessionsQuery({ state: "live" }), "");
  assert.equal(narrowed(filters), true);
  assert.equal(narrowed(sessionsFilters(new URLSearchParams("state=recent"))), false);
});

test("Sessions can be a work item's own: ?item=12", () => {
  const filters = sessionsFilters(new URLSearchParams("state=recent&item=12"));
  assert.equal(filters.item, 12);
  assert.equal(narrowed(filters), true);
  assert.equal(sessionsQuery(filters), "?state=recent&item=12");
  for (const bad of ["0", "-3", "x", "1.5"]) assert.equal(sessionsFilters(new URLSearchParams(`item=${bad}`)).item, null, bad);
});

test("live sessions come apart from those that ended, most recently heard from first", () => {
  const sessions = [
    listed("old", { state: "ended" }),
    listed("idle", { state: "idle" }),
    listed("a", { lastActivityAt: "2026-10-17T09:00:00Z", actor: "bo" }),
    listed("b", { lastActivityAt: "2026-10-17T11:30:00Z", actor: "bo" }),
  ];
  const { active, idle, ended } = splitLive(sessions);
  assert.deepEqual(
    active.map((session) => session.id),
    ["b", "a"],
  );
  assert.deepEqual(
    idle.map((session) => session.id),
    ["idle"],
  );
  assert.deepEqual(
    ended.map((session) => session.id),
    ["old"],
  );
  assert.deepEqual(peopleIn(sessions), ["ana", "bo"]);
  assert.equal(repoName("acme/web", "Acme"), "web");
  assert.equal(repoName("other/web", "acme"), "other/web");
});

test("a session's cost reads as an estimate at list price, and says when some usage is priced as unknown", () => {
  assert.equal(sessionCost({ costUsd: 4.1234 }), "≈ $4.12 at list price");
  assert.equal(sessionCost({ costUsd: 1234.5, costPartial: true }), "≈ $1,234.50 at list price, some usage priced as unknown");
  assert.equal(sessionCost({ costUsd: 0.004 }), "≈ under $0.01 at list price");
  assert.equal(sessionCost({ costUsd: 0 }), "≈ $0.00 at list price");
  assert.equal(sessionCost({ costUsd: null, costPartial: true }), "Usage priced as unknown");
  assert.equal(sessionCost({ costUsd: null }), null);
  assert.equal(sessionCost({}), null);
  assert.equal(sessionCost(null), null);
});
