/**
 * The rules of a repository's deployments, apart from storing them: what a
 * reported deployment and status may say, how a g1t.page build reads as a
 * deployment, what a status says on the commit, and how a g1t Actions
 * run's jobs move its deployment along. Kept free of the service so its
 * tests run on Node as they are. See repo-deployments.ts.
 */

import type { DeployKind, DeployStatus, DeploymentState, DeploymentStatus, RepoDeployment } from "@g1t/contracts";

/** The states, as `DEPLOYMENT_STATES` in @g1t/contracts lists them (kept here so this runs on Node). */
const STATES: readonly DeploymentState[] = ["queued", "in_progress", "success", "failure", "error", "inactive"];

/** The environment a deployment goes to when none is named. */
export const DEFAULT_ENVIRONMENT = "production";
/** The longest environment name, task, description and address. */
export const MAX_ENVIRONMENT = 255;
export const MAX_TASK = 100;
export const MAX_DESCRIPTION = 1000;
export const MAX_URL = 2000;
/** The most a payload may hold, as JSON. */
export const MAX_PAYLOAD = 64 * 1024;
/** How many deployments a page holds unless asked, and at most. */
export const PER_PAGE = 30;
export const MAX_PER_PAGE = 100;

/** The commit status a deployment's statuses set on its commit. */
export function statusContext(environment: string): string {
  return `deploy / ${environment}`;
}

export function isState(value: unknown): value is DeploymentState {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

/** Whether a state is one a deployment ends in (until something newer replaces it). */
export function finished(state: DeploymentState): boolean {
  return state === "success" || state === "failure" || state === "error" || state === "inactive";
}

/**
 * An environment's name as given, trimmed: `Err` says what is wrong.
 * Anything printable up to 255 characters, as names like `production`,
 * `staging`, `review/feature-x` or `Production – web` are all in use.
 */
export function environmentName(value: unknown): string | { error: string } {
  if (value == null || value === "") return DEFAULT_ENVIRONMENT;
  if (typeof value !== "string") return { error: "`environment` is a string, such as production." };
  const name = value.trim();
  if (!name) return DEFAULT_ENVIRONMENT;
  if (name.length > MAX_ENVIRONMENT) return { error: `\`environment\` is at most ${MAX_ENVIRONMENT} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { error: "`environment` cannot hold control characters." };
  return name;
}

/** An http(s) address, or null for none. `Err` says what is wrong. */
export function address(value: unknown, field: string): string | null | { error: string } {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return { error: `\`${field}\` is an address, such as https://example.com.` };
  const text = value.trim();
  if (text.length > MAX_URL) return { error: `\`${field}\` is at most ${MAX_URL} characters.` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: `\`${field}\` is not an address: give it as https://….` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: `\`${field}\` must start with https:// or http://.` };
  return text;
}

/** A payload: an object, or JSON text of one. `Err` says what is wrong. */
export function payloadOf(value: unknown): { value: Record<string, unknown> } | { error: string } {
  if (value == null || value === "") return { value: {} };
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { error: "`payload` is a JSON object." };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "`payload` is a JSON object." };
  if (JSON.stringify(parsed).length > MAX_PAYLOAD) return { error: "`payload` is at most 64 KB as JSON." };
  return { value: parsed as Record<string, unknown> };
}

/** A whole commit id: 40 (SHA-1) or 64 (SHA-256) hex digits. */
export function fullSha(value: string): boolean {
  return /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

/** A branch or tag as a ref names it: `refs/heads/main` reads `main`. */
export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

/** How a g1t.page build's status reads as a deployment's state. */
export function buildState(status: DeployStatus): DeploymentState {
  switch (status) {
    case "queued":
      return "queued";
    case "building":
      return "in_progress";
    case "ready":
      return "success";
    case "failed":
      return "failure";
    case "skipped":
      return "error";
    case "replaced":
    case "down":
      return "inactive";
  }
}

/** The same mapping in SQL, over a column of build statuses. */
export const BUILD_STATE_SQL = `CASE status WHEN 'queued' THEN 'queued' WHEN 'building' THEN 'in_progress' WHEN 'ready' THEN 'success'
  WHEN 'failed' THEN 'failure' WHEN 'skipped' THEN 'error' ELSE 'inactive' END`;

/**
 * What a deployment's state sets on its commit: the commit status's state,
 * or null for none (an inactive deployment leaves what it said before).
 */
export function commitState(state: DeploymentState): "pending" | "success" | "failure" | "error" | null {
  switch (state) {
    case "queued":
    case "in_progress":
      return "pending";
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "error":
      return "error";
    case "inactive":
      return null;
  }
}

/** What the commit status says, when the status gave no description. */
export function commitDescription(state: DeploymentState, environment: string): string {
  switch (state) {
    case "queued":
      return `Waiting to deploy to ${environment}`;
    case "in_progress":
      return `Deploying to ${environment}`;
    case "success":
      return `Deployed to ${environment}`;
    case "failure":
      return `The deployment to ${environment} failed`;
    case "error":
      return `The deployment to ${environment} could not finish`;
    case "inactive":
      return `No longer active in ${environment}`;
  }
}

/** How each state is said when nothing else is. */
export function stateDescription(state: DeploymentState): string {
  return {
    queued: "Queued",
    in_progress: "Deploying",
    success: "Deployed",
    failure: "Failed",
    error: "Could not finish",
    inactive: "Replaced by a newer deployment",
  }[state];
}

/**
 * Where a g1t Actions run's deployment to one environment goes next, given
 * the state it is in and what the run says now; null leaves it as it is.
 *
 * - A job that names the environment starting: `in_progress`, unless the
 *   deployment already failed (a later job of the same run does not undo
 *   that) or ended.
 * - A job that names it failing: `failure` at once.
 * - The run finishing (`final`): its outcome for the environment's jobs,
 *   whatever came before, since it is the last word.
 */
export function actionsTransition(current: DeploymentState | null, next: DeploymentState, final: boolean): DeploymentState | null {
  if (current === next) return null;
  if (final || current == null) return next;
  if (current === "failure" || current === "error" || current === "inactive") return null;
  if (current === "success" && next === "in_progress") return null;
  return next;
}

/**
 * How a finished run went for one environment, from the conclusions of
 * the jobs that named it: failed if any failed, cancelled as an error,
 * else a success. Jobs that were skipped never deployed.
 */
export function runOutcome(conclusions: (string | null)[]): DeploymentState | null {
  const ran = conclusions.filter((conclusion) => conclusion !== "skipped" && conclusion != null);
  if (ran.length === 0) return null;
  if (ran.some((conclusion) => conclusion === "failure" || conclusion === "timed_out")) return "failure";
  if (ran.some((conclusion) => conclusion === "cancelled")) return "error";
  return "success";
}

/**
 * The order environments are shown in: those people use directly first
 * (production by name before others), then the most recently deployed.
 */
export function compareEnvironments(
  a: { name: string; production_environment: boolean; updated_at: string },
  b: { name: string; production_environment: boolean; updated_at: string },
): number {
  const rank = (env: { name: string; production_environment: boolean }) =>
    env.name.toLowerCase() === "production" ? 0 : env.production_environment ? 1 : 2;
  return rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at) || a.name.localeCompare(b.name);
}

