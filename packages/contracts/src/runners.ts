import type { User } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * Self-hosted runners: a workspace's or a repository's own machines, which
 * run its workflow jobs (and, when it says so, its agents' work) instead of
 * g1t's sandboxes, at $0. Mirrors `crates/contracts/src/runners.rs`.
 */

export type RunnerStatus = "online" | "busy" | "offline";

/** What a runner is doing now. */
export type RunnerWork = {
  kind: "workflow" | "agent";
  id: string;
  name: string;
  repo: string | null;
  /** The workflow run the job is in; for `agent` work, the agent run it is, when known. */
  runId: string | null;
  startedAt: string | null;
};

export type Runner = {
  id: string;
  name: string;
  workspace: string;
  /** `owner/name` for a repository's own runner; null for the workspace's. */
  repo: string | null;
  group: string | null;
  labels: string[];
  os: "linux" | "macos" | "windows";
  arch: "x64" | "arm64";
  version: string;
  ephemeral: boolean;
  status: RunnerStatus;
  work: RunnerWork | null;
  lastSeenAt: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type RunnerGroup = {
  id: string;
  name: string;
  default: boolean;
  /** Repository names; empty is every repository in the workspace. */
  repositories: string[];
  runners: number;
  updatedAt: string;
};

/** Shown once. */
export type RegistrationToken = {
  token: string;
  expiresAt: string;
  workspace: string;
  repo: string | null;
  group: string | null;
  url: string;
};

export type RunnerSettings = {
  agentsOnSelfHosted: boolean;
  agentLabels: string[];
  forkPullRequests: boolean;
  /** For a repository: these are its workspace's. */
  inherited: boolean;
};

export type RunnersOwner = { repo: RepoPath } | { workspace: string };

export type RunnerSettingsChange = {
  agents_on_self_hosted?: boolean;
  agent_labels?: string[];
  fork_pull_requests?: boolean;
  inherit?: boolean;
};

/** A workflow job running in one of g1t's sandboxes. Snake case, as `runner_activity` answers. */
export type CloudJob = { id: string; name: string; run_id: string; repo: string; started_at: string | null };

/** Agent work handed to one of the workspace's own runners, waiting for one or taken. */
export type HandedOverTask = {
  id: string;
  /** The agent run it is; null for work handed over before runs were noted. */
  run_id: string | null;
  kind: string;
  title: string;
  repo: string;
  status: "queued" | "in_progress";
  runner_name: string | null;
  created_at: string;
  started_at: string | null;
};

/** What runs for a workspace now, in g1t's sandboxes and on its own runners (`runner_activity`). */
export type RunnerActivity = {
  /** At most `RUNNER_ACTIVITY_LIMIT`, newest first. */
  cloud_jobs: CloudJob[];
  cloud_jobs_queued: number;
  handed_over: HandedOverTask[];
  self_hosted_jobs_queued: number;
};

/** The most jobs and tasks `runner_activity` lists of each: `ACTIVITY_LIMIT` in the actions service. */
export const RUNNER_ACTIVITY_LIMIT = 100;

/** A job that has waited ten minutes or more with no matching runner online. */
export type StuckJob = { id: string; name: string; runId: string; repo: string; labels: string; queuedAt: string };

export interface RunnersApi {
  /** The viewer's workspaces' jobs stuck waiting for a self-hosted runner, for Mission control. */
  stuck(viewer: User): Promise<StuckJob[]>;
  /** What runs for the workspace now, in g1t's sandboxes and handed to its own runners. Owners. */
  activity(actor: User, workspace: string): Promise<Result<RunnerActivity>>;
  list(actor: User, owner: RunnersOwner): Promise<Result<Runner[]>>;
  createToken(actor: User, owner: RunnersOwner, group?: string): Promise<Result<RegistrationToken>>;
  remove(actor: User, owner: RunnersOwner, id: string): Promise<Result<boolean>>;
  groups(actor: User, workspace: string): Promise<Result<RunnerGroup[]>>;
  /** Without `id`, a new group. */
  setGroup(actor: User, workspace: string, group: { id?: string; name?: string; repositories?: string[] }): Promise<Result<RunnerGroup>>;
  deleteGroup(actor: User, workspace: string, id: string): Promise<Result<boolean>>;
  settings(actor: User, owner: RunnersOwner): Promise<Result<RunnerSettings>>;
  setSettings(actor: User, owner: RunnersOwner, change: RunnerSettingsChange): Promise<Result<RunnerSettings>>;
}

/**
 * The runner's container image: `g1t-runner` and the Docker CLI, for
 * running it in Docker or Kubernetes. Published with each release.
 */
export const RUNNER_IMAGE = "g1t.sh/flagon-io/g1t-runner";

/** Where the runner binary is published: `g1t.sh/downloads/runner/<version>/<file>`. */
export const RUNNER_DOWNLOADS = "https://g1t.sh/downloads/runner";

/** The file for each platform, as published. */
export const RUNNER_FILES: Record<"linux-x64" | "linux-arm64" | "macos-arm64" | "macos-x64" | "windows-x64", string> = {
  "linux-x64": "g1t-runner-linux-x64",
  "linux-arm64": "g1t-runner-linux-arm64",
  "macos-arm64": "g1t-runner-macos-arm64",
  "macos-x64": "g1t-runner-macos-x64",
  "windows-x64": "g1t-runner-windows-x64.exe",
};
