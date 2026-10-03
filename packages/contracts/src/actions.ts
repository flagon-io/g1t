import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * GitHub Actions workflows, run on g1t as they are. Mirrors
 * `crates/contracts/src/actions.rs`.
 */

export type WorkflowNote = {
  severity: "info" | "warning" | "unsupported";
  job: string | null;
  message: string;
};

/** One `workflow_dispatch` input, as written in the workflow. */
export type DispatchInput = {
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  type?: "string" | "boolean" | "number" | "choice" | "environment";
  options?: string[];
};

export type RunStatus = "pending" | "queued" | "in_progress" | "completed";
export type Conclusion = "success" | "failure" | "cancelled" | "skipped";

export type WorkflowRun = {
  id: string;
  workflowId: string;
  path: string;
  name: string;
  title: string;
  number: number;
  attempt: number;
  event: string;
  ref: string;
  sha: string;
  pull: number | null;
  status: RunStatus;
  conclusion: Conclusion | null;
  error: string | null;
  actor: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type Workflow = {
  id: string;
  path: string;
  name: string;
  events: string[];
  state: "active" | "disabled";
  error: string | null;
  notes: WorkflowNote[];
  dispatch: Record<string, DispatchInput> | null;
  lastRun: WorkflowRun | null;
};

export type StepState = {
  number: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: Conclusion | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type Annotation = {
  level: "error" | "warning" | "notice";
  message: string;
  title: string | null;
  file: string | null;
  line: number | null;
};

export type Job = {
  id: string;
  runId: string;
  key: string;
  name: string;
  needs: string[];
  /** `calling`: running the reusable workflow it calls, whose jobs follow it. */
  status: "waiting" | "queued" | "in_progress" | "calling" | "completed";
  conclusion: Conclusion | null;
  steps: StepState[];
  annotations: Annotation[];
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunDetail = { run: WorkflowRun; jobs: Job[]; notes: WorkflowNote[] };

export type LogChunk = { seq: number; step: number; text: string };
export type JobLog = { chunks: LogChunk[]; done: boolean };

export type Setting = {
  name: string;
  /** Variables only. */
  value: string | null;
  scope: "repository" | "workspace";
  updatedAt: string;
};

export type SettingsOwner = { repo: RepoPath } | { workspace: string };
export type SettingKind = "secret" | "variable";

export type RunsFilter = {
  workflow?: string;
  branch?: string;
  event?: string;
  pull?: number;
  sha?: string;
  limit?: number;
};

export interface ActionsApi {
  workflows(repo: RepoPath, viewer: Viewer): Promise<Result<Workflow[]>>;
  runs(repo: RepoPath, viewer: Viewer, filter?: RunsFilter): Promise<Result<WorkflowRun[]>>;
  run(repo: RepoPath, viewer: Viewer, id: string): Promise<Result<RunDetail>>;
  logs(repo: RepoPath, viewer: Viewer, job: string, after?: number): Promise<Result<JobLog>>;
  dispatch(
    actor: User,
    repo: RepoPath,
    workflow: string,
    ref: string | undefined,
    inputs: Record<string, unknown>,
  ): Promise<Result<WorkflowRun>>;
  cancel(actor: User, repo: RepoPath, id: string): Promise<Result<WorkflowRun>>;
  rerun(actor: User, repo: RepoPath, id: string, failedOnly?: boolean): Promise<Result<WorkflowRun>>;
  setWorkflowEnabled(actor: User, repo: RepoPath, workflow: string, enabled: boolean): Promise<Result<Workflow>>;
  settings(actor: User, owner: SettingsOwner, kind: SettingKind): Promise<Result<Setting[]>>;
  setSetting(actor: User, owner: SettingsOwner, kind: SettingKind, name: string, value: string): Promise<Result<Setting>>;
  deleteSetting(actor: User, owner: SettingsOwner, kind: SettingKind, name: string): Promise<Result<boolean>>;
}
