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

/**
 * Who may read a secret or variable: `workflows` (`secrets.*`, `vars.*` in
 * GitHub Actions) and `deployments` (a deploy build's environment and the
 * running app's bindings). Agents, checks and the merge queue never read
 * any.
 */
export type SettingReader = "workflows" | "deployments";

/**
 * One row of secrets and variables, as Vercel lists environment variables:
 * a key, its type, the environments it applies to and who reads it. A key
 * may have one row per environment. Secrets' values are never returned.
 */
export type Setting = {
  id: string;
  name: string;
  /** `variable` is shown as Config. Config may become a secret, never back. */
  kind: SettingKind;
  /** A variable's value. */
  value: string | null;
  scope: "repository" | "workspace";
  updatedAt: string;
  availableTo: SettingReader[];
  /** The environments it applies to; empty is every environment. */
  environments: string[];
  /** A workspace's row: the repositories it reaches; empty is every one. */
  repositories: string[];
  /** Where to rotate it, or who to ask. */
  note: string | null;
  updatedBy: string | null;
};

/** What saving a row sets beyond its value; left out is unchanged. */
export type SettingOptions = {
  /** The row to change; left out, the key's row for every environment. */
  id?: string;
  availableTo?: SettingReader[];
  environments?: string[];
  repositories?: string[];
  note?: string;
};

export type SettingsOwner = { repo: RepoPath } | { workspace: string };
export type SettingKind = "secret" | "variable";
/** `all` lists both. */
export type SettingKindFilter = SettingKind | "all";

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
  settings(actor: User, owner: SettingsOwner, kind: SettingKindFilter): Promise<Result<Setting[]>>;
  /** `value` null keeps an existing entry's default value. */
  setSetting(
    actor: User,
    owner: SettingsOwner,
    kind: SettingKind,
    name: string,
    value: string | null,
    options?: SettingOptions,
  ): Promise<Result<Setting>>;
  /** One row by `id`, or every row of the key. */
  deleteSetting(actor: User, owner: SettingsOwner, kind: SettingKindFilter, name: string, id?: string): Promise<Result<boolean>>;
}
