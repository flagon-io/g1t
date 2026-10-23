/**
 * The deployments service: a project's production, deployed from its
 * default branch on every push, and a live preview of every branch with an
 * open pull request, on g1t.page.
 *
 * It reacts to events (a pull request opened, ready, pushed to, closed or
 * merged; a push to the default branch) for every project built from the
 * repository, asks billing whether the workspace pays for Deployments, and
 * asks the runner to build the commit in a sandbox. The sandbox reports
 * back through the API with a token for that build alone; this service
 * opens the upload of its files and puts the finished app in the Workers
 * for Platforms namespace, where the `*.g1t.page` dispatcher finds it by
 * hostname.
 *
 * A g1t Actions job can open a build too (`startFromWorkflow`, for
 * `POST /repos/{owner}/{repo}/deployments/builds` and the `g1t/deploy`
 * action) and build it in its own checkout with `g1t-runner deploy`; it
 * reports the same way, and its time is the job's, not a sandbox's.
 *
 * Nothing here is free, and nothing is capped. On the plan, every build
 * second is charged as it happens; requests, CPU time and custom domains
 * are charged from the first once the month is over, all at cost plus the
 * margin and from the plan's included usage first. No count of projects,
 * previews or apps ever stops or pauses a workspace: apps are not metered
 * at all. Only the workspace's spend limit pauses its apps
 * (`holdToLimits`), and only the plan ending takes them down. A Worker
 * runs only while it answers a request, so an app no one visits costs
 * nothing, and a preview is taken down when its pull request closes or
 * after its project's idle days.
 *
 * Reached through service bindings (`POST /rpc/<method>`) and, for a
 * build's reports, through the API (`POST /jobs/<id>/<step>`).
 */

import {
  BUILD_AS,
  CUSTOM_DOMAIN_TARGET,
  DEFAULT_APP_INSTANCE,
  DEPLOYMENT_COSTS,
  frameworkId,
  SLUG_HOLD_DAYS,
  ComputeGate,
  actionsClient,
  allows,
  billingClient,
  can,
  needs,
  permission,
  sandboxEstimateMicros,
  currentMovedPath,
  currentWorkspaceSlug,
  eventsClient,
  fail,
  identityClient,
  isProtectedWorkspace,
  newId,
  ok,
  openD1,
  projectsClient,
  repoMove,
  reposClient,
  staleMovedPaths,
  staleSlugs,
  workClient,
  type BuildAs,
  type ContainerCosts,
  type DeployKind,
  type DeploySettings,
  type DetectedKind,
  type DeployStatus,
  type DeployUsage,
  type Deployment,
  type Domain,
  type G1tEvent,
  type LiveApp,
  type Project,
  type ProjectDeploys,
  type RepoMove,
  type ProjectDomains,
  type ProjectRef,
  workOwner,
  type RepoPath,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
  telemetryClient,
} from "@g1t/contracts";

import { NEEDS, repoRef, trustedOutright, type Method } from "./access";
import { Cloudflare, type BuiltWorker, type Manifest } from "./cloudflare";
import {
  REGISTRY_HOST,
  appWorkerMetadata,
  containerCost,
  containerOffer,
  instanceTypeOf,
  maxImageBytes,
  meterReport,
  pushedImage,
  repositoryFor,
  type AppWorkerSettings,
  type ContainerMeter,
} from "./containers";
import { CustomHostnames } from "./custom-hostnames";
import { Domains, NOT_ENABLED_NOTICE, toDomain } from "./domains";
import { monthCost, movesMeter } from "./metering";
import { moveTargets, ownerOf, rebuildOutcome, type DroppedBuild, type MoveTarget } from "./moves";
import { commitMissing, MAX_IDENTICAL_FAILURES, missingCommitMessage, retryDecision, type PastBuild } from "./retries";
import { appHost, appUrl, label, uniqueLabel } from "./names";
import { RepoDeployments, sourceOf } from "./repo-deployments";
import { Shipped, shipmentOf } from "./shipped";
import { telemetryTags, withOtel, type AppTelemetry } from "./telemetry";
import { NEEDS_WRITE, commitOf, jobEndedMessage, jobOf, projectNamed, readOnlyAllowed, runTrusted, targetOf, type WorkflowBuild } from "./workflow-builds";

type Env = {
  DB: D1Database;
  REPOS: ServiceBinding;
  WORK: ServiceBinding;
  IDENTITY: ServiceBinding;
  BILLING: ServiceBinding;
  RUNNER: ServiceBinding;
  PROJECTS: ServiceBinding;
  /** Secrets and variables: the actions service holds the one store. */
  ACTIONS: ServiceBinding;
  /** The bus: each build that finishes is published, for the inbox, webhooks and workflows. */
  EVENTS?: ServiceBinding;
  /** Secret: scoped to Workers scripts and analytics on g1t's account. */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  DISPATCH_NAMESPACE: string;
  SITE: string;
  /** Custom domains: hostname to app, read by the dispatcher. */
  DOMAINS?: KVNamespace;
  /** Observability: each project's deployments token (services/telemetry). */
  TELEMETRY?: ServiceBinding;
  /**
   * The Workers Observability destination apps send Cloudflare's own
   * traces to (src/telemetry.ts); empty, none are sent.
   */
  TRACES_DESTINATION?: string;
  /** The g1t.page zone, where custom hostnames are added (Cloudflare for SaaS). */
  CUSTOM_HOSTNAMES_ZONE_ID?: string;
  /**
   * `on` runs container apps (Docker deployments, src/containers.ts), as
   * g1t.sh does; `off` where the account has no Containers (a self-hosted
   * g1t). While off, a container build is refused at its `registry` step with
   * `not_enabled`, and a project with a site besides its Dockerfile is
   * built as that site.
   */
  CONTAINERS?: string;
  /** Where container apps' Workers report their running time: the API. */
  G1T_API?: string;
  /** The og service's `Screenshots`: production's screenshot, taken once per deploy. */
  SCREENSHOTS?: { capture(input: { host: string; commit: string }): Promise<boolean> };
};

/** A build that has not reported in this long has died. */
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;
/** A script in the namespace that no app holds, older than this, is removed. */
const ORPHAN_AFTER_MS = 60 * 60 * 1000;
const LIST_LIMIT = 50;
const STATUS_CONTEXT = "g1t / deploy";
/**
 * Deliveries of `workspace.renamed` that wait for the projects service to
 * have seen it too, before going ahead with the new slug regardless.
 */
const RENAME_WAITS = 3;
/** Why a build under way was dropped by a move; the move builds it again under the new name. */
const MOVED_ERROR = "The repository moved: built again under its new name.";
const RENAMED_ERROR = "The workspace was renamed: built again under its new name.";
/**
 * A move's rebuild that could not start, or failed, is tried again by the
 * sweep after this long, doubled for each failure after the first, up to
 * `MAX_IDENTICAL_FAILURES` (see retries.ts).
 */
const MOVE_RETRY_MS = 60 * 60 * 1000;

/** A build's report of what it found the project to be, if it is one g1t knows. */
export function detectedKind(value: unknown): DetectedKind | null {
  return value === "workers" || value === "static" || value === "html" || value === "container" ? value : null;
}

/** What a project is built as, as it is kept. */
export function buildAsOf(value: unknown): BuildAs {
  return BUILD_AS.includes(value as BuildAs) ? (value as BuildAs) : "auto";
}

