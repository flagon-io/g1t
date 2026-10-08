/**
 * A repository's deployments, wherever they run, in one model: what any
 * CI reports through the API, what g1t Actions makes for each job with an
 * `environment:`, and g1t.page builds, which stay in `deployments` and are
 * read in alongside (never copied, so nothing about building them changes).
 *
 * Reported deployments keep every status they were given; a build's
 * statuses are read from its own timestamps. Each status also reports on
 * the commit as `deploy / <environment>`, through the work service's
 * commit statuses, so it shows with the commit's checks and a ruleset can
 * require it. Every new deployment and status is published
 * (`deployment.created`, `deployment_status.created`) for webhooks.
 *
 * The rules, apart from storage, are in environments.ts.
 */

import {
  can,
  eventsClient,
  fail,
  needs,
  newId,
  ok,
  permission,
  reposClient,
  type Capability,
  type DeploymentDetail,
  type DeploymentEnvironment,
  type DeploymentEnvironments,
  type DeploymentFilter,
  type DeploymentPage,
  type DeploymentSource,
  type DeploymentState,
  type DeploymentStatus,
  type NewDeployment,
  type NewDeploymentStatus,
  type Repo,
  type RepoDeployment,
  type RepoPath,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
} from "@g1t/contracts";

import {
  BUILD_STATE_SQL,
  MAX_DESCRIPTION,
  MAX_PER_PAGE,
  MAX_TASK,
  PER_PAGE,
  actionsTransition,
  address,
  buildStatuses,
  fromBuild,
  commitDescription,
  commitState,
  compareEnvironments,
  environmentName,
  fullSha,
  isState,
  payloadOf,
  shortRef,
  stateDescription,
  statusContext,
  withoutPayload,
} from "./environments";
import { appUrl } from "./names";

export { buildStatuses, fromBuild, type BuildRow } from "./environments";
import type { BuildRow } from "./environments";

export type RepoDeploymentsEnv = {
  DB: D1Database;
  REPOS: ServiceBinding;
  WORK: ServiceBinding;
  IDENTITY: ServiceBinding;
  EVENTS?: ServiceBinding;
  SITE: string;
};

const now = () => new Date().toISOString();

type ReportedRow = {
  id: string;
  repo_id: string;
  environment: string;
  ref: string;
  sha: string;
  task: string;
  description: string | null;
  payload: string;
  transient_environment: number;
  production_environment: number;
  state: DeploymentState;
  environment_url: string | null;
  log_url: string | null;
  creator: string;
  source: "api" | "actions";
  run_id: string | null;
  run_attempt: number | null;
  run_url: string | null;
  created_at: string;
  updated_at: string;
};

type StatusRow = {
  id: string;
  deployment_id: string;
  state: DeploymentState;
  description: string | null;
  environment_url: string | null;
  log_url: string | null;
  creator: string;
  created_at: string;
};

/** What g1t Actions says about a run's deployment to one environment (`actions_deployment`). */
export type ActionsReport = {
  repoId: string;
  repo: RepoPath;
  runId: string;
  attempt: number;
  runUrl: string;
  environment: string;
  /** From the job's `environment.url`, when it gave a plain one. */
  url: string | null;
  ref: string;
  sha: string;
  state: DeploymentState;
  /** The run finished: this is its outcome for the environment. */
  final: boolean;
  /** Who started the run, or null for g1t. */
  creator: string | null;
  workflow: string;
};