/** A deployment without its payload, as events carry it. */
export function withoutPayload(deployment: RepoDeployment): Omit<RepoDeployment, "payload"> {
  const { payload: _payload, ...rest } = deployment;
  return rest;
}

/** A g1t.page build, as much of it as a deployment needs. */
export type BuildRow = {
  id: string;
  workspace: string;
  slug: string;
  repo_id: string;
  kind: DeployKind;
  branch: string | null;
  number: number | null;
  commit_sha: string;
  script: string;
  status: DeployStatus;
  error: string | null;
  created_by: string;
  created_at: string;
  started_at?: string | null;
  finished_at: string | null;
};

/**
 * How a g1t.page build reads as a deployment. `appUrl` is where a script
 * is served (names.ts); `names` turns a creator's id into a username.
 */
export function fromBuild(
  row: BuildRow,
  defaultBranch: string,
  site: string,
  appUrl: (script: string) => string,
  names: Record<string, string> = {},
): RepoDeployment {
  const state = buildState(row.status);
  const went = row.status === "ready" || row.status === "replaced" || row.status === "down";
  return {
    id: row.id,
    environment: row.kind,
    ref: row.branch ?? defaultBranch,
    sha: row.commit_sha,
    task: "deploy",
    description: row.error ?? (row.kind === "production" ? "Production on g1t.page" : `Preview of ${row.branch ?? "a branch"} on g1t.page`),
    payload: {},
    transient_environment: row.kind === "preview",
    production_environment: row.kind === "production",
    state,
    environment_url: went ? appUrl(row.script) : null,
    log_url: `${site}/${row.workspace}/${row.slug}/deployments/${row.id}`,
    creator: names[row.created_by] ?? (row.created_by.startsWith("usr_") ? "g1t" : row.created_by),
    source: "g1t_page",
    run_id: null,
    run_url: null,
    project: row.slug,
    number: row.kind === "preview" ? row.number : null,
    created_at: row.created_at,
    updated_at: row.finished_at ?? row.started_at ?? row.created_at,
  };
}

/** A build's statuses, from its own timestamps: queued, building, then how it ended. */
export function buildStatuses(row: BuildRow, deployment: RepoDeployment): DeploymentStatus[] {
  const status = (suffix: string, state: DeploymentState, at: string, description: string): DeploymentStatus => ({
    id: `${row.id}:${suffix}`,
    deployment_id: row.id,
    state,
    description,
    environment_url: state === "success" ? deployment.environment_url : null,
    log_url: deployment.log_url,
    creator: deployment.creator,
    created_at: at,
  });
  const out = [status("queued", "queued", row.created_at, "Waiting for a sandbox")];
  if (row.started_at) out.push(status("building", "in_progress", row.started_at, "Building"));
  const end = row.finished_at;
  if (end && row.status !== "queued" && row.status !== "building") {
    const state = row.status === "replaced" || row.status === "down" ? "success" : buildState(row.status);
    out.push(status("finished", state, end, row.error ?? (state === "success" ? "Live" : stateDescription(state))));
  }
  if (row.status === "replaced" || row.status === "down") {
    out.push(
      status(
        row.status,
        "inactive",
        end ?? row.created_at,
        row.status === "replaced" ? "Replaced by a newer build" : "Taken down",
      ),
    );
  }
  return out;
}
