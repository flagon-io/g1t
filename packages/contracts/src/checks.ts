/**
 * Checks: what CI, integrations and g1t's own workflows say about a
 * commit. Statuses (a state per context) and check runs (a lifecycle, a
 * conclusion, a Markdown report, annotations and buttons), grouped per
 * reporter into check suites. A g1t Actions job is a check run too, and its
 * workflow run the suite. Mirrors `crates/contracts/src/checks.rs`.
 */

import type { RepoPath } from "./repos";
import type { Result } from "./result";
import type { User, Viewer } from "./identity";
import type { CommitStatus } from "./work";

export type CheckRunStatus = "queued" | "in_progress" | "completed";
export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required";
export type AnnotationLevel = "notice" | "warning" | "failure";

/** Who reported a check run or suite. `actions` is g1t Actions. */
export type CheckApp = { slug: string; name: string };

export type CheckAnnotation = {
  path: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  annotationLevel: AnnotationLevel;
  message: string;
  title?: string;
  rawDetails?: string;
};

/** A button on a check run's page; pressing it sends `check_run.requested_action`. */
export type CheckAction = { label: string; description: string; identifier: string };

export type CommitCheckRun = {
  /** `cr_…`, or a g1t Actions job's `job_…`. */
  id: string;
  name: string;
  headSha: string;
  status: CheckRunStatus;
  conclusion: CheckConclusion | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The reporter's own page for it. */
  detailsUrl: string | null;
  externalId: string | null;
  /** Its page on the site, as a path. */
  htmlUrl: string;
  output: { title: string | null; summary: string | null; text: string | null; annotationsCount: number };
  actions: CheckAction[];
  checkSuite: { id: string };
  app: CheckApp;
  /** For a g1t Actions job: its workflow run. */
  workflow?: { runId: string; name: string; event: string };
  createdAt: string;
};

export type CommitCheckSuite = {
  id: string;
  headSha: string;
  headBranch: string | null;
  status: CheckRunStatus;
  conclusion: CheckConclusion | null;
  app: CheckApp;
  name?: string;
  latestCheckRunsCount: number;
  createdAt: string;
  updatedAt: string;
};

/** A check's state as one word. */
export type CheckState = "success" | "failure" | "pending" | "neutral" | "skipped" | "cancelled";

/** One check as a commit's list shows it: a check run or a status, from any reporter (a deployment's included). */
export type CheckItem = {
  kind: "check_run" | "status";
  id: string | null;
  name: string;
  state: CheckState;
  description: string | null;
  /** The reporter's page for it. */
  detailsUrl: string | null;
  /** Its page on g1t: a check run's, or a job's run. */
  url: string | null;
  app: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

/** Every check on one commit, and what they add up to. */
export type CommitChecks = {
  state: "success" | "failure" | "pending" | "none";
  total: number;
  successful: number;
  failed: number;
  pending: number;
  /** Neutral, skipped and cancelled. */
  skipped: number;
  /** Failing first, then pending, then the rest. */
  checks: CheckItem[];
};

/** Methods of the work service for checks. */
export interface ChecksApi {
  /** Every check on each of `shas` (at most 100), by SHA; commits nothing reported on are left out. */
  commitChecks(repo: RepoPath, viewer: Viewer, shas: string[]): Promise<Result<Record<string, CommitChecks>>>;
  getCheckRun(repo: RepoPath, id: string, viewer: Viewer): Promise<Result<CommitCheckRun>>;
  checkRunAnnotations(repo: RepoPath, id: string, viewer: Viewer): Promise<Result<CheckAnnotation[]>>;
  /** Someone pressed one of a check run's buttons. */
  requestCheckAction(actor: User, repo: RepoPath, id: string, identifier: string): Promise<Result<boolean>>;
  /** Asks the reporter to run it again; a g1t Actions job's run runs again. */
  rerequestCheckRun(actor: User, repo: RepoPath, id: string): Promise<Result<boolean>>;
}

/** What `check_run.*` events carry. */
export type CheckRunEventData = { repoId: string; checkRun: CommitCheckRun; requestedAction?: string };
/** What `check_suite.*` events carry. */
export type CheckSuiteEventData = { repoId: string; checkSuite: CommitCheckSuite };
/** What `status.created` carries. */
export type StatusEventData = {
  repoId: string;
  sha: string;
  context: string;
  state: CommitStatus["state"];
  description: string | null;
  targetUrl: string | null;
};
