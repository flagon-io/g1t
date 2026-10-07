/**
 * The projects service: what a workspace builds and runs.
 *
 * A project has one source, where its code lives: today a repository hosted
 * on g1t and a root directory in it. Everything about running it
 * (deployments, environments, domains, secrets and variables) hangs off the
 * project; other services key their data by its id. Every repository gets
 * a project of its own name: when it is created (from `repo.created`), and
 * for repositories made before projects existed, the first time their
 * workspace's projects are asked for.
 *
 * Reached through service bindings: `POST /rpc/<method>`.
 */

import { parse as parseYaml } from "yaml";

import { NEEDS, repoRef } from "./access";
import { effectiveDescription, ownDescription } from "./description";
import { type KindFacts, type RootFiles, MANIFESTS, deploysSetting, detectKind, goFilesToRead, resolveKind } from "./kind";
import { ACTIVE, decayed, raised } from "./activity";
import { MAX_PINS, MAX_RECENT, MAX_VISITS, placePin, recentAfterPins, reorderPins } from "./pins";
import { renameStatements } from "./rename";
import { moveStatements, slugOf, strandedQuery } from "./transfer";

import {
  can,
  currentMovedPath,
  currentWorkspaceSlug,
  fail,
  identityClient,
  staleSlugs,
  needs,
  isProtectedWorkspace,
  newId,
  ok,
  openD1,
  packagesClient,
  permission,
  repoMove,
  reposClient,
  staleMovedPaths,
  type Dependencies,
  type DependencyLink,
  type DeploysSetting,
  type Ecosystem,
  type G1tEvent,
  type NewProject,
  type Project,
  type ProjectEcosystem,
  type ProjectGraph,
  type ProjectShortcuts,
  type Repo,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
} from "@g1t/contracts";

type Env = {
  DB: D1Database;
  REPOS: ServiceBinding;
  IDENTITY: ServiceBinding;
  PACKAGES: ServiceBinding;
  DEPLOYMENTS: ServiceBinding;
};

type Row = {
  id: string;
  workspace: string;
  slug: string;
  name: string;
  /** The project's own description; null while it follows its repository's. */
  description: string | null;
  /** Its repository's description, kept from repos. */
  repo_description?: string | null;
  source_kind: string;
  repo_id: string;
  repo_namespace: string;
  repo_name: string;
  repo_private: number;
  default_branch: string;
  root_dir: string;
  is_primary: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Set while its repository is deleted; the project is hidden until it is restored. */
  repo_deleted_at: string | null;
  /** When its repository was archived; null while it is not. */
  repo_archived_at?: string | null;
  /** auto, yes or no: whether it deploys (migrations/0007_deploys.sql). */
  deploys?: string | null;
  detected_kind?: string | null;
  detected_detail?: string | null;
  detected_ecosystem?: string | null;
  /** The default branch's commit its files were read at; null until they have been. */
  detected_commit?: string | null;
  linked_package?: string | null;
  deployments_on?: number | null;
  /** When its repository was last pushed to (migrations/0009_activity.sql). */
  pushed_at?: string | null;
  /** How active it is lately, as of `active_at` (src/activity.ts). */
  activity?: number | null;
  active_at?: string | null;
};

/** How a package its repository publishes is named in why a project is a library. */
const ECOSYSTEM_NAME: Record<Ecosystem, string> = {
  container: "container image",
  npm: "npm package",
  composer: "Composer package",
  cargo: "crate",
  go: "Go module",
};

/** How many projects one listing reads the files of, in the background, before it has. */
const DETECT_PER_LIST = 10;

const now = () => new Date().toISOString();

/** A variable's name for a dependency's address, spelled as secrets' names are. */
const ALIAS = /^[A-Z_][A-Z0-9_]{0,99}$/;
/** How many dependencies a project may declare. */
const MAX_DEPENDENCIES = 50;

type LinkRow = { slug: string; name: string; alias: string | null; source: "ui" | "file"; repo_id: string; repo_namespace: string; repo_private: number };
type NodeRow = { id: string; slug: string; workspace: string; alias: string | null };

function toProject(row: Row): Project {
  const { description, inherited } = effectiveDescription(row);
  const deploys = deploysSetting(row.deploys);
  const facts: Omit<KindFacts, "deploys"> = {
    deploymentsOn: row.deployments_on == null ? null : !!row.deployments_on,
    linkedPackage: row.linked_package ?? null,
    detected:
      row.detected_commit == null
        ? null
        : { kind: row.detected_kind === "app" || row.detected_kind === "library" ? row.detected_kind : null, detail: row.detected_detail ?? "" },
  };
  const { kind, reason } = resolveKind({ deploys, ...facts });
  const auto = resolveKind({ deploys: "auto", ...facts });
  return {
    id: row.id,
    workspace: row.workspace,
    slug: row.slug,
    name: row.name,
    description,
    descriptionInherited: inherited,
    source: {
      kind: "hosted",
      repoId: row.repo_id,
      repo: { namespace: row.repo_namespace, name: row.repo_name },
      rootDir: row.root_dir,
      defaultBranch: row.default_branch,
    },
    private: !!row.repo_private,
    archived: !!row.repo_archived_at,
    primary: !!row.is_primary,
    deploys,
    kind,
    kindReason: reason,
    detected: auto,
    ecosystem: (row.detected_ecosystem as ProjectEcosystem | null) ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pushedAt: row.pushed_at ?? null,
    activity: decayed(row.activity ?? 0, row.active_at ?? null, now()),
  };
}

function isMember(viewer: Viewer, workspace: string): boolean {
  return !!viewer?.workspaces?.some((m) => m.slug === workspace.toLowerCase());
}

class Projects {
  /** `defer` runs work after the answer is sent: the request's waitUntil. */
  constructor(
    private readonly env: Env,
    private readonly defer: (work: Promise<unknown>) => void = () => {},
  ) {}

  private get db() {
    return this.env.DB;
  }

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

