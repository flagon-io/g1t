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

/**
 * `action_required`: a pull request's run from outside, waiting for someone
 * with the Write role to approve it. `waiting`: its jobs are held by an
 * environment's protection rules (a run's detail says so; lists do not).
 */
export type RunStatus = "pending" | "action_required" | "queued" | "in_progress" | "waiting" | "completed";
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
  /**
   * `calling`: running the reusable workflow it calls, whose jobs follow it.
   * `pending`: held by its environment's protection rules; `reason` says for what.
   */
  status: "waiting" | "pending" | "queued" | "in_progress" | "calling" | "completed";
  conclusion: Conclusion | null;
  steps: StepState[];
  annotations: Annotation[];
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The environment it names, once its needs are done. */
  environment?: string | null;
  /** Its `runs-on` names self-hosted runners. */
  selfHosted?: boolean;
  /** The self-hosted runner that took it, by name. */
  runner?: string | null;
};

export type RunDetail = {
  run: WorkflowRun;
  jobs: Job[];
  notes: WorkflowNote[];
  /** For a pull request's run from outside: whether it waits for, or had, approval. */
  approval?: RunApproval | null;
  /** The environments whose protection rules hold its jobs, this attempt. */
  pendingDeployments?: PendingDeployment[];
};

export type RunApproval = {
  state: "required" | "approved";
  /** Why it waits, in words. */
  reason: string;
  approvedBy: string | null;
};

/** One person or team who may approve an environment's jobs. */
export type EnvironmentReviewer = { type: "user" | "team"; name: string };

/** A branch or tag pattern an environment takes deployments from. */
export type BranchPattern = { name: string; type: "branch" | "tag" };

/** The most reviewers an environment may have. */
export const MAX_ENVIRONMENT_REVIEWERS = 6;
/** The longest wait timer, in minutes (30 days). */
export const MAX_WAIT_MINUTES = 43_200;

/**
 * An environment and its protection rules. Jobs naming it with
 * `environment:` wait until the rules let them through, and only then get
 * its secrets.
 */
export type Environment = {
  /** Lowercase. */
  name: string;
  reviewers: EnvironmentReviewer[];
  preventSelfReview: boolean;
  waitMinutes: number;
  /** `protected`: branches the rules protect; `selected`: `branchPatterns`. */
  branchPolicy: "all" | "protected" | "selected";
  branchPatterns: BranchPattern[];
  adminsBypass: boolean;
  /** Whether it has rules saved; false for one only named by a workflow or a secret. */
  protected: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** What changes an environment's rules; left out is unchanged. */
export type EnvironmentChange = Partial<
  Pick<Environment, "reviewers" | "preventSelfReview" | "waitMinutes" | "branchPolicy" | "branchPatterns" | "adminsBypass">
>;

/** An environment holding a run's jobs, and where its rules stand. */
export type PendingDeployment = {
  environment: string;
  state: "waiting" | "approved" | "rejected";
  needsReview: boolean;
  /** When its wait timer lets its jobs start. */
  waitUntil: string | null;
  reviewers: EnvironmentReviewer[];
  /** The jobs it holds, by name. */
  jobs: string[];
  /** Whether the viewer may approve or reject it now. */
  canReview: boolean;
  reviewedBy: string | null;
  comment: string | null;
  reviewedAt: string | null;
};

/** Which pull requests' runs wait for approval, least strict first. */
export const APPROVAL_POLICIES = ["first_time_contributors", "outside_contributors", "all_external_contributors"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/** A repository's choices for its workflows. */
export type ActionsSettings = {
  /** What a workflow without `permissions:` gets: `read` (the default) or `write`. */
  defaultPermissions: "read" | "write";
  approvalPolicy: ApprovalPolicy;
};

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
  /** A project's (a repository's belong to its project) or the workspace's. */
  scope: "project" | "workspace";
  updatedAt: string;
  availableTo: SettingReader[];
  /** The environments it applies to; empty is every environment. */
  environments: string[];
  /** A workspace's row: the projects it reaches, by slug; empty is every one. */
  projects: string[];
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
  /** A workspace's row: project slugs; empty for every one. */
  projects?: string[];
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
  /** Lets a pull request's run from outside start. Write role. */
  approveRun(actor: User, repo: RepoPath, id: string): Promise<Result<WorkflowRun>>;
  pendingDeployments(repo: RepoPath, viewer: Viewer, id: string): Promise<Result<PendingDeployment[]>>;
  /** Approves or rejects the jobs `environments` hold (every waiting one when empty). */
  reviewDeployments(
    actor: User,
    repo: RepoPath,
    id: string,
    state: "approved" | "rejected",
    environments?: string[],
    comment?: string,
  ): Promise<Result<PendingDeployment[]>>;
  actionsSettings(repo: RepoPath, viewer: Viewer): Promise<Result<ActionsSettings>>;
  /** Admin role. Left out is unchanged. */
  setActionsSettings(actor: User, repo: RepoPath, change: Partial<ActionsSettings>): Promise<Result<ActionsSettings>>;
  /** Every environment the repository's rules, secrets, workflows or jobs name. */
  environments(repo: RepoPath, viewer: Viewer): Promise<Result<Environment[]>>;
  /** Admin role. */
  setEnvironment(actor: User, repo: RepoPath, name: string, change: EnvironmentChange): Promise<Result<Environment>>;
  deleteEnvironment(actor: User, repo: RepoPath, name: string): Promise<Result<boolean>>;
}
