/**
 * Which of a run's buttons its page shows: Cancel run (or Force cancel)
 * while any of it is still going, the re-runs once it has finished. Pure;
 * the page is routes/repo/actions-run.tsx.
 *
 * A run is going while its latest attempt is: the attempt list's last
 * entry says how it stands now, whichever attempt the page shows, so an
 * earlier attempt's page (`?attempt=2`, and its `?job=` links) offers
 * Cancel run while a later one runs. On the latest attempt a job that has
 * not finished (waiting, pending approval, queued for a runner, running)
 * keeps the run going too, whatever the run's own status says.
 */
import type { Job, RunAttempt, WorkflowRun } from "@g1t/contracts";

export type RunControls = {
  /** The attempt shown is the run's latest. */
  latest: boolean;
  /** The run, at its latest attempt, has not finished. */
  going: boolean;
  /** Cancelled, while its jobs run their cleanup steps: Force cancel in place of Cancel run. */
  cancelling: boolean;
  canCancel: boolean;
  canRerun: boolean;
};

export function runControls(input: {
  run: Pick<WorkflowRun, "attempt" | "status" | "conclusion" | "error">;
  jobs: Pick<Job, "status">[];
  attempts: Pick<RunAttempt, "attempt" | "status">[];
  /** The viewer may cancel and re-run (Write). */
  member: boolean;
}): RunControls {
  const { run, jobs, attempts, member } = input;
  const newest = attempts[attempts.length - 1];
  const latest = newest == null || run.attempt === newest.attempt;
  const going = latest ? run.status !== "completed" || jobs.some((job) => job.status !== "completed") : newest.status !== "completed";
  // Only the latest attempt's own status says it is being cancelled; an
  // earlier attempt's conclusion is how that attempt ended.
  const cancelling = going && latest && run.conclusion === "cancelled";
  const allowed = member && !run.error;
  return { latest, going, cancelling, canCancel: allowed && going, canRerun: allowed && !going && latest };
}