  /** A free slug for `wanted` in the workspace. */
  private async freeSlug(workspace: string, wanted: string): Promise<string> {
    const base = slugOf(wanted) || "project";
    for (let n = 1; n < 100; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const taken = await this.db
        .prepare("SELECT 1 FROM projects WHERE workspace = ? AND slug = ?")
        .bind(workspace, slug)
        .first();
      if (!taken) return slug;
    }
    return `${base}-${crypto.randomUUID().slice(0, 6)}`;
  }

  /** Gives a repository its own project, unless it has one. */
  private async ensureFor(repo: Repo, createdBy: string): Promise<void> {
    if (repo.forkOf) return;
    const existing = await this.db.prepare("SELECT id FROM projects WHERE repo_id = ?").bind(repo.id).first();
    if (existing) {
      await this.db
        .prepare(
          "UPDATE projects SET repo_private = ?, default_branch = ?, repo_name = ?, repo_archived_at = ?, repo_description = ? WHERE repo_id = ?",
        )
        .bind(repo.isPrivate ? 1 : 0, repo.defaultBranch, repo.name, repo.archivedAt ?? null, repo.description ?? null, repo.id)
        .run();
      return;
    }
    const at = now();
    await this.db
      .prepare(
        // No description of its own: it shows the repository's, as that changes.
        `INSERT INTO projects (id, workspace, slug, name, description, repo_description, repo_id, repo_namespace, repo_name, repo_private,
           default_branch, root_dir, is_primary, created_by, created_at, updated_at, repo_archived_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, '', 1, ?, ?, ?, ?)
         ON CONFLICT (workspace, slug) DO NOTHING`,
      )
      .bind(
        newId("prj"),
        repo.namespace.toLowerCase(),
        await this.freeSlug(repo.namespace.toLowerCase(), repo.name),
        repo.name,
        repo.description ?? null,
        repo.id,
        repo.namespace,
        repo.name,
        repo.isPrivate ? 1 : 0,
        repo.defaultBranch,
        createdBy,
        at,
        at,
        repo.archivedAt ?? null,
      )
      .run();
  }

  /** Projects for a workspace's repositories made before projects existed. Once. */
  private async backfill(workspace: string): Promise<void> {
    const done = await this.db.prepare("SELECT 1 FROM backfilled WHERE workspace = ?").bind(workspace).first();
    if (done) return;
    const actor = await this.workspaceActor(workspace);
    if (!actor) return;
    const list = await reposClient(this.env.REPOS).list(actor, { namespace: workspace });
    for (const repo of list) {
      if (repo.namespace.toLowerCase() === workspace) await this.ensureFor(repo, "g1t");
    }
    await this.db.prepare("INSERT OR REPLACE INTO backfilled (workspace, at) VALUES (?, ?)").bind(workspace, now()).run();
  }

  /**
   * Whether the viewer can read the project's repository. The workspace's
   * own token sees all its projects, also one left building from a
   * repository that moved to another workspace.
   */
  private visible(row: Row, viewer: Viewer): boolean {
    if (viewer?.kind === "workspace" && isMember(viewer, row.workspace)) return true;
    return permission(viewer, repoRef(row)) != null;
  }

  /**
   * Whether the actor may change the project: not found when they cannot
   * read its repository, refused when their role there is too low.
   */
  private changeable(row: Row, actor: User, capability: (typeof NEEDS)[keyof typeof NEEDS]): Result<true> {
    if (!this.visible(row, actor)) return fail("not_found", "There is no such project.");
    if (!can(actor, repoRef(row), capability)) return fail("forbidden", needs(capability));
    return ok(true);
  }

  async list(a: { workspace: string; viewer: Viewer }): Promise<Result<Project[]>> {
    const workspace = a.workspace.toLowerCase();
    await this.backfill(workspace);
    const rows = await this.db
      .prepare("SELECT * FROM projects WHERE workspace = ? AND repo_deleted_at IS NULL ORDER BY name COLLATE NOCASE")
      .bind(workspace)
      .all<Row>();
    // Projects whose files have not been read yet are read after this answer,
    // a few at a time; until then they show as apps, as before.
    const unread = rows.results.filter((row) => row.detected_commit == null).slice(0, DETECT_PER_LIST);
    if (unread.length) this.defer(Promise.all(unread.map((row) => this.detect(row).catch((error) => console.warn("detect", row.slug, error)))));
    return ok(rows.results.filter((row) => this.visible(row, a.viewer)).map(toProject));
  }

  async get(a: { workspace: string; slug: string; viewer: Viewer }): Promise<Result<Project>> {
    const workspace = a.workspace.toLowerCase();
    await this.backfill(workspace);
    const row = await this.db
      .prepare("SELECT * FROM projects WHERE workspace = ? AND slug = ? AND repo_deleted_at IS NULL")
      .bind(workspace, a.slug.toLowerCase())
      .first<Row>();
    if (!row || !this.visible(row, a.viewer)) return fail("not_found", "There is no such project.");
    if (row.detected_commit == null) {
      // Once per project: what its files say, read now so its first page is right.
      const read = await this.detect(row).catch((error) => (console.warn("detect", row.slug, error), null));
      if (read) return ok(toProject(read));
    }
    return ok(toProject(row));
  }

