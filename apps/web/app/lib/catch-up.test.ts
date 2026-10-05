import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRun } from "@g1t/contracts";

import { CATCH_UP_TIMEOUT_MS, catchUpPhase, catchUpRun, catchUpTitle, catchUpWhy } from "./catch-up.ts";

const START = Date.parse("2026-10-05T12:00:00Z");

function run(kind: AgentRun["kind"], status: AgentRun["status"], createdAt: string): AgentRun {
  return {
    id: `run-${kind}-${createdAt}`,
    repo: { namespace: "acme", name: "app" },
    number: 7,
    title: null,
    kind,
    agent: "g1t-agent",
    model: null,
    status,
    step: null,
    steps: [],
    stepCount: 0,
    startedBy: "octo",
    error: null,
    costUsd: null,
    turns: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
    updatedAt: createdAt,
  };
}

test("the update run for a request is the newest one since it was made", () => {
  const runs = [
    run("update", "failed", "2026-10-05T11:00:00Z"),
    run("review", "running", "2026-10-05T12:00:05Z"),
    run("update", "running", "2026-10-05T12:00:03Z"),
  ];
  assert.equal(catchUpRun(runs, START)?.createdAt, "2026-10-05T12:00:03Z");
  assert.equal(catchUpRun(runs.slice(0, 2), START), null);
});

test("it is done as soon as the pull request is no longer behind", () => {
  assert.equal(catchUpPhase({ behind: false, run: null, startedAt: START, now: START + 1000 }), "done");
  const failed = run("update", "failed", "2026-10-05T12:00:03Z");
  assert.equal(catchUpPhase({ behind: false, run: failed, startedAt: START, now: START }), "done");
});

test("a run that ended while still behind failed", () => {
  for (const status of ["failed", "stopped"] as const) {
    const ended = run("update", status, "2026-10-05T12:00:03Z");
    assert.equal(catchUpPhase({ behind: true, run: ended, startedAt: START, now: START + 60_000 }), "failed");
  }
});

test("it never waits forever", () => {
  const going = run("update", "running", "2026-10-05T12:00:03Z");
  assert.equal(catchUpPhase({ behind: true, run: going, startedAt: START, now: START + 60_000 }), "working");
  assert.equal(catchUpPhase({ behind: true, run: null, startedAt: START, now: START + CATCH_UP_TIMEOUT_MS + 1 }), "timed_out");
});

test("the box says who is doing what", () => {
  assert.equal(catchUpTitle("conflicting", "main"), "g1t-agent is resolving conflicts with main");
  assert.equal(catchUpTitle("overlap", "main"), "g1t-agent is merging main into this pull request");
  assert.match(catchUpWhy({ reason: "overlap", paths: ["a.rs"] }, "main"), /both changed one file/);
  assert.match(catchUpWhy({ reason: "conflicting", paths: ["a.rs", "b.rs"] }, "main"), /conflicts in 2 files/);
});
