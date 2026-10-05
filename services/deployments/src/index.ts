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
 * Nothing here is free. A build is charged by the second; requests, CPU
 * time and apps past the plan's allowance are charged once the month is
 * over. A Worker runs only while it answers a request, so an app no one
 * visits costs nothing, and a preview is taken down when its pull request
 * closes or after its project's idle days.
 *
 * Reached through service bindings (`POST /rpc/<method>`) and, for a
 * build's reports, through the API (`POST /jobs/<id>/<step>`).
 */

import {
  DEPLOYMENTS_ALLOWANCE,
  billingClient,
  fail,
  identityClient,
  newId,
  ok,
  projectsClient,
  reposClient,
  workClient,
  type DeployKind,
  type DeploySettings,
  type DeployStatus,
  type DeployUsage,
  type Deployment,
  type G1tEvent,
  type LiveApp,
  type Project,
  type ProjectDeploys,
  type ProjectRef,
  type RepoPath,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
} from "@g1t/contracts";

import { Cloudflare, type BuiltWorker, type Manifest } from "./cloudflare";
import { appUrl, label, uniqueLabel } from "./names";

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
  /** Secret: scoped to Workers scripts and analytics on g1t's account. */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  DISPATCH_NAMESPACE: string;
  SITE: string;
};

/** A build that has not reported in this long has died. */
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;
/** A script in the namespace that no app holds, older than this, is removed. */
const ORPHAN_AFTER_MS = 60 * 60 * 1000;
const LIST_LIMIT = 50;
const STATUS_CONTEXT = "g1t / deploy";

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
    return token ? new Cloudflare(token, this.env.CLOUDFLARE_ACCOUNT_ID, this.env.DISPATCH_NAMESPACE) : null;
  }

  private get db() {
    return this.env.DB;
  }

  private get projects() {
    return projectsClient(this.env.PROJECTS);
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
  private async resolve(
    project: { id: string; slug: string; repoId: string; repo: RepoPath },
    environment: DeployKind,
    trusted: boolean,
    branch: string | null,
  ): Promise<{ secrets: Record<string, string>; variables: Record<string, string> }> {
    const [rows, references] = await Promise.all([
      this.rows(project, environment, trusted),
      this.references(project.id, environment === "preview" ? branch : null),
    ]);
    // The project's own rows win over a dependency's address of the same name.
    return { secrets: rows.secrets, variables: { ...references, ...rows.variables } };
  }

  /**
   * Each dependency's address, under the name the dependency gives it:
   * for a preview, the same branch's preview of it if one is up, else its
   * production; for production, its production.
   */
  private async references(projectId: string, branch: string | null): Promise<Record<string, string>> {
    const graph = await this.projects.graph(projectId).catch(() => null);
    const out: Record<string, string> = {};
    for (const dependency of graph?.dependsOn ?? []) {
      if (!dependency.as) continue;
      const app =
        (branch
          ? await this.db
              .prepare("SELECT script FROM apps WHERE project_id = ? AND kind = 'preview' AND branch = ?")
              .bind(dependency.id, branch)
              .first<{ script: string }>()
          : null) ??
        (await this.db
          .prepare("SELECT script FROM apps WHERE project_id = ? AND kind = 'production'")
          .bind(dependency.id)
          .first<{ script: string }>());
      out[dependency.as] = appUrl(app?.script ?? (await label(dependency.workspace, dependency.slug, null)));
    }
    return out;
  }

  private async rows(
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
   * Whether a pull request's author is trusted with the project's secrets:
   * g1t's agent, or a member of the workspace. Someone from outside gets a
   * preview built without them, as their workflows run.
   */
  private async insider(repo: RepoPath, author: User, actor: User): Promise<boolean> {
    if (author.kind === "agent" || author.username === "g1t-agent") return true;
    // On a private repository only members can open one at all.
    const found = await reposClient(this.env.REPOS).get(repo, actor);
    if (found.ok && found.value.isPrivate) return true;
    if (author.workspaces?.some((m) => m.slug === repo.namespace.toLowerCase())) return true;
    const members = await identityClient(this.env.IDENTITY).listMembers(repo.namespace, actor);
    return members.ok && members.value.some((m) => m.username.toLowerCase() === author.username.toLowerCase());
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
      productionUrl: appUrl(await this.scriptFor(project, null)),
    };
  }

  /** The project, if `viewer` belongs to its workspace. */
  private async memberProject(ref: ProjectRef, viewer: Viewer): Promise<Result<Project>> {
    if (!isMember(viewer, ref.workspace)) return fail("forbidden", "Only members of the workspace can manage its deployments.");
    return this.projects.get(ref.workspace, ref.slug, viewer);
  }

  // ---- Methods for the site and the API ------------------------------

  async settings(a: { project: ProjectRef; viewer: Viewer }): Promise<Result<DeploySettings>> {
    const project = await this.memberProject(a.project, a.viewer);
    if (!project.ok) return project;
    return ok(await this.toSettings(project.value, await this.settingsRow(project.value.id)));
  }

  async updateSettings(a: {
    actor: User;
    project: ProjectRef;
    changes: Partial<DeploySettings>;
  }): Promise<Result<DeploySettings>> {
    const found = await this.memberProject(a.project, a.actor);
    if (!found.ok) return found;
    const project = found.value;
    const before = await this.toSettings(project, await this.settingsRow(project.id));
    const next = { ...before, ...a.changes };
    if (next.enabled && !before.enabled) {
      // Turning it on starts paid work: only with the workspace's plan.
      const plan = await billingClient(this.env.BILLING).hasFeature(project.workspace, "deployments");
      if (!plan.ok) return plan;
    }
    const idleDays = Math.min(90, Math.max(1, Math.trunc(Number(next.idleDays) || 7)));
    const clip = (text: string | null | undefined) => (text?.trim() ? text.trim().slice(0, 500) : null);
    await this.db
      .prepare(
        `INSERT INTO settings (project_id, workspace, slug, repo_id, enabled, previews, production, build_command,
           output_dir, idle_days, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (project_id) DO UPDATE SET workspace = ?2, slug = ?3, repo_id = ?4, enabled = ?5, previews = ?6,
           production = ?7, build_command = ?8, output_dir = ?9, idle_days = ?10, updated_by = ?11, updated_at = ?12`,
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
      )
      .run();
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

  async list(a: { project: ProjectRef; viewer: Viewer }): Promise<Result<{ deployments: Deployment[]; live: LiveApp[] }>> {
    const project = await this.memberProject(a.project, a.viewer);
    if (!project.ok) return project;
    const [deployments, apps] = await Promise.all([
      this.db
        .prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT ?")
        .bind(project.value.id, LIST_LIMIT)
        .all<DeploymentRow>(),
      this.db
        .prepare("SELECT * FROM apps WHERE project_id = ? ORDER BY kind DESC, deployed_at DESC")
        .bind(project.value.id)
        .all<AppRow>(),
    ]);
    return ok({ deployments: deployments.results.map(toDeployment), live: apps.results.map(toLive) });
  }

  async get(a: { project: ProjectRef; id: string; viewer: Viewer }): Promise<Result<Deployment & { log: string | null }>> {
    const project = await this.memberProject(a.project, a.viewer);
    if (!project.ok) return project;
    const row = await this.db
      .prepare("SELECT * FROM deployments WHERE id = ? AND project_id = ?")
      .bind(a.id, project.value.id)
      .first<DeploymentRow>();
    if (!row) return fail("not_found", "No such deployment.");
    return ok({ ...toDeployment(row), log: row.log });
  }

  async redeploy(a: { actor: User; project: ProjectRef; branch: string | null }): Promise<Result<Deployment>> {
    const found = await this.memberProject(a.project, a.actor);
    if (!found.ok) return found;
    const project = found.value;
    const settings = await this.settingsRow(project.id);
    if (!settings?.enabled) return fail("conflict", "Deployments are off for this project.");
    if (a.branch == null) {
      return (await this.deployProduction(project, null, a.actor.username)) ?? fail("conflict", "There was nothing to deploy.");
    }
    // A branch's preview comes from its pull request.
    const app = await this.db
      .prepare("SELECT number FROM deployments WHERE project_id = ? AND branch = ? AND number IS NOT NULL ORDER BY id DESC")
      .bind(project.id, a.branch)
      .first<{ number: number }>();
    if (!app) return fail("not_found", `No pull request has deployed ${a.branch}.`);
    return (await this.deployPreview(project, app.number, a.actor.username, true)) ?? fail("conflict", "Its pull request is not open.");
  }

  /**
   * A preview stack: the projects that use this one get previews of their
   * own default branch, under the same branch name, so each reaches this
   * branch's preview through its dependency's variable. A change to an API
   * can then be clicked through in the apps that call it.
   */
  async stack(
    a: { actor: User; project: ProjectRef; branch: string },
    background: (work: Promise<unknown>) => void,
  ): Promise<Result<string[]>> {
    const found = await this.memberProject(a.project, a.actor);
    if (!found.ok) return found;
    const upstream = await this.db
      .prepare("SELECT script FROM apps WHERE project_id = ? AND kind = 'preview' AND branch = ?")
      .bind(found.value.id, a.branch)
      .first();
    if (!upstream) return fail("conflict", `${a.branch} has no preview up to build against.`);
    const graph = await this.projects.graph(found.value.id);
    const ready: { project: Project; settings: SettingsRow }[] = [];
    for (const dependent of graph.usedBy) {
      const project = await this.projects.get(dependent.workspace, dependent.slug, a.actor);
      if (!project.ok) continue;
      const settings = await this.settingsRow(project.value.id);
      if (settings?.enabled && settings.previews) ready.push({ project: project.value, settings });
    }
    if (ready.length === 0) return fail("conflict", "No project that uses this one has previews turned on.");
    // The builds start after the answer: a person moving on from the page
    // does not stop them.
    background(
      (async () => {
        for (const { project, settings } of ready) {
          const actor = await this.workspaceActor(project.workspace);
          if (!actor) continue;
          const repo = repoOf(project);
          const branches = await reposClient(this.env.REPOS).branches(repo.path, actor);
          const head = branches.ok ? branches.value.find((b) => b.name === repo.defaultBranch)?.hash : undefined;
          if (!head) continue;
          await this.start({
            project,
            kind: "preview",
            branch: a.branch,
            number: null,
            commit: head,
            source: repo.path,
            reader: actor,
            createdBy: a.actor.username,
            settings,
            // Its own default branch, asked for by a member.
            trusted: true,
          });
        }
      })().catch((error) => console.error("stack failed", a.project.slug, a.branch, error)),
    );
    return ok(ready.map(({ project }) => project.name));
  }

  async takeDown(a: { actor: User; project: ProjectRef; branch: string | null }): Promise<Result<true>> {
    const project = await this.memberProject(a.project, a.actor);
    if (!project.ok) return project;
    await this.takeDownWhere(project.value.id, a.branch == null ? "production" : "preview", a.branch ?? undefined);
    return ok(true);
  }

  async overview(a: { workspace: string; viewer: Viewer }): Promise<Result<ProjectDeploys[]>> {
    const workspace = a.workspace.toLowerCase();
    if (!isMember(a.viewer, workspace)) return fail("forbidden", "Only members can see a workspace's deployments.");
    const [settings, apps, latest] = await Promise.all([
      this.db.prepare("SELECT slug, enabled FROM settings WHERE workspace = ?").bind(workspace).all<{ slug: string; enabled: number }>(),
      this.db.prepare("SELECT * FROM apps WHERE workspace = ?").bind(workspace).all<AppRow>(),
      this.db
        .prepare(
          `SELECT * FROM deployments WHERE id IN (SELECT MAX(id) FROM deployments WHERE workspace = ? GROUP BY project_id)`,
        )
        .bind(workspace)
        .all<DeploymentRow>(),
    ]);
    return ok(
      settings.results.map((row) => {
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
      this.db
        .prepare("SELECT * FROM meters WHERE namespace = ? AND month = ?")
        .bind(slug, month())
        .first<{
          requests: number;
          cpu_ms: number;
          peak_apps: number;
          build_seconds: number;
          build_micros: number;
          counted_at: string | null;
        }>(),
      this.db.prepare("SELECT COUNT(*) AS n FROM apps WHERE workspace = ?").bind(slug).first<{ n: number }>(),
    ]);
    return ok({
      month: month(),
      requests: meter?.requests ?? 0,
      cpuMs: meter?.cpu_ms ?? 0,
      apps: apps?.n ?? 0,
      peakApps: Math.max(meter?.peak_apps ?? 0, apps?.n ?? 0),
      buildSeconds: meter?.build_seconds ?? 0,
      buildMicros: meter?.build_micros ?? 0,
      countedAt: meter?.counted_at ?? null,
    });
  }

  // ---- Starting builds -----------------------------------------------

  /**
   * Opens a deployment and starts its build. Skipped, with the reason
   * recorded, when the workspace's plan is off.
   */
  private async start(input: {
    project: Project;
    kind: DeployKind;
    branch: string | null;
    number: number | null;
    commit: string;
    source: RepoPath;
    reader: User;
    createdBy: string;
    settings: SettingsRow;
    /** A push, or work by a member or an agent; see `insider`. */
    trusted: boolean;
  }): Promise<Result<Deployment>> {
    const { project } = input;
    const repo = repoOf(project);
    const script = await this.scriptFor(project, input.branch);
    const id = newId("dpl");
    const token = randomToken();
    const plan = await billingClient(this.env.BILLING).hasFeature(project.workspace, "deployments");
    const limit = await billingClient(this.env.BILLING).checkLimit(project.workspace);
    const cloudflare = this.cloudflare;
    const refused = !plan.ok
      ? plan.error.message
      : limit.ok && limit.value.state === "stopped"
        ? (limit.value.message ?? "The workspace reached its usage limit.")
      : !cloudflare
        ? "Deployments are not set up on this g1t: it has no Cloudflare token."
        : null;
    await this.db
      .prepare(
        `INSERT INTO deployments (id, project_id, workspace, slug, repo_id, repo, kind, branch, number, commit_sha,
           script, status, error, token_hash, trusted, created_by, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      .run();
    if (refused) return ok(toDeployment((await this.deploymentRow(id))!));
    // Older builds of the same app are replaced by this one.
    await this.db
      .prepare(
        `UPDATE deployments SET status = 'skipped', error = 'A newer commit replaced this build.', finished_at = ?
         WHERE script = ? AND id != ? AND status IN ('queued', 'building')`,
      )
      .bind(now(), script, id)
      .run();
    await this.status(repo.id, input.commit, project, "pending", "Building", `${this.env.SITE}/${project.workspace}/${project.slug}/deployments/${id}`);
    // What the project's secrets and variables give builds of this kind.
    const build = await this.resolve(
      { id: project.id, slug: project.slug, repoId: repo.id, repo: repo.path },
      input.kind,
      input.trusted,
      input.branch,
    );
    const response = await this.env.RUNNER.fetch("https://runner/rpc/start_deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deployId: id,
        token,
        actor: input.reader,
        source: input.source,
        commit: input.commit,
        rootDir: project.source.rootDir,
        buildCommand: input.settings.build_command,
        outputDir: input.settings.output_dir,
        buildEnv: build.variables,
        buildSecrets: build.secrets,
      }),
    });
    const started = response.ok ? ((await response.json()) as Result<true>) : fail("conflict", `The runner answered ${response.status}.`);
    if (!started.ok) await this.finishFailed(id, started.error.message, null, null);
    return ok(toDeployment((await this.deploymentRow(id))!));
  }

  private async deployProduction(project: Project, commit: string | null, createdBy: string): Promise<Result<Deployment> | null> {
    const settings = await this.settingsRow(project.id);
    if (!settings?.enabled || !settings.production) return null;
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
      // The default branch only moves by people and agents with access.
      trusted: true,
    });
  }

  private async deployPreview(project: Project, number: number, createdBy: string, force = false): Promise<Result<Deployment> | null> {
    const settings = await this.settingsRow(project.id);
    if (!settings?.enabled || !settings.previews) return null;
    const actor = await this.workspaceActor(project.workspace);
    if (!actor) return null;
    const repo = repoOf(project);
    const detail = await workClient(this.env.WORK).getPull(repo.path, number, actor);
    if (!detail.ok) return null;
    const { pull } = detail.value;
    if ((pull.status !== "open" && pull.status !== "draft") || !pull.headCommit) return null;
    // A pull request from a fork (as g1t's agents work) has no branch here.
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
      // The pull request's fork may be private: read it as its author.
      reader: pull.author,
      createdBy,
      settings,
      trusted: await this.insider(repo.path, pull.author, actor),
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
        await this.db
          .prepare("UPDATE deployments SET status = 'building', started_at = ? WHERE id = ?")
          .bind(now(), id)
          .run();
        return Response.json(ok(true));
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
        try {
          // Running apps' secrets and variables are bound here, by g1t:
          // they never pass through the build's sandbox.
          const runtime = await this.resolve(
            { id: row.project_id, slug: row.slug, repoId: row.repo_id, repo: { namespace, name } },
            row.kind,
            !!row.trusted,
            row.branch,
          );
          await cloudflare.putScript(
            row.script,
            worker,
            typeof body.completionJwt === "string" ? body.completionJwt : null,
            [`workspace:${row.workspace}`, `project:${row.workspace}/${row.slug}`, row.kind],
            runtime,
          );
        } catch (error) {
          await this.finishFailed(id, `Cloudflare did not take the app: ${String(error).replace(/^Error: /, "")}`, String(body.log ?? ""), seconds);
          return Response.json(ok(false));
        }
        const at = now();
        await this.db.batch([
          this.db
            .prepare(
              `UPDATE deployments SET status = 'ready', warnings = ?, log = ?, build_seconds = ?, finished_at = ?
               WHERE id = ?`,
            )
            .bind(JSON.stringify(Array.isArray(body.warnings) ? body.warnings : []), String(body.log ?? ""), seconds, at, id),
          this.db
            .prepare(
              `INSERT INTO apps (script, project_id, workspace, slug, kind, branch, number, commit_sha, deployed_at, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
               ON CONFLICT (script) DO UPDATE SET commit_sha = ?8, number = ?7, deployed_at = ?9, paused_at = NULL`,
            )
            .bind(row.script, row.project_id, row.workspace, row.slug, row.kind, row.branch, row.number, row.commit_sha, at),
        ]);
        await this.chargeBuild(row, seconds);
        await this.notePeak(row.workspace);
        await this.statusFor(row, "success", row.kind === "preview" ? "Preview is live" : "Production is live", appUrl(row.script));
        return Response.json(ok(true));
      }
      case "fail":
        await this.finishFailed(id, String(body.message ?? "The build failed."), body.log == null ? null : String(body.log), Number(body.buildSeconds) || null);
        return Response.json(ok(true));
      default:
        return Response.json(fail("not_found", "No such step."), { status: 404 });
    }
  }

  private async finishFailed(id: string, message: string, log: string | null, seconds: number | null): Promise<void> {
    const row = await this.deploymentRow(id);
    if (!row || (row.status !== "queued" && row.status !== "building")) return;
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
  }

  /** Each build is charged by the second at the container price plus the margin. */
  private async chargeBuild(row: DeploymentRow, seconds: number): Promise<void> {
    const cost = Math.ceil(seconds) * DEPLOYMENTS_ALLOWANCE.microsPerBuildSecond;
    if (cost <= 0) return;
    const what =
      row.kind === "preview"
        ? `the ${row.branch} preview of ${row.workspace}/${row.slug}`
        : `${row.workspace}/${row.slug} to production`;
    await billingClient(this.env.BILLING).chargeFeature({
      workspace: row.workspace,
      feature: "deployments",
      costMicros: cost,
      description: `Building ${what} (${Math.ceil(seconds)} s)`,
      repo: row.repo,
      reference: `deploy/${row.id}`,
    });
    await this.db
      .prepare(
        `INSERT INTO meters (namespace, month, build_seconds, build_micros) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (namespace, month) DO UPDATE SET build_seconds = build_seconds + ?3, build_micros = build_micros + ?4`,
      )
      .bind(row.workspace, month(), Math.ceil(seconds), cost)
      .run();
  }

  /** Remembers the most apps the workspace had up at once this month. */
  private async notePeak(workspace: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO meters (namespace, month, peak_apps)
         VALUES (?1, ?2, (SELECT COUNT(*) FROM apps WHERE workspace = ?1))
         ON CONFLICT (namespace, month) DO UPDATE SET
           peak_apps = MAX(peak_apps, (SELECT COUNT(*) FROM apps WHERE workspace = ?1))`,
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
      body: JSON.stringify({ repoId, sha, context, state, description, targetUrl }),
    }).catch(() => undefined);
  }

  private async statusFor(row: DeploymentRow, state: string, description: string, targetUrl: string): Promise<void> {
    const projects = await this.projects.byRepo(row.repo_id);
    const primary = projects.find((p) => p.id === row.project_id)?.primary ?? true;
    await this.status(row.repo_id, row.commit_sha, { slug: row.slug, primary }, state, description, targetUrl);
  }

  // ---- Taking apps down ----------------------------------------------

  private async removeApp(script: string): Promise<void> {
    await this.cloudflare?.deleteScript(script);
    await this.db.prepare("DELETE FROM apps WHERE script = ?").bind(script).run();
  }

  private async takeDownWhere(projectId: string, kind: DeployKind | null, branch?: string): Promise<void> {
    const apps = await this.db
      .prepare(
        `SELECT script FROM apps WHERE project_id = ?1 AND (?2 IS NULL OR kind = ?2) AND (?3 IS NULL OR branch = ?3)`,
      )
      .bind(projectId, kind, branch ?? null)
      .all<{ script: string }>();
    for (const app of apps.results) await this.removeApp(app.script);
  }

  // ---- Events --------------------------------------------------------

  async onEvent(event: G1tEvent): Promise<void> {
    switch (event.type) {
      case "pull.opened":
      case "pull.ready":
      case "pull.updated":
        for (const project of await this.projects.byRepo(event.data.repoId)) {
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
      case "git.push":
        if (!event.data.defaultBranch) break;
        for (const project of await this.projects.byRepo(event.data.repoId)) {
          await this.deployProduction(project, event.data.after, event.actor ?? "g1t");
        }
        break;
    }
  }

  // ---- The sweep -----------------------------------------------------

  /**
   * Every few minutes: builds that died are failed; usage is counted; idle
   * previews, the apps of workspaces whose plan ended, and scripts no app
   * holds come down; and a month that is over is charged past its
   * allowance.
   */
  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - BUILD_TIMEOUT_MS).toISOString();
    const stuck = await this.db
      .prepare("SELECT id FROM deployments WHERE status IN ('queued', 'building') AND created_at < ?")
      .bind(cutoff)
      .all<{ id: string }>();
    for (const { id } of stuck.results) await this.finishFailed(id, "The build did not finish in 45 minutes.", null, null);

    const apps = (await this.db.prepare("SELECT * FROM apps").all<AppRow>()).results;
    const workspaces = [...new Set(apps.map((app) => app.workspace))];

    // Apps of workspaces whose plan has ended come down.
    const billing = billingClient(this.env.BILLING);
    await this.holdToLimits(apps).catch((error) => console.error("could not apply limits", error));
    for (const workspace of workspaces) {
      const plan = await billing.hasFeature(workspace, "deployments");
      if (!plan.ok && plan.error.code === "payment_required") {
        for (const app of apps.filter((a) => a.workspace === workspace)) await this.removeApp(app.script);
      }
    }

    await this.removeOrphans(apps).catch((error) => console.error("could not remove orphans", error));
    await this.count(apps).catch((error) => console.error("could not count usage", error));
    await this.takeDownIdle();
    await this.chargeMonths();
  }

  /**
   * Pauses the apps of workspaces that reached their limit for usage not
   * yet paid for, and rebuilds them from the same commit once they are
   * under it again. Paused apps answer with a notice and run nothing.
   */
  private async holdToLimits(apps: AppRow[]): Promise<void> {
    const cloudflare = this.cloudflare;
    if (!cloudflare) return;
    const billing = billingClient(this.env.BILLING);
    for (const workspace of [...new Set(apps.map((app) => app.workspace))]) {
      const limit = await billing.checkLimit(workspace);
      if (!limit.ok) continue;
      const theirs = apps.filter((app) => app.workspace === workspace);
      if (limit.value.state === "stopped") {
        for (const app of theirs.filter((a) => !a.paused_at)) {
          await cloudflare.pauseScript(app.script);
          await this.db.prepare("UPDATE apps SET paused_at = ? WHERE script = ?").bind(now(), app.script).run();
        }
        continue;
      }
      const paused = theirs.filter((a) => a.paused_at);
      if (paused.length === 0) continue;
      const actor = await this.workspaceActor(workspace);
      if (!actor) continue;
      for (const app of paused) {
        const project = await this.projects.get(workspace, app.slug, actor);
        if (!project.ok) continue;
        // A failed or refused rebuild leaves it paused, to try again next time.
        const rebuilt =
          app.kind === "production"
            ? await this.deployProduction(project.value, app.commit_sha, "g1t")
            : app.number != null
              ? await this.deployPreview(project.value, app.number, "g1t", true)
              : null;
        if (rebuilt && !rebuilt.ok) console.log("could not resume", app.script, rebuilt.error.message);
      }
    }
  }

  /** Scripts in the namespace that no app holds, such as ones renamed. */
  private async removeOrphans(apps: AppRow[]): Promise<void> {
    const cloudflare = this.cloudflare;
    if (!cloudflare) return;
    const held = new Set(apps.map((app) => app.script));
    const building = await this.db
      .prepare("SELECT script FROM deployments WHERE status IN ('queued', 'building')")
      .all<{ script: string }>();
    for (const row of building.results) held.add(row.script);
    const cutoff = Date.now() - ORPHAN_AFTER_MS;
    for (const script of await cloudflare.listScripts()) {
      if (!held.has(script.id) && Date.parse(script.modified_on) < cutoff) await cloudflare.deleteScript(script.id);
    }
  }

  /** Counts this month's requests and CPU time per workspace, from analytics. */
  private async count(apps: AppRow[]): Promise<void> {
    const cloudflare = this.cloudflare;
    if (!cloudflare || apps.length === 0) return;
    const start = `${month()}-01T00:00:00Z`;
    const totals = await cloudflare.usage(apps.map((app) => app.script), start, now());
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
    for (const [workspace, used] of perWorkspace) {
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
    for (const [script, used] of recent) {
      if (used.requests > 0) {
        await this.db.prepare("UPDATE apps SET last_request_at = ? WHERE script = ?").bind(at, script).run();
      }
    }
    for (const workspace of new Set(apps.map((app) => app.workspace))) await this.notePeak(workspace);
  }

  /** Previews no one has visited in their project's idle days. */
  private async takeDownIdle(): Promise<void> {
    const idle = await this.db
      .prepare(
        `SELECT apps.script FROM apps JOIN settings ON settings.project_id = apps.project_id
         WHERE apps.kind = 'preview'
           AND COALESCE(apps.last_request_at, apps.deployed_at) < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || settings.idle_days || ' days')`,
      )
      .all<{ script: string }>();
    for (const { script } of idle.results) await this.removeApp(script);
  }

  /** Charges each month that is over for what it used past the allowance, once. */
  private async chargeMonths(): Promise<void> {
    const due = await this.db
      .prepare("SELECT * FROM meters WHERE month < ? AND charged_at IS NULL")
      .bind(month())
      .all<{ namespace: string; month: string; requests: number; cpu_ms: number; peak_apps: number }>();
    const a = DEPLOYMENTS_ALLOWANCE;
    for (const meter of due.results) {
      const extraRequests = Math.max(0, meter.requests - a.requests);
      const extraCpu = Math.max(0, meter.cpu_ms - a.cpuMs);
      const extraApps = Math.max(0, meter.peak_apps - a.apps);
      const cost = Math.ceil(
        (extraRequests / 1_000_000) * a.microsPerMillionRequests +
          (extraCpu / 1_000_000) * a.microsPerMillionCpuMs +
          extraApps * a.microsPerAppMonth,
      );
      if (cost > 0) {
        const parts = [
          extraApps && `${extraApps} extra apps`,
          extraRequests && `${extraRequests.toLocaleString("en-US")} extra requests`,
          extraCpu && `${extraCpu.toLocaleString("en-US")} extra CPU ms`,
        ].filter(Boolean);
        const charged = await billingClient(this.env.BILLING).chargeFeature({
          workspace: meter.namespace,
          feature: "deployments",
          costMicros: cost,
          description: `Deployments in ${meter.month} past the plan: ${parts.join(", ")}`,
          reference: `deployments/${meter.namespace}/${meter.month}`,
        });
        if (!charged.ok) continue;
      }
      await this.db
        .prepare("UPDATE meters SET charged_at = ? WHERE namespace = ? AND month = ?")
        .bind(now(), meter.namespace, meter.month)
        .run();
    }
  }
}

/** `POST /rpc/<method>`: the arguments are the body. */
async function rpc(service: Deployments, method: string, args: any, ctx: ExecutionContext): Promise<unknown> {
  switch (method) {
    case "settings":
      return service.settings(args);
    case "update_settings":
      return service.updateSettings(args);
    case "list":
      return service.list(args);
    case "get":
      return service.get(args);
    case "redeploy":
      return service.redeploy(args);
    case "take_down":
      return service.takeDown(args);
    case "stack":
      return service.stack(args, (work) => ctx.waitUntil(work));
    case "overview":
      return service.overview(args);
    case "usage":
      return service.usage(args);
    default:
      return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST") return new Response("Not found\n", { status: 404 });
    const service = new Deployments(env);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const rpcMatch = pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (rpcMatch) {
      const result = await rpc(service, rpcMatch[1], body, ctx);
      return result === undefined ? new Response("Unknown method\n", { status: 404 }) : Response.json(result);
    }
    // A build's reports, forwarded by the API.
    const jobMatch = pathname.match(/^\/jobs\/([a-z0-9_]+)\/(started|session|finish|fail)$/);
    if (jobMatch) return service.job(jobMatch[1], jobMatch[2], body);
    return new Response("Not found\n", { status: 404 });
  },

  async queue(batch: MessageBatch<G1tEvent>, env: Env): Promise<void> {
    const service = new Deployments(env);
    for (const message of batch.messages) {
      try {
        await service.onEvent(message.body);
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