  /** How many projects a workspace shows: what deleting it would take with it. */
  async count(a: { workspace: string }): Promise<number> {
    const row = await this.db
      .prepare("SELECT count(*) AS n FROM projects WHERE workspace = ? AND repo_deleted_at IS NULL")
      .bind(a.workspace.toLowerCase())
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** The repository as it is now, read as its workspace; null when it is gone or deleted. */
  private async repoById(repoId: string): Promise<Repo | null> {
    const path = await this.env.REPOS.fetch("https://repos/rpc/path_by_id", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: repoId }),
    });
    const repoPath = path.ok ? ((await path.json()) as { namespace: string; name: string } | null) : null;
    if (!repoPath) return null;
    const actor = await this.workspaceActor(repoPath.namespace);
    const repo = actor ? await reposClient(this.env.REPOS).get(repoPath, actor) : null;
    return repo?.ok ? repo.value : null;
  }

  async byRepo(a: { repoId: string }): Promise<Project[]> {
    const rows = await this.db
      .prepare("SELECT * FROM projects WHERE repo_id = ? ORDER BY is_primary DESC, created_at")
      .bind(a.repoId)
      .all<Row>();
    // A deleted repository's projects are hidden until it is restored.
    if (rows.results.length > 0) return rows.results.filter((row) => !row.repo_deleted_at).map(toProject);
    // A repository from before projects: give it its own now.
    const repo = await this.repoById(a.repoId);
    if (!repo) return [];
    await this.ensureFor(repo, "g1t");
    const again = await this.db
      .prepare("SELECT * FROM projects WHERE repo_id = ? AND repo_deleted_at IS NULL")
      .bind(a.repoId)
      .all<Row>();
    return again.results.map(toProject);
  }

  async create(a: { actor: User; workspace: string; input: NewProject }): Promise<Result<Project>> {
    const workspace = a.workspace.toLowerCase();
    if (!isMember(a.actor, workspace)) return fail("forbidden", "Only members can add projects to a workspace.");
    if (a.input.repo.namespace.toLowerCase() !== workspace) {
      return fail("invalid", "A project builds from one of its own workspace's repositories.");
    }
    const repo = await reposClient(this.env.REPOS).get(a.input.repo, a.actor);
    if (!repo.ok) return repo;
    if (!can(a.actor, repo.value, NEEDS.create)) return fail("forbidden", needs(NEEDS.create));
    if (repo.value.forkOf) return fail("invalid", "A pull request's working copy cannot be a project's source.");
    const name = a.input.name.trim();
    if (!name || name.length > 100) return fail("invalid", "A project's name is 1 to 100 characters.");
    const rootDir = (a.input.rootDir ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (rootDir.split("/").some((part) => part === "..")) return fail("invalid", "The root directory is inside the repository.");
    const slug = slugOf(name);
    if (!slug) return fail("invalid", "Give the project a name with letters or digits.");
    const taken = await this.db.prepare("SELECT 1 FROM projects WHERE workspace = ? AND slug = ?").bind(workspace, slug).first();
    if (taken) return fail("conflict", `${workspace} already has a project called ${slug}.`);
    const primary = !(await this.db.prepare("SELECT 1 FROM projects WHERE repo_id = ?").bind(repo.value.id).first());
    const at = now();
    const id = newId("prj");
    await this.db
      .prepare(
        `INSERT INTO projects (id, workspace, slug, name, description, repo_description, repo_id, repo_namespace, repo_name, repo_private,
           default_branch, root_dir, is_primary, created_by, created_at, updated_at, repo_archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        workspace,
        slug,
        name,
        ownDescription(null, a.input.description ?? null),
        repo.value.description ?? null,
        repo.value.id,
        repo.value.namespace,
        repo.value.name,
        repo.value.isPrivate ? 1 : 0,
        repo.value.defaultBranch,
        rootDir,
        primary ? 1 : 0,
        a.actor.username,
        at,
        at,
        repo.value.archivedAt ?? null,
      )
      .run();
    return ok(toProject((await this.db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<Row>())!));
  }

  async update(a: {
    actor: User;
    workspace: string;
    slug: string;
    changes: { name?: string; description?: string | null; rootDir?: string; deploys?: DeploysSetting };
  }): Promise<Result<Project>> {
    const workspace = a.workspace.toLowerCase();
    const row = await this.db
      .prepare("SELECT * FROM projects WHERE workspace = ? AND slug = ? AND repo_deleted_at IS NULL")
      .bind(workspace, a.slug.toLowerCase())
      .first<Row>();
    if (!row) return fail("not_found", "There is no such project.");
    const allowed = this.changeable(row, a.actor, NEEDS.update);
    if (!allowed.ok) return allowed;
    const name = a.changes.name?.trim() || row.name;
    // Blank or null goes back to following the repository's description.
    const description = ownDescription(row.description, a.changes.description);
    const rootDir = a.changes.rootDir === undefined ? row.root_dir : a.changes.rootDir.trim().replace(/^\/+|\/+$/g, "");
    if (rootDir.split("/").some((part) => part === "..")) return fail("invalid", "The root directory is inside the repository.");
    const deploys = a.changes.deploys === undefined ? deploysSetting(row.deploys) : deploysSetting(a.changes.deploys);
    // Not deploying while Deployments run would leave apps up that no page
    // offers: a person turns them off first, in Deployments settings.
    const deploying = deploys === "no" && deploysSetting(row.deploys) !== "no" ? (row.deployments_on ?? (await this.deploymentsOn(row.id))) : false;
    if (deploying) {
      return fail("conflict", "Deployments are on for this project. Turn them off in its Deployments settings first.");
    }
    await this.db
      .prepare("UPDATE projects SET name = ?, description = ?, root_dir = ?, deploys = ?, updated_at = ? WHERE id = ?")
      .bind(name.slice(0, 100), description, rootDir, deploys, now(), row.id)
      .run();
    let saved = (await this.db.prepare("SELECT * FROM projects WHERE id = ?").bind(row.id).first<Row>())!;
    // Another root has other files: read them again.
    if (rootDir !== row.root_dir) saved = (await this.detect({ ...saved, detected_commit: null }).catch(() => null)) ?? saved;
    return ok(toProject(saved));
  }

  async deploymentsChanged(a: { projectId: string; enabled: boolean }): Promise<void> {
    await this.db.prepare("UPDATE projects SET deployments_on = ? WHERE id = ?").bind(a.enabled ? 1 : 0, a.projectId).run();
  }

  // ---- Pinned and recent ---------------------------------------------------

  /** The person's pins in the workspace, in order, as rows: hidden projects left out. */
  private async pinRows(userId: string, workspace: string): Promise<Row[]> {
    const rows = await this.db
      .prepare(
        `SELECT p.* FROM pins n JOIN projects p ON p.id = n.project_id
         WHERE n.user_id = ? AND p.workspace = ? AND p.repo_deleted_at IS NULL ORDER BY n.position, n.pinned_at`,
      )
      .bind(userId, workspace.toLowerCase())
      .all<Row>();
    return rows.results;
  }

  /** Writes the person's pins in the workspace in this order, by project id. */
  private async writePins(userId: string, order: string[], dropped: string[] = []): Promise<void> {
    const at = now();
    await this.db.batch([
      ...dropped.map((id) => this.db.prepare("DELETE FROM pins WHERE user_id = ? AND project_id = ?").bind(userId, id)),
      ...order.map((id, position) =>
        this.db
          .prepare(
            `INSERT INTO pins (user_id, project_id, position, pinned_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id, project_id) DO UPDATE SET position = excluded.position`,
          )
          .bind(userId, id, position, at),
      ),
    ]);
  }

  /** The person behind a call about their own pins, or why there is none. */
  private person(viewer: Viewer): Result<User> {
    if (!viewer) return fail("unauthenticated", "Sign in to pin projects.");
    if (viewer.kind && viewer.kind !== "user") return fail("forbidden", "Pins are a person's own: use a personal access token.");
    return ok(viewer);
  }

  /** A project the person can see, for pinning. */
  private async pinnable(actor: User, workspace: string, slug: string): Promise<Result<Row>> {
    const row = await this.row(workspace, slug);
    if (!row || !this.visible(row, actor)) return fail("not_found", "There is no such project.");
    return ok(row);
  }

  async shortcuts(a: { workspace: string; viewer: Viewer }): Promise<ProjectShortcuts> {
    const who = this.person(a.viewer);
    if (!who.ok) return { pinned: [], recent: [] };
    const workspace = a.workspace.toLowerCase();
    const [pinned, visited] = await Promise.all([
      this.pinRows(who.value.id, workspace),
      this.db
        .prepare(
          `SELECT p.* FROM visits v JOIN projects p ON p.id = v.project_id
           WHERE v.user_id = ? AND p.workspace = ? AND p.repo_deleted_at IS NULL ORDER BY v.visited_at DESC LIMIT ?`,
        )
        .bind(who.value.id, workspace, MAX_PINS + MAX_RECENT)
        .all<Row>(),
    ]);
    const shown = (row: Row) => this.visible(row, who.value);
    const pins = pinned.filter(shown);
    return {
      pinned: pins.map(toProject),
      recent: recentAfterPins(visited.results.filter(shown), pins.map((row) => row.id)).map(toProject),
    };
  }

  async pin(a: { actor: User; workspace: string; slug: string; position?: number | null }): Promise<Result<Project[]>> {
    const who = this.person(a.actor);
    if (!who.ok) return who;
    const found = await this.pinnable(who.value, a.workspace, a.slug);
    if (!found.ok) return found;
    const current = await this.pinRows(who.value.id, found.value.workspace);
    const order = placePin(
      current.map((row) => row.id),
      found.value.id,
      a.position,
    );
    if (!order) return fail("conflict", `You can pin ${MAX_PINS} projects in a workspace. Unpin one first.`);
    await this.writePins(who.value.id, order);
    return ok((await this.pinRows(who.value.id, found.value.workspace)).filter((row) => this.visible(row, who.value)).map(toProject));
  }

  async unpin(a: { actor: User; workspace: string; slug: string }): Promise<Result<Project[]>> {
    const who = this.person(a.actor);
    if (!who.ok) return who;
    const row = await this.row(a.workspace, a.slug);
    if (!row) return fail("not_found", "There is no such project.");
    const rest = (await this.pinRows(who.value.id, row.workspace)).map((pinned) => pinned.id).filter((id) => id !== row.id);
    await this.writePins(who.value.id, rest, [row.id]);
    return ok((await this.pinRows(who.value.id, row.workspace)).filter((pinned) => this.visible(pinned, who.value)).map(toProject));
  }

  async reorderPins(a: { actor: User; workspace: string; slugs: string[] }): Promise<Result<Project[]>> {
    const who = this.person(a.actor);
    if (!who.ok) return who;
    if (!Array.isArray(a.slugs)) return fail("invalid", "Give the pinned projects' slugs, in order.");
    const workspace = a.workspace.toLowerCase();
    const current = await this.pinRows(who.value.id, workspace);
    const idOf = new Map(current.map((row) => [row.slug, row.id]));
    const wanted = a.slugs.map((slug) => idOf.get(String(slug).toLowerCase()) ?? String(slug));
    const order = reorderPins(
      current.map((row) => row.id),
      wanted,
    );
    if (!order.ok) return fail("invalid", order.message);
    await this.writePins(who.value.id, order.order);
    return ok((await this.pinRows(who.value.id, workspace)).filter((row) => this.visible(row, who.value)).map(toProject));
  }

  async visited(a: { actor: User; projectId: string }): Promise<void> {
    const who = this.person(a.actor);
    if (!who.ok || !a.projectId) return;
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO visits (user_id, project_id, visited_at) VALUES (?, ?, ?)
           ON CONFLICT (user_id, project_id) DO UPDATE SET visited_at = excluded.visited_at`,
        )
        .bind(who.value.id, a.projectId, now()),
      // Only their latest few are kept.
      this.db
        .prepare(
          `DELETE FROM visits WHERE user_id = ?1 AND project_id NOT IN
             (SELECT project_id FROM visits WHERE user_id = ?1 ORDER BY visited_at DESC LIMIT ?2)`,
        )
        .bind(who.value.id, MAX_VISITS),
    ]);
  }

  // ---- App or library --------------------------------------------------

  /**
   * Reads what decides whether the project is a library: the manifests at
   * its root at `commit` (the default branch's head when null), a package
   * its repository publishes, and, the first time, whether Deployments are
   * on. Files are read again only for a commit they were not read at.
   * `packages` reads only the packages. Returns the row as it is now.
   */
  private async detect(row: Row, commit: string | null = null, only?: "packages"): Promise<Row> {
    const actor = await this.workspaceActor(row.workspace);
    if (!actor) return row;
    const repo = { namespace: row.repo_namespace, name: row.repo_name };
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    const filesRead = only === "packages" || (commit != null && commit === row.detected_commit);
    const [files, linked, deploying] = await Promise.all([
      filesRead ? null : this.readRoot(repo, actor, commit, row.root_dir),
      this.linkedPackage(row, actor),
      row.deployments_on == null && only !== "packages" ? this.deploymentsOn(row.id) : null,
    ]);
    if (files) {
      const found = files.commit ? detectKind(files.root) : null;
      set("detected_kind", found?.kind ?? null);
      set("detected_detail", found?.detail ?? null);
      set("detected_ecosystem", found?.ecosystem ?? null);
      set("detected_commit", files.commit);
    }
    if (linked !== undefined) set("linked_package", linked);
    if (deploying != null) set("deployments_on", deploying ? 1 : 0);
    if (sets.length === 0) return row;
    await this.db
      .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values, row.id)
      .run();
    return (await this.db.prepare("SELECT * FROM projects WHERE id = ?").bind(row.id).first<Row>()) ?? row;
  }

  /** The project's root at a commit: its names, and the few files detection reads. Commit '' when it has none. */
  private async readRoot(
    repo: { namespace: string; name: string },
    actor: User,
    commit: string | null,
    rootDir: string,
  ): Promise<{ commit: string; root: RootFiles } | null> {
    const client = reposClient(this.env.REPOS);
    const empty = { commit: "", root: { entries: [], text: {} } };
    const tree = await client.tree(repo, actor, commit, rootDir);
    if (!tree.ok) return null;
    const head = commit ?? tree.value.head?.hash ?? "";
    if (!head) return empty;
    const entries = tree.value.entries.map((entry) => (entry.kind === "tree" ? `${entry.name}/` : entry.name));
    const at = (name: string) => (rootDir ? `${rootDir}/${name}` : name);
    const names = [...MANIFESTS.filter((name) => entries.includes(name)), ...(entries.includes("go.mod") ? goFilesToRead(entries) : [])];
    const below = (dir: string) => client.tree(repo, actor, head, at(dir)).catch(() => null);
    const [texts, src, pub] = await Promise.all([
      Promise.all(
        names.map(async (name) => {
          const blob = await client.blob(repo, actor, head, at(name)).catch(() => null);
          return [name, blob?.ok ? (blob.value.text ?? "") : ""] as const;
        }),
      ),
      entries.includes("Cargo.toml") && entries.includes("src/") ? below("src") : null,
      entries.includes("composer.json") && entries.includes("public/") ? below("public") : null,
    ]);
    const list = (view: Awaited<ReturnType<typeof below>>) => (view?.ok ? view.value.entries.map((entry) => entry.name) : undefined);
    return { commit: head, root: { entries, text: Object.fromEntries(texts), src: list(src), public: list(pub) } };
  }

  /** A package other than a container image that the repository publishes, named; undefined when packages could not say. */
  private async linkedPackage(row: Row, actor: User): Promise<string | null | undefined> {
    const listed = await packagesClient(this.env.PACKAGES)
      .list(row.workspace, actor, { repoId: row.repo_id })
      .catch(() => null);
    if (!listed?.ok) return undefined;
    // An image is how an app ships too; it says nothing about being a library.
    const pkg = listed.value.find((p) => p.ecosystem !== "container");
    if (!pkg) return null;
    return `${ECOSYSTEM_NAME[pkg.ecosystem]} ${pkg.ecosystem === "npm" ? `@${pkg.workspace}/${pkg.name}` : pkg.name}`;
  }

  /** Whether Deployments are on for the project, asked of deployments once; after that it tells this service. */
  private async deploymentsOn(projectId: string): Promise<boolean | null> {
    const answer = await this.env.DEPLOYMENTS.fetch("https://deployments/rpc/is_enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    }).catch(() => null);
    if (!answer?.ok) return null;
    const value = (await answer.json().catch(() => null)) as unknown;
    return typeof value === "boolean" ? value : null;
  }

  // ---- Dependencies ------------------------------------------------------

  private async row(workspace: string, slug: string): Promise<Row | null> {
    return this.db
      .prepare("SELECT * FROM projects WHERE workspace = ? AND slug = ? AND repo_deleted_at IS NULL")
      .bind(workspace.toLowerCase(), slug.toLowerCase())
      .first<Row>();
  }

  /** A project's dependencies; for a viewer, only the projects whose repositories they can read. */
  private async links(projectId: string, viewer?: Viewer): Promise<Dependencies> {
    const [out, into] = await Promise.all([
      this.db
        .prepare(
          `SELECT p.slug, p.name, d.alias, d.source, p.repo_id, p.repo_namespace, p.repo_private FROM dependencies d JOIN projects p ON p.id = d.depends_on_id
           WHERE d.project_id = ? AND p.repo_deleted_at IS NULL ORDER BY p.name COLLATE NOCASE`,
        )
        .bind(projectId)
        .all<LinkRow>(),
      this.db
        .prepare(
          `SELECT p.slug, p.name, d.alias, d.source, p.repo_id, p.repo_namespace, p.repo_private FROM dependencies d JOIN projects p ON p.id = d.project_id
           WHERE d.depends_on_id = ? AND p.repo_deleted_at IS NULL ORDER BY p.name COLLATE NOCASE`,
        )
        .bind(projectId)
        .all<LinkRow>(),
    ]);
    const link = (r: LinkRow): DependencyLink => ({ slug: r.slug, name: r.name, as: r.alias, source: r.source });
    const shown = (r: LinkRow) => viewer === undefined || permission(viewer, repoRef(r)) != null;
    return { dependsOn: out.results.filter(shown).map(link), usedBy: into.results.filter(shown).map(link) };
  }

  /** Whether `from` already reaches `to` through dependencies. */
  private async reaches(from: string, to: string): Promise<boolean> {
    const seen = new Set<string>([from]);
    let frontier = [from];
    while (frontier.length > 0) {
      const marks = frontier.map(() => "?").join(", ");
      const next = await this.db
        .prepare(`SELECT depends_on_id AS id FROM dependencies WHERE project_id IN (${marks})`)
        .bind(...frontier)
        .all<{ id: string }>();
      frontier = [];
      for (const { id } of next.results) {
        if (id === to) return true;
        if (!seen.has(id)) {
          seen.add(id);
          frontier.push(id);
        }
      }
    }
    return false;
  }

  async dependencies(a: { workspace: string; slug: string; viewer: Viewer }): Promise<Result<Dependencies>> {
    const row = await this.row(a.workspace, a.slug);
    if (!row || !this.visible(row, a.viewer)) return fail("not_found", "There is no such project.");
    return ok(await this.links(row.id, a.viewer));
  }

  /** Records `row` using `target`, after the checks every way of declaring one shares. */
  private async declare(row: Row, target: Row, alias: string | null, source: "ui" | "file", by: string): Promise<Result<true>> {
    if (target.id === row.id) return fail("invalid", "A project cannot depend on itself.");
    if (alias != null && !ALIAS.test(alias)) {
      return fail("invalid", "The variable's name is capital letters, digits and underscores, such as API_URL.");
    }
    if (await this.reaches(target.id, row.id)) {
      return fail("conflict", `${target.slug} already depends on ${row.slug}, directly or through others; that would be a cycle.`);
    }
    const count = await this.db
      .prepare("SELECT COUNT(*) AS n FROM dependencies WHERE project_id = ?")
      .bind(row.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_DEPENDENCIES) return fail("invalid", `A project can depend on at most ${MAX_DEPENDENCIES} others.`);
    await this.db
      .prepare(
        `INSERT INTO dependencies (project_id, depends_on_id, alias, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, depends_on_id) DO UPDATE SET alias = excluded.alias, source = excluded.source`,
      )
      .bind(row.id, target.id, alias, source, by, now())
      .run();
    return ok(true);
  }

  async addDependency(a: { actor: User; workspace: string; slug: string; on: string; as: string | null }): Promise<Result<Dependencies>> {
    const [row, target] = await Promise.all([this.row(a.workspace, a.slug), this.row(a.workspace, a.on)]);
    if (!row) return fail("not_found", "There is no such project.");
    const allowed = this.changeable(row, a.actor, NEEDS.addDependency);
    if (!allowed.ok) return allowed;
    // A project the actor cannot read is not there for them to depend on.
    if (!target || !this.visible(target, a.actor)) return fail("not_found", `${a.workspace} has no project called ${a.on}.`);
    const existing = await this.db
      .prepare("SELECT source FROM dependencies WHERE project_id = ? AND depends_on_id = ?")
      .bind(row.id, target.id)
      .first<{ source: string }>();
    if (existing?.source === "file") return fail("conflict", "This dependency is declared in .g1t/project.yml; change it there.");
    const alias = a.as?.trim() ? a.as.trim().toUpperCase() : null;
    const done = await this.declare(row, target, alias, "ui", a.actor.username);
    if (!done.ok) return done;
    return ok(await this.links(row.id, a.actor));
  }

  async removeDependency(a: { actor: User; workspace: string; slug: string; on: string }): Promise<Result<Dependencies>> {
    const [row, target] = await Promise.all([this.row(a.workspace, a.slug), this.row(a.workspace, a.on)]);
    if (!row) return fail("not_found", "There is no such project.");
    const allowed = this.changeable(row, a.actor, NEEDS.removeDependency);
    if (!allowed.ok) return allowed;
    if (!target) return fail("not_found", "There is no such dependency.");
    const removed = await this.db
      .prepare("DELETE FROM dependencies WHERE project_id = ? AND depends_on_id = ? AND source = 'ui' RETURNING project_id")
      .bind(row.id, target.id)
      .first();
    if (!removed) return fail("conflict", "This dependency is declared in .g1t/project.yml, or does not exist; change the file.");
    return ok(await this.links(row.id, a.actor));
  }

  async graph(a: { projectId: string }): Promise<ProjectGraph> {
    const [out, into] = await Promise.all([
      this.db
        .prepare(
          `SELECT p.id, p.slug, p.workspace, d.alias FROM dependencies d JOIN projects p ON p.id = d.depends_on_id
           WHERE d.project_id = ? AND p.repo_deleted_at IS NULL`,
        )
        .bind(a.projectId)
        .all<NodeRow>(),
      this.db
        .prepare(
          `SELECT p.id, p.slug, p.workspace, d.alias FROM dependencies d JOIN projects p ON p.id = d.project_id
           WHERE d.depends_on_id = ? AND p.repo_deleted_at IS NULL`,
        )
        .bind(a.projectId)
        .all<NodeRow>(),
    ]);
    const node = (r: NodeRow) => ({ id: r.id, slug: r.slug, workspace: r.workspace, as: r.alias });
    return { dependsOn: out.results.map(node), usedBy: into.results.map(node) };
  }

  /** For the runner: each project on a repository, with what it uses and what uses it. */
  async contextForRepo(a: { repoId: string }): Promise<{ slug: string; name: string; dependencies: Dependencies }[]> {
    const rows = await this.db
      .prepare("SELECT * FROM projects WHERE repo_id = ? AND repo_deleted_at IS NULL")
      .bind(a.repoId)
      .all<Row>();
    return Promise.all(rows.results.map(async (row) => ({ slug: row.slug, name: row.name, dependencies: await this.links(row.id) })));
  }

  /**
   * A project's `.g1t/project.yml` at a commit of its default branch:
   *
   *     dependsOn:
   *       - project: api
   *         as: API_URL
   *
   * Its dependencies replace the ones the file declared before. Ones that
   * cannot be kept (an unknown project, a cycle) are left out.
   */
  private async syncFile(row: Row, commit: string): Promise<void> {
    const actor = await this.workspaceActor(row.workspace);
    if (!actor) return;
    const path = row.root_dir ? `${row.root_dir}/.g1t/project.yml` : ".g1t/project.yml";
    const blob = await reposClient(this.env.REPOS).blob({ namespace: row.repo_namespace, name: row.repo_name }, actor, commit, path);
    if (!blob.ok || blob.value.text == null) {
      // No file (any more): what it declared goes with it.
      await this.db.prepare("DELETE FROM dependencies WHERE project_id = ? AND source = 'file'").bind(row.id).run();
      return;
    }
    let declared: unknown[] = [];
    try {
      const parsed = parseYaml(blob.value.text) as { dependsOn?: unknown } | null;
      if (Array.isArray(parsed?.dependsOn)) declared = parsed.dependsOn;
    } catch (error) {
      console.error("could not read", path, "of", row.slug, error);
      return;
    }
    await this.db.prepare("DELETE FROM dependencies WHERE project_id = ? AND source = 'file'").bind(row.id).run();
    for (const entry of declared.slice(0, MAX_DEPENDENCIES)) {
      const item = entry as { project?: unknown; as?: unknown } | string;
      const on = typeof item === "string" ? item : typeof item?.project === "string" ? item.project : null;
      if (!on) continue;
      const target = await this.row(row.workspace, on);
      if (!target) continue;
      const alias = typeof item === "object" && typeof item.as === "string" ? item.as.trim().toUpperCase() : null;
      await this.declare(row, target, alias, "file", "g1t");
    }
  }

  /** Something happened to a repository's code or work: its projects are that much more active. */
  private async active(repoId: string, at: string, pushed: boolean): Promise<void> {
    const rows = await this.db
      .prepare("SELECT id, activity, active_at FROM projects WHERE repo_id = ?")
      .bind(repoId)
      .all<{ id: string; activity: number | null; active_at: string | null }>();
    if (rows.results.length === 0) return;
    await this.db.batch(
      rows.results.map((row) => {
        const next = raised(row.activity ?? 0, row.active_at, at);
        return pushed
          ? this.db
              .prepare("UPDATE projects SET activity = ?, active_at = ?, pushed_at = MAX(COALESCE(pushed_at, ''), ?) WHERE id = ?")
              .bind(next.score, next.at, at, row.id)
          : this.db.prepare("UPDATE projects SET activity = ?, active_at = ? WHERE id = ?").bind(next.score, next.at, row.id);
      }),
    );
  }

  async onEvent(event: G1tEvent): Promise<void> {
    if (ACTIVE.has(event.type)) {
      const repoId = event.repoId ?? ("repoId" in event.data ? (event.data as { repoId?: string }).repoId : undefined);
      if (repoId) await this.active(repoId, event.time, event.type === "git.push");
    }
    if (event.type === "workspace.renamed") {
      const current = await currentWorkspaceSlug(this.env.IDENTITY, event.data);
      const statements = renameStatements(staleSlugs(event.data, current), current);
      if (statements.length) await this.db.batch(statements.map(({ sql, params }) => this.db.prepare(sql).bind(...params)));
      return;
    }
    const move = repoMove(event);
    if (move) {
      const current = await currentMovedPath(this.env.REPOS, move);
      const stale = staleMovedPaths(move, current);
      if (stale.length === 0) return;
      const statements = moveStatements(stale, current, move.repoId);
      await this.db.batch(statements.map(({ sql, params }) => this.db.prepare(sql).bind(...params)));
      // A project whose slug the destination already had moves under a free one.
      const query = strandedQuery(stale, current, move.repoId);
      if (!query) return;
      const workspace = current.split("/")[0]!;
      const stranded = await this.db.prepare(query.sql).bind(...query.params).all<Row>();
      for (const row of stranded.results) {
        const slug = await this.freeSlug(workspace, row.slug);
        console.log("project", row.id, "moved to", workspace, "as", slug, "since", row.slug, "was taken");
        await this.db
          .prepare("UPDATE projects SET workspace = ?, slug = ?, repo_namespace = ?, updated_at = ? WHERE id = ?")
          .bind(workspace, slug, workspace, now(), row.id)
          .run();
      }
      return;
    }
    if (event.type === "repo.deleted") {
      // Hidden, not gone: a restore brings its projects back as they were.
      await this.db
        .prepare("UPDATE projects SET repo_deleted_at = COALESCE(repo_deleted_at, ?) WHERE repo_id = ?")
        .bind(now(), event.data.repoId)
        .run();
      return;
    }
    if (event.type === "repo.restored") {
      await this.db
        .prepare("UPDATE projects SET repo_deleted_at = NULL, repo_private = ? WHERE repo_id = ?")
        .bind(event.data.isPrivate ? 1 : 0, event.data.repoId)
        .run();
      return;
    }
    if (event.type === "repo.purged") {
      const ids = "SELECT id FROM projects WHERE repo_id = ?1";
      await this.db.batch([
        this.db
          .prepare(`DELETE FROM dependencies WHERE project_id IN (${ids}) OR depends_on_id IN (${ids})`)
          .bind(event.data.repoId),
        // Pins and visits of what is gone go with it.
        this.db.prepare(`DELETE FROM pins WHERE project_id IN (${ids})`).bind(event.data.repoId),
        this.db.prepare(`DELETE FROM visits WHERE project_id IN (${ids})`).bind(event.data.repoId),
        this.db.prepare("DELETE FROM projects WHERE repo_id = ?").bind(event.data.repoId),
      ]);
      return;
    }
    if (event.type === "repo.updated" || event.type === "repo.visibility_changed") {
      // Who may see its projects follows who may see the repository.
      await this.db
        .prepare("UPDATE projects SET repo_private = ? WHERE repo_id = ?")
        .bind(event.data.isPrivate ? 1 : 0, event.data.repoId)
        .run();
      if (event.type === "repo.updated") {
        // Projects without a description of their own show the repository's.
        // Asked of repos, so changes delivered out of order end the same.
        const repo = await this.repoById(event.data.repoId);
        if (repo) {
          await this.db
            .prepare("UPDATE projects SET repo_description = ? WHERE repo_id = ?")
            .bind(repo.description ?? null, event.data.repoId)
            .run();
        }
      }
      return;
    }
    if (event.type === "repo.archived" || event.type === "repo.unarchived") {
      // Asked of repos, so changes delivered out of order end the same.
      const repo = await this.repoById(event.data.repoId);
      const archivedAt = repo ? (repo.archivedAt ?? null) : event.data.archived ? now() : null;
      await this.db.prepare("UPDATE projects SET repo_archived_at = ? WHERE repo_id = ?").bind(archivedAt, event.data.repoId).run();
      return;
    }
    if (event.type === "repo.default_branch_changed") {
      // Asked of repos, so changes delivered out of order end the same.
      const repo = await this.repoById(event.data.repoId);
      await this.db
        .prepare("UPDATE projects SET default_branch = ? WHERE repo_id = ?")
        .bind(repo?.defaultBranch ?? event.data.to, event.data.repoId)
        .run();
      // Another branch has other files: they are read again from its head.
      const rows = await this.db.prepare("SELECT * FROM projects WHERE repo_id = ?").bind(event.data.repoId).all<Row>();
      for (const row of rows.results) await this.detect({ ...row, detected_commit: null });
      return;
    }
    if (
      (event.type === "package.published" || event.type === "package.deleted" || event.type === "package.version_deleted") &&
      event.data.repoId
    ) {
      const rows = await this.db.prepare("SELECT * FROM projects WHERE repo_id = ?").bind(event.data.repoId).all<Row>();
      for (const row of rows.results) await this.detect(row, null, "packages");
      return;
    }
    if (event.type === "workspace.deleting") {
      // Hidden, not gone: every project it shows, including any building
      // from a repository it transferred away, until staff restore it or it
      // is purged. Those already hidden stay as they were.
      if (isProtectedWorkspace(event.data.slug)) return;
      const at = now();
      await this.db
        .prepare(
          "UPDATE projects SET repo_deleted_at = ?1, workspace_deleted_at = ?1 WHERE workspace = ?2 AND repo_deleted_at IS NULL",
        )
        .bind(at, event.data.slug.toLowerCase())
        .run();
      return;
    }
    if (event.type === "workspace.restored") {
      await this.db
        .prepare(
          "UPDATE projects SET repo_deleted_at = NULL, workspace_deleted_at = NULL WHERE workspace = ? AND workspace_deleted_at IS NOT NULL",
        )
        .bind(event.data.slug.toLowerCase())
        .run();
      return;
    }
    if (event.type === "workspace.deleted") {
      // Its own repositories' projects go with them (`repo.purged`); any
      // building from a repository it transferred away goes now. It is not
      // backfilled again.
      const slug = event.data.slug.toLowerCase();
      const ids = "SELECT id FROM projects WHERE workspace = ?1";
      await this.db.batch([
        this.db.prepare(`DELETE FROM dependencies WHERE project_id IN (${ids}) OR depends_on_id IN (${ids})`).bind(slug),
        this.db.prepare(`DELETE FROM pins WHERE project_id IN (${ids})`).bind(slug),
        this.db.prepare(`DELETE FROM visits WHERE project_id IN (${ids})`).bind(slug),
        this.db.prepare("DELETE FROM projects WHERE workspace = ?").bind(slug),
        this.db.prepare("DELETE FROM backfilled WHERE workspace = ?").bind(slug),
      ]);
      return;
    }
    if (event.type === "git.push" && event.data.defaultBranch) {
      const rows = await this.db.prepare("SELECT * FROM projects WHERE repo_id = ?").bind(event.data.repoId).all<Row>();
      for (const row of rows.results) {
        await this.syncFile(row, event.data.after);
        await this.detect(row, event.data.after);
      }
      return;
    }
    if (event.type !== "repo.created") return;
    const actor = await this.workspaceActor(event.data.namespace);
    if (!actor) return;
    const repo = await reposClient(this.env.REPOS).get({ namespace: event.data.namespace, name: event.data.name }, actor);
    if (repo.ok) await this.ensureFor(repo.value, event.actor ?? "g1t");
  }
}