/** A Dockerfile's path as a project may set it: inside the project, or none. */
export function dockerfileOf(value: unknown): string | null {
  const path = typeof value === "string" ? value.trim().replace(/^\.\//, "") : "";
  if (!path || path.startsWith("/") || path.split("/").includes("..") || path.length > 300) return null;
  return path;
}

const now = () => new Date().toISOString();
const month = (at = new Date()) => at.toISOString().slice(0, 7);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isMember(viewer: Viewer, slug: string): boolean {
  return !!viewer?.workspaces?.some((membership) => membership.slug === slug.toLowerCase());
}

/** The repository a project builds from. */
/** One compute gate per isolate, so entitlements and prices are kept between calls. */
let computeGate: ComputeGate | null = null;
function gateFor(billing: ServiceBinding): ComputeGate {
  computeGate ??= new ComputeGate(billing);
  return computeGate;
}

/** The longest a build may run, in minutes: as long as its read token lasts. */
const BUILD_MINUTES = 30;

/**
 * A build that was skipped before it started (its plan, its limit, or
 * billing's refusal) as a failure, so whoever asked for it sees why.
 */
function notStarted(result: Result<Deployment>): Result<Deployment> {
  if (result.ok && result.value.status === "skipped" && result.value.error) {
    return fail("payment_required", result.value.error);
  }
  return result;
}

function repoOf(project: Project): { id: string; path: RepoPath; defaultBranch: string } {
  if (project.source.kind !== "hosted") throw new Error("Only projects hosted on g1t deploy so far.");
  return { id: project.source.repoId, path: project.source.repo, defaultBranch: project.source.defaultBranch };
}

type SettingsRow = {
  project_id: string;
  workspace: string;
  slug: string;
  repo_id: string;
  enabled: number;
  previews: number;
  production: number;
  build_command: string | null;
  output_dir: string | null;
  idle_days: number;
  /** Whether it builds through its managed deploy workflow; see `syncManagedDeploy`. */
  via_workflow?: number;
  /** Set while its repository is deleted (restorable); see `repoDeleted`. */
  repo_deleted_at: string | null;
  /** Set while its workspace is deleted (restorable); see `workspaceDeleting`. */
  workspace_deleted_at?: string | null;
  /** What it is built as, its Dockerfile, and its container's size (migration 0014). */
  build_as?: string | null;
  dockerfile?: string | null;
  instance_type?: string | null;
};

type DeploymentRow = {
  id: string;
  project_id: string;
  workspace: string;
  slug: string;
  repo_id: string;
  repo: string;
  kind: DeployKind;
  branch: string | null;
  number: number | null;
  commit_sha: string;
  script: string;
  status: DeployStatus;
  error: string | null;
  warnings: string;
  log: string | null;
  token_hash: string | null;
  trusted: number;
  build_seconds: number | null;
  created_by: string;
  created_at: string;
  finished_at: string | null;
  /** Set for a build a g1t Actions job runs (migration 0011): the job pays for its time. */
  run_id?: string | null;
  job_id?: string | null;
  detected?: string | null;
  /** What it was built with, and a container's image by digest (migration 0014). */
  framework?: string | null;
  image?: string | null;
  /** When billing confirmed its seconds (migration 0016); null until then. */
  build_charged_at?: string | null;
};

/** What opening any build takes; see `open`. */
type OpenInput = {
  project: Project;
  kind: DeployKind;
  branch: string | null;
  number: number | null;
  commit: string;
  createdBy: string;
  settings: SettingsRow;
  /** A push, or work by a member; see `insider`. */
  trusted: boolean;
  /** The g1t Actions job that builds it, for a build opened from a workflow. */
  workflow?: { runId: string; jobId: string };
};

/** Why a build was not opened: the plan or the limit, or g1t itself. */
type Refusal = "payment_required" | "conflict";

/** A sandbox's reservation with billing; none for a workflow job's build. */
type Compute = { reservation: string | null; microsPerSecond: number; maxRunMinutes: number | null };

type Opened =
  | { refused: string; code: Refusal; id: string }
  | {
      refused: null;
      id: string;
      token: string;
      script: string;
      build: { secrets: Record<string, string>; variables: Record<string, string> };
      compute: Compute;
    };

type AppRow = {
  script: string;
  project_id: string;
  workspace: string;
  slug: string;
  kind: DeployKind;
  branch: string | null;
  number: number | null;
  commit_sha: string;
  deployed_at: string;
  created_at: string;
  last_request_at: string | null;
  /** Set while its workspace is over its limit; see `holdToLimits`. */
  paused_at: string | null;
  /** `container` for a container app (migration 0014), with its Container application and size. */
  runtime?: string | null;
  container_app_id?: string | null;
  instance_type?: string | null;
  /** The build it serves (migration 0015). */
  deployment_id?: string | null;
};

function toDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    kind: row.kind,
    branch: row.branch,
    number: row.number,
    commit: row.commit_sha,
    status: row.status,
    url: appUrl(row.script),
    error: row.error,
    warnings: JSON.parse(row.warnings || "[]") as string[],
    buildSeconds: row.build_seconds,
    detected: detectedKind(row.detected),
    framework: frameworkId(row.framework),
    createdBy: row.created_by,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function toLive(app: AppRow): LiveApp {
  return {
    kind: app.kind,
    branch: app.branch,
    number: app.number,
    url: appUrl(app.script),
    commit: app.commit_sha,
    deployedAt: app.deployed_at,
  };
}

class Deployments {
  constructor(private readonly env: Env) {}

  private get cloudflare(): Cloudflare | null {
    const token = this.env.CLOUDFLARE_API_TOKEN;
    return token ? new Cloudflare(token, this.env.CLOUDFLARE_ACCOUNT_ID, this.env.DISPATCH_NAMESPACE, this.env.TRACES_DESTINATION || null) : null;
  }

  private get db() {
    return this.env.DB;
  }

  private get domains(): Domains {
    const token = this.env.CLOUDFLARE_API_TOKEN;
    const zone = this.env.CUSTOM_HOSTNAMES_ZONE_ID;
    return new Domains(this.env.DB, this.env.DOMAINS, token && zone ? new CustomHostnames(token, zone) : null);
  }

  private get projects() {
    return projectsClient(this.env.PROJECTS);
  }

  /** A repository's deployments wherever they run: reported, from g1t Actions, and these builds. */
  get repoDeployments(): RepoDeployments {
    return new RepoDeployments(this.env);
  }

  /** What each production deployment shipped, and whether a change is live (shipped.ts). */
  get shipped(): Shipped {
    return new Shipped(
      this.env,
      (slug) => this.workspaceActor(slug),
      (repo, actor, ref, limit) => reposClient(this.env.REPOS).log(repo, actor, ref, limit),
    );
  }

  /**
   * Publishes a build's change in the repository-wide model
   * (`deployment.created`, `deployment_status.created`), as a reported
   * deployment's are. Never fails the build.
   */
  private async buildChanged(id: string, created = false): Promise<void> {
    try {
      const row = await this.deploymentRow(id);
      if (!row) return;
      const project = (await this.projects.byRepo(row.repo_id)).find((p) => p.id === row.project_id);
      const defaultBranch = project?.source.kind === "hosted" ? project.source.defaultBranch : "main";
      await this.repoDeployments.buildChanged(row, defaultBranch, created);
    } catch (error) {
      console.error("build change not published", id, String(error));
    }
  }

  /** The workspace itself, as the service acts for it. */
  private async workspaceActor(slug: string): Promise<User | null> {
    const workspace = await identityClient(this.env.IDENTITY).getWorkspace(slug);
    if (!workspace) return null;
    return {
      id: workspace.id,
      username: workspace.slug,
      kind: "workspace",
      verified: true,
      workspaces: [{ slug: workspace.slug, role: "member" }],
    };
  }

  /**
   * What the project's secrets and variables available to deployments give
   * production or a preview: its build's environment, and the same again as
   * the running app's bindings. Untrusted builds get no secrets.
   */
  /**
   * The token the project's apps send OpenTelemetry with, from the
   * telemetry service; null when it cannot be had, and the app goes up
   * without it (its requests and logs still arrive as tail events).
   */
  private async telemetryToken(projectId: string, workspace: string): Promise<string | null> {
    if (!this.env.TELEMETRY) return null;
    try {
      // The workspace, so the project's telemetry is capped and metered with the rest of the workspace's.
      return (await telemetryClient(this.env.TELEMETRY).deploymentToken({ project_id: projectId, workspace })).secret;
    } catch (error) {
      console.error("could not get the project's telemetry token", projectId, error);
      return null;
    }
  }

  private async resolve(
    project: { id: string; slug: string; repoId: string; repo: RepoPath },
    environment: DeployKind,
    trusted: boolean,
  ): Promise<{ secrets: Record<string, string>; variables: Record<string, string> }> {
    const response = await this.env.ACTIONS.fetch("https://actions/rpc/resolve_settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: project.repoId,
        repo: project.repo,
        projectId: project.id,
        projectSlug: project.slug,
        consumer: "deployments",
        environment,
        trusted,
      }),
    });
    if (!response.ok) throw new Error(`Secrets and variables could not be read (${response.status}).`);
    const resolved = (await response.json()) as { secrets: Record<string, string>; variables: Record<string, string> };
    return { secrets: trusted ? resolved.secrets : {}, variables: resolved.variables };
  }

  /**
   * Whether whoever a pull request is for (`workOwner`: whoever asked g1t for
   * it, or its author) is trusted with the project's secrets: g1t's own
   * system work, or someone who can push to the repository (Write or more,
   * a member's or a collaborator's). Anyone else gets a preview built
   * without them, as their workflows run. A change made for someone is
   * trusted as they are, never more.
   */
  private async insider(repo: RepoPath, owner: User, actor: User): Promise<boolean> {
    if (trustedOutright(owner)) return true;
    const found = await identityClient(this.env.IDENTITY)
      .collaboratorPermission(actor, repo.namespace, repo.name, owner.username)
      .catch(() => null);
    return !!found?.ok && allows(found.value.role, "push");
  }

  private async settingsRow(projectId: string): Promise<SettingsRow | null> {
    return this.db.prepare("SELECT * FROM settings WHERE project_id = ?").bind(projectId).first<SettingsRow>();
  }

  /** The name an app gets, unique among apps: production, or a branch's preview. */
  private async scriptFor(project: Project, branch: string | null): Promise<string> {
    const base = await label(project.workspace, project.slug, branch);
    const holder = await this.db
      .prepare(
        `SELECT project_id, branch FROM apps WHERE script = ?1
         UNION ALL SELECT project_id, branch FROM deployments WHERE script = ?1 LIMIT 1`,
      )
      .bind(base)
      .first<{ project_id: string; branch: string | null }>();
    if (!holder || (holder.project_id === project.id && (holder.branch ?? null) === branch)) return base;
    return uniqueLabel(base, `${project.id}/${branch ?? ""}`);
  }

  private async toSettings(project: Project, row: SettingsRow | null): Promise<DeploySettings> {
    return {
      enabled: !!row?.enabled,
      previews: row ? !!row.previews : true,
      production: row ? !!row.production : true,
      buildCommand: row?.build_command ?? null,
      outputDir: row?.output_dir ?? null,
      idleDays: row?.idle_days ?? 7,
      viaWorkflow: !!row?.via_workflow,
      productionUrl: appUrl(await this.scriptFor(project, null)),
      primaryDomain: await this.domains.primary(project.id).catch(() => null),
      ...(await this.lastDetected(project.id)),
      buildAs: buildAsOf(row?.build_as),
      dockerfile: row?.dockerfile ?? null,
      instanceType: instanceTypeOf(row?.instance_type ?? DEFAULT_APP_INSTANCE),
      containers: await this.containerOffer(),
    };
  }

  /** What the project's last finished build found it to be, and built with; null before one has. */
  private async lastDetected(projectId: string): Promise<{ detected: DetectedKind | null; framework: string | null }> {
    const row = await this.db
      .prepare("SELECT detected, framework FROM deployments WHERE project_id = ? AND detected IS NOT NULL ORDER BY finished_at DESC LIMIT 1")
      .bind(projectId)
      .first<{ detected: string; framework: string | null }>()
      .catch(() => null);
    return { detected: detectedKind(row?.detected), framework: frameworkId(row?.framework) };
  }

  /** Whether container apps run here. */
  private get containersOn(): boolean {
    return this.env.CONTAINERS?.trim().toLowerCase() === "on";
  }

  /** What each container size is charged an hour awake, for Settings, Deployments. */
  private async containerOffer() {
    const costs = await this.costs();
    return containerOffer(costs.container, costs.marginPercent, this.containersOn);
  }

  /**
   * The project, if `viewer` may do what `method` needs on its repository
   * (see `NEEDS`): not found when they cannot read it, refused when they can
   * but their role is too low.
   */
  private async projectFor(ref: ProjectRef, viewer: Viewer, method: Method): Promise<Result<Project>> {
    const found = await this.projects.get(ref.workspace, ref.slug, viewer);
    if (!found.ok) return found;
    const repo = repoRef(found.value);
    if (!permission(viewer, repo)) return fail("not_found", "There is no such project.");
    const capability = NEEDS[method];
    if (!can(viewer, repo, capability)) return fail("forbidden", needs(capability));
    return found;
  }

  // ---- Methods for the site and the API ------------------------------

  async settings(a: { project: ProjectRef; viewer: Viewer }): Promise<Result<DeploySettings>> {
    const project = await this.projectFor(a.project, a.viewer, "settings");
    if (!project.ok) return project;
    return ok(await this.toSettings(project.value, await this.settingsRow(project.value.id)));
  }

  async updateSettings(a: { actor: User; project: ProjectRef; changes: Partial<DeploySettings> }): Promise<Result<DeploySettings>> {
    const found = await this.projectFor(a.project, a.actor, "updateSettings");
    if (!found.ok) return found;
    const project = found.value;
    const before = await this.toSettings(project, await this.settingsRow(project.id));
    const next = { ...before, ...a.changes };
    // A library, a tool or other, as set in its settings, does not deploy.
    if (next.enabled && !before.enabled && project.setting?.kind && project.setting.kind !== "app" && project.setting.kind !== "docs") {
      return fail("conflict", "This project is set to be something that doesn't deploy. Change what it is in its General settings first.");
    }
    if (next.enabled && !before.enabled) {
      // Turning it on starts paid work: only with the workspace's plan.
      const plan = await billingClient(this.env.BILLING).hasFeature(project.workspace, "deployments");
      if (!plan.ok) return plan;
    }
    const idleDays = Math.min(90, Math.max(1, Math.trunc(Number(next.idleDays) || 7)));
    const clip = (text: string | null | undefined) => (text?.trim() ? text.trim().slice(0, 500) : null);
    if (a.changes.dockerfile && !dockerfileOf(a.changes.dockerfile)) {
      return fail("invalid", "The Dockerfile's path must be inside the project, such as `Dockerfile` or `deploy/web.Dockerfile`.");
    }
    await this.db
      .prepare(
        `INSERT INTO settings (project_id, workspace, slug, repo_id, enabled, previews, production, build_command,
           output_dir, idle_days, updated_by, updated_at, via_workflow, build_as, dockerfile, instance_type)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT (project_id) DO UPDATE SET workspace = ?2, slug = ?3, repo_id = ?4, enabled = ?5, previews = ?6,
           production = ?7, build_command = ?8, output_dir = ?9, idle_days = ?10, updated_by = ?11, updated_at = ?12,
           via_workflow = ?13, build_as = ?14, dockerfile = ?15, instance_type = ?16`,
      )
      .bind(
        project.id,
        project.workspace,
        project.slug,
        repoOf(project).id,
        next.enabled ? 1 : 0,
        next.previews ? 1 : 0,
        next.production ? 1 : 0,
        clip(next.buildCommand),
        clip(next.outputDir),
        idleDays,
        a.actor.username,
        now(),
        next.viaWorkflow ? 1 : 0,
        buildAsOf(next.buildAs),
        dockerfileOf(next.dockerfile),
        instanceTypeOf(next.instanceType),
      )
      .run();
    // The managed deploy workflow follows the settings: installed while the
    // project builds through it, removed when it stops.
    if (next.viaWorkflow || before.viaWorkflow) {
      const installed = await this.syncManagedDeploy(project, next);
      if (!installed.ok) return installed;
    }
    // Projects keeps whether it deploys, so a project with Deployments on is an app.
    if (next.enabled !== before.enabled) {
      await this.projects.deploymentsChanged(project.id, next.enabled).catch((error) => console.warn("projects:", error));
    }
    // What was turned off comes down now; nothing keeps running unasked.
    if (!next.enabled) await this.takeDownWhere(project.id, null);
    else {
      if (!next.previews) await this.takeDownWhere(project.id, "preview");
      if (!next.production) await this.takeDownWhere(project.id, "production");
    }
    // Turned on: production goes up from the default branch at once.
    if (next.enabled && next.production && (!before.enabled || !before.production)) {
      await this.deployProduction(project, null, a.actor.username);
    }
    return ok(await this.toSettings(project, await this.settingsRow(project.id)));
  }

  /**
   * Installs, replaces or removes the project's managed deploy workflow
   * (the actions service's `set_managed_deploy`) to match `settings`: it
   * runs while Deployments are on and the project builds through it.
   */
  private async syncManagedDeploy(project: Project, settings: DeploySettings): Promise<Result<boolean>> {
    const on = settings.enabled && settings.viaWorkflow;
    const repo = repoOf(project);
    const response = await this.env.ACTIONS.fetch("https://actions/rpc/set_managed_deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: repo.id,
        project: project.slug,
        productionBranch: repo.defaultBranch,
        rootDir: project.source.kind === "hosted" ? (project.source.rootDir ?? "") : "",
        buildCommand: settings.buildCommand ?? "",
        outputDir: settings.outputDir ?? "",
        previews: on && settings.previews,
        production: on && settings.production,
      }),
    });
    const answer = (await response.json().catch(() => null)) as { ok?: boolean; value?: boolean; error?: { message?: string } } | null;
    if (!response.ok || !answer || answer.ok === false) {
      return fail("unavailable", answer?.error?.message ?? "The deploy workflow could not be installed. Try again in a moment.");
    }
    return ok(!!answer.value);
  }

  /** Whether `projectId` builds through its managed deploy workflow, so pushes and pull requests start no build here. */
  private async buildsViaWorkflow(projectId: string): Promise<boolean> {
    return !!(await this.settingsRow(projectId))?.via_workflow;
  }

  /** For projects: whether Deployments are on for a project. Reads only this service's own table. */
  async isEnabled(a: { projectId: string }): Promise<boolean> {
    return !!(await this.settingsRow(a.projectId))?.enabled;
  }

  async list(a: { project: ProjectRef; viewer: Viewer }): Promise<Result<{ deployments: Deployment[]; live: LiveApp[] }>> {
    const project = await this.projectFor(a.project, a.viewer, "list");
    if (!project.ok) return project;
    const [deployments, apps] = await Promise.all([
      this.db.prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT ?").bind(project.value.id, LIST_LIMIT).all<DeploymentRow>(),
      this.db.prepare("SELECT * FROM apps WHERE project_id = ? ORDER BY kind DESC, deployed_at DESC").bind(project.value.id).all<AppRow>(),
    ]);
    return ok({ deployments: deployments.results.map(toDeployment), live: apps.results.map(toLive) });
  }

  async get(a: { project: ProjectRef; id: string; viewer: Viewer }): Promise<Result<Deployment & { log: string | null }>> {
    const project = await this.projectFor(a.project, a.viewer, "get");
    if (!project.ok) return project;
    const row = await this.db.prepare("SELECT * FROM deployments WHERE id = ? AND project_id = ?").bind(a.id, project.value.id).first<DeploymentRow>();
    if (!row) return fail("not_found", "No such deployment.");
    return ok({ ...toDeployment(row), log: row.log });
  }

  async redeploy(a: { actor: User; project: ProjectRef; branch: string | null }): Promise<Result<Deployment>> {
    const found = await this.projectFor(a.project, a.actor, "redeploy");
    if (!found.ok) return found;
    const project = found.value;
    const settings = await this.settingsRow(project.id);
    if (!settings?.enabled) return fail("conflict", "Deployments are off for this project.");
    if (a.branch == null) {
      return notStarted((await this.deployProduction(project, null, a.actor.username)) ?? fail("conflict", "There was nothing to deploy."));
    }
    // A branch's preview comes from its pull request.
    const app = await this.db
      .prepare("SELECT number FROM deployments WHERE project_id = ? AND branch = ? AND number IS NOT NULL ORDER BY id DESC")
      .bind(project.id, a.branch)
      .first<{ number: number }>();
    if (!app) return fail("not_found", `No pull request has deployed ${a.branch}.`);
    return notStarted((await this.deployPreview(project, app.number, a.actor.username, true)) ?? fail("conflict", "Its pull request is not open."));
  }

  async takeDown(a: { actor: User; project: ProjectRef; branch: string | null }): Promise<Result<true>> {
    const project = await this.projectFor(a.project, a.actor, "takeDown");
    if (!project.ok) return project;
    await this.takeDownWhere(project.value.id, a.branch == null ? "production" : "preview", a.branch ?? undefined);
    return ok(true);
  }

  async overview(a: { workspace: string; viewer: Viewer }): Promise<Result<ProjectDeploys[]>> {
    const workspace = a.workspace.toLowerCase();
    if (!isMember(a.viewer, workspace)) return fail("forbidden", "Only members can see a workspace's deployments.");
    // Only the projects whose repositories the viewer can read: the
    // projects service lists no others.
    const listed = await this.projects.list(workspace, a.viewer);
    if (!listed.ok) return listed;
    const readable = new Set(listed.value.map((project) => project.slug));
    const [settings, apps, latest] = await Promise.all([
      // A deleted repository's projects are hidden until it is restored.
      this.db
        .prepare("SELECT slug, enabled FROM settings WHERE workspace = ? AND repo_deleted_at IS NULL")
        .bind(workspace)
        .all<{ slug: string; enabled: number }>(),
      this.db.prepare("SELECT * FROM apps WHERE workspace = ?").bind(workspace).all<AppRow>(),
      this.db
        .prepare(`SELECT * FROM deployments WHERE id IN (SELECT MAX(id) FROM deployments WHERE workspace = ? GROUP BY project_id)`)
        .bind(workspace)
        .all<DeploymentRow>(),
    ]);
    return ok(
      settings.results
        .filter((row) => readable.has(row.slug))
        .map((row) => {
          const own = apps.results.filter((app) => app.slug === row.slug);
          const production = own.find((app) => app.kind === "production");
          const newest = latest.results.find((d) => d.slug === row.slug);
          return {
            slug: row.slug,
            enabled: !!row.enabled,
            production: production ? toLive(production) : null,
            previews: own.filter((app) => app.kind === "preview").length,
            latest: newest ? toDeployment(newest) : null,
          };
        }),
    );
  }

  async usage(a: { workspace: string; viewer: Viewer }): Promise<Result<DeployUsage>> {
    const slug = a.workspace.toLowerCase();
    if (!isMember(a.viewer, slug)) return fail("forbidden", "Only members can see a workspace's usage.");
    const [meter, apps] = await Promise.all([
      this.db.prepare("SELECT * FROM meters WHERE namespace = ? AND month = ?").bind(slug, month()).first<{
        requests: number;
        cpu_ms: number;
        peak_apps: number;
        build_seconds: number;
        build_micros: number;
        counted_at: string | null;
      }>(),
      this.db.prepare("SELECT COUNT(*) AS n FROM apps WHERE workspace = ?").bind(slug).first<{ n: number }>(),
    ]);
    const container = (await this.containerMonth(month())).get(slug);
    return ok({
      month: month(),
      containerSeconds: container?.seconds ?? 0,
      containerMicros: container?.micros ?? 0,
      requests: meter?.requests ?? 0,
      cpuMs: meter?.cpu_ms ?? 0,
      apps: apps?.n ?? 0,
      peakApps: Math.max(meter?.peak_apps ?? 0, apps?.n ?? 0),
      buildSeconds: meter?.build_seconds ?? 0,
      buildMicros: meter?.build_micros ?? 0,
      countedAt: meter?.counted_at ?? null,
    });
  }

  // ---- Custom domains ------------------------------------------------

  async listDomains(a: { project: ProjectRef; viewer: Viewer }): Promise<Result<ProjectDomains>> {
    const project = await this.projectFor(a.project, a.viewer, "listDomains");
    if (!project.ok) return project;
    const domains = this.domains;
    await domains.catchUp(project.value.id).catch((error) => console.error("could not check domains", error));
    const [rows, available, used, costs] = await Promise.all([
      domains.forProject(project.value.id),
      domains.available(),
      domains.countFor(project.value.workspace),
      this.costs(),
    ]);
    return ok({
      domains: rows.map(toDomain),
      target: CUSTOM_DOMAIN_TARGET,
      available,
      notice: available ? null : NOT_ENABLED_NOTICE,
      monthlyMicros: costs.domainMonthPrice,
      used,
    });
  }

  async addDomain(a: { actor: User; project: ProjectRef; hostname: string; twin?: boolean }): Promise<Result<Domain[]>> {
    const found = await this.projectFor(a.project, a.actor, "addDomain");
    if (!found.ok) return found;
    const project = found.value;
    const plan = await billingClient(this.env.BILLING).hasFeature(project.workspace, "deployments");
    if (!plan.ok) return plan;
    const added = await this.domains.add({
      project: { id: project.id, workspace: project.workspace, slug: project.slug },
      script: await this.productionScript(project),
      hostname: String(a.hostname ?? ""),
      twin: !!a.twin,
      by: a.actor.username,
    });
    if (!added.ok) return fail(added.code, added.message);
    await this.notePeak(project.workspace);
    return ok(added.rows.map(toDomain));
  }

  async removeDomain(a: { actor: User; project: ProjectRef; id: string }): Promise<Result<true>> {
    const found = await this.projectFor(a.project, a.actor, "removeDomain");
    if (!found.ok) return found;
    const row = await this.domains.byId(found.value.id, String(a.id ?? ""));
    if (!row) return fail("not_found", "No such domain.");
    await this.domains.remove(row);
    return ok(true);
  }

  async refreshDomain(a: { actor: User; project: ProjectRef; id: string }): Promise<Result<Domain>> {
    const found = await this.projectFor(a.project, a.actor, "refreshDomain");
    if (!found.ok) return found;
    const domains = this.domains;
    const row = await domains.byId(found.value.id, String(a.id ?? ""));
    if (!row) return fail("not_found", "No such domain.");
    const after = await domains.refresh(row, row.script ?? (await this.productionScript(found.value)), true);
    await this.notePeak(found.value.workspace);
    return ok(toDomain(after));
  }

  /** The script production is up under, or the name it will have. */
  private async productionScript(project: Project): Promise<string> {
    const app = await this.db.prepare("SELECT script FROM apps WHERE project_id = ? AND kind = 'production'").bind(project.id).first<{ script: string }>();
    return app?.script ?? (await this.scriptFor(project, null));
  }

  // ---- Starting builds -----------------------------------------------

  /**
   * Opens a deployment and starts its build in a sandbox. Skipped, with the
   * reason recorded, when the workspace's plan is off.
   */
  private async start(
    input: OpenInput & {
      /** Where the build reads the commit from: the project, or a pull request's fork. */
      source: RepoPath;
      /** Who reads it: the workspace, or whoever the pull request is for. */
      reader: User;
    },
  ): Promise<Result<Deployment>> {
    const { project } = input;
    const repo = repoOf(project);
    const opened = await this.open(input, { reserve: true });
    if (opened.refused !== null) return ok(toDeployment((await this.deploymentRow(opened.id))!));
    const { build, compute } = opened;
    const response = await this.env.RUNNER.fetch("https://runner/rpc/start_deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deployId: opened.id,
        token: opened.token,
        workspace: project.workspace,
        reservation: compute.reservation,
        microsPerSecond: compute.microsPerSecond,
        maxRunMinutes: compute.maxRunMinutes,
        actor: input.reader,
        source: input.source,
        // The project, whose guardrails the build runs under: a preview's
        // source is its pull request's working copy, not the project.
        repo: repo.path,
        repoId: repo.id,
        commit: input.commit,
        rootDir: project.source.rootDir,
        buildCommand: input.settings.build_command,
        outputDir: input.settings.output_dir,
        buildAs: buildAsOf(input.settings.build_as),
        dockerfile: input.settings.dockerfile ?? null,
        buildEnv: build.variables,
        buildSecrets: build.secrets,
      }),
    });
    const started = response.ok ? ((await response.json()) as Result<true>) : fail("conflict", `The runner answered ${response.status}.`);
    if (!started.ok) {
      // Never reached a sandbox: what was reserved is given back.
      if (compute.reservation) await gateFor(this.env.BILLING).settle(compute.reservation, 0);
      await this.finishFailed(opened.id, started.error.message, null, null);
    }
    return ok(toDeployment((await this.deploymentRow(opened.id))!));
  }

  /**
   * What every build does before anything builds it: checks the plan and
   * the spend limit (and, for a sandbox, reserves its compute with
   * billing), records the deployment with a token for that build alone,
   * replaces older builds of the same app, sets the commit's status, and
   * reads what the project's secrets and variables give builds of its
   * kind. A refusal is the deployment's status, saying what to do; nothing
   * is resolved for a refused build.
   */
  private async open(input: OpenInput, options: { reserve: boolean }): Promise<Opened> {
    const { project } = input;
    const repo = repoOf(project);
    const script = await this.scriptFor(project, input.branch);
    const id = newId("dpl");
    const token = randomToken();
    const plan = await billingClient(this.env.BILLING).hasFeature(project.workspace, "deployments");
    const limit = await billingClient(this.env.BILLING).checkLimit(project.workspace);
    const stopped = limit.ok && limit.value.state === "stopped";
    const cloudflare = this.cloudflare;
    let refused = !plan.ok
      ? plan.error.message
      : stopped
        ? (limit.value.message ?? "The workspace reached its usage limit.")
        : !cloudflare
          ? "Deployments are not set up on this g1t: it has no Cloudflare token."
          : null;
    let code: Refusal = plan.ok && !stopped ? "conflict" : "payment_required";
    // A sandbox's build is compute: reserved with billing before it starts,
    // and settled by its sandbox when it stops. A workflow job's build runs
    // in the job, which pays for its own time.
    const compute: Compute = { reservation: null, microsPerSecond: 0, maxRunMinutes: null };
    if (!refused && options.reserve) {
      const gate = gateFor(this.env.BILLING);
      const ent = await gate.entitlements(project.workspace);
      compute.microsPerSecond = await gate.microsPerSecond();
      compute.maxRunMinutes = ent && ent.maxRunMinutes > 0 ? ent.maxRunMinutes : null;
      const isPrivate = await reposClient(this.env.REPOS)
        .get(repo.path, null)
        .then((found) => !found.ok || found.value.isPrivate)
        .catch(() => true);
      const admitted = await gate.admit(
        {
          workspace: project.workspace,
          repo: repo.path,
          public: !isPrivate,
          kind: "deploy",
          estimateMicros: sandboxEstimateMicros(Math.min(BUILD_MINUTES, compute.maxRunMinutes ?? BUILD_MINUTES), compute.microsPerSecond),
        },
        ent,
      );
      if (admitted.ok) compute.reservation = admitted.reservation?.id ?? null;
      else {
        refused = admitted.message;
        code = "payment_required";
      }
    }
    await this.db
      .prepare(
        `INSERT INTO deployments (id, project_id, workspace, slug, repo_id, repo, kind, branch, number, commit_sha,
           script, status, error, token_hash, trusted, created_by, created_at, finished_at, run_id, job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        project.id,
        project.workspace,
        project.slug,
        repo.id,
        `${repo.path.namespace}/${repo.path.name}`,
        input.kind,
        input.branch,
        input.number,
        input.commit,
        script,
        refused ? "skipped" : "queued",
        refused,
        refused ? null : await sha256(token),
        input.trusted ? 1 : 0,
        input.createdBy,
        now(),
        refused ? now() : null,
        input.workflow?.runId ?? null,
        input.workflow?.jobId ?? null,
      )
      .run();
    if (refused) return { refused, code, id };
    // Older builds of the same app are replaced by this one.
    await this.db
      .prepare(
        `UPDATE deployments SET status = 'skipped', error = 'A newer commit replaced this build.', finished_at = ?
         WHERE script = ? AND id != ? AND status IN ('queued', 'building')`,
      )
      .bind(now(), script, id)
      .run();
    await this.status(repo.id, input.commit, project, "pending", "Building", `${this.env.SITE}/${project.workspace}/${project.slug}/deployments/${id}`);
    await this.buildChanged(id, true);
    // What the project's secrets and variables give builds of this kind.
    const build = await this.resolve({ id: project.id, slug: project.slug, repoId: repo.id, repo: repo.path }, input.kind, input.trusted);
    return { refused: null, id, token, script, build, compute };
  }

  /**
   * For a g1t Actions job (`POST /repos/{owner}/{repo}/deployments/builds`):
   * opens a g1t.page build of one of the repository's projects, which the
   * job builds in its own checkout with `g1t-runner deploy`. The caller is
   * the job's own token (`token.job`), which needs `deployments: write` and
   * reaches this repository only. The run decides what is built: a run on
   * the project's production branch builds production, a pull request's
   * run its preview, a run on another branch that branch's preview. A pull
   * request from a fork or from someone who cannot push here, and a run
   * that needed approval, get no build secrets. The job pays for its own
   * time, so nothing is reserved or charged here for the build; the plan
   * and the spend limit are checked as for any build.
   */
  async startFromWorkflow(a: { actor: User; repo: RepoPath; project?: string | null; sha?: string | null }): Promise<Result<WorkflowBuild>> {
    const repoPath = { namespace: String(a.repo?.namespace ?? ""), name: String(a.repo?.name ?? "") };
    const job = jobOf(a.actor, repoPath);
    if ("error" in job) return fail("forbidden", job.error);
    const actor = await this.workspaceActor(repoPath.namespace);
    if (!actor) return fail("not_found", "There is no such repository.");
    const found = await reposClient(this.env.REPOS).get(repoPath, actor);
    if (!found.ok) return fail("not_found", "There is no such repository.");
    const projects = await this.projects.byRepo(found.value.id);
    const rows = new Map(await Promise.all(projects.map(async (p) => [p.id, await this.settingsRow(p.id)] as const)));
    const live = (row: SettingsRow | null | undefined): row is SettingsRow => !!row?.enabled && !row.repo_deleted_at && !row.workspace_deleted_at;
    const chosen = projectNamed(projects, (p) => live(rows.get(p.id)), a.project);
    if ("error" in chosen) return fail(chosen.code, chosen.error);
    const project = chosen;
    if (project.source.kind !== "hosted") return fail("conflict", "Only projects hosted on g1t deploy so far.");
    // A token that writes deployments needs the role a redeploy does; one
    // that does not is let through below only for a managed preview.
    if (job.writes && !can(a.actor, repoRef(project), NEEDS.redeploy)) return fail("forbidden", needs(NEEDS.redeploy));
    const settings = rows.get(project.id);
    if (!live(settings)) return fail("conflict", `Deployments are off for ${project.slug}.`);
    const repo = repoOf(project);

    // The run and its job, as the actions service has them: still running.
    const detail = await actionsClient(this.env.ACTIONS).run(repo.path, actor, job.runId);
    if (!detail.ok) return fail("not_found", "The job's run was not found.");
    const { run } = detail.value;
    const running = detail.value.jobs.find((j) => j.id === job.jobId);
    if (run.status === "completed" || !running || running.status === "completed") {
      return fail("conflict", "The job has finished: a build is opened from a job while it runs.");
    }
    const commit = commitOf(a.sha, run);
    if (typeof commit !== "string") return fail("invalid", commit.error);

    const target = targetOf(run, repo.defaultBranch);
    if ("error" in target) return fail("invalid", target.error);
    if (!job.writes && !readOnlyAllowed(run, target)) return fail("forbidden", NEEDS_WRITE);
    let kind: DeployKind = "production";
    let branch: string | null = null;
    let number: number | null = null;
    let trusted = runTrusted({ approval: detail.value.approval, pull: null, insider: true });
    if (target.kind === "pull") {
      const pull = await workClient(this.env.WORK).getPull(repo.path, target.number, actor);
      if (!pull.ok) return fail("not_found", `Pull request #${target.number} was not found.`);
      const open = pull.value.pull;
      if (open.status !== "open" && open.status !== "draft") {
        return fail("conflict", `Pull request #${target.number} is not open, so it has no preview.`);
      }
      kind = "preview";
      // A pull request from a fork has no branch here (see `deployPreview`).
      branch = open.branch ?? `pr-${target.number}`;
      number = target.number;
      trusted = runTrusted({
        approval: detail.value.approval,
        pull: open,
        insider: await this.insider(repo.path, workOwner(open), actor),
      });
    } else if (target.kind === "branch") {
      kind = "preview";
      branch = target.branch;
    }
    // A read-only token's build never gets the project's build secrets.
    if (!job.writes) trusted = false;
    if (kind === "production" && !settings.production) return fail("conflict", `Production deploys are off for ${project.slug}.`);
    if (kind === "preview" && !settings.previews) return fail("conflict", `Previews are off for ${project.slug}.`);

    const opened = await this.open(
      { project, kind, branch, number, commit, createdBy: run.actor ?? "g1t", settings, trusted, workflow: job },
      { reserve: false },
    );
    if (opened.refused !== null) return fail(opened.code, opened.refused);
    return ok({
      deploy_id: opened.id,
      token: opened.token,
      kind,
      project: project.slug,
      branch,
      number,
      commit,
      url: appUrl(opened.script),
      trusted,
      root_dir: project.source.rootDir ?? "",
      build_command: settings.build_command,
      output_dir: settings.output_dir,
      build_as: buildAsOf(settings.build_as),
      dockerfile: settings.dockerfile ?? null,
      build_env: opened.build.variables,
      build_secrets: opened.build.secrets,
    });
  }

  /**
   * For the actions service, when a workflow job ends (`finish_job`), with
   * any conclusion: a build the job opened and did not finish or fail is
   * failed now, saying how the job ended, rather than left building until
   * the sweep's 45 minutes. A build the job finished is left as it is.
   */
  async workflowJobEnded(a: { jobId?: unknown; conclusion?: unknown }): Promise<Result<number>> {
    if (typeof a.jobId !== "string" || !a.jobId) return fail("invalid", "No job.");
    const open = await this.db.prepare("SELECT id FROM deployments WHERE job_id = ? AND status IN ('queued', 'building')").bind(a.jobId).all<{ id: string }>();
    const message = jobEndedMessage(typeof a.conclusion === "string" ? a.conclusion : "");
    for (const { id } of open.results) await this.finishFailed(id, message, null, null);
    return ok(open.results.length);
  }

  private async deployProduction(project: Project, commit: string | null, createdBy: string): Promise<Result<Deployment> | null> {
    const settings = await this.settingsRow(project.id);
    if (!settings?.enabled || !settings.production || settings.repo_deleted_at || settings.workspace_deleted_at) return null;
    const actor = await this.workspaceActor(project.workspace);
    if (!actor) return null;
    const repo = repoOf(project);
    let head = commit;
    if (!head) {
      const branches = await reposClient(this.env.REPOS).branches(repo.path, actor);
      head = branches.ok ? (branches.value.find((b) => b.name === repo.defaultBranch)?.hash ?? null) : null;
    }
    if (!head) return null;
    return this.start({
      project,
      kind: "production",
      branch: null,
      number: null,
      commit: head,
      source: repo.path,
      reader: actor,
      createdBy,
      settings,
      // The default branch only moves by people with access.
      trusted: true,
    });
  }

  private async deployPreview(project: Project, number: number, createdBy: string, force = false): Promise<Result<Deployment> | null> {
    const settings = await this.settingsRow(project.id);
    if (!settings?.enabled || !settings.previews || settings.repo_deleted_at || settings.workspace_deleted_at) return null;
    const actor = await this.workspaceActor(project.workspace);
    if (!actor) return null;
    const repo = repoOf(project);
    const detail = await workClient(this.env.WORK).getPull(repo.path, number, actor);
    if (!detail.ok) return null;
    const { pull } = detail.value;
    if ((pull.status !== "open" && pull.status !== "draft") || !pull.headCommit) return null;
    // A pull request from a fork has no branch here.
    const branch = pull.branch ?? `pr-${number}`;
    if (!force) {
      // Already built, or being built, at this commit.
      const same = await this.db
        .prepare(
          `SELECT id FROM deployments WHERE project_id = ? AND kind = 'preview' AND branch = ? AND commit_sha = ?
             AND status IN ('queued', 'building', 'ready')`,
        )
        .bind(project.id, branch, pull.headCommit)
        .first();
      if (same) return null;
    }
    return this.start({
      project,
      kind: "preview",
      branch,
      number,
      commit: pull.headCommit,
      source: pull.fork ?? repo.path,
      // The pull request's fork may be private: read it as whoever it is
      // for (whoever asked g1t for it, or its author), who is also who is
      // trusted or not with the project's secrets.
      reader: workOwner(pull),
      createdBy,
      settings,
      trusted: await this.insider(repo.path, workOwner(pull), actor),
    });
  }

  // ---- A build's reports ---------------------------------------------

  private async deploymentRow(id: string): Promise<DeploymentRow | null> {
    return this.db.prepare("SELECT * FROM deployments WHERE id = ?").bind(id).first<DeploymentRow>();
  }

  /** The build, if `token` is its own and it is still under way. */
  private async building(id: string, token: unknown): Promise<DeploymentRow | null> {
    const row = await this.deploymentRow(id);
    if (!row?.token_hash || typeof token !== "string") return null;
    if (row.token_hash !== (await sha256(token))) return null;
    return row.status === "queued" || row.status === "building" ? row : null;
  }

  async job(id: string, step: string, body: Record<string, unknown>): Promise<Response> {
    // Each report, for the logs: a build's own failure says why.
    console.log("build", id, step, typeof body.message === "string" ? body.message.slice(0, 500) : "");
    const row = await this.building(id, body.token);
    if (!row) return Response.json(fail("not_found", "No such build, or it has finished."), { status: 404 });
    const cloudflare = this.cloudflare;
    if (!cloudflare) return Response.json(fail("conflict", "Deployments are not set up."), { status: 409 });
    switch (step) {
      case "started":
        await this.db.prepare("UPDATE deployments SET status = 'building', started_at = ? WHERE id = ?").bind(now(), id).run();
        await this.buildChanged(id);
        return Response.json(ok(true));
      case "registry": {
        // Where a container build pushes its image: its app's repository,
        // with a login that can push and nothing else, for minutes.
        if (!this.containersOn) {
          // Its own code, which the build reads to build the site the
          // project is without its Dockerfile, when it is one.
          const error = { code: "not_enabled", message: "Docker deployments are switched off on this g1t." };
          return Response.json({ ok: false, error }, { status: 409 });
        }
        const instanceType = instanceTypeOf((await this.settingsRow(row.project_id))?.instance_type);
        let login: Awaited<ReturnType<typeof cloudflare.registryLogin>>;
        try {
          login = await cloudflare.registryLogin();
        } catch (error) {
          // Said in the build's log, not as a bare 500: most often the
          // operator's Cloudflare token lacks Containers: Edit.
          const reason = error instanceof Error ? error.message : String(error);
          console.error("registry login refused", row.id, reason);
          const message = `Cloudflare refused a login to push the image (${reason}). Its API token needs the Containers: Edit permission.`;
          return Response.json(fail("unavailable", message), { status: 502 });
        }
        return Response.json(
          ok({
            registry: REGISTRY_HOST,
            repository: repositoryFor(this.env.CLOUDFLARE_ACCOUNT_ID, row.script),
            tag: row.id,
            username: login.username,
            password: login.password,
            maxImageBytes: maxImageBytes(instanceType),
            instanceType,
          }),
        );
      }
      case "session": {
        const manifest = body.manifest as Manifest | undefined;
        if (!manifest || typeof manifest !== "object") return Response.json(fail("invalid", "No manifest."), { status: 400 });
        const session = await cloudflare.openUpload(row.script, manifest);
        return Response.json(ok({ ...session, uploadUrl: cloudflare.uploadUrl }));
      }
      case "finish": {
        const worker = (body.worker ?? {}) as BuiltWorker;
        const seconds = Number(body.buildSeconds) || 0;
        const [namespace, name] = row.repo.split("/") as [string, string];
        const detected = detectedKind(body.detected);
        const tags = [`workspace:${row.workspace}`, `project:${row.workspace}/${row.slug}`, row.kind, ...telemetryTags(row.project_id, id)];
        const app: AppTelemetry = { project: row.project_id, deployment: id, environment: row.kind, service: row.slug, commit: row.commit_sha };
        let container: { appId: string; instanceType: string; meterHash: string; image: string } | null = null;
        let before: AppRow | null = null;
        try {
          // Running apps' secrets and variables are bound here, by g1t:
          // they never pass through the build's sandbox.
          // OpenTelemetry's variables point the app's own SDK at the
          // project (src/telemetry.ts); an untrusted build's app gets no token.
          const runtime = withOtel(
            await this.resolve({ id: row.project_id, slug: row.slug, repoId: row.repo_id, repo: { namespace, name } }, row.kind, !!row.trusted),
            app,
            row.trusted ? await this.telemetryToken(row.project_id, row.workspace) : null,
          );
          before = await this.db.prepare("SELECT runtime, container_app_id, deployment_id FROM apps WHERE script = ?").bind(row.script).first<AppRow>();
          if (detected === "container") {
            container = await this.runContainer(cloudflare, row, body.container, runtime, tags);
          } else {
            // A container app that is now a site: its container goes first,
            // and its Worker, whose class the site's does not have.
            if (before?.runtime === "container") {
              await cloudflare.deleteContainer(row.script, before.container_app_id);
              await cloudflare.deleteScript(row.script);
              await this.dropImages(cloudflare, row.script, []);
            }
            await cloudflare.putScript(row.script, worker, typeof body.completionJwt === "string" ? body.completionJwt : null, tags, runtime);
          }
        } catch (error) {
          await this.finishFailed(id, `Cloudflare did not take the app: ${String(error).replace(/^Error: /, "")}`, String(body.log ?? ""), seconds);
          return Response.json(ok(false));
        }
        const at = now();
        const wasRedirect = await this.db.prepare("SELECT 1 FROM redirects WHERE script = ?").bind(row.script).first();
        await this.db.batch([
          this.db
            .prepare(
              `UPDATE deployments SET status = 'ready', warnings = ?, log = ?, build_seconds = ?, finished_at = ?, detected = ?,
                 framework = ?, image = ?
               WHERE id = ?`,
            )
            .bind(
              JSON.stringify(Array.isArray(body.warnings) ? body.warnings : []),
              String(body.log ?? ""),
              seconds,
              at,
              detected,
              frameworkId(body.framework),
              container?.image ?? null,
              id,
            ),
          // The build it replaces is no longer what the app serves.
          this.db.prepare(`UPDATE deployments SET status = 'replaced' WHERE script = ? AND id != ? AND status = 'ready'`).bind(row.script, id),
          this.db
            .prepare(
              `INSERT INTO apps (script, project_id, workspace, slug, kind, branch, number, commit_sha, deployed_at, created_at,
                 runtime, container_app_id, instance_type, meter_hash, deployment_id)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, ?13, ?14)
               ON CONFLICT (script) DO UPDATE SET commit_sha = ?8, number = ?7, deployed_at = ?9, paused_at = NULL,
                 runtime = ?10, container_app_id = ?11, instance_type = ?12, meter_hash = ?13, deployment_id = ?14`,
            )
            .bind(
              row.script,
              row.project_id,
              row.workspace,
              row.slug,
              row.kind,
              row.branch,
              row.number,
              row.commit_sha,
              at,
              container ? "container" : "worker",
              container?.appId ?? null,
              container?.instanceType ?? null,
              container?.meterHash ?? null,
              id,
            ),
          // A name that redirected elsewhere (a move undone) is an app again.
          this.db.prepare("DELETE FROM redirects WHERE script = ?").bind(row.script),
        ]);
        // A pull request closed while its preview built: `pull.closed` took
        // down what was up then, so the preview this build just put up is
        // taken down here, or it would stay up for good. Asked after the app
        // is written, so a close that comes later finds it.
        if (await this.pullGone(row)) {
          await this.removeApp(row.script);
          await this.buildChanged(id);
          return Response.json(ok(true));
        }
        // Under its own hostname, what the dispatcher files each request
        // under (src/telemetry.ts); this also replaces a redirect the name
        // held while it was not an app.
        await this.env.DOMAINS?.put(appHost(row.script), JSON.stringify({ script: row.script, redirect: null, telemetry: app })).catch((error) =>
          console.error(wasRedirect ? "could not drop redirect" : "could not note the app's project", row.script, error),
        );
        // The same app at an older name (its project moved) now redirects
        // here; it stays up as it was if the redirect cannot be put.
        await this.supersede(cloudflare, row, row.script);
        // The project's own domains serve production wherever it is up.
        if (row.kind === "production") {
          await this.domains.follow(row.project_id, row.script).catch((error) => console.error("could not point domains", error));
        }
        // Its images but this one and the one it replaced go.
        if (container) await this.dropImages(cloudflare, row.script, [id, before?.deployment_id ?? null]);
        await this.chargeBuild(row, seconds);
        await this.notePeak(row.workspace);
        await this.statusFor(row, "success", row.kind === "preview" ? "Preview is live" : "Production is live", appUrl(row.script));
        await this.announce(row, null);
        await this.buildChanged(id);
        // A screenshot of production as it now is, for the project's overview.
        if (row.kind === "production") {
          await this.env.SCREENSHOTS?.capture({ host: appHost(row.script), commit: row.commit_sha }).catch((error) =>
            console.error("could not ask for a screenshot", error),
          );
        }
        return Response.json(ok(true));
      }
      case "fail":
        await this.finishFailed(id, String(body.message ?? "The build failed."), body.log == null ? null : String(body.log), Number(body.buildSeconds) || null);
        return Response.json(ok(true));
      default:
        return Response.json(fail("not_found", "No such step."), { status: 404 });
    }
  }

  /**
   * Runs a container build's image as its app: checks it is an image in
   * the app's own repository, by digest, that the registry has; puts the
   * app's Worker (g1t's, `APP_WORKER`) in the namespace with the project's
   * entries and a new token to report its running time with; then makes
   * or rolls out its Container application at the project's size.
   */
  private async runContainer(
    cloudflare: Cloudflare,
    row: DeploymentRow,
    report: unknown,
    runtime: { secrets: Record<string, string>; variables: Record<string, string> },
    tags: string[],
  ): Promise<{ appId: string; instanceType: string; meterHash: string; image: string }> {
    if (!this.containersOn) throw new Error("Docker deployments are switched off on this g1t.");
    const repository = repositoryFor(this.env.CLOUDFLARE_ACCOUNT_ID, row.script);
    const pushed = pushedImage(report, repository);
    if (!pushed) throw new Error(`the build did not report an image by digest in ${REGISTRY_HOST}/${repository}.`);
    if (!(await cloudflare.hasImage(repository, pushed.digest))) throw new Error(`${pushed.image} is not in the registry.`);
    const instanceType = instanceTypeOf((await this.settingsRow(row.project_id))?.instance_type);
    const meterToken = randomToken();
    const settings: AppWorkerSettings = { mode: "serve", port: pushed.port, instanceType, meterUrl: this.meterUrl(row.script), meterToken };
    await cloudflare.putContainerWorker(row.script, appWorkerMetadata(settings, runtime, [...tags, "container"]));
    const appId = await cloudflare.runContainer(row.script, pushed.image, instanceType, `${row.id}: ${row.commit_sha.slice(0, 7)}`);
    return { appId, instanceType, meterHash: await sha256(meterToken), image: pushed.image };
  }

  /**
   * Deletes an app's images but those its builds still use: the tags in
   * `keep`, and those of its builds under way, which may have pushed an
   * image they have yet to report. Containers holds an account's images
   * to `IMAGE_STORAGE_GB` in all, so nothing is kept that will not run.
   * A failure is logged: the app's next deploy or removal tries again.
   */
  private async dropImages(cloudflare: Cloudflare, script: string, keep: (string | null | undefined)[]): Promise<void> {
    try {
      const building = await this.db
        .prepare("SELECT id FROM deployments WHERE script = ? AND status IN ('queued', 'building')")
        .bind(script)
        .all<{ id: string }>();
      const held = [...keep, ...building.results.map((b) => b.id)].filter((tag): tag is string => !!tag);
      const gone = await cloudflare.pruneImages(repositoryFor(this.env.CLOUDFLARE_ACCOUNT_ID, script), held);
      if (gone.length) console.log("deleted images", script, gone.join(", "));
    } catch (error) {
      console.error("could not delete images", script, error);
    }
  }

  /** Where a container app's Worker reports its running time: the API, which forwards it here. */
  private meterUrl(script: string): string {
    return `${(this.env.G1T_API ?? "https://api.g1t.sh").replace(/\/+$/, "")}/deployments/apps/${script}/meter`;
  }

  /**
   * A container app held as it is, without serving: paused (its
   * workspace's limit), or redirecting to where its project moved. Its
   * Worker keeps its class, so its container stays attached and stops.
   */
  private async holdContainer(cloudflare: Cloudflare, script: string, mode: "paused" | "redirect", redirect?: string): Promise<void> {
    const app = await this.db.prepare("SELECT instance_type FROM apps WHERE script = ?").bind(script).first<{ instance_type: string | null }>();
    const meterToken = randomToken();
    const settings: AppWorkerSettings = {
      mode,
      redirect,
      port: 8080,
      instanceType: instanceTypeOf(app?.instance_type),
      meterUrl: this.meterUrl(script),
      meterToken,
    };
    await cloudflare.putContainerWorker(script, appWorkerMetadata(settings, { secrets: {}, variables: {} }, [mode, "container"]));
    await this.db
      .prepare("UPDATE apps SET meter_hash = ? WHERE script = ?")
      .bind(await sha256(meterToken), script)
      .run();
  }

  /** Whether `script` is a container app. */
  private async isContainer(script: string): Promise<boolean> {
    const app = await this.db.prepare("SELECT runtime FROM apps WHERE script = ?").bind(script).first<{ runtime: string | null }>();
    return app?.runtime === "container";
  }

  /**
   * A container app's Worker reporting how long its container has run this
   * month and what it sent (`POST /deployments/apps/<script>/meter`), with
   * the token it was deployed with. Each counter is only ever raised.
   */
  async meter(script: string, body: unknown): Promise<Response> {
    const report = meterReport(body);
    if (!report) return Response.json(fail("invalid", "Not a report."), { status: 400 });
    const app = await this.db
      .prepare("SELECT workspace, meter_hash FROM apps WHERE script = ? AND runtime = 'container'")
      .bind(script)
      .first<{ workspace: string; meter_hash: string | null }>();
    if (!app?.meter_hash || app.meter_hash !== (await sha256(report.token))) {
      return Response.json(fail("not_found", "No such app."), { status: 404 });
    }
    await this.db
      .prepare(
        `INSERT INTO container_meters (script, epoch, month, workspace, instance_type, awake_seconds, egress_bytes, reported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (script, epoch, month) DO UPDATE SET
           awake_seconds = MAX(awake_seconds, ?6), egress_bytes = MAX(egress_bytes, ?7), reported_at = ?8`,
      )
      .bind(script, report.epoch, report.month, app.workspace, report.instanceType, report.awakeSeconds, report.egressBytes, now())
      .run();
    return Response.json(ok(true));
  }

  /** What each workspace's containers ran in `month`, and what that cost g1t. */
  private async containerMonth(month: string): Promise<Map<string, { micros: number; seconds: number; detail: string | null }>> {
    const costs = (await this.costs()).container;
    const rows = await this.db
      .prepare("SELECT workspace, instance_type, awake_seconds, egress_bytes FROM container_meters WHERE month = ?")
      .bind(month)
      .all<ContainerMeter & { workspace: string }>()
      .catch(() => ({ results: [] as (ContainerMeter & { workspace: string })[] }));
    const by = new Map<string, ContainerMeter[]>();
    for (const row of rows.results) by.set(row.workspace, [...(by.get(row.workspace) ?? []), row]);
    return new Map([...by].map(([workspace, own]) => [workspace, containerCost(own, costs)]));
  }

  /**
   * Older names of the app `script`, now up: one project's production, or
   * its preview of one branch, has one name, so any other app row for the
   * same is the app under a name it had before its project moved (its
   * workspace renamed, its repository renamed or transferred). Each is
   * replaced in the namespace by a redirect to the new name, its app row
   * goes, and the redirect is recorded for `SLUG_HOLD_DAYS`, both here (for
   * the sweep to hold the old script) and in `DOMAINS` under the old
   * hostname, which the dispatcher follows before running anything, so the
   * old address redirects even if the old script is paused. A name that
   * cannot be redirected is left as it is, for the next deploy or sweep.
   */
  private async supersede(
    cloudflare: Cloudflare,
    app: { project_id: string; kind: DeployKind; branch: string | null; workspace: string },
    script: string,
  ): Promise<string[]> {
    const older = await this.db
      .prepare("SELECT script FROM apps WHERE project_id = ? AND kind = ? AND branch IS ? AND script != ?")
      .bind(app.project_id, app.kind, app.branch, script)
      .all<{ script: string }>();
    const target = appHost(script);
    const done: string[] = [];
    for (const { script: old } of older.results) {
      try {
        if (await this.isContainer(old)) await this.holdContainer(cloudflare, old, "redirect", target);
        else await cloudflare.redirectScript(old, target);
      } catch (error) {
        console.error("could not redirect", old, "to", script, error);
        continue;
      }
      const at = now();
      const expires = new Date(Date.parse(at) + SLUG_HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await this.db.batch([
        this.db.prepare("DELETE FROM apps WHERE script = ?").bind(old),
        this.db
          .prepare(
            `INSERT INTO redirects (script, target, workspace, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (script) DO UPDATE SET target = ?2, workspace = ?3, created_at = ?4, expires_at = ?5`,
          )
          .bind(old, target, app.workspace, at, expires),
        // Its builds are no longer live under the old name.
        this.db.prepare("UPDATE deployments SET status = 'replaced' WHERE script = ? AND status = 'ready'").bind(old),
      ]);
      await this.env.DOMAINS?.put(appHost(old), JSON.stringify({ script: old, redirect: target }), {
        expiration: Math.floor(Date.parse(expires) / 1000),
      }).catch((error) => console.error("could not record redirect", old, error));
      done.push(old);
    }
    return done;
  }

  private async finishFailed(id: string, message: string, log: string | null, seconds: number | null): Promise<void> {
    const row = await this.deploymentRow(id);
    if (!row || (row.status !== "queued" && row.status !== "building")) return;
    // A commit that is gone says so plainly; git's own words stay in the log.
    if (commitMissing(message)) {
      log = log ?? message;
      message = missingCommitMessage(row);
    }
    await this.db
      .prepare(
        `UPDATE deployments SET status = 'failed', error = ?, log = COALESCE(?, log), build_seconds = ?, finished_at = ?
         WHERE id = ?`,
      )
      .bind(message.slice(0, 2000), log, seconds, now(), id)
      .run();
    // A failed build still used its sandbox.
    if (seconds) await this.chargeBuild(row, seconds);
    await this.statusFor(row, "failure", "Deployment failed", `${this.env.SITE}/${row.workspace}/${row.slug}/deployments/${id}`);
    await this.announce(row, message.slice(0, 300));
    await this.buildChanged(id);
  }

  /**
   * Publishes a finished build: `deployment.failed` with what went wrong,
   * or `deployment.succeeded`, saying whether the build of the same app
   * before it failed. Whoever started it is the actor when it was a
   * person known by id; otherwise `triggeredBy` names them, or g1t.
   */
  private async announce(row: DeploymentRow, error: string | null): Promise<void> {
    if (!this.env.EVENTS) return;
    const previous = error
      ? null
      : await this.db
          .prepare(
            `SELECT status FROM deployments
             WHERE script = ? AND id != ? AND created_at < ? AND status IN ('ready', 'replaced', 'down', 'failed')
             ORDER BY created_at DESC LIMIT 1`,
          )
          .bind(row.script, row.id, row.created_at)
          .first<{ status: string }>();
    const byId = row.created_by.startsWith("usr_");
    const event = {
      source: "deployments",
      repoId: row.repo_id,
      actor: byId ? row.created_by : null,
      data: {
        deploymentId: row.id,
        projectId: row.project_id,
        repoId: row.repo_id,
        workspace: row.workspace,
        project: row.slug,
        kind: row.kind,
        branch: row.branch,
        number: row.kind === "preview" ? row.number : null,
        commit: row.commit_sha,
        path: `/${row.workspace}/${row.slug}/deployments/${row.id}`,
        error,
        recovered: previous?.status === "failed",
        triggeredBy: byId ? "" : row.created_by,
      },
    };
    await eventsClient(this.env.EVENTS)
      .publish([error == null ? { type: "deployment.succeeded", ...event } : { type: "deployment.failed", ...event }])
      .catch((reason: unknown) => console.error("deployment not published", row.id, String(reason)));
  }

  /**
   * Each build is charged by the second, from the first, at the container
   * price plus the margin. A build a workflow job ran is not: the job's
   * time is charged as Actions time. Never throws: a build whose charge
   * billing did not confirm keeps `build_charged_at` empty and the sweep
   * tries again (`chargeBuilds`), so a billing failure never keeps a
   * build's status or announcement from going out.
   */
  private async chargeBuild(row: DeploymentRow, seconds: number): Promise<void> {
    const charged = await this.tryChargeBuild(row, seconds).catch((error: unknown) => {
      console.error("build not charged yet", row.id, String(error));
      return false;
    });
    if (!charged) console.log("build charge left for the sweep", row.id, Math.ceil(seconds));
  }

  /**
   * Charges a build's seconds once: billing records `deploy/<id>` once
   * whatever it is sent, and the month's meter counts the build only in
   * the write that marks it charged. True once it is charged (or had
   * nothing to charge).
   */
  private async tryChargeBuild(row: DeploymentRow, seconds: number): Promise<boolean> {
    if (row.run_id) return true;
    const costs = await this.costs();
    const cost = Math.ceil(Math.ceil(seconds) * costs.buildSecond);
    if (cost > 0) {
      const what = row.kind === "preview" ? `the ${row.branch} preview of ${row.workspace}/${row.slug}` : `${row.workspace}/${row.slug} to production`;
      const charged = await billingClient(this.env.BILLING).chargeFeature({
        workspace: row.workspace,
        feature: "deployments",
        costMicros: cost,
        description: `Building ${what} (${Math.ceil(seconds)} s)`,
        repo: row.repo,
        reference: `deploy/${row.id}`,
        // Every second is metered; billing prices it from its price book and
        // tallies the month's build time.
        buildSeconds: Math.ceil(seconds),
      });
      if (!charged.ok) {
        console.error("build not charged yet", row.id, charged.error.message);
        return false;
      }
    }
    // Counted in the month it finished in, however late billing took it.
    const finished = row.finished_at ? new Date(row.finished_at) : null;
    const at = finished && !Number.isNaN(finished.getTime()) ? finished : new Date();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO meters (namespace, month, build_seconds, build_micros)
           SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM deployments WHERE id = ?5 AND build_charged_at IS NULL)
           ON CONFLICT (namespace, month) DO UPDATE SET build_seconds = build_seconds + ?3, build_micros = build_micros + ?4`,
        )
        .bind(row.workspace, month(at), Math.ceil(seconds), Math.max(0, cost), row.id),
      this.db.prepare("UPDATE deployments SET build_charged_at = ? WHERE id = ? AND build_charged_at IS NULL").bind(now(), row.id),
    ]);
    return true;
  }

  /**
   * Charges the sandbox builds of the last five weeks whose charge billing
   * has not confirmed, a few at a time: each build's finish tries once,
   * and this catches up what billing could not take then.
   */
  private async chargeBuilds(): Promise<void> {
    const since = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const owed = await this.db
      .prepare(
        `SELECT * FROM deployments
         WHERE build_charged_at IS NULL AND build_seconds > 0 AND run_id IS NULL
           AND status NOT IN ('queued', 'building') AND finished_at >= ?
         ORDER BY finished_at LIMIT 50`,
      )
      .bind(since)
      .all<DeploymentRow>();
    for (const row of owed.results) {
      const charged = await this.tryChargeBuild(row, row.build_seconds ?? 0).catch((error: unknown) => {
        console.error("build not charged yet", row.id, String(error));
        return false;
      });
      if (charged) console.log("build charged late", row.id, row.build_seconds);
    }
  }

  /**
   * What each unit costs g1t now, from billing's price book, which follows
   * what Cloudflare bills. The plan's figures if billing cannot say.
   */
  private async costs(): Promise<{
    buildSecond: number;
    millionRequests: number;
    millionCpuMs: number;
    domainMonth: number;
    /** What one custom domain is charged a month: the cost plus the margin. */
    domainMonthPrice: number;
    /** Container apps' parts, from the price book's `app_container_*` meters. */
    container: ContainerCosts;
    /** The margin container apps are sold at, in percent: the price book's. */
    marginPercent: number;
  }> {
    const a = DEPLOYMENT_COSTS;
    const book = await billingClient(this.env.BILLING)
      .prices()
      .catch(() => null);
    const cost = (meter: string, fallback: number) => book?.prices.find((p) => p.meter === meter)?.costMicros ?? fallback;
    const vcpu = book?.prices.find((p) => p.meter === "app_container_vcpu_second");
    return {
      buildSecond: cost("build_second", a.microsPerBuildSecond),
      millionRequests: cost("app_requests", a.microsPerMillionRequests),
      millionCpuMs: cost("app_cpu", a.microsPerMillionCpuMs),
      domainMonth: cost("custom_domain_month", a.microsPerDomainMonth),
      domainMonthPrice: book?.prices.find((p) => p.meter === "custom_domain_month")?.priceMicros ?? Math.ceil(a.microsPerDomainMonth * 1.2),
      container: {
        vcpuSecond: cost("app_container_vcpu_second", a.container.vcpuSecond),
        memoryGibSecond: cost("app_container_memory_gib_second", a.container.memoryGibSecond),
        diskGbSecond: cost("app_container_disk_gb_second", a.container.diskGbSecond),
        instanceSecond: cost("app_container_second", a.container.instanceSecond),
        egressGb: cost("app_container_egress_gb", a.container.egressGb),
      },
      marginPercent: vcpu?.priceMicros && vcpu.costMicros ? Math.round((vcpu.priceMicros / vcpu.costMicros - 1) * 100) : 20,
    };
  }

  /** Remembers the most apps (for information; never charged) and custom domains the workspace had at once this month. */
  private async notePeak(workspace: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO meters (namespace, month, peak_apps, peak_domains)
         VALUES (?1, ?2, (SELECT COUNT(*) FROM apps WHERE workspace = ?1),
           (SELECT COUNT(*) FROM domains WHERE workspace = ?1 AND cf_hostname_id IS NOT NULL))
         ON CONFLICT (namespace, month) DO UPDATE SET
           peak_apps = MAX(peak_apps, (SELECT COUNT(*) FROM apps WHERE workspace = ?1)),
           peak_domains = MAX(peak_domains, (SELECT COUNT(*) FROM domains WHERE workspace = ?1 AND cf_hostname_id IS NOT NULL))`,
      )
      .bind(workspace, month())
      .run();
  }

  /**
   * The check on the commit: `g1t / deploy`, or, for one of several
   * projects on a repository, `g1t / deploy (<project>)`.
   */
  private async status(
    repoId: string,
    sha: string,
    project: { slug: string; primary: boolean },
    state: string,
    description: string,
    targetUrl: string,
  ): Promise<void> {
    const context = project.primary ? STATUS_CONTEXT : `${STATUS_CONTEXT} (${project.slug})`;
    await this.env.WORK.fetch("https://work/rpc/set_commit_status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId, sha, context, state, description, targetUrl, source: "deployments" }),
    }).catch(() => undefined);
  }

  private async statusFor(row: DeploymentRow, state: string, description: string, targetUrl: string): Promise<void> {
    const projects = await this.projects.byRepo(row.repo_id);
    const primary = projects.find((p) => p.id === row.project_id)?.primary ?? true;
    await this.status(row.repo_id, row.commit_sha, { slug: row.slug, primary }, state, description, targetUrl);
  }

  // ---- Taking apps down ----------------------------------------------

  private async removeApp(script: string): Promise<void> {
    const app = await this.db
      .prepare("SELECT runtime, container_app_id FROM apps WHERE script = ?")
      .bind(script)
      .first<{ runtime: string | null; container_app_id: string | null }>();
    // A container app's container goes first, with any instance it has up,
    // and its images after it.
    if (app?.runtime === "container") await this.cloudflare?.deleteContainer(script, app.container_app_id);
    await this.cloudflare?.deleteScript(script);
    if (app?.runtime === "container" && this.cloudflare) await this.dropImages(this.cloudflare, script, []);
    await this.db.batch([
      this.db.prepare("DELETE FROM apps WHERE script = ?").bind(script),
      // Its build is no longer live anywhere.
      this.db.prepare("UPDATE deployments SET status = 'down' WHERE script = ? AND status = 'ready'").bind(script),
    ]);
  }

  /** Whether a pull request's preview build is for one now closed or merged. */
  private async pullGone(row: DeploymentRow): Promise<boolean> {
    if (row.kind !== "preview" || row.number == null) return false;
    const actor = await this.workspaceActor(row.workspace);
    if (!actor) return false;
    const [namespace, name] = row.repo.split("/") as [string, string];
    const detail = await workClient(this.env.WORK).getPull({ namespace, name }, row.number, actor);
    if (!detail.ok) return false;
    return detail.value.pull.status !== "open" && detail.value.pull.status !== "draft";
  }

  private async takeDownBranchPreview(projectId: string, branch: string): Promise<void> {
    const apps = await this.db
      .prepare("SELECT script FROM apps WHERE project_id = ? AND kind = 'preview' AND number IS NULL AND branch = ?")
      .bind(projectId, branch)
      .all<{ script: string }>();
    for (const app of apps.results) await this.removeApp(app.script);
  }

  private async takeDownWhere(projectId: string, kind: DeployKind | null, branch?: string): Promise<void> {
    const apps = await this.db
      .prepare(`SELECT script FROM apps WHERE project_id = ?1 AND (?2 IS NULL OR kind = ?2) AND (?3 IS NULL OR branch = ?3)`)
      .bind(projectId, kind, branch ?? null)
      .all<{ script: string }>();
    for (const app of apps.results) await this.removeApp(app.script);
  }

  // ---- Events --------------------------------------------------------

  /** `attempts`: which delivery of the event this is, from 1. */
  async onEvent(event: G1tEvent, attempts = 1): Promise<void> {
    switch (event.type) {
      case "workspace.renamed":
        await this.renamed(event.data, attempts);
        break;
      case "repo.transferred":
      case "repo.renamed":
        await this.moved(repoMove(event)!, attempts);
        break;
      // A repository that went or came back with its workspace is the
      // workspace's to handle: its apps are paused, not taken down.
      case "repo.deleted":
        if (!event.data.withWorkspace) await this.repoDeleted(event.data.repoId);
        break;
      case "repo.restored":
        if (!event.data.withWorkspace) await this.repoRestored(event.data.repoId, attempts);
        break;
      case "workspace.deleting":
        await this.workspaceDeleting(event.data.slug);
        break;
      case "workspace.restored":
        await this.workspaceRestored(event.data.slug);
        break;
      case "workspace.deleted":
        await this.workspacePurged(event.data.slug);
        break;
      case "repo.purged":
        await this.repoPurged(event.data.repoId);
        await this.repoDeployments.purge(event.data.repoId);
        await this.shipped.purge(event.data.repoId);
        break;
      case "repo.default_branch_changed":
        await this.defaultBranchChanged(event.data.repoId, event.data.to, event.actor ?? "g1t");
        break;
      case "branch.renamed":
        await this.branchRenamed(event.data.repoId, event.data.from, event.data.to);
        break;

      case "pull.opened":
      case "pull.ready":
      case "pull.updated":
      case "pull.reopened":
        for (const project of await this.projects.byRepo(event.data.repoId)) {
          // Its managed deploy workflow builds it instead (`syncManagedDeploy`).
          if (await this.buildsViaWorkflow(project.id)) continue;
          await this.deployPreview(project, event.data.number, "g1t");
        }
        break;
      case "pull.closed":
      case "pull.merged":
        for (const project of await this.projects.byRepo(event.data.repoId)) {
          const apps = await this.db
            .prepare("SELECT script FROM apps WHERE project_id = ? AND kind = 'preview' AND number = ?")
            .bind(project.id, event.data.number)
            .all<{ script: string }>();
          for (const app of apps.results) await this.removeApp(app.script);
        }
        break;
      // A branch deleted takes its own preview (not a pull request's) down.
      case "git.deleted":
        if (event.data.ref.startsWith("refs/heads/")) {
          const branch = event.data.ref.slice("refs/heads/".length);
          for (const project of await this.projects.byRepo(event.data.repoId)) await this.takeDownBranchPreview(project.id, branch);
        }
        break;
      case "git.push":
        if (!event.data.defaultBranch) break;
        for (const project of await this.projects.byRepo(event.data.repoId)) {
          if (await this.buildsViaWorkflow(project.id)) continue;
          await this.deployProduction(project, event.data.after, event.actor ?? "g1t");
        }
        break;
      // A production deployment went live, wherever it ran: what it shipped is written down.
      case "deployment_status.created": {
        const repo = await reposClient(this.env.REPOS).pathById(event.data.repoId);
        const shipment = repo ? shipmentOf(event.data, repo, this.env.SITE) : null;
        if (shipment) await this.shipped.record(shipment);
        break;
      }
    }
  }

  /**
   * A workspace's slug changed, and with it every app's name: production
   * at `<project>-<workspace>`, previews at `<project>-git-<branch>-<workspace>`.
   *
   * Its rows move to the slug it has now (asked of identity, so a delivery
   * twice over, or an older rename after a newer one, ends the same), and
   * each app (paused or not) is built again from the same commit under its
   * new name; see `followMoves`. The old name keeps serving the app until
   * the new one is live; then it redirects to the new name (see
   * `supersede`), held for as long as the workspace holds its old slug.
   * Builds under way for the old name are dropped and started again under
   * the new one.
   */
  private async renamed(renamed: { workspaceId: string; from: string; to: string }, attempts: number): Promise<void> {
    const current = await currentWorkspaceSlug(this.env.IDENTITY, renamed);
    const stale = staleSlugs(renamed, current);
    if (stale.length === 0) return;
    const marks = stale.map(() => "?").join(", ");

    // The workspace's projects, under any of its names: a second delivery
    // finds them under the new one, with whatever is left to do.
    const rows = await this.db
      .prepare(`SELECT project_id FROM settings WHERE workspace IN (${marks}, ?)`)
      .bind(...stale, current)
      .all<{ project_id: string }>();
    const projectIds = rows.results.map((row) => row.project_id);
    const projects = await this.projectsById(projectIds);
    // The projects service hears of the rename on its own queue: wait for
    // it a few deliveries, so the builds read the repository by its new name.
    const behind = [...projects.values()].some((p) => p.workspace !== current);
    if (behind && attempts < RENAME_WAITS) throw new Error(`projects has not seen ${renamed.from} renamed to ${current} yet`);

    // Every row moves at once.
    const at = now();
    const statements: D1PreparedStatement[] = [];
    for (const slug of stale) {
      statements.push(
        this.db
          .prepare(`UPDATE deployments SET status = 'skipped', error = ?, finished_at = ? WHERE workspace = ? AND status IN ('queued', 'building')`)
          .bind(RENAMED_ERROR, at, slug),
        this.db.prepare("UPDATE settings SET workspace = ?1 WHERE workspace = ?2").bind(current, slug),
        this.db.prepare("UPDATE apps SET workspace = ?1 WHERE workspace = ?2").bind(current, slug),
        this.db
          .prepare(
            `UPDATE deployments SET workspace = ?1,
               repo = CASE WHEN substr(repo, 1, length(?2) + 1) = ?2 || '/' THEN ?1 || substr(repo, length(?2) + 1) ELSE repo END
             WHERE workspace = ?2`,
          )
          .bind(current, slug),
        this.db.prepare("UPDATE redirects SET workspace = ?1 WHERE workspace = ?2").bind(current, slug),
        this.domains.rename(slug, current),
        // Counters add up; the peak is the higher; a month charged stays charged.
        this.db
          .prepare(
            `INSERT INTO meters (namespace, month, requests, cpu_ms, peak_apps, peak_domains, build_seconds, build_micros, counted_at, charged_at)
             SELECT ?1, month, requests, cpu_ms, peak_apps, peak_domains, build_seconds, build_micros, counted_at, charged_at
             FROM meters WHERE namespace = ?2
             ON CONFLICT (namespace, month) DO UPDATE SET
               requests = requests + excluded.requests,
               cpu_ms = cpu_ms + excluded.cpu_ms,
               peak_apps = MAX(peak_apps, excluded.peak_apps),
               peak_domains = MAX(peak_domains, excluded.peak_domains),
               build_seconds = build_seconds + excluded.build_seconds,
               build_micros = build_micros + excluded.build_micros,
               counted_at = COALESCE(MAX(counted_at, excluded.counted_at), counted_at, excluded.counted_at),
               charged_at = COALESCE(charged_at, excluded.charged_at)`,
          )
          .bind(current, slug),
        this.db.prepare("DELETE FROM meters WHERE namespace = ?").bind(slug),
      );
    }
    await this.db.batch(statements);

    // Each app again, under its new name.
    const followed = await this.followMoves(projectIds, {
      projects,
      adjust: (project) => this.underSlug(project, current, stale),
    });
    if (followed.failed.length > 0) {
      throw new Error(`could not rebuild after the rename to ${current}: ${followed.failed.join("; ")}`);
    }
  }

  /**
   * A repository moved: transferred to another workspace, and its projects
   * with it, or renamed within its own, when its own project's slug follows
   * its name (see the projects service). Each app's name is
   * `<project>-<workspace>`, so the apps of every project whose workspace or
   * slug changed (production and every preview, paused or not) are built
   * again, from the same commit, under the new name; see `followMoves`. As
   * after a workspace rename, the old name keeps serving until the new one
   * is live, then redirects to it (see `supersede`) for `SLUG_HOLD_DAYS`.
   * The project's custom domains follow its production. Builds under way
   * are started again under the new name. What the apps used this month
   * stays on the old workspace's meter; from now on, the new workspace's
   * counts it.
   *
   * Projects whose name did not change (a rename where the new name was
   * taken, or a project of another name) only learn the repository's new
   * path. What is left to rebuild is read from the rows each time, so a
   * second or late delivery builds only what the first could not, and one
   * whose rebuild could not be queued is delivered again (and, past the
   * queue's retries, followed up by the sweep).
   */
  private async moved(move: RepoMove, attempts: number): Promise<void> {
    const current = await currentMovedPath(this.env.REPOS, move);
    if (staleMovedPaths(move, current).length === 0) return;
    const [workspace, name] = current.split("/") as [string, string];
    const settings = await this.db
      .prepare("SELECT project_id, workspace, slug FROM settings WHERE repo_id = ?")
      .bind(move.repoId)
      .all<{ project_id: string; workspace: string; slug: string }>();
    if (settings.results.length === 0) return;

    // The projects service hears of the move on its own queue: wait for it
    // a few deliveries, so builds read the project where and as it is now.
    const projects = new Map<string, Project>();
    for (const project of await this.projects.byRepo(move.repoId)) projects.set(project.id, project);
    const behind = settings.results.some(({ project_id }) => {
      const project = projects.get(project_id);
      if (!project || project.source.kind !== "hosted") return false;
      return project.workspace !== workspace || `${project.source.repo.namespace}/${project.source.repo.name}` !== current;
    });
    if (behind && attempts < RENAME_WAITS) throw new Error(`projects has not seen ${current} moved yet`);

    // Its history goes with it, as its pull requests do.
    const statements: D1PreparedStatement[] = [this.db.prepare("UPDATE deployments SET repo = ? WHERE repo_id = ?").bind(current, move.repoId)];
    // The projects whose apps' names change, and have not been moved yet.
    const moving = settings.results
      .filter((row) => row.workspace !== workspace || (projects.get(row.project_id)?.slug ?? row.slug) !== row.slug)
      .map((row) => row.project_id);
    if (moving.length > 0) {
      const ids = moving.map(() => "?").join(", ");
      statements.push(
        this.db
          .prepare(
            `UPDATE deployments SET status = 'skipped', error = ?, finished_at = ?
             WHERE project_id IN (${ids}) AND status IN ('queued', 'building')`,
          )
          .bind(MOVED_ERROR, now(), ...moving),
      );
    }
    for (const projectId of moving) {
      const slug = projects.get(projectId)?.slug ?? null;
      statements.push(
        this.db.prepare("UPDATE settings SET workspace = ?1, slug = COALESCE(?2, slug) WHERE project_id = ?3").bind(workspace, slug, projectId),
        this.db.prepare("UPDATE domains SET workspace = ?1, slug = COALESCE(?2, slug) WHERE project_id = ?3").bind(workspace, slug, projectId),
        this.db.prepare("UPDATE deployments SET workspace = ?1, slug = COALESCE(?2, slug) WHERE project_id = ?3").bind(workspace, slug, projectId),
        // Within the workspace its apps are listed under the project's name
        // now. One left behind in another workspace stays as it is until the
        // new name is live and redirects it.
        this.db.prepare("UPDATE apps SET slug = COALESCE(?2, slug) WHERE project_id = ?3 AND workspace = ?1").bind(workspace, slug, projectId),
      );
    }
    await this.db.batch(statements);

    // Each app again, under its new name. App rows under the old name stay
    // until the new one is live, which redirects them.
    const followed = await this.followMoves(
      settings.results.map((row) => row.project_id),
      {
        projects,
        adjust: (found) =>
          found.source.kind === "hosted"
            ? { ...found, workspace, source: { ...found.source, repo: { ...found.source.repo, namespace: workspace, name } } }
            : { ...found, workspace },
      },
    );
    if (followed.failed.length > 0) throw new Error(`could not rebuild after the move to ${current}: ${followed.failed.join("; ")}`);
  }

  /** The projects with these ids, as the projects service has them now (found through their repositories). */
  private async projectsById(projectIds: string[]): Promise<Map<string, Project>> {
    const projects = new Map<string, Project>();
    if (projectIds.length === 0) return projects;
    const repoIds = new Set<string>();
    for (let i = 0; i < projectIds.length; i += 50) {
      const chunk = projectIds.slice(i, i + 50);
      const rows = await this.db
        .prepare(`SELECT DISTINCT repo_id FROM settings WHERE project_id IN (${chunk.map(() => "?").join(", ")})`)
        .bind(...chunk)
        .all<{ repo_id: string }>();
      for (const { repo_id } of rows.results) repoIds.add(repo_id);
    }
    const wanted = new Set(projectIds);
    for (const repoId of repoIds) {
      for (const project of await this.projects.byRepo(repoId)) {
        if (wanted.has(project.id)) projects.set(project.id, project);
      }
    }
    return projects;
  }

  /** Whether `script` is the name an app of the project has where the project is now. */
  private async namedNow(script: string, settings: { project_id: string; workspace: string; slug: string }, branch: string | null): Promise<boolean> {
    const base = await label(settings.workspace, settings.slug, branch);
    return script === base || script === (await uniqueLabel(base, `${settings.project_id}/${branch ?? ""}`));
  }

  /** Apps still under a name their project had before it moved, among `apps` (whose projects are in `settings`). */
  private async staleApps(apps: AppRow[], settings: Map<string, SettingsRow>): Promise<AppRow[]> {
    const stale: AppRow[] = [];
    for (const app of apps) {
      const row = settings.get(app.project_id);
      if (row && !(await this.namedNow(app.script, row, app.branch))) stale.push(app);
    }
    return stale;
  }

  /**
   * Brings the apps of the projects `projectIds` (every project when null)
   * under the names they have where the projects are now: each app still
   * under an older name, paused or not, and each build a move dropped, is
   * built again under its new name from the same commit, and once that is
   * live the old name redirects to it (`supersede`).
   *
   * Idempotent, and safe to run again at any time: an app already up under
   * its new name only has its old names redirected; one whose rebuild is
   * queued or under way is left to it; one whose workspace has no
   * Deployments or is over its limit waits, without a refused deployment
   * each time; one whose commit is gone, or whose rebuild failed the same
   * way `MAX_IDENTICAL_FAILURES` times, is not tried again; with `backoff`
   * (the sweep), one whose rebuild was tried within `MOVE_RETRY_MS`,
   * doubled for each failure, waits. Returns what could not be queued, for an
   * event's delivery to be retried.
   */
  private async followMoves(
    projectIds: string[] | null,
    options: { projects?: Map<string, Project>; adjust?: (project: Project) => Project; backoff?: boolean } = {},
  ): Promise<{ queued: number; waiting: number; failed: string[] }> {
    const result = { queued: 0, waiting: 0, failed: [] as string[] };
    if (projectIds && projectIds.length === 0) return result;
    const cloudflare = this.cloudflare;
    if (!cloudflare) return result;

    const settingsRows =
      projectIds == null
        ? (await this.db.prepare("SELECT * FROM settings WHERE repo_deleted_at IS NULL").all<SettingsRow>()).results
        : (await Promise.all(projectIds.map((id) => this.settingsRow(id)))).filter((row): row is SettingsRow => row != null);
    const settings = new Map(settingsRows.map((row) => [row.project_id, row]));
    if (settings.size === 0) return result;
    const ids = [...settings.keys()];

    const apps: AppRow[] = [];
    const dropped: DroppedBuild[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const marks = chunk.map(() => "?").join(", ");
      const [appRows, droppedRows] = await Promise.all([
        this.db
          .prepare(`SELECT * FROM apps WHERE project_id IN (${marks})`)
          .bind(...chunk)
          .all<AppRow>(),
        // Builds a move dropped, that nothing has been built in place of since.
        this.db
          .prepare(
            `SELECT * FROM deployments d WHERE d.project_id IN (${marks}) AND d.status = 'skipped' AND d.error IN (?, ?)
               AND d.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
               AND NOT EXISTS (
                 SELECT 1 FROM deployments n WHERE n.project_id = d.project_id AND n.kind = d.kind AND n.branch IS d.branch
                   AND n.created_at > d.created_at AND n.status != 'skipped'
               )`,
          )
          .bind(...chunk, MOVED_ERROR, RENAMED_ERROR)
          .all<DeploymentRow>(),
      ]);
      apps.push(...appRows.results);
      dropped.push(...droppedRows.results);
    }
    const targets: MoveTarget[] = moveTargets(await this.staleApps(apps, settings), dropped);
    if (targets.length === 0) return result;

    const projects = new Map(options.projects ?? []);
    const unknown = [...new Set(targets.map((t) => t.projectId))].filter((id) => !projects.has(id));
    for (const [id, project] of await this.projectsById(unknown)) projects.set(id, project);
    const billing = billingClient(this.env.BILLING);
    const open = new Map<string, boolean>();

    for (const target of targets) {
      const row = settings.get(target.projectId)!;
      const found = projects.get(target.projectId);
      if (!found) continue;
      const project = options.adjust ? options.adjust(found) : found;
      const named = `${row.workspace}/${row.slug}${target.branch ? ` (${target.branch})` : ""}`;
      // Built only where deployments has the project now; the projects
      // service catches up on its own queue, and a later run builds then.
      if (project.workspace !== row.workspace || project.slug !== row.slug) {
        result.waiting++;
        continue;
      }
      try {
        const script = await this.scriptFor(project, target.branch);
        // Already up under its new name: only its old names are left to redirect.
        const up = await this.db.prepare("SELECT 1 FROM apps WHERE script = ?").bind(script).first();
        if (up) {
          await this.supersede(cloudflare, { project_id: project.id, kind: target.kind, branch: target.branch, workspace: project.workspace }, script);
          continue;
        }
        const history = await this.recentBuilds(script);
        const last = history[0];
        if (last && (last.status === "queued" || last.status === "building")) {
          result.queued++;
          continue;
        }
        // A commit that is gone, or a build that failed the same way a few
        // times, is not tried again; a push or a redeploy builds it.
        // Otherwise the sweep waits longer after each failure.
        if (retryDecision(history, Date.now(), MOVE_RETRY_MS, { backoff: options.backoff }).kind !== "build") {
          result.waiting++;
          continue;
        }
        // A workspace without Deployments, or over its limit, waits for it
        // rather than gathering refused deployments.
        if (!open.has(project.workspace)) {
          const [plan, limit] = await Promise.all([billing.hasFeature(project.workspace, "deployments"), billing.checkLimit(project.workspace)]);
          open.set(project.workspace, plan.ok && !(limit.ok && limit.value.state === "stopped"));
        }
        if (!open.get(project.workspace)) {
          result.waiting++;
          continue;
        }
        const started =
          target.kind === "production"
            ? await this.deployProduction(project, target.commit, "g1t")
            : target.number != null
              ? await this.deployPreview(project, target.number, "g1t", true)
              : // A preview no pull request holds is not built again; the sweep takes it down.
                null;
        const outcome = rebuildOutcome(started);
        if (outcome === "queued") result.queued++;
        else if (outcome === "failed") {
          const why = started?.ok ? (started.value.error ?? started.value.status) : started ? started.error.message : "";
          result.failed.push(`${named}: ${why}`);
        }
      } catch (error) {
        result.failed.push(`${named}: ${String(error)}`);
      }
    }
    if (result.failed.length > 0) console.error("could not rebuild moved apps", result.failed);
    return result;
  }

  /** An app's latest builds, newest first: enough to tell a run of identical failures (see retries.ts). */
  private async recentBuilds(script: string): Promise<PastBuild[]> {
    const rows = await this.db
      .prepare("SELECT status, error, commit_sha, created_at FROM deployments WHERE script = ? ORDER BY created_at DESC LIMIT ?")
      .bind(script, MAX_IDENTICAL_FAILURES)
      .all<PastBuild>();
    return rows.results;
  }

  /** The projects built from a repository, as this service has them (projects hides a deleted one's). */
  private async projectIdsFor(repoId: string): Promise<string[]> {
    const rows = await this.db.prepare("SELECT project_id FROM settings WHERE repo_id = ?").bind(repoId).all<{ project_id: string }>();
    return rows.results.map((row) => row.project_id);
  }

  /**
   * A repository was deleted, restorable for a while: every app of its
   * projects (production and previews) comes down, builds under way are
   * dropped, and nothing builds for it until it is restored. Its settings
   * and custom domains are kept for the restore; until then a domain has
   * nothing up to serve, as when production is turned off.
   */
  private async repoDeleted(repoId: string): Promise<void> {
    const projectIds = await this.projectIdsFor(repoId);
    if (projectIds.length === 0) return;
    const at = now();
    await this.db.batch([
      this.db.prepare("UPDATE settings SET repo_deleted_at = COALESCE(repo_deleted_at, ?) WHERE repo_id = ?").bind(at, repoId),
      this.db
        .prepare(
          `UPDATE deployments SET status = 'skipped', error = 'The repository was deleted.', finished_at = ?
           WHERE repo_id = ? AND status IN ('queued', 'building')`,
        )
        .bind(at, repoId),
    ]);
    for (const projectId of projectIds) await this.takeDownWhere(projectId, null);
  }

  /**
   * A deleted repository is back: production goes up again from its
   * default branch, for each project that has it on. Previews come back
   * with the next push to their pull requests.
   */
  private async repoRestored(repoId: string, attempts: number): Promise<void> {
    const deleted = await this.db
      .prepare("SELECT project_id FROM settings WHERE repo_id = ? AND repo_deleted_at IS NOT NULL")
      .bind(repoId)
      .all<{ project_id: string }>();
    const ids = deleted.results.map((row) => row.project_id);
    if (ids.length === 0) return;
    // The projects service hears of the restore on its own queue, and hides
    // the projects until then: wait for it a few deliveries.
    const projects = (await this.projects.byRepo(repoId)).filter((project) => ids.includes(project.id));
    if (projects.length < ids.length && attempts < RENAME_WAITS) throw new Error(`projects has not seen ${repoId} restored yet`);
    await this.db.prepare("UPDATE settings SET repo_deleted_at = NULL WHERE repo_id = ?").bind(repoId).run();
    for (const project of projects) {
      try {
        const started = await this.deployProduction(project, null, "g1t");
        if (started && !started.ok) console.log("could not deploy after restore", project.slug, started.error.message);
      } catch (error) {
        console.error("could not deploy after restore", project.slug, error);
      }
    }
  }

  /**
   * A workspace was deleted, restorable by g1t's staff for a while: every
   * app of its projects (production and previews) is paused, answering with
   * a notice and running nothing, builds under way are dropped, and nothing
   * builds for it until it is restored. Nothing is taken down: scripts,
   * settings and custom domains are kept for the restore. Never for a
   * protected workspace, whatever was published.
   */
  private async workspaceDeleting(slug: string): Promise<void> {
    const workspace = slug.toLowerCase();
    if (isProtectedWorkspace(workspace)) {
      console.error("workspace.deleting ignored for protected", workspace);
      return;
    }
    const at = now();
    await this.db.batch([
      this.db.prepare("UPDATE settings SET workspace_deleted_at = COALESCE(workspace_deleted_at, ?) WHERE workspace = ?").bind(at, workspace),
      this.db
        .prepare(
          `UPDATE deployments SET status = 'skipped', error = 'The workspace was deleted.', finished_at = ?
           WHERE workspace = ? AND status IN ('queued', 'building')`,
        )
        .bind(at, workspace),
    ]);
    const cloudflare = this.cloudflare;
    for (const app of await this.appsOfWorkspace(workspace)) {
      if (app.paused_at) continue;
      await cloudflare?.pauseScript(app.script);
      await this.db.prepare("UPDATE apps SET paused_at = ? WHERE script = ?").bind(at, app.script).run();
    }
  }

  /**
   * A deleted workspace is back: it builds again, and its paused apps are
   * resumed as the workspace's limit allows, as `holdToLimits` resumes any
   * (the sweep tries again any it could not).
   */
  private async workspaceRestored(slug: string): Promise<void> {
    const workspace = slug.toLowerCase();
    await this.db.prepare("UPDATE settings SET workspace_deleted_at = NULL WHERE workspace = ?").bind(workspace).run();
    const rows = await this.db.prepare("SELECT * FROM settings WHERE workspace = ?").bind(workspace).all<SettingsRow>();
    const settings = new Map(rows.results.map((row) => [row.project_id, row]));
    await this.holdToLimits(await this.appsOfWorkspace(workspace), settings);
  }

  /**
   * A deleted workspace is purged: whatever its projects still have up
   * comes down and their custom domains go, as for a purged repository.
   * Its own repositories' projects are purged with them (`repo.purged`);
   * this catches any building from a repository it had transferred away.
   */
  private async workspacePurged(slug: string): Promise<void> {
    const workspace = slug.toLowerCase();
    if (isProtectedWorkspace(workspace)) return;
    const rows = await this.db.prepare("SELECT project_id FROM settings WHERE workspace = ?").bind(workspace).all<{ project_id: string }>();
    for (const { project_id } of rows.results) {
      await this.takeDownWhere(project_id, null);
      await this.domains.removeWhere("project_id", project_id);
    }
    for (const app of await this.appsOfWorkspace(workspace)) await this.removeApp(app.script);
    await this.db.batch([
      this.db.prepare("DELETE FROM deployments WHERE workspace = ?").bind(workspace),
      this.db.prepare("DELETE FROM settings WHERE workspace = ?").bind(workspace),
    ]);
  }

  /** The apps of a workspace's projects, and any still under its name. */
  private async appsOfWorkspace(workspace: string): Promise<AppRow[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM apps WHERE workspace = ?1
           OR project_id IN (SELECT project_id FROM settings WHERE workspace = ?1)`,
      )
      .bind(workspace)
      .all<AppRow>();
    return rows.results;
  }

  /**
   * A deleted repository is gone for good: its projects' custom domains are
   * removed (from the dispatcher and from Cloudflare), any app or redirect
   * still up comes down, and every row kept for them goes. What they used
   * stays on their workspace's meter.
   */
  private async repoPurged(repoId: string): Promise<void> {
    const projectIds = await this.projectIdsFor(repoId);
    const domains = this.domains;
    for (const projectId of projectIds) {
      await this.takeDownWhere(projectId, null);
      // One Cloudflare does not let go of yet is left `removing`, for the sweep.
      await domains.removeWhere("project_id", projectId);
    }
    // The redirects left at names its apps had before.
    const scripts = await this.db.prepare("SELECT DISTINCT script FROM deployments WHERE repo_id = ?").bind(repoId).all<{ script: string }>();
    const hosts = scripts.results.map(({ script }) => appHost(script));
    for (let i = 0; i < hosts.length; i += 50) {
      const chunk = hosts.slice(i, i + 50);
      const redirects = await this.db
        .prepare(`SELECT script FROM redirects WHERE target IN (${chunk.map(() => "?").join(", ")})`)
        .bind(...chunk)
        .all<{ script: string }>();
      for (const { script } of redirects.results) {
        await this.cloudflare?.deleteScript(script);
        await this.env.DOMAINS?.delete(appHost(script)).catch((error) => console.error("could not drop redirect", script, error));
        await this.db.prepare("DELETE FROM redirects WHERE script = ?").bind(script).run();
      }
    }
    await this.db.batch([
      this.db.prepare("DELETE FROM deployments WHERE repo_id = ?").bind(repoId),
      this.db.prepare("DELETE FROM settings WHERE repo_id = ?").bind(repoId),
    ]);
  }

  /**
   * The default branch is another one now: production is built from it, as
   * from a push to it, unless production already serves (or is building)
   * its commit, as when the default branch was only renamed.
   */
  private async defaultBranchChanged(repoId: string, branch: string, createdBy: string): Promise<void> {
    for (const found of await this.projects.byRepo(repoId)) {
      if (found.source.kind !== "hosted") continue;
      // Projects may not have heard yet: the event names the branch.
      const project: Project = { ...found, source: { ...found.source, defaultBranch: branch } };
      const actor = await this.workspaceActor(project.workspace);
      if (!actor) continue;
      const branches = await reposClient(this.env.REPOS).branches(repoOf(project).path, actor);
      const head = branches.ok ? branches.value.find((b) => b.name === branch)?.hash : undefined;
      if (!head) continue;
      const same = await this.db
        .prepare(
          `SELECT 1 FROM deployments WHERE project_id = ? AND kind = 'production' AND commit_sha = ?
             AND status IN ('queued', 'building', 'ready')`,
        )
        .bind(project.id, head)
        .first();
      if (same) continue;
      await this.deployProduction(project, head, createdBy);
    }
  }

  /**
   * A branch was renamed: its preview is the same app, so its rows follow.
   * The app keeps its name until it is next built; then it goes up under
   * the new branch's name, and the old one redirects there (see `supersede`).
   */
  private async branchRenamed(repoId: string, from: string, to: string): Promise<void> {
    const projectIds = await this.projectIdsFor(repoId);
    if (projectIds.length === 0) return;
    const ids = projectIds.map(() => "?").join(", ");
    await this.db.batch([
      this.db.prepare(`UPDATE apps SET branch = ? WHERE kind = 'preview' AND branch = ? AND project_id IN (${ids})`).bind(to, from, ...projectIds),
      this.db.prepare(`UPDATE deployments SET branch = ? WHERE kind = 'preview' AND branch = ? AND project_id IN (${ids})`).bind(to, from, ...projectIds),
    ]);
  }

  /** `project` under the workspace's slug now, whether or not projects has caught up. */
  private underSlug(project: Project, current: string, stale: string[]): Project {
    const source =
      project.source.kind === "hosted" && stale.includes(project.source.repo.namespace)
        ? { ...project.source, repo: { ...project.source.repo, namespace: current } }
        : project.source;
    return { ...project, workspace: current, source };
  }

  // ---- The sweep -----------------------------------------------------

  /**
   * Every few minutes: builds that died are failed; usage is counted; idle
   * previews, the apps of workspaces whose plan ended, and scripts no app
   * holds come down; and a month that is over is charged past its
   * allowance.
   *
   * Each step stands alone: one that fails is logged and the rest still
   * run. Taking idle previews down and charging months, which only read
   * g1t's own tables, go before the steps that wait on Cloudflare's API,
   * so a slow or failing API never holds them up.
   */
  async sweep(): Promise<void> {
    const step = (name: string, work: () => Promise<unknown>) => work().catch((error) => console.error(`sweep: ${name} failed`, error));
    await step("failing stuck builds", async () => {
      const cutoff = new Date(Date.now() - BUILD_TIMEOUT_MS).toISOString();
      const stuck = await this.db
        .prepare("SELECT id FROM deployments WHERE status IN ('queued', 'building') AND created_at < ?")
        .bind(cutoff)
        .all<{ id: string }>();
      for (const { id } of stuck.results) await this.finishFailed(id, "The build did not finish in 45 minutes.", null, null);
    });
    await step("taking down previews no pull request holds", () => this.takeDownUnheld());
    await step("taking down idle previews", () => this.takeDownIdle());
    await step("charging builds", () => this.chargeBuilds());
    await step("charging months", () => this.chargeMonths());

    let apps = (await this.db.prepare("SELECT * FROM apps").all<AppRow>()).results;
    // Each app is its project's workspace's, as deployments has it now: an
    // app still under the name it had before its project moved is the new
    // workspace's, and plans and limits are checked there.
    const settings = new Map((await this.db.prepare("SELECT * FROM settings").all<SettingsRow>()).results.map((row) => [row.project_id, row]));
    const owners = new Map([...settings].map(([id, row]) => [id, row.workspace]));
    // A deleted workspace's apps stay paused as they are, for a restore:
    // its plan ended with the deletion, and that must not take them down.
    const held = (app: AppRow) => Boolean(settings.get(app.project_id)?.workspace_deleted_at);
    const live = apps.filter((app) => !held(app));
    const workspaces = [...new Set(live.map((app) => ownerOf(app, owners)))];

    // Apps of workspaces whose plan has ended come down.
    const billing = billingClient(this.env.BILLING);
    await this.holdToLimits(live, settings).catch((error) => console.error("could not apply limits", error));
    for (const workspace of workspaces) {
      await step(`ending ${workspace}'s apps`, async () => {
        const plan = await billing.hasFeature(workspace, "deployments");
        if (!plan.ok && plan.error.code === "payment_required") {
          for (const app of live.filter((a) => ownerOf(a, owners) === workspace)) await this.removeApp(app.script);
          // Custom domains cost g1t by the month: they go with the plan.
          await this.domains.removeWhere("workspace", workspace).catch((error) => console.error("could not remove domains", error));
        }
      });
    }

    // Apps whose project moved and are not up under the new name yet: a
    // move's rebuild that could not start is tried again here.
    await this.followMoves(null, { backoff: true }).catch((error) => console.error("could not follow moves", error));
    apps = (await this.db.prepare("SELECT * FROM apps").all<AppRow>()).results;

    await this.domains
      .sweep(async (projectId) => {
        const app = await this.db.prepare("SELECT script FROM apps WHERE project_id = ? AND kind = 'production'").bind(projectId).first<{ script: string }>();
        return app?.script ?? null;
      })
      .catch((error) => console.error("could not check domains", error));

    await this.removeOrphans(apps).catch((error) => console.error("could not remove orphans", error));
    await this.count(apps).catch((error) => console.error("could not count usage", error));
  }

  /**
   * Pauses the apps of workspaces that reached their limit for usage not
   * yet paid for, and rebuilds them from the same commit once they are
   * under it again. Paused apps answer with a notice and run nothing.
   *
   * The workspace is the project's now (see `ownerOf`), never the one an
   * app's row was written under, so an app left under its old name after
   * a transfer is paused only if its new workspace is over its limit. Such
   * an app is resumed by being built under its new name (`followMoves`),
   * not here.
   */
  private async holdToLimits(apps: AppRow[], settings: Map<string, SettingsRow>): Promise<void> {
    const cloudflare = this.cloudflare;
    if (!cloudflare) return;
    const billing = billingClient(this.env.BILLING);
    const owners = new Map([...settings].map(([id, row]) => [id, row.workspace]));
    for (const workspace of [...new Set(apps.map((app) => ownerOf(app, owners)))]) {
      const limit = await billing.checkLimit(workspace);
      if (!limit.ok) continue;
      const theirs = apps.filter((app) => ownerOf(app, owners) === workspace);
      if (limit.value.state === "stopped") {
        for (const app of theirs.filter((a) => !a.paused_at)) {
          // A container app stops its container and starts none until it is resumed.
          if (app.runtime === "container") await this.holdContainer(cloudflare, app.script, "paused");
          else await cloudflare.pauseScript(app.script);
          await this.db.prepare("UPDATE apps SET paused_at = ? WHERE script = ?").bind(now(), app.script).run();
        }
        continue;
      }
      const stale = new Set((await this.staleApps(theirs, settings)).map((app) => app.script));
      const paused = theirs.filter((a) => a.paused_at && !stale.has(a.script));
      if (paused.length === 0) continue;
      const projects = await this.projectsById([...new Set(paused.map((app) => app.project_id))]);
      for (const app of paused) {
        const project = projects.get(app.project_id);
        if (!project) continue;
        // A failed or refused rebuild leaves it paused, to try again later:
        // longer after each failure, and not once its commit is gone or it
        // failed the same way a few times.
        const history = await this.recentBuilds(app.script);
        if (history[0]?.status === "queued" || history[0]?.status === "building") continue;
        const backoff = history[0]?.status === "failed";
        if (retryDecision(history, Date.now(), MOVE_RETRY_MS, { backoff }).kind !== "build") continue;
        const rebuilt =
          app.kind === "production"
            ? await this.deployProduction(project, app.commit_sha, "g1t")
            : app.number != null
              ? await this.deployPreview(project, app.number, "g1t", true)
              : null;
        if (rebuilt && !rebuilt.ok) console.log("could not resume", app.script, rebuilt.error.message);
      }
    }
  }

  /**
   * Scripts in the namespace that no app holds, such as ones renamed. An
   * old address that redirects to its app's new one is held until its
   * redirect expires, then removed with the rest.
   */
  private async removeOrphans(apps: AppRow[]): Promise<void> {
    const cloudflare = this.cloudflare;
    if (!cloudflare) return;
    // Their entries in `DOMAINS` expire on their own, at the same time.
    await this.db.prepare("DELETE FROM redirects WHERE expires_at < ?").bind(now()).run();
    const redirects = await this.db.prepare("SELECT script FROM redirects").all<{ script: string }>();
    const held = new Set([...apps.map((app) => app.script), ...redirects.results.map((r) => r.script)]);
    const building = await this.db.prepare("SELECT script FROM deployments WHERE status IN ('queued', 'building')").all<{ script: string }>();
    for (const row of building.results) held.add(row.script);
    const cutoff = Date.now() - ORPHAN_AFTER_MS;
    for (const script of await cloudflare.listScripts()) {
      if (!held.has(script.id) && Date.parse(script.modified_on) < cutoff) {
        // A container app's old name (a redirect that expired) has its
        // Container application still: it goes too.
        await cloudflare.deleteContainer(script.id).catch((error) => console.error("could not remove container", script.id, error));
        await cloudflare.deleteScript(script.id);
        if (this.containersOn) await this.dropImages(cloudflare, script.id, []);
      }
    }
  }

  /** Counts this month's requests and CPU time per workspace, from analytics. */
  private async count(apps: AppRow[]): Promise<void> {
    const cloudflare = this.cloudflare;
    if (!cloudflare || apps.length === 0) return;
    const start = `${month()}-01T00:00:00Z`;
    const totals = await cloudflare.usage(
      apps.map((app) => app.script),
      start,
      now(),
    );
    // Analytics only counts apps that are up; the meter keeps what earlier
    // apps used by never going down.
    const perWorkspace = new Map<string, { requests: number; cpuMs: number }>();
    for (const app of apps) {
      const used = totals.get(app.script);
      if (!used) continue;
      const sum = perWorkspace.get(app.workspace) ?? { requests: 0, cpuMs: 0 };
      sum.requests += used.requests;
      sum.cpuMs += used.cpuMs;
      perWorkspace.set(app.workspace, sum);
    }
    const at = now();
    // Written only when the count moves the meter: most sweeps it does not.
    const stored = new Map(
      (
        await this.db
          .prepare("SELECT namespace, requests, cpu_ms FROM meters WHERE month = ?")
          .bind(month())
          .all<{ namespace: string; requests: number; cpu_ms: number }>()
      ).results.map((row) => [row.namespace, row]),
    );
    for (const [workspace, used] of perWorkspace) {
      if (!movesMeter(stored.get(workspace), used)) continue;
      await this.db
        .prepare(
          `INSERT INTO meters (namespace, month, requests, cpu_ms, counted_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (namespace, month) DO UPDATE SET
             requests = MAX(requests, ?3), cpu_ms = MAX(cpu_ms, ?4), counted_at = ?5`,
        )
        .bind(workspace, month(), used.requests, used.cpuMs, at)
        .run();
    }
    // When each preview last answered anyone, for the idle sweep.
    const recent = await cloudflare.usage(
      apps.filter((app) => app.kind === "preview").map((app) => app.script),
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      at,
    );
    // At an hour's resolution: previews idle for days are what it finds.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const lastRequest = new Map(apps.map((app) => [app.script, app.last_request_at]));
    for (const [script, used] of recent) {
      const last = lastRequest.get(script);
      if (used.requests > 0 && (!last || last < hourAgo)) {
        await this.db.prepare("UPDATE apps SET last_request_at = ? WHERE script = ?").bind(at, script).run();
      }
    }
    for (const workspace of new Set(apps.map((app) => app.workspace))) await this.notePeak(workspace);
    // What this month's traffic and custom domains will cost, from the
    // first request and the first domain, so the workspace's limit counts
    // it now rather than when the month closes, and its Billing page shows it.
    const costs = await this.costs();
    const billing = billingClient(this.env.BILLING);
    // One month for the whole report, sent with it: a sweep that runs over
    // midnight on the 1st still files these totals under the month they are.
    const reporting = month();
    const meters = await this.db
      .prepare("SELECT namespace, requests, cpu_ms, peak_domains FROM meters WHERE month = ?")
      .bind(reporting)
      .all<{ namespace: string; requests: number; cpu_ms: number; peak_domains: number | null }>();
    // Container time is the same feature's, noted with its traffic.
    const containers = await this.containerMonth(reporting);
    const seen = new Set(meters.results.map((meter) => meter.namespace));
    const rows = [
      ...meters.results,
      ...[...containers.keys()].filter((w) => !seen.has(w)).map((namespace) => ({ namespace, requests: 0, cpu_ms: 0, peak_domains: 0 })),
    ];
    for (const meter of rows) {
      const cost = monthCost(meter, costs);
      const container = containers.get(meter.namespace);
      const detail = [cost.traffic.detail, container?.detail].filter(Boolean).join("; ") || null;
      await billing
        .notePending(meter.namespace, "deployments", cost.traffic.micros + (container?.micros ?? 0), detail, reporting)
        .catch((error) => console.error("could not note pending usage", error));
      if ((meter.peak_domains ?? 0) > 0) {
        await billing
          .notePending(meter.namespace, "domains", cost.domains.micros, cost.domains.detail, reporting)
          .catch((error) => console.error("could not note pending usage", error));
      }
    }
  }

  /**
   * Previews of a branch that is gone. A pull request's preview comes down
   * when it closes or merges; a branch's preview (built by a project's
   * deploy workflow) has no pull request, so it comes down once its branch
   * is deleted, here for any whose deletion was missed. A deleted
   * workspace's stay paused for a restore.
   */
  private async takeDownUnheld(): Promise<void> {
    const unheld = await this.db
      .prepare(
        `SELECT apps.script, apps.project_id, apps.branch FROM apps JOIN settings ON settings.project_id = apps.project_id
         WHERE apps.kind = 'preview' AND apps.number IS NULL AND settings.workspace_deleted_at IS NULL`,
      )
      .all<{ script: string; project_id: string; branch: string | null }>();
    if (unheld.results.length === 0) return;
    const projects = await this.projectsById([...new Set(unheld.results.map((app) => app.project_id))]);
    const branchesOf = new Map<string, Set<string> | null>();
    for (const app of unheld.results) {
      const project = projects.get(app.project_id);
      if (!project || project.source.kind !== "hosted") continue;
      if (!branchesOf.has(project.id)) {
        const actor = await this.workspaceActor(project.workspace);
        const branches = actor ? await reposClient(this.env.REPOS).branches(repoOf(project).path, actor) : null;
        // A read that failed says nothing: the app stays until one succeeds.
        branchesOf.set(project.id, branches?.ok ? new Set(branches.value.map((b) => b.name)) : null);
      }
      const names = branchesOf.get(project.id);
      if (names && (app.branch == null || !names.has(app.branch))) await this.removeApp(app.script);
    }
  }

  /** Previews no one has visited in their project's idle days. */
  private async takeDownIdle(): Promise<void> {
    const idle = await this.db
      .prepare(
        `SELECT apps.script FROM apps JOIN settings ON settings.project_id = apps.project_id
         WHERE apps.kind = 'preview' AND settings.workspace_deleted_at IS NULL
           AND COALESCE(apps.last_request_at, apps.deployed_at) < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || settings.idle_days || ' days')`,
      )
      .all<{ script: string }>();
    for (const { script } of idle.results) await this.removeApp(script);
  }

  /**
   * Charges each month that is over for its requests, CPU time, custom
   * domains and container time, from the first, once.
   */
  private async chargeMonths(): Promise<void> {
    // A workspace whose only usage was container time has a meter row too.
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO meters (namespace, month)
         SELECT DISTINCT workspace, month FROM container_meters WHERE month < ?`,
      )
      .bind(month())
      .run()
      .catch((error) => console.error("could not note container months", error));
    const due = await this.db
      .prepare("SELECT * FROM meters WHERE month < ? AND charged_at IS NULL")
      .bind(month())
      .all<{ namespace: string; month: string; requests: number; cpu_ms: number; peak_domains: number | null }>();
    const costs = await this.costs();
    const containers = new Map<string, Map<string, { micros: number; seconds: number; detail: string | null }>>();
    for (const meter of due.results) {
      if (!containers.has(meter.month)) containers.set(meter.month, await this.containerMonth(meter.month));
      const cost = monthCost(meter, costs);
      const container = containers.get(meter.month)?.get(meter.namespace);
      const micros = cost.micros + (container?.micros ?? 0);
      const description = [cost.description, container?.detail].filter(Boolean).join(", ");
      if (micros > 0) {
        const charged = await billingClient(this.env.BILLING).chargeFeature({
          workspace: meter.namespace,
          feature: "deployments",
          costMicros: micros,
          description: `Deployments in ${meter.month}: ${description}`,
          reference: `deployments/${meter.namespace}/${meter.month}`,
        });
        if (!charged.ok) continue;
      }
      await this.db.prepare("UPDATE meters SET charged_at = ? WHERE namespace = ? AND month = ?").bind(now(), meter.namespace, meter.month).run();
    }
  }
}

/** `POST /rpc/<method>`: the arguments are the body. */
async function rpc(service: Deployments, method: string, args: any, ctx: ExecutionContext): Promise<unknown> {
  switch (method) {
    case "settings":
      return service.settings(args);
    case "is_enabled":
      return service.isEnabled(args);
    case "update_settings":
      return service.updateSettings(args);
    case "list":
      return service.list(args);
    case "get":
      return service.get(args);
    case "redeploy":
      return service.redeploy(args);
    // For the API: a g1t Actions job opening a build it runs itself.
    case "start_from_workflow":
      return service.startFromWorkflow(args);
    // For the actions service: a job ended, so its open builds end too.
    case "workflow_job_ended":
      return service.workflowJobEnded(args);
    case "take_down":
      return service.takeDown(args);
    case "overview":
      return service.overview(args);
    case "usage":
      return service.usage(args);
    case "domains":
      return service.listDomains(args);
    case "add_domain":
      return service.addDomain(args);
    case "remove_domain":
      return service.removeDomain(args);
    case "refresh_domain":
      return service.refreshDomain(args);
    // A repository's deployments wherever they run (repo-deployments.ts).
    case "list_deployments":
      return service.repoDeployments.list({ ...args, source: args.source == null ? null : (sourceOf(args.source) ?? "none") });
    case "get_deployment":
      return service.repoDeployments.get(args);
    case "list_deployment_statuses":
      return service.repoDeployments.statuses(args);
    case "list_environments":
      return service.repoDeployments.environments(args);
    case "get_environment":
      return service.repoDeployments.environment(args);
    case "create_deployment":
      return service.repoDeployments.create(args);
    case "create_deployment_status":
      return service.repoDeployments.createStatus(args);
    // For the actions service: a run's deployment to one environment.
    case "actions_deployment":
      return service.repoDeployments.fromActions(args);
    // For Home: whether changes that landed went live (shipped.ts).
    case "shipped":
      return service.shipped.answer(args);
    default:
      return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST") return new Response("Not found\n", { status: 404 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const rpcMatch = pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (rpcMatch) {
      // A replica near the caller when it asks for one (@g1t/contracts d1.ts).
      const opened = openD1(env.DB, request);
      const service = new Deployments(Object.create(env, { DB: { value: opened.db } }) as Env);
      const result = await rpc(service, rpcMatch[1], body, ctx);
      return opened.finish(result === undefined ? new Response("Unknown method\n", { status: 404 }) : Response.json(result));
    }
    const service = new Deployments(env);
    // A build's reports, forwarded by the API.
    const jobMatch = pathname.match(/^\/jobs\/([a-z0-9_]+)\/(started|registry|session|finish|fail)$/);
    if (jobMatch) return service.job(jobMatch[1], jobMatch[2], body);
    // A container app's Worker reporting its running time, forwarded by the API.
    const meterMatch = pathname.match(/^\/apps\/([a-z0-9-]{1,63})\/meter$/);
    if (meterMatch) return service.meter(meterMatch[1], body);
    return new Response("Not found\n", { status: 404 });
  },

  async queue(batch: MessageBatch<G1tEvent>, env: Env): Promise<void> {
    const service = new Deployments(env);
    for (const message of batch.messages) {
      try {
        await service.onEvent(message.body, message.attempts);
        message.ack();
      } catch (error) {
        console.error("deployments could not handle", message.body.type, error);
        message.retry();
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await new Deployments(env).sweep();
  },
} satisfies ExportedHandler<Env, G1tEvent>;
