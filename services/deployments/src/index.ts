/**
 * The deployments service: every pull request gets a live preview on
 * g1t.page, and the default branch goes to production on every push.
 *
 * It reacts to events (a pull request opened, ready, pushed to, closed or
 * merged; a push to the default branch), asks billing whether the
 * workspace pays for Deployments, and asks the runner to build the commit
 * in a sandbox. The sandbox reports back through the API with a token for
 * that build alone; this service opens the upload of its files and puts
 * the finished app in the Workers for Platforms namespace, where the
 * `*.g1t.page` dispatcher finds it by hostname.
 *
 * Nothing here is free. A build is charged by the second; requests, CPU
 * time and apps past the plan's allowance are charged once the month is
 * over. A Worker runs only while it answers a request, so an app no one
 * visits costs nothing, and a preview is taken down when its pull request
 * closes or after its repository's idle days.
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
  reposClient,
  workClient,
  type DeployKind,
  type DeploySettings,
  type DeployStatus,
  type DeployUsage,
  type Deployment,
  type G1tEvent,
  type LiveApp,
  type RepoPath,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
} from "@g1t/contracts";

import { Cloudflare, type BuiltWorker, type Manifest } from "./cloudflare";
import { appUrl, scriptName } from "./names";

type Env = {
  DB: D1Database;
  REPOS: ServiceBinding;
  WORK: ServiceBinding;
  IDENTITY: ServiceBinding;
  BILLING: ServiceBinding;
  RUNNER: ServiceBinding;
  /** Secret: scoped to Workers scripts and analytics on g1t's account. */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  DISPATCH_NAMESPACE: string;
  SITE: string;
};

/** A build that has not reported in this long has died. */
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const LIST_LIMIT = 50;
const MAX_ENV_VARS = 50;
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

type SettingsRow = {
  repo_id: string;
  namespace: string;
  name: string;
  enabled: number;
  previews: number;
  production: number;
  build_command: string | null;
  output_dir: string | null;
  build_env: string;
  idle_days: number;
};

type DeploymentRow = {
  id: string;
  repo_id: string;
  namespace: string;
  name: string;
  kind: DeployKind;
  number: number | null;
  commit_sha: string;
  script: string;
  status: DeployStatus;
  error: string | null;
  warnings: string;
  log: string | null;
  token_hash: string | null;
  build_seconds: number | null;
  created_by: string;
  created_at: string;
  finished_at: string | null;
};

type AppRow = {
  script: string;
  repo_id: string;
  namespace: string;
  name: string;
  kind: DeployKind;
  number: number | null;
  commit_sha: string;
  deployed_at: string;
  created_at: string;
  last_request_at: string | null;
};

function toDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    kind: row.kind,
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

class Deployments {
  constructor(private readonly env: Env) {}

  private get cloudflare(): Cloudflare | null {
    const token = this.env.CLOUDFLARE_API_TOKEN;
    return token ? new Cloudflare(token, this.env.CLOUDFLARE_ACCOUNT_ID, this.env.DISPATCH_NAMESPACE) : null;
  }

