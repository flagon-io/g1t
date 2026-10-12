import assert from "node:assert/strict";
import { test } from "node:test";

import type { Job, RunAttempt, WorkflowRun } from "@g1t/contracts";
import { runControls } from "./run-controls.ts";

type Run = Pick<WorkflowRun, "attempt" | "status" | "conclusion" | "error">;
type Attempt = Pick<RunAttempt, "attempt" | "status">;

const run = (more: Partial<Run> = {}): Run => ({ attempt: 1, status: "completed", conclusion: "success", error: null, ...more });
const jobs = (...statuses: Job["status"][]) => statuses.map((status) => ({ status }));
/** Attempts 1 to `latest`, the earlier ones finished, the latest as `status`. */
function attempts(latest: number, status: Attempt["status"]): Attempt[] {
  return Array.from({ length: latest }, (_, i) => ({ attempt: i + 1, status: i + 1 === latest ? status : "completed" }));
}

test("a re-run of failed jobs whose job waits for a self-hosted runner can be cancelled, not re-run", () => {
  // Attempt 6 of 6: its first job succeeded, the one that needs it is queued.
  const controls = runControls({
    run: run({ attempt: 6, status: "in_progress", conclusion: null }),
    jobs: jobs("completed", "queued"),
    attempts: attempts(6, "in_progress"),
    member: true,
  });
  assert.deepEqual(controls, { latest: true, going: true, cancelling: false, canCancel: true, canRerun: false });
});

test("an earlier attempt's page offers Cancel run while the latest attempt runs", () => {
  // `?attempt=5`: attempt 5 as it ended, every job finished.
  const controls = runControls({
    run: run({ attempt: 5, status: "completed", conclusion: "failure" }),
    jobs: jobs("completed", "completed"),
    attempts: attempts(6, "in_progress"),
    member: true,
  });
  assert.equal(controls.latest, false);
  assert.equal(controls.going, true);
  assert.equal(controls.canCancel, true);
  assert.equal(controls.canRerun, false);
  // How attempt 5 ended says nothing of attempt 6 being cancelled.
  assert.equal(runControls({ run: run({ attempt: 5, conclusion: "cancelled" }), jobs: [], attempts: attempts(6, "queued"), member: true }).cancelling, false);
});

test("a job not finished keeps the latest attempt going, whatever the run's own status says", () => {
  for (const status of ["waiting", "pending", "queued", "in_progress", "calling"] as const) {
    const controls = runControls({ run: run({ attempt: 2, status: "completed" }), jobs: jobs("completed", status), attempts: attempts(2, "completed"), member: true });
    assert.equal(controls.canCancel, true, status);
    assert.equal(controls.canRerun, false, status);
  }
});

test("every status a run waits or runs in can be cancelled", () => {
  for (const status of ["pending", "action_required", "queued", "in_progress", "waiting"] as const) {
    const controls = runControls({ run: run({ status, conclusion: null }), jobs: [], attempts: attempts(1, status), member: true });
    assert.equal(controls.canCancel, true, status);
    assert.equal(controls.canRerun, false, status);
  }
});

test("a finished run is re-run from its latest attempt only", () => {
  const latest = runControls({ run: run({ attempt: 2, conclusion: "failure" }), jobs: jobs("completed"), attempts: attempts(2, "completed"), member: true });
  assert.deepEqual(latest, { latest: true, going: false, cancelling: false, canCancel: false, canRerun: true });
  const earlier = runControls({ run: run({ attempt: 1, conclusion: "failure" }), jobs: jobs("completed"), attempts: attempts(2, "completed"), member: true });
  assert.equal(earlier.canRerun, false);
  assert.equal(earlier.canCancel, false);
  // A run of one attempt has no list to look through.
  assert.equal(runControls({ run: run(), jobs: jobs("completed"), attempts: [], member: true }).canRerun, true);
});

test("a run being cancelled shows Force cancel", () => {
  const controls = runControls({ run: run({ status: "in_progress", conclusion: "cancelled" }), jobs: jobs("in_progress"), attempts: attempts(1, "in_progress"), member: true });
  assert.equal(controls.cancelling, true);
  assert.equal(controls.canCancel, true);
});

test("neither without Write, nor for a run whose workflow file could not be used", () => {
  const going = { run: run({ status: "in_progress", conclusion: null }), jobs: jobs("queued"), attempts: attempts(1, "in_progress") };
  assert.equal(runControls({ ...going, member: false }).canCancel, false);
  const broken = runControls({ run: run({ conclusion: "failure", error: "Its file is not YAML." }), jobs: [], attempts: [], member: true });
  assert.equal(broken.canCancel, false);
  assert.equal(broken.canRerun, false);
});