/** One RPC method's answer. */
async function answer(service: Projects, method: string, args: any): Promise<Response> {
  switch (method) {
    case "list":
      return Response.json(await service.list(args));
    case "get":
      return Response.json(await service.get(args));
    case "by_repo":
      return Response.json(await service.byRepo(args));
    case "count":
      return Response.json(await service.count(args));
    case "create":
      return Response.json(await service.create(args));
    case "update":
      return Response.json(await service.update(args));
    case "deployments_changed":
      await service.deploymentsChanged(args);
      return Response.json(null);
    case "dependencies":
      return Response.json(await service.dependencies(args));
    case "add_dependency":
      return Response.json(await service.addDependency(args));
    case "remove_dependency":
      return Response.json(await service.removeDependency(args));
    case "graph":
      return Response.json(await service.graph(args));
    case "shortcuts":
      return Response.json(await service.shortcuts(args));
    case "pin":
      return Response.json(await service.pin(args));
    case "unpin":
      return Response.json(await service.unpin(args));
    case "reorder_pins":
      return Response.json(await service.reorderPins(args));
    case "visited":
      await service.visited(args);
      return Response.json(null);
    case "context_for_repo":
      return Response.json(await service.contextForRepo(args));
    default:
      return new Response("Unknown method\n", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (request.method !== "POST" || !match) return new Response("Not found\n", { status: 404 });
    // A replica near the caller when it asks for one (@g1t/contracts d1.ts).
    const opened = openD1(env.DB, request);
    const service = new Projects(Object.create(env, { DB: { value: opened.db } }) as Env, (work) => ctx.waitUntil(work));
    const args = (await request.json().catch(() => ({}))) as any;
    return opened.finish(await answer(service, match[1], args));
  },

  async queue(batch: MessageBatch<G1tEvent>, env: Env): Promise<void> {
    const service = new Projects(env);
    for (const message of batch.messages) {
      try {
        await service.onEvent(message.body);
        message.ack();
      } catch (error) {
        console.error("projects could not handle", message.body.type, error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, G1tEvent>;