function toDeployment(row: ReportedRow): RepoDeployment {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload || "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    environment: row.environment,
    ref: row.ref,
    sha: row.sha,
    task: row.task,
    description: row.description,
    payload,
    transient_environment: !!row.transient_environment,
    production_environment: !!row.production_environment,
    state: row.state,
    environment_url: row.environment_url,
    log_url: row.log_url,
    creator: row.creator,
    source: row.source,
    run_id: row.run_id,
    run_url: row.run_url,
    project: null,
    number: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toStatus(row: StatusRow): DeploymentStatus {
  return { ...row };
}

/** The shape every listing reads from: reported deployments and builds as one table. */
const UNION = `
  SELECT id, environment, ref, sha, task, state, source, creator, transient_environment, production_environment,
         created_at, updated_at, 0 AS build
  FROM reported_deployments WHERE repo_id = ?1
  UNION ALL
  SELECT id, kind, COALESCE(branch, ?2), commit_sha, 'deploy', ${BUILD_STATE_SQL}, 'g1t_page', created_by,
         kind = 'preview', kind = 'production', created_at, COALESCE(finished_at, started_at, created_at), 1
  FROM deployments WHERE repo_id = ?1`;

type Listed = { id: string; build: number };

export class RepoDeployments {
  constructor(private readonly env: RepoDeploymentsEnv) {}

  private get db() {
    return this.env.DB;
  }

  /** The repository, if `viewer` may do `capability` in it: not found when they cannot read it. */
  private async repoFor(path: RepoPath, viewer: Viewer, capability: Capability): Promise<Result<Repo>> {
    if (!path?.namespace || !path?.name) return fail("invalid", "Give the repository as owner/name.");
    const found = await reposClient(this.env.REPOS).get(path, viewer);
    if (!found.ok) return found;
    const ref = { id: found.value.id, namespace: found.value.namespace, isPrivate: found.value.isPrivate };
    if (!permission(viewer, ref)) return fail("not_found", "There is no such repository.");
    if (!can(viewer, ref, capability)) return fail("forbidden", needs(capability));
    if (capability !== "read" && found.value.archivedAt) {
      return fail("conflict", "The repository is archived: it is read-only until it is unarchived.");
    }
    return found;
  }

  /** Usernames for the builds' creators recorded by id. */
  private async names(rows: BuildRow[]): Promise<Record<string, string>> {
    const ids = [...new Set(rows.map((row) => row.created_by).filter((by) => by.startsWith("usr_")))];
    if (ids.length === 0) return {};
    const response = await this.env.IDENTITY.fetch("https://identity/rpc/usernames", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    }).catch(() => null);
    return response?.ok ? ((await response.json().catch(() => ({}))) as Record<string, string>) : {};
  }

  /** The deployments `listed` names, in that order. */
  private async hydrate(listed: Listed[], repo: Repo): Promise<RepoDeployment[]> {
    const reportedIds = listed.filter((row) => !row.build).map((row) => row.id);
    const buildIds = listed.filter((row) => row.build).map((row) => row.id);
    const marks = (ids: string[]) => ids.map(() => "?").join(", ");
    const [reported, builds] = await Promise.all([
      reportedIds.length
        ? this.db.prepare(`SELECT * FROM reported_deployments WHERE id IN (${marks(reportedIds)})`).bind(...reportedIds).all<ReportedRow>()
        : Promise.resolve({ results: [] as ReportedRow[] }),
      buildIds.length
        ? this.db.prepare(`SELECT * FROM deployments WHERE id IN (${marks(buildIds)})`).bind(...buildIds).all<BuildRow>()
        : Promise.resolve({ results: [] as BuildRow[] }),
    ]);
    const names = await this.names(builds.results);
    const byId = new Map<string, RepoDeployment>();
    for (const row of reported.results) byId.set(row.id, toDeployment(row));
    for (const row of builds.results) byId.set(row.id, fromBuild(row, repo.defaultBranch, this.env.SITE, appUrl, names));
    return listed.map((row) => byId.get(row.id)).filter((found): found is RepoDeployment => !!found);
  }

  // ---- Reading -------------------------------------------------------

  async list(a: { repo: RepoPath; viewer: Viewer } & DeploymentFilter): Promise<Result<DeploymentPage>> {
    const found = await this.repoFor(a.repo, a.viewer, "read");
    if (!found.ok) return found;
    const repo = found.value;
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(Number(a.per_page) || PER_PAGE)));
    const page = Math.max(1, Math.floor(Number(a.page) || 1));
    if (a.state != null && !isState(a.state)) return fail("invalid", "`state` is queued, in_progress, success, failure, error or inactive.");
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    const sha = text(a.sha)?.toLowerCase() ?? null;
    const where = `WHERE (?3 IS NULL OR environment = ?3 COLLATE NOCASE)
      AND (?4 IS NULL OR ref = ?4) AND (?5 IS NULL OR sha LIKE ?5 || '%') AND (?6 IS NULL OR task = ?6)
      AND (?7 IS NULL OR state = ?7) AND (?8 IS NULL OR source = ?8) AND (?9 IS NULL OR creator = ?9 COLLATE NOCASE)`;
    const binds = [
      repo.id,
      repo.defaultBranch,
      text(a.environment),
      text(a.ref) ? shortRef(text(a.ref)!) : null,
      sha,
      text(a.task),
      a.state ?? null,
      text(a.source),
      text(a.creator),
    ];
    const [rows, count] = await Promise.all([
      this.db
        .prepare(`WITH d AS (${UNION}) SELECT id, build FROM d ${where} ORDER BY created_at DESC, id DESC LIMIT ?10 OFFSET ?11`)
        .bind(...binds, perPage, (page - 1) * perPage)
        .all<Listed>(),
      this.db.prepare(`WITH d AS (${UNION}) SELECT COUNT(*) AS n FROM d ${where}`).bind(...binds).first<{ n: number }>(),
    ]);
    return ok({
      deployments: await this.hydrate(rows.results, repo),
      total_count: count?.n ?? 0,
      page,
      per_page: perPage,
    });
  }

  async get(a: { repo: RepoPath; id: string; viewer: Viewer }): Promise<Result<DeploymentDetail>> {
    const found = await this.repoFor(a.repo, a.viewer, "read");
    if (!found.ok) return found;
    return this.detail(found.value, String(a.id ?? ""));
  }

  private async detail(repo: Repo, id: string): Promise<Result<DeploymentDetail>> {
    if (id.startsWith("dpl_")) {
      const row = await this.db
        .prepare("SELECT * FROM deployments WHERE id = ? AND repo_id = ?")
        .bind(id, repo.id)
        .first<BuildRow>();
      if (!row) return fail("not_found", "There is no such deployment.");
      const deployment = fromBuild(row, repo.defaultBranch, this.env.SITE, appUrl, await this.names([row]));
      return ok({ ...deployment, statuses: buildStatuses(row, deployment) });
    }
    const row = await this.db
      .prepare("SELECT * FROM reported_deployments WHERE id = ? AND repo_id = ?")
      .bind(id, repo.id)
      .first<ReportedRow>();
    if (!row) return fail("not_found", "There is no such deployment.");
    const statuses = await this.db
      .prepare("SELECT * FROM deployment_statuses WHERE deployment_id = ? ORDER BY created_at, id")
      .bind(id)
      .all<StatusRow>();
    return ok({ ...toDeployment(row), statuses: statuses.results.map(toStatus) });
  }

  async statuses(a: { repo: RepoPath; id: string; viewer: Viewer }): Promise<Result<DeploymentStatus[]>> {
    const found = await this.get(a);
    // Newest first, as a list of statuses reads.
    return found.ok ? ok([...found.value.statuses].reverse()) : found;
  }

  async environments(a: { repo: RepoPath; viewer: Viewer }): Promise<Result<DeploymentEnvironments>> {
    const found = await this.repoFor(a.repo, a.viewer, "read");
    if (!found.ok) return found;
    const repo = found.value;
    // Each environment's count, its newest deployment, and its newest
    // that succeeded and is still active.
    const [counts, latest, current] = await Promise.all([
      this.db
        .prepare(
          `WITH d AS (${UNION}) SELECT environment, COUNT(*) AS n, MAX(updated_at) AS at,
             MAX(transient_environment) AS transient, MAX(production_environment) AS production
           FROM d GROUP BY environment COLLATE NOCASE ORDER BY at DESC LIMIT 100`,
        )
        .bind(repo.id, repo.defaultBranch)
        .all<{ environment: string; n: number; at: string; transient: number; production: number }>(),
      this.db
        .prepare(
          `WITH d AS (${UNION}) SELECT id, build FROM (
             SELECT id, build, ROW_NUMBER() OVER (PARTITION BY lower(environment) ORDER BY created_at DESC, id DESC) AS rn FROM d
           ) WHERE rn = 1`,
        )
        .bind(repo.id, repo.defaultBranch)
        .all<Listed>(),
      this.db
        .prepare(
          `WITH d AS (${UNION}) SELECT id, build FROM (
             SELECT id, build, ROW_NUMBER() OVER (PARTITION BY lower(environment) ORDER BY created_at DESC, id DESC) AS rn
             FROM d WHERE state = 'success'
           ) WHERE rn = 1`,
        )
        .bind(repo.id, repo.defaultBranch)
        .all<Listed>(),
    ]);
    const deployments = await this.hydrate([...latest.results, ...current.results], repo);
    const pick = (ids: Listed[], name: string) =>
      deployments.find((d) => ids.some((row) => row.id === d.id) && d.environment.toLowerCase() === name.toLowerCase()) ?? null;
    const environments: DeploymentEnvironment[] = counts.results.map((row) => {
      const newest = pick(latest.results, row.environment);
      const live = pick(current.results, row.environment);
      return {
        name: newest?.environment ?? row.environment,
        url: live?.environment_url ?? null,
        production_environment: !!row.production,
        transient_environment: !!row.transient,
        deployments_count: row.n,
        latest: newest,
        current: live,
        updated_at: row.at,
      };
    });
    environments.sort(compareEnvironments);
    return ok({ total_count: counts.results.reduce((sum, row) => sum + row.n, 0), environments });
  }

  async environment(a: { repo: RepoPath; name: string; viewer: Viewer }): Promise<Result<DeploymentEnvironment>> {
    const all = await this.environments(a);
    if (!all.ok) return all;
    const found = all.value.environments.find((env) => env.name.toLowerCase() === String(a.name ?? "").trim().toLowerCase());
    return found ? ok(found) : fail("not_found", `There is no environment called ${a.name}.`);
  }

  // ---- Reporting -----------------------------------------------------

  /** The environment's name as first spelled, made on its first deployment. */
  private async environmentFor(repoId: string, name: string): Promise<string> {
    await this.db
      .prepare("INSERT INTO environments (repo_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (repo_id, name) DO NOTHING")
      .bind(repoId, name, now())
      .run();
    const row = await this.db
      .prepare("SELECT name FROM environments WHERE repo_id = ? AND name = ?")
      .bind(repoId, name)
      .first<{ name: string }>();
    // A g1t.page environment is spelled as g1t.page spells it.
    const builtIn = ["production", "preview"].find((own) => own === name.toLowerCase());
    return builtIn ?? row?.name ?? name;
  }

  async create(a: { repo: RepoPath; actor: User } & NewDeployment): Promise<Result<DeploymentDetail>> {
    const found = await this.repoFor(a.repo, a.actor, "push");
    if (!found.ok) return found;
    const repo = found.value;
    const environment = environmentName(a.environment);
    if (typeof environment !== "string") return fail("invalid", environment.error);
    const payload = payloadOf(a.payload);
    if ("error" in payload) return fail("invalid", payload.error);
    const environmentUrl = address(a.environment_url, "environment_url");
    if (environmentUrl && typeof environmentUrl === "object") return fail("invalid", environmentUrl.error);
    const logUrl = address(a.log_url, "log_url");
    if (logUrl && typeof logUrl === "object") return fail("invalid", logUrl.error);
    const state = a.state ?? "queued";
    if (!isState(state)) return fail("invalid", "`state` is queued, in_progress, success, failure, error or inactive.");
    const task = typeof a.task === "string" && a.task.trim() ? a.task.trim() : "deploy";
    if (task.length > MAX_TASK) return fail("invalid", `\`task\` is at most ${MAX_TASK} characters.`);
    const description = typeof a.description === "string" && a.description.trim() ? a.description.trim() : null;
    if (description && description.length > MAX_DESCRIPTION) return fail("invalid", `\`description\` is at most ${MAX_DESCRIPTION} characters.`);
    const givenRef = typeof a.ref === "string" ? a.ref.trim() : "";
    const givenSha = typeof a.sha === "string" ? a.sha.trim().toLowerCase() : "";
    if (!givenRef && !givenSha) return fail("invalid", "Give the `ref` deployed: a branch, a tag or a commit.");
    let sha = fullSha(givenSha) ? givenSha : "";
    if (!sha) {
      const commit = await reposClient(this.env.REPOS).log(a.repo, a.actor, givenSha || givenRef, 1);
      if (!commit.ok || commit.value.length === 0) {
        return fail("invalid", `${givenSha || givenRef} is not a branch, tag or commit of ${repo.namespace}/${repo.name}.`);
      }
      sha = commit.value[0].hash;
    }
    const ref = givenRef ? shortRef(givenRef) : sha;
    const name = await this.environmentFor(repo.id, environment);
    const id = newId("dep");
    const at = now();
    const production = a.production_environment ?? name.toLowerCase() === "production";
    await this.db
      .prepare(
        `INSERT INTO reported_deployments (id, repo_id, environment, ref, sha, task, description, payload,
           transient_environment, production_environment, state, environment_url, log_url, creator, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', ?, ?)`,
      )
      .bind(
        id,
        repo.id,
        name,
        ref,
        sha,
        task,
        description,
        JSON.stringify(payload.value),
        a.transient_environment ? 1 : 0,
        production ? 1 : 0,
        state,
        environmentUrl,
        logUrl,
        a.actor.username,
        at,
        at,
      )
      .run();
    await this.addStatus(repo, id, {
      state,
      description,
      environment_url: environmentUrl,
      log_url: logUrl,
      creator: a.actor.username,
      auto_inactive: true,
      created: true,
      actor: a.actor.kind === "system" ? null : a.actor.id,
    });
    return this.detail(repo, id);
  }

  async createStatus(a: { repo: RepoPath; actor: User; id: string } & NewDeploymentStatus): Promise<Result<DeploymentStatus>> {
    const found = await this.repoFor(a.repo, a.actor, "push");
    if (!found.ok) return found;
    const repo = found.value;
    const id = String(a.id ?? "");
    if (id.startsWith("dpl_")) {
      const build = await this.db.prepare("SELECT id FROM deployments WHERE id = ? AND repo_id = ?").bind(id, repo.id).first();
      if (build) return fail("conflict", "That is a g1t.page build: its statuses come from the build itself.");
    }
    const exists = await this.db.prepare("SELECT id FROM reported_deployments WHERE id = ? AND repo_id = ?").bind(id, repo.id).first();
    if (!exists) return fail("not_found", "There is no such deployment.");
    if (!isState(a.state)) return fail("invalid", "`state` is queued, in_progress, success, failure, error or inactive.");
    const environmentUrl = address(a.environment_url, "environment_url");
    if (environmentUrl && typeof environmentUrl === "object") return fail("invalid", environmentUrl.error);
    const logUrl = address(a.log_url, "log_url");
    if (logUrl && typeof logUrl === "object") return fail("invalid", logUrl.error);
    const description = typeof a.description === "string" && a.description.trim() ? a.description.trim() : null;
    if (description && description.length > MAX_DESCRIPTION) return fail("invalid", `\`description\` is at most ${MAX_DESCRIPTION} characters.`);
    const status = await this.addStatus(repo, id, {
      state: a.state,
      description,
      environment_url: environmentUrl,
      log_url: logUrl,
      creator: a.actor.username,
      auto_inactive: a.auto_inactive ?? true,
      created: false,
      actor: a.actor.kind === "system" ? null : a.actor.id,
    });
    return ok(status);
  }

  /**
   * Records a status: the deployment takes its state and any address it
   * gives, the commit hears of it, and webhooks are told. A success, with
   * `auto_inactive`, makes the environment's older successes inactive.
   */
  private async addStatus(
    repo: Pick<Repo, "id" | "namespace" | "name">,
    deploymentId: string,
    input: {
      state: DeploymentState;
      description: string | null;
      environment_url: string | null;
      log_url: string | null;
      creator: string;
      auto_inactive: boolean;
      /** The deployment is new: `deployment.created` is published first. */
      created: boolean;
      /** The person who caused it, by id, for the event. */
      actor: string | null;
    },
  ): Promise<DeploymentStatus> {
    const at = now();
    const status: DeploymentStatus = {
      id: newId("dst"),
      deployment_id: deploymentId,
      state: input.state,
      description: input.description,
      environment_url: input.environment_url,
      log_url: input.log_url,
      creator: input.creator,
      created_at: at,
    };
    const updated = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO deployment_statuses (id, deployment_id, state, description, environment_url, log_url, creator, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(status.id, deploymentId, status.state, status.description, status.environment_url, status.log_url, status.creator, at),
      this.db
        .prepare(
          `UPDATE reported_deployments SET state = ?, environment_url = COALESCE(?, environment_url),
             log_url = COALESCE(?, log_url), updated_at = ? WHERE id = ? RETURNING *`,
        )
        .bind(status.state, status.environment_url, status.log_url, at, deploymentId),
    ]);
    const row = (updated[1].results as ReportedRow[])[0];
    if (!row) return status;
    const deployment = toDeployment(row);
    if (input.state === "success" && input.auto_inactive) await this.retireOlder(repo, deployment);
    await this.reportOnCommit(repo, deployment, status);
    const events = [];
    if (input.created) {
      events.push({ type: "deployment.created" as const, source: "deployments", repoId: repo.id, actor: input.actor, data: { repoId: repo.id, deployment: withoutPayload(deployment) } });
    }
    events.push({
      type: "deployment_status.created" as const,
      source: "deployments",
      repoId: repo.id,
      actor: input.actor,
      data: { repoId: repo.id, deployment: withoutPayload(deployment), deploymentStatus: status },
    });
    await this.publish(events);
    return status;
  }

  /** The environment's older deployments that succeeded are no longer what it serves. */
  private async retireOlder(repo: Pick<Repo, "id">, deployment: RepoDeployment): Promise<void> {
    const older = await this.db
      .prepare(
        `SELECT id FROM reported_deployments WHERE repo_id = ? AND environment = ? COLLATE NOCASE AND id != ? AND state = 'success'
           AND created_at <= ?`,
      )
      .bind(repo.id, deployment.environment, deployment.id, deployment.created_at)
      .all<{ id: string }>();
    if (older.results.length === 0) return;
    const at = now();
    const statements = older.results.flatMap((row) => [
      this.db
        .prepare(
          `INSERT INTO deployment_statuses (id, deployment_id, state, description, environment_url, log_url, creator, created_at)
           VALUES (?, ?, 'inactive', ?, NULL, NULL, 'g1t', ?)`,
        )
        .bind(newId("dst"), row.id, `Replaced by ${deployment.id}`, at),
      this.db.prepare("UPDATE reported_deployments SET state = 'inactive', updated_at = ? WHERE id = ?").bind(at, row.id),
    ]);
    await this.db.batch(statements);
  }

  /** `deploy / <environment>` on the commit, linked to the deployment's page. */
  private async reportOnCommit(
    repo: Pick<Repo, "id" | "namespace" | "name">,
    deployment: RepoDeployment,
    status: DeploymentStatus,
  ): Promise<void> {
    const state = commitState(status.state);
    if (!state) return;
    await this.env.WORK.fetch("https://work/rpc/set_commit_status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: repo.id,
        sha: deployment.sha,
        context: statusContext(deployment.environment),
        state,
        description: (status.description ?? commitDescription(status.state, deployment.environment)).slice(0, 140),
        targetUrl: `${this.env.SITE}/${repo.namespace}/${repo.name}/deployments/${deployment.id}`,
        source: "deployments",
      }),
    }).catch((error: unknown) => console.error("deployment status not set on the commit", deployment.id, String(error)));
  }

  private async publish(events: Parameters<ReturnType<typeof eventsClient>["publish"]>[0]): Promise<void> {
    if (!this.env.EVENTS || events.length === 0) return;
    await eventsClient(this.env.EVENTS)
      .publish(events)
      .catch((error: unknown) => console.error("deployment events not published", String(error)));
  }

  // ---- g1t Actions ---------------------------------------------------

  /**
   * A g1t Actions run's deployment to one environment: made when its first
   * job naming the environment starts, moved along as jobs fail, and
   * settled when the run finishes (see `actionsTransition`). One per run,
   * attempt and environment. For the actions service only.
   */
  async fromActions(a: ActionsReport): Promise<Result<{ id: string; state: DeploymentState } | null>> {
    const environment = environmentName(a.environment);
    if (typeof environment !== "string") return fail("invalid", environment.error);
    if (!isState(a.state)) return fail("invalid", "Unknown state.");
    const url = typeof address(a.url, "url") === "string" ? (a.url as string).trim() : null;
    const repo = { id: a.repoId, namespace: a.repo.namespace, name: a.repo.name };
    const existing = await this.db
      .prepare("SELECT * FROM reported_deployments WHERE run_id = ? AND run_attempt = ? AND environment = ? COLLATE NOCASE")
      .bind(a.runId, a.attempt, environment)
      .first<ReportedRow>();
    const creator = a.creator || "g1t";
    const description = (state: DeploymentState) =>
      state === "in_progress"
        ? `${a.workflow} is deploying`
        : state === "success"
          ? `${a.workflow} deployed`
          : state === "failure"
            ? `${a.workflow} failed`
            : state === "error"
              ? `${a.workflow} was cancelled`
              : stateDescription(state);
    if (!existing) {
      // A run that finished without deploying (every job that names the
      // environment skipped) has nothing to report.
      if (a.final && a.state !== "success" && a.state !== "failure" && a.state !== "error") return ok(null);
      const name = await this.environmentFor(a.repoId, environment);
      const id = newId("dep");
      const at = now();
      const inserted = await this.db
        .prepare(
          `INSERT INTO reported_deployments (id, repo_id, environment, ref, sha, task, description, payload,
             transient_environment, production_environment, state, environment_url, log_url, creator, source,
             run_id, run_attempt, run_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'deploy', ?, '{}', 0, ?, ?, ?, ?, ?, 'actions', ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING RETURNING id`,
        )
        .bind(
          id,
          a.repoId,
          name,
          shortRef(a.ref),
          a.sha,
          `${a.workflow}`,
          name.toLowerCase() === "production" ? 1 : 0,
          a.state,
          null,
          a.runUrl,
          creator,
          a.runId,
          a.attempt,
          a.runUrl,
          at,
          at,
        )
        .first<{ id: string }>();
      // Two jobs starting at once: the other made it; this one moves it along.
      if (!inserted) return this.fromActions(a);
      await this.addStatus(repo, id, {
        state: a.state,
        description: description(a.state),
        environment_url: a.state === "success" || a.state === "in_progress" ? url : null,
        log_url: a.runUrl,
        creator,
        auto_inactive: true,
        created: true,
        actor: null,
      });
      return ok({ id, state: a.state });
    }
    const next = actionsTransition(existing.state, a.state, a.final);
    if (!next) return ok({ id: existing.id, state: existing.state });
    await this.addStatus(repo, existing.id, {
      state: next,
      description: description(next),
      environment_url: next === "success" || next === "in_progress" ? url : null,
      log_url: a.runUrl,
      creator,
      auto_inactive: true,
      created: false,
      actor: null,
    });
    return ok({ id: existing.id, state: next });
  }

  // ---- g1t.page builds -----------------------------------------------

  /**
   * Publishes a g1t.page build's change as the same events a reported
   * deployment's are: `deployment.created` when it is queued, then a
   * `deployment_status.created` for each state it reaches.
   */
  async buildChanged(row: BuildRow, defaultBranch: string, created: boolean): Promise<void> {
    if (!this.env.EVENTS) return;
    const deployment = fromBuild(row, defaultBranch, this.env.SITE, appUrl, await this.names([row]));
    const statuses = buildStatuses(row, deployment);
    const status = statuses[statuses.length - 1];
    const actor = row.created_by.startsWith("usr_") ? row.created_by : null;
    const data = { repoId: row.repo_id, deployment: withoutPayload(deployment) };
    await this.publish([
      ...(created ? [{ type: "deployment.created" as const, source: "deployments", repoId: row.repo_id, actor, data }] : []),
      {
        type: "deployment_status.created" as const,
        source: "deployments",
        repoId: row.repo_id,
        actor,
        data: { ...data, deploymentStatus: status },
      },
    ]);
  }

  /** A purged repository's reported deployments go with it. */
  async purge(repoId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        "DELETE FROM deployment_statuses WHERE deployment_id IN (SELECT id FROM reported_deployments WHERE repo_id = ?)",
      ).bind(repoId),
      this.db.prepare("DELETE FROM reported_deployments WHERE repo_id = ?").bind(repoId),
      this.db.prepare("DELETE FROM environments WHERE repo_id = ?").bind(repoId),
    ]);
  }
}

/** Which source a filter names, if it is one. */
export function sourceOf(value: unknown): DeploymentSource | null {
  return value === "api" || value === "actions" || value === "g1t_page" ? value : null;
}