  private get db() {
    return this.env.DB;
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

  private async pathById(id: string): Promise<RepoPath | null> {
    const response = await this.env.REPOS.fetch("https://repos/rpc/path_by_id", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return response.ok ? ((await response.json()) as RepoPath | null) : null;
  }

  private async settingsRow(repoId: string): Promise<SettingsRow | null> {
    return this.db.prepare("SELECT * FROM settings WHERE repo_id = ?").bind(repoId).first<SettingsRow>();
  }

  private async toSettings(repo: RepoPath, row: SettingsRow | null): Promise<DeploySettings> {
    return {
      enabled: !!row?.enabled,
      previews: row ? !!row.previews : true,
      production: row ? !!row.production : true,
      buildCommand: row?.build_command ?? null,
      outputDir: row?.output_dir ?? null,
      buildEnv: JSON.parse(row?.build_env ?? "{}") as Record<string, string>,
      idleDays: row?.idle_days ?? 7,
      productionUrl: appUrl(await scriptName(repo, null)),
    };
  }

  /** The repository, if `viewer` belongs to its workspace and it is not a fork. */
  private async memberRepo(repo: RepoPath, viewer: Viewer) {
    if (!isMember(viewer, repo.namespace)) return fail("forbidden", "Only members of the workspace can manage its deployments.");
    const found = await reposClient(this.env.REPOS).get(repo, viewer);
    if (!found.ok) return found;
    if (found.value.forkOf) return fail("invalid", "A pull request's working copy does not deploy on its own.");
    return found;
  }

  // ---- Methods for the site and the API ------------------------------

  async settings(a: { repo: RepoPath; viewer: Viewer }): Promise<Result<DeploySettings>> {
    const repo = await this.memberRepo(a.repo, a.viewer);
    if (!repo.ok) return repo;
    return ok(await this.toSettings(a.repo, await this.settingsRow(repo.value.id)));
  }

  async updateSettings(a: {
    actor: User;
    repo: RepoPath;
    changes: Partial<DeploySettings>;
  }): Promise<Result<DeploySettings>> {
    const repo = await this.memberRepo(a.repo, a.actor);
    if (!repo.ok) return repo;
    const before = await this.toSettings(a.repo, await this.settingsRow(repo.value.id));
    const next = { ...before, ...a.changes };
    if (next.enabled && !before.enabled) {
      // Turning it on starts paid work: only with the workspace's plan.
      const plan = await billingClient(this.env.BILLING).hasFeature(a.repo.namespace, "deployments");
      if (!plan.ok) return plan;
    }
    const env = Object.entries(next.buildEnv ?? {});
    if (env.length > MAX_ENV_VARS) return fail("invalid", `At most ${MAX_ENV_VARS} build variables.`);
    if (env.some(([name]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      return fail("invalid", "A variable's name is letters, digits and underscores, not starting with a digit.");
    }
    const idleDays = Math.min(90, Math.max(1, Math.trunc(Number(next.idleDays) || 7)));
    const clip = (text: string | null | undefined) => (text?.trim() ? text.trim().slice(0, 500) : null);
    await this.db
      .prepare(
        `INSERT INTO settings (repo_id, namespace, name, enabled, previews, production, build_command, output_dir,
           build_env, idle_days, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (repo_id) DO UPDATE SET namespace = ?2, name = ?3, enabled = ?4, previews = ?5, production = ?6,
           build_command = ?7, output_dir = ?8, build_env = ?9, idle_days = ?10, updated_by = ?11, updated_at = ?12`,
      )
      .bind(
        repo.value.id,
        repo.value.namespace,
        repo.value.name,
        next.enabled ? 1 : 0,
        next.previews ? 1 : 0,
        next.production ? 1 : 0,
        clip(next.buildCommand),
        clip(next.outputDir),
        JSON.stringify(Object.fromEntries(env.map(([k, v]) => [k, String(v).slice(0, 2000)]))),
        idleDays,
        a.actor.username,
        now(),
      )
      .run();
    // What was turned off comes down now; nothing keeps running unasked.
    if (!next.enabled) await this.takeDownWhere(repo.value.id, null);
    else {
      if (!next.previews) await this.takeDownWhere(repo.value.id, "preview");
      if (!next.production) await this.takeDownWhere(repo.value.id, "production");
    }
    // Turned on: production goes up from the default branch at once.
    if (next.enabled && next.production && (!before.enabled || !before.production)) {
      await this.deployProduction(repo.value.id, a.repo, repo.value.defaultBranch, null, a.actor.username);
    }
    return ok(await this.toSettings(a.repo, await this.settingsRow(repo.value.id)));
  }

  async list(a: { repo: RepoPath; viewer: Viewer }): Promise<Result<{ deployments: Deployment[]; live: LiveApp[] }>> {
    const repo = await this.memberRepo(a.repo, a.viewer);
    if (!repo.ok) return repo;
    const [deployments, apps] = await Promise.all([
      this.db
        .prepare("SELECT * FROM deployments WHERE repo_id = ? ORDER BY id DESC LIMIT ?")
        .bind(repo.value.id, LIST_LIMIT)
        .all<DeploymentRow>(),
      this.db
        .prepare("SELECT * FROM apps WHERE repo_id = ? ORDER BY kind DESC, number DESC")
        .bind(repo.value.id)
        .all<AppRow>(),
    ]);
    return ok({
      deployments: deployments.results.map(toDeployment),
      live: apps.results.map((app) => ({
        kind: app.kind,
        number: app.number,
        url: appUrl(app.script),
        commit: app.commit_sha,
        deployedAt: app.deployed_at,
      })),
    });
  }

  async get(a: { repo: RepoPath; id: string; viewer: Viewer }): Promise<Result<Deployment & { log: string | null }>> {
    const repo = await this.memberRepo(a.repo, a.viewer);
    if (!repo.ok) return repo;
    const row = await this.db
      .prepare("SELECT * FROM deployments WHERE id = ? AND repo_id = ?")
      .bind(a.id, repo.value.id)
      .first<DeploymentRow>();
    if (!row) return fail("not_found", "No such deployment.");
    return ok({ ...toDeployment(row), log: row.log });
  }

  async redeploy(a: { actor: User; repo: RepoPath; number: number | null }): Promise<Result<Deployment>> {
    const repo = await this.memberRepo(a.repo, a.actor);
    if (!repo.ok) return repo;
    const settings = await this.settingsRow(repo.value.id);
    if (!settings?.enabled) return fail("conflict", "Deployments are off for this repository.");
    const started =
      a.number == null
        ? await this.deployProduction(repo.value.id, a.repo, repo.value.defaultBranch, null, a.actor.username)
        : await this.deployPreview(repo.value.id, a.repo, a.number, a.actor.username, true);
    return started ?? fail("conflict", "There was nothing to deploy.");
  }

  async takeDown(a: { actor: User; repo: RepoPath; number: number | null }): Promise<Result<true>> {
    const repo = await this.memberRepo(a.repo, a.actor);
    if (!repo.ok) return repo;
    const script = await scriptName(a.repo, a.number);
    await this.removeApp(script);
    return ok(true);
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
      this.db.prepare("SELECT COUNT(*) AS n FROM apps WHERE namespace = ?").bind(slug).first<{ n: number }>(),
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
    repoId: string;
    repo: RepoPath;
    kind: DeployKind;
    number: number | null;
    commit: string;
    source: RepoPath;
    reader: User;
    createdBy: string;
    settings: SettingsRow;
  }): Promise<Result<Deployment>> {
    const script = await scriptName(input.repo, input.number);
    const id = newId("dpl");
    const token = randomToken();
    const plan = await billingClient(this.env.BILLING).hasFeature(input.repo.namespace, "deployments");
    const cloudflare = this.cloudflare;
    const refused = !plan.ok
      ? plan.error.message
      : !cloudflare
        ? "Deployments are not set up on this g1t: it has no Cloudflare token."
        : null;
    await this.db
      .prepare(
        `INSERT INTO deployments (id, repo_id, namespace, name, kind, number, commit_sha, script, status, error,
           token_hash, created_by, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.repoId,
        input.repo.namespace,
        input.repo.name,
        input.kind,
        input.number,
        input.commit,
        script,
        refused ? "skipped" : "queued",
        refused,
        refused ? null : await sha256(token),
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
    await this.status(input.repoId, input.commit, "pending", "Building", `${this.env.SITE}/${input.repo.namespace}/${input.repo.name}/deployments/${id}`);
    const env = JSON.parse(input.settings.build_env || "{}") as Record<string, string>;
    const response = await this.env.RUNNER.fetch("https://runner/rpc/start_deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deployId: id,
        token,
        actor: input.reader,
        source: input.source,
        commit: input.commit,
        buildCommand: input.settings.build_command,
        outputDir: input.settings.output_dir,
        buildEnv: env,
      }),
    });
    const started = response.ok ? ((await response.json()) as Result<true>) : fail("conflict", `The runner answered ${response.status}.`);
    if (!started.ok) await this.finishFailed(id, started.error.message, null, null);
    return ok(toDeployment((await this.deploymentRow(id))!));
  }

  private async deployProduction(
    repoId: string,
    repo: RepoPath,
    branch: string,
    commit: string | null,
    createdBy: string,
  ): Promise<Result<Deployment> | null> {
    const settings = await this.settingsRow(repoId);
    if (!settings?.enabled || !settings.production) return null;
    const actor = await this.workspaceActor(repo.namespace);
    if (!actor) return null;
    let head = commit;
    if (!head) {
      const branches = await reposClient(this.env.REPOS).branches(repo, actor);
      head = branches.ok ? (branches.value.find((b) => b.name === branch)?.hash ?? null) : null;
    }
    if (!head) return null;
    return this.start({
      repoId,
      repo,
      kind: "production",
      number: null,
      commit: head,
      source: repo,
      reader: actor,
      createdBy,
      settings,
    });
  }

  private async deployPreview(
    repoId: string,
    repo: RepoPath,
    number: number,
    createdBy: string,
    force = false,
  ): Promise<Result<Deployment> | null> {
    const settings = await this.settingsRow(repoId);
    if (!settings?.enabled || !settings.previews) return null;
    const actor = await this.workspaceActor(repo.namespace);
    if (!actor) return null;
    const detail = await workClient(this.env.WORK).getPull(repo, number, actor);
    if (!detail.ok) return null;
    const { pull } = detail.value;
    if ((pull.status !== "open" && pull.status !== "draft") || !pull.headCommit) return null;
    if (!force) {
      // Already built, or being built, at this commit.
      const same = await this.db
        .prepare(
          `SELECT id FROM deployments WHERE repo_id = ? AND kind = 'preview' AND number = ? AND commit_sha = ?
             AND status IN ('queued', 'building', 'ready')`,
        )
        .bind(repoId, number, pull.headCommit)
        .first();
      if (same) return null;
    }
    return this.start({
      repoId,
      repo,
      kind: "preview",
      number,
      commit: pull.headCommit,
      source: pull.fork ?? repo,
      // The pull request's fork may be private: read it as its author.
      reader: pull.author,
      createdBy,
      settings,
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
        try {
          await cloudflare.putScript(
            row.script,
            worker,
            typeof body.completionJwt === "string" ? body.completionJwt : null,
            [`workspace:${row.namespace}`, `repo:${row.namespace}/${row.name}`, row.kind],
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
              `INSERT INTO apps (script, repo_id, namespace, name, kind, number, commit_sha, deployed_at, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
               ON CONFLICT (script) DO UPDATE SET commit_sha = ?7, deployed_at = ?8`,
            )
            .bind(row.script, row.repo_id, row.namespace, row.name, row.kind, row.number, row.commit_sha, at),
        ]);
        await this.chargeBuild(row, seconds);
        await this.notePeak(row.namespace);
        await this.status(
          row.repo_id,
          row.commit_sha,
          "success",
          row.kind === "preview" ? "Preview is live" : "Production is live",
          appUrl(row.script),
        );
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
    await this.status(
      row.repo_id,
      row.commit_sha,
      "failure",
      "Deployment failed",
      `${this.env.SITE}/${row.namespace}/${row.name}/deployments/${id}`,
    );
  }

  /** Each build is charged by the second at the container price plus the margin. */
  private async chargeBuild(row: DeploymentRow, seconds: number): Promise<void> {
    const cost = Math.ceil(seconds) * DEPLOYMENTS_ALLOWANCE.microsPerBuildSecond;
    if (cost <= 0) return;
    const what = row.kind === "preview" ? `the preview of ${row.namespace}/${row.name}#${row.number}` : `${row.namespace}/${row.name} to production`;
    await billingClient(this.env.BILLING).chargeFeature({
      workspace: row.namespace,
      feature: "deployments",
      costMicros: cost,
      description: `Building ${what} (${Math.ceil(seconds)} s)`,
      repo: `${row.namespace}/${row.name}`,
      reference: `deploy/${row.id}`,
    });
    await this.db
      .prepare(
        `INSERT INTO meters (namespace, month, build_seconds, build_micros) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (namespace, month) DO UPDATE SET build_seconds = build_seconds + ?3, build_micros = build_micros + ?4`,
      )
      .bind(row.namespace, month(), Math.ceil(seconds), cost)
      .run();
  }

  /** Remembers the most apps the workspace had up at once this month. */
  private async notePeak(namespace: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO meters (namespace, month, peak_apps)
         VALUES (?1, ?2, (SELECT COUNT(*) FROM apps WHERE namespace = ?1))
         ON CONFLICT (namespace, month) DO UPDATE SET
           peak_apps = MAX(peak_apps, (SELECT COUNT(*) FROM apps WHERE namespace = ?1))`,
      )
      .bind(namespace, month())
      .run();
  }

  private async status(repoId: string, sha: string, state: string, description: string, targetUrl: string): Promise<void> {
    await this.env.WORK.fetch("https://work/rpc/set_commit_status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId, sha, context: STATUS_CONTEXT, state, description, targetUrl }),
    }).catch(() => undefined);
  }

  // ---- Taking apps down ----------------------------------------------

  private async removeApp(script: string): Promise<void> {
    await this.cloudflare?.deleteScript(script);
    await this.db.prepare("DELETE FROM apps WHERE script = ?").bind(script).run();
  }

  private async takeDownWhere(repoId: string, kind: DeployKind | null, number?: number): Promise<void> {
    const apps = await this.db
      .prepare(
        `SELECT script FROM apps WHERE repo_id = ?1 AND (?2 IS NULL OR kind = ?2) AND (?3 IS NULL OR number = ?3)`,
      )
      .bind(repoId, kind, number ?? null)
      .all<{ script: string }>();
    for (const app of apps.results) await this.removeApp(app.script);
  }

  // ---- Events --------------------------------------------------------

  async onEvent(event: G1tEvent): Promise<void> {
    switch (event.type) {
      case "pull.opened":
      case "pull.ready":
      case "pull.updated": {
        const repo = await this.pathById(event.data.repoId);
        if (repo) await this.deployPreview(event.data.repoId, repo, event.data.number, "g1t");
        break;
      }
      case "pull.closed":
      case "pull.merged":
        await this.takeDownWhere(event.data.repoId, "preview", event.data.number);
        break;
      case "git.push": {
        if (!event.data.defaultBranch) break;
        const repo = await this.pathById(event.data.repoId);
        if (!repo) break;
        await this.deployProduction(
          event.data.repoId,
          repo,
          event.data.ref.replace(/^refs\/heads\//, ""),
          event.data.after,
          event.actor ?? "g1t",
        );
        break;
      }
    }
  }

  // ---- The sweep -----------------------------------------------------

  /**
   * Every few minutes: builds that died are failed; usage is counted; idle
   * previews and the apps of workspaces whose plan ended come down; and a
   * month that is over is charged past its allowance.
   */
  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - BUILD_TIMEOUT_MS).toISOString();
    const stuck = await this.db
      .prepare("SELECT id FROM deployments WHERE status IN ('queued', 'building') AND created_at < ?")
      .bind(cutoff)
      .all<{ id: string }>();
    for (const { id } of stuck.results) await this.finishFailed(id, "The build did not finish in 45 minutes.", null, null);

    const apps = (await this.db.prepare("SELECT * FROM apps").all<AppRow>()).results;
    const workspaces = [...new Set(apps.map((app) => app.namespace))];

    // Apps of workspaces whose plan has ended come down.
    const billing = billingClient(this.env.BILLING);
    for (const workspace of workspaces) {
      const plan = await billing.hasFeature(workspace, "deployments");
      if (!plan.ok && plan.error.code === "payment_required") {
        for (const app of apps.filter((a) => a.namespace === workspace)) await this.removeApp(app.script);
      }
    }

    await this.count(apps).catch((error) => console.error("could not count usage", error));
    await this.takeDownIdle();
    await this.chargeMonths();
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
      const sum = perWorkspace.get(app.namespace) ?? { requests: 0, cpuMs: 0 };
      sum.requests += used.requests;
      sum.cpuMs += used.cpuMs;
      perWorkspace.set(app.namespace, sum);
    }
    const at = now();
    for (const [namespace, used] of perWorkspace) {
      await this.db
        .prepare(
          `INSERT INTO meters (namespace, month, requests, cpu_ms, counted_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (namespace, month) DO UPDATE SET
             requests = MAX(requests, ?3), cpu_ms = MAX(cpu_ms, ?4), counted_at = ?5`,
        )
        .bind(namespace, month(), used.requests, used.cpuMs, at)
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
    for (const namespace of new Set(apps.map((app) => app.namespace))) await this.notePeak(namespace);
  }

  /** Previews no one has visited in their repository's idle days. */
  private async takeDownIdle(): Promise<void> {
    const idle = await this.db
      .prepare(
        `SELECT apps.script FROM apps JOIN settings ON settings.repo_id = apps.repo_id
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
async function rpc(service: Deployments, method: string, args: any): Promise<unknown> {
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
    case "usage":
      return service.usage(args);
    default:
      return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST") return new Response("Not found\n", { status: 404 });
    const service = new Deployments(env);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const rpcMatch = pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (rpcMatch) {
      const result = await rpc(service, rpcMatch[1], body);
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
