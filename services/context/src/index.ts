/**
 * The context service: the context hub's catalog, search and scorecards.
 *
 * - **Catalog.** What a workspace builds and runs, as entities (projects,
 *   apps, APIs, packages, languages, owners, environments, integrations,
 *   docs) and relations between them. Built by itself: on every push to a
 *   project's default branch it reads the project's manifests and docs
 *   whose blobs changed (at most `MAX_READS` files a push) and joins them
 *   with what projects, deployments, identity and integrations know.
 *   Rebuilding is idempotent: entity ids are hashes of what they are.
 * - **Search.** Docs, catalog entities, issues, pull requests and kept
 *   memory, embedded with Workers AI into a Vectorize index whose rows
 *   carry their workspace, project and whether they are private, so a
 *   query reads only what its reader may. Matching words in D1 answers
 *   when the index cannot, and fills in after it.
 * - **Backfill.** Once per workspace (and again on request): the catalog
 *   for every project, memory candidates from docs, manifests and the last
 *   merged pull requests, and the search index filled. One queued job per
 *   project, capped and metered.
 * - **Run context.** The Context section every g1t agent run starts with.
 *
 * Reached through service bindings: `POST /rpc/<method>`.
 */

import {
  type Backfill,
  type CaptureItem,
  type Catalog,
  type ContextStatus,
  type Entity,
  type EntityDetail,
  type EntityKind,
  ENTITY_KINDS,
  type G1tEvent,
  type Memory,
  type Project,
  type ProjectDeploys,
  type RelationKind,
  type RunContext,
  type Scorecard,
  type SearchHit,
  type SearchKind,
  type SearchResult,
  type ServiceBinding,
  type User,
  type Viewer,
  ComputeGate,
  billingClient,
  embeddingEstimateMicros,
  localRefusal,
  currentMovedPath,
  currentWorkspaceSlug,
  repoMove,
  staleMovedPaths,
  deploymentsClient,
  fail,
  granted,
  identityClient,
  integrationsClient,
  memoryReviewClient,
  ok,
  projectsClient,
  reposClient,
  securityClient,
  staleSlugs,
  workClient,
  type Result,
} from "@g1t/contracts";

import { assemble, authorsOf, integrationEntities, type EntityDraft, type FileRecord, type ProjectInput, type Surroundings } from "./assemble";
import { extract, interesting, type FileFacts } from "./extract";
import { composeRunContext, type ContextNote, type ProjectContext } from "./runcontext";
import { evaluate } from "./scorecards";
import { allowedKinds, countVisible, indexFilter, memoryReadable, merge, projectReadable, readable, runMemoryReadable, type IndexMeta, type Reader } from "./visibility";

type Job =
  | { type: "backfill_project"; workspace: string; slug: string }
  | { type: "backfill_memory"; workspace: string };

type Env = {
  DB: D1Database;
  AI?: Ai;
  VECTORS?: Vectorize;
  JOBS: Queue<Job>;
  REPOS: ServiceBinding;
  PROJECTS: ServiceBinding;
  WORK: ServiceBinding;
  IDENTITY: ServiceBinding;
  DEPLOYMENTS: ServiceBinding;
  INTEGRATIONS: ServiceBinding;
  SECURITY?: ServiceBinding;
  /** Told the month's embedding cost so far, which it charges once the month is over. */
  BILLING?: ServiceBinding;
};

/** Workers AI's embedding model: 768 dimensions, as the index was made with. */
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
/** What it costs, in millionths of a dollar per token ($0.067 per million). */
const MICROS_PER_TOKEN = 0.067;
/** Past this many tokens in a month, a workspace's new text goes unindexed; text search still finds it. */
const MONTHLY_TOKENS = 20_000_000;
/** The most text embedded for one row; the model reads 512 tokens. */
const EMBED_CHARS = 2000;
const EMBED_BATCH = 50;
/** The most files read from a repository for one project's rebuild. */
const MAX_READS = 15;
/** Of them, workflows. */
const MAX_WORKFLOW_READS = 3;
/** The most projects one push rebuilds. */
const MAX_PROJECTS_PER_PUSH = 5;
/** A backfill's caps. */
const BACKFILL_PROJECTS = 50;
const BACKFILL_PULLS = 20;
const BACKFILL_ITEMS = 30;
/** A backfill still marked running after this long is taken to have died. */
const BACKFILL_STALE_MS = 30 * 60 * 1000;
const ITEM_CHARS = 4000;
const SNIPPET_CHARS = 280;
/** Kinds every project shares rather than owns. */
const SHARED: Set<EntityKind> = new Set(["owner", "language", "integration"]);

/** One compute gate per isolate, so entitlements are kept between calls. */
let computeGate: ComputeGate | null = null;
function gateFor(billing: ServiceBinding): ComputeGate {
  computeGate ??= new ComputeGate(billing);
  return computeGate;
}

const now = () => new Date().toISOString();
const month = () => now().slice(0, 7);

function isMember(viewer: Viewer, workspace: string): boolean {
  return !!viewer?.workspaces?.some((m) => m.slug === workspace.toLowerCase());
}

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An entity's id: the same for the same thing, however often it is rebuilt. */
export async function entityId(workspace: string, kind: string, key: string): Promise<string> {
  return `ent_${(await sha(`${workspace}\u0000${kind}\u0000${key.toLowerCase()}`)).slice(0, 24)}`;
}

function snippet(text: string | null | undefined): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length <= SNIPPET_CHARS ? line : `${line.slice(0, SNIPPET_CHARS - 1)}…`;
}

type EntityRow = {
  id: string;
  workspace: string;
  kind: EntityKind;
  key: string;
  name: string;
  summary: string | null;
  project_id: string | null;
  project: string | null;
  repo_id: string | null;
  private: number;
  data: string;
  source: string;
  ref: string | null;
  updated_at: string;
};

type ItemRow = {
  id: string;
  workspace: string;
  kind: "doc" | "issue" | "pull";
  entity_id: string | null;
  project: string | null;
  private: number;
  title: string;
  text: string;
  url: string | null;
  by: string | null;
  updated_at: string;
};

function toEntity(row: EntityRow): Entity {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data);
  } catch {}
  return {
    id: row.id,
    workspace: row.workspace,
    kind: row.kind,
    key: row.key,
    name: row.name,
    summary: row.summary,
    project: row.project,
    private: !!row.private,
    data,
    source: row.source,
    ref: row.ref,
    updatedAt: row.updated_at,
  };
}

/** Where a memory came from, in a few words. */
function memorySource(memory: Memory): string {
  const ref = memory.source.reference ?? "";
  const number = memory.source.number;
  switch (memory.source.kind) {
    case "doc":
      return ref.split(":").slice(2).join(":") || "a doc";
    case "review":
      return number ? `review on #${number}` : "a review";
    case "pr":
      return number ? `#${number}` : "a merged pull request";
    case "run":
      return number ? `agent run on #${number}` : "an agent run";
    default:
      return `added by ${memory.createdBy}`;
  }
}

/** What one workspace's rebuilds share: asked of other services once. */
class WorkspaceCache {
  private members?: Promise<string[]>;
  private deploys?: Promise<ProjectDeploys[]>;
  private connections?: Promise<Surroundings["integrations"]>;
  constructor(
    private readonly env: Env,
    readonly workspace: string,
    readonly actor: User,
  ) {}

  memberNames(): Promise<string[]> {
    this.members ??= identityClient(this.env.IDENTITY)
      .listMembers(this.workspace, this.actor)
      .then((found) => (found.ok ? found.value.map((member) => member.username) : []))
      .catch(() => []);
    return this.members;
  }

  deployments(): Promise<ProjectDeploys[]> {
    this.deploys ??= deploymentsClient(this.env.DEPLOYMENTS)
      .overview(this.workspace, this.actor)
      .then((found) => (found.ok ? found.value : []))
      .catch(() => []);
    return this.deploys;
  }

  integrations(): Promise<Surroundings["integrations"]> {
    this.connections ??= integrationsClient(this.env.INTEGRATIONS)
      .list(this.workspace, this.actor)
      .then((found) =>
        found.ok
          ? found.value
              .filter((connection) => connection.kind !== "models")
              .map((connection) => ({
                id: connection.id,
                provider: connection.provider,
                name: connection.name,
                kind: connection.kind,
                repo: connection.config.repo ?? null,
              }))
          : [],
      )
      .catch(() => []);
    return this.connections;
  }
}

type ScanStats = { entities: number; candidates: number; kept: number; indexed: number };

class Context {
  constructor(private readonly env: Env) {}

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

  // ---- Search index --------------------------------------------------------

  /**
   * Whether semantic search is open to a workspace: embeddings are compute,
   * so only on a paid plan or the trial (`localRefusal`). Text search
   * answers for everyone else. Closed when billing cannot say, which
   * leaves text search; open where there is no billing service at all.
   */
  private async semanticOpen(workspace: string): Promise<boolean> {
    if (!this.env.BILLING) return true;
    const ent = await gateFor(this.env.BILLING).entitlements(workspace);
    return ent != null && localRefusal(ent, "embedding", false) == null;
  }

  /**
   * Embeds and stores rows in the search index, within the workspace's
   * monthly allowance, reserving what it costs with billing first and
   * settling what it did. Never throws.
   */
  private async index(workspace: string, rows: { id: string; text: string; meta: IndexMeta }[]): Promise<number> {
    const { AI, VECTORS } = this.env;
    if (!AI || !VECTORS || rows.length === 0) return 0;
    if (!(await this.semanticOpen(workspace))) return 0;
    let reservation: string | null = null;
    let spentTokens = 0;
    if (this.env.BILLING) {
      const estimate = rows.reduce((sum, row) => sum + Math.ceil(Math.min(row.text.length, EMBED_CHARS) / 4), 0);
      const admitted = await gateFor(this.env.BILLING).admit({
        workspace,
        repo: { namespace: workspace, name: rows[0].meta.project ?? "" },
        public: rows.every((row) => !row.meta.private),
        kind: "embedding",
        estimateMicros: embeddingEstimateMicros(estimate),
      });
      if (!admitted.ok) {
        console.log("embeddings not started for", workspace, admitted.code, admitted.message);
        return 0;
      }
      reservation = admitted.reservation?.id ?? null;
    }
    try {
      const used = await this.db
        .prepare("SELECT tokens FROM usage WHERE workspace = ? AND month = ?")
        .bind(workspace, month())
        .first<{ tokens: number }>();
      if ((used?.tokens ?? 0) >= MONTHLY_TOKENS) return 0;
      let stored = 0;
      for (let at = 0; at < rows.length; at += EMBED_BATCH) {
        const batch = rows.slice(at, at + EMBED_BATCH);
        const texts = batch.map((row) => row.text.slice(0, EMBED_CHARS));
        const embedded = (await AI.run(EMBED_MODEL, { text: texts })) as { data?: number[][] };
        const vectors = (embedded.data ?? []).map((values, i) => ({
          id: batch[i].id,
          values,
          metadata: batch[i].meta as unknown as Record<string, VectorizeVectorMetadata>,
        }));
        if (vectors.length) await VECTORS.upsert(vectors);
        stored += vectors.length;
        const tokens = (rows: { text: string }[]) => rows.reduce((sum, row) => sum + Math.ceil(row.text.length / 4), 0);
        const all = texts.map((text) => ({ text }));
        spentTokens += tokens(all);
        await this.meter(workspace, tokens(all), tokens(all.filter((_, i) => batch[i].meta.private)));
      }
      return stored;
    } catch (error) {
      console.error("could not index", rows.length, "rows for", workspace, error);
      return 0;
    } finally {
      if (reservation && this.env.BILLING) {
        await gateFor(this.env.BILLING).settle(reservation, embeddingEstimateMicros(spentTokens));
      }
    }
  }

  /** Drops a repository's rows kept under any of `workspaces`, and their index entries. */
  private async forgetRepo(repoId: string, workspaces: string[]): Promise<void> {
    const marks = workspaces.map(() => "?").join(", ");
    const items = await this.db
      .prepare(`SELECT id FROM items WHERE repo_id = ? AND workspace IN (${marks})`)
      .bind(repoId, ...workspaces)
      .all<{ id: string }>();
    for (let i = 0; i < items.results.length; i += 100) {
      await this.unindex(items.results.slice(i, i + 100).map((row) => row.id));
    }
    const projects = `SELECT project_id FROM entities WHERE repo_id = ? AND workspace IN (${marks}) AND project_id IS NOT NULL`;
    await this.db.batch([
      this.db.prepare(`DELETE FROM relations WHERE project_id IN (${projects})`).bind(repoId, ...workspaces),
      this.db.prepare(`DELETE FROM files WHERE project_id IN (${projects})`).bind(repoId, ...workspaces),
      this.db.prepare(`DELETE FROM items WHERE repo_id = ? AND workspace IN (${marks})`).bind(repoId, ...workspaces),
      this.db.prepare(`DELETE FROM scans WHERE repo_id = ? AND workspace IN (${marks})`).bind(repoId, ...workspaces),
      this.db.prepare(`DELETE FROM entities WHERE repo_id = ? AND workspace IN (${marks})`).bind(repoId, ...workspaces),
    ]);
  }

  /** A deleted workspace's hub: everything but its usage, which billing has already read. */
  private async forgetWorkspace(slug: string): Promise<void> {
    const items = await this.db.prepare("SELECT id FROM items WHERE workspace = ?").bind(slug).all<{ id: string }>();
    for (let i = 0; i < items.results.length; i += 100) {
      await this.unindex(items.results.slice(i, i + 100).map((row) => row.id));
    }
    await this.db.batch(
      ["items", "relations", "entities", "scans", "backfills"].map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE workspace = ?`).bind(slug),
      ),
    );
  }

  private async unindex(ids: string[]): Promise<void> {
    if (!this.env.VECTORS || ids.length === 0) return;
    try {
      await this.env.VECTORS.deleteByIds(ids);
    } catch (error) {
      console.error("could not take", ids.length, "rows out of the index", error);
    }
  }

  /**
   * Records what embedding cost. Of it, `billableTokens` are private
   * text's: public repositories' text and searches are never charged.
   * Billing is told the month's billable total, which it charges at cost
   * plus its margin once the month is over (its `embedding_tokens` meter).
   * A failure to tell billing only delays it: the next call sends the
   * whole month again.
   */
  private async meter(workspace: string, tokens: number, billableTokens = 0): Promise<void> {
    const total = await this.db
      .prepare(
        `INSERT INTO usage (workspace, month, tokens, cost_micros, billable_micros) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (workspace, month) DO UPDATE SET
           tokens = tokens + ?3, cost_micros = cost_micros + ?4, billable_micros = billable_micros + ?5
         RETURNING billable_micros`,
      )
      .bind(workspace, month(), tokens, Math.ceil(tokens * MICROS_PER_TOKEN), billableTokens * MICROS_PER_TOKEN)
      .first<{ billable_micros: number }>();
    if (this.env.BILLING && total && billableTokens > 0) {
      await billingClient(this.env.BILLING)
        .notePending(workspace, "context", Math.ceil(total.billable_micros))
        .catch((error) => console.error("could not tell billing what embedding cost", workspace, error));
    }
  }

  /**
   * A query's embedding, for semantic search. Too small to reserve one by
   * one (a few hundred tokens, a fraction of a cent): it needs the plan or
   * the trial, as indexing does, and is metered with the month's usage.
   */
  private async embedQuery(workspace: string, query: string): Promise<number[] | null> {
    if (!this.env.AI || !this.env.VECTORS) return null;
    if (!(await this.semanticOpen(workspace))) return null;
    try {
      const embedded = (await this.env.AI.run(EMBED_MODEL, { text: [query.slice(0, EMBED_CHARS)] })) as { data?: number[][] };
      await this.meter(workspace, Math.ceil(query.length / 4));
      return embedded.data?.[0] ?? null;
    } catch (error) {
      console.error("could not embed a query", error);
      return null;
    }
  }

  // ---- Building the catalog --------------------------------------------------

  /** The files of a project worth reading, with their blobs, found in a few tree reads. */
  private async candidates(project: Project, actor: User, ref: string): Promise<{ files: { path: string; hash: string }[]; siblings: string[]; head: string | null } | null> {
    if (project.source.kind !== "hosted") return null;
    const repos = reposClient(this.env.REPOS);
    const { repo, rootDir: root } = project.source;
    const at = (path: string) => [root, path].filter(Boolean).join("/");
    const top = await repos.tree(repo, actor, ref, root);
    if (!top.ok) return null;
    const files: { path: string; hash: string }[] = [];
    const siblings = top.value.entries.map((entry) => entry.name);
    const blobs = (entries: { name: string; hash: string; kind: string }[], dir: string) => {
      for (const entry of entries) {
        if (entry.kind !== "blob" && entry.kind !== "exec") continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (interesting(path)) files.push({ path, hash: entry.hash });
      }
    };
    blobs(top.value.entries, "");
    const dirs = new Set(top.value.entries.filter((entry) => entry.kind === "tree").map((entry) => entry.name));
    const look = async (dir: string) => {
      const found = await repos.tree(repo, actor, ref, at(dir)).catch(() => null);
      return found?.ok ? found.value.entries : [];
    };
    for (const dir of ["docs", "doc", "runbooks"]) if (dirs.has(dir)) blobs(await look(dir), dir);
    for (const dir of [".g1t", ".github"]) {
      if (!dirs.has(dir)) continue;
      const inside = await look(dir);
      blobs(inside, dir);
      if (inside.some((entry) => entry.name === "workflows" && entry.kind === "tree")) blobs(await look(`${dir}/workflows`), `${dir}/workflows`);
    }
    return { files, siblings, head: top.value.head?.hash ?? null };
  }

  /**
   * Builds one project's place in the catalog from its default branch (or
   * `commit`), reading only files whose blobs changed unless `force`.
   * Indexes what changed and sends what its docs say to memory.
   */
  async scan(project: Project, cache: WorkspaceCache, commit: string | null, force: boolean): Promise<ScanStats> {
    const stats: ScanStats = { entities: 0, candidates: 0, kept: 0, indexed: 0 };
    if (project.source.kind !== "hosted") return stats;
    const { repo, repoId, rootDir, defaultBranch } = project.source;
    const ref = commit ?? defaultBranch;
    const found = await this.candidates(project, cache.actor, ref);
    if (!found) return stats;
    const workspace = project.workspace;

    // What each file says: stored for unchanged blobs, read for the rest.
    const stored = new Map(
      (
        await this.db.prepare("SELECT path, hash, facts FROM files WHERE project_id = ?").bind(project.id).all<{ path: string; hash: string; facts: string }>()
      ).results.map((row) => [row.path, row]),
    );
    const files: FileRecord[] = [];
    const changed: string[] = [];
    const writes: D1PreparedStatement[] = [];
    let reads = 0;
    let workflowReads = 0;
    const repos = reposClient(this.env.REPOS);
    for (const file of found.files) {
      const before = stored.get(file.path);
      const workflow = file.path.includes("/workflows/");
      const fresh = before && before.hash === file.hash && !force;
      const canRead = reads < MAX_READS && (!workflow || workflowReads < MAX_WORKFLOW_READS);
      if (fresh || !canRead) {
        if (before) files.push({ path: file.path, facts: JSON.parse(before.facts) as FileFacts });
        continue;
      }
      reads++;
      if (workflow) workflowReads++;
      const blob = await repos.blob(repo, cache.actor, found.head ?? ref, [rootDir, file.path].filter(Boolean).join("/")).catch(() => null);
      if (!blob?.ok || blob.value.text == null) continue;
      const facts = extract(file.path, blob.value.text, { project: project.name, siblings: found.siblings });
      files.push({ path: file.path, facts });
      changed.push(file.path);
      writes.push(
        this.db
          .prepare(
            `INSERT INTO files (project_id, path, hash, facts, read_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (project_id, path) DO UPDATE SET hash = excluded.hash, facts = excluded.facts, read_at = excluded.read_at`,
          )
          .bind(project.id, file.path, file.hash, JSON.stringify(facts), now()),
      );
    }
    const present = new Set(found.files.map((file) => file.path));
    for (const path of stored.keys()) {
      if (!present.has(path)) writes.push(this.db.prepare("DELETE FROM files WHERE project_id = ? AND path = ?").bind(project.id, path));
    }

    // What g1t knows about it besides its files.
    const [members, deploys, integrations, graph, log] = await Promise.all([
      cache.memberNames(),
      cache.deployments(),
      cache.integrations(),
      projectsClient(this.env.PROJECTS).graph(project.id).catch(() => ({ dependsOn: [], usedBy: [] })),
      repos.log(repo, cache.actor, found.head ?? ref, 100).catch(() => null),
    ]);
    const deploy = deploys.find((d) => d.slug === project.slug) ?? null;
    const around: Surroundings = {
      owners: authorsOf(log?.ok ? log.value : [], members),
      dependsOn: graph.dependsOn.map((dep) => ({ slug: dep.slug, as: dep.as })),
      deploy: deploy
        ? {
            enabled: deploy.enabled,
            production: deploy.production ? { url: deploy.production.url, commit: deploy.production.commit, deployedAt: deploy.production.deployedAt } : null,
            previews: deploy.previews,
            latest: deploy.latest ? { status: deploy.latest.status, kind: deploy.latest.kind, error: deploy.latest.error, createdAt: deploy.latest.createdAt } : null,
          }
        : null,
      integrations,
    };
    const input: ProjectInput = {
      id: project.id,
      workspace,
      slug: project.slug,
      name: project.name,
      description: project.description,
      private: project.private,
      repoId,
      repo,
      rootDir,
      defaultBranch,
    };
    const built = assemble(input, files, around);
    const drafts: EntityDraft[] = [...built.entities, ...integrationEntities(integrations)];

    // Entities: upserted; the project's own that it no longer has, removed.
    const previous = new Map(
      (
        await this.db
          .prepare("SELECT id, name, summary FROM entities WHERE workspace = ? AND (project_id = ? OR project_id IS NULL)")
          .bind(workspace, project.id)
          .all<{ id: string; name: string; summary: string | null }>()
      ).results.map((row) => [row.id, row]),
    );
    const ids: string[] = [];
    const toIndex: { id: string; text: string; meta: IndexMeta }[] = [];
    const at = now();
    for (const draft of drafts) {
      const id = await entityId(workspace, draft.kind, draft.key);
      ids.push(id);
      const shared = SHARED.has(draft.kind);
      const source = draft.kind === "app" || draft.kind === "environment" ? "deployments" : draft.kind === "integration" ? "integrations" : "scan";
      writes.push(
        this.db
          .prepare(
            `INSERT INTO entities (id, workspace, kind, key, name, summary, project_id, project, repo_id, private, data, source, ref, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (workspace, kind, key) DO UPDATE SET name = excluded.name, summary = excluded.summary,
               project_id = excluded.project_id, project = excluded.project, repo_id = excluded.repo_id, private = excluded.private,
               data = excluded.data, source = excluded.source, ref = excluded.ref, updated_at = excluded.updated_at`,
          )
          .bind(
            id,
            workspace,
            draft.kind,
            draft.key,
            draft.name,
            draft.summary,
            shared ? null : project.id,
            shared ? null : project.slug,
            shared ? null : repoId,
            shared ? 0 : project.private ? 1 : 0,
            JSON.stringify(draft.data),
            source,
            draft.ref,
            at,
          ),
      );
      const before = previous.get(id);
      if (force || !before || before.name !== draft.name || before.summary !== draft.summary) {
        toIndex.push({
          id,
          text: `${draft.kind} ${draft.name}. ${draft.summary ?? ""}`,
          meta: {
            workspace,
            kind: draft.kind,
            project: shared ? "" : project.slug,
            private: shared ? false : project.private,
            title: draft.name,
            snippet: snippet(draft.summary),
            url: draft.ref ?? "",
            source: "catalog",
            by: "",
            at,
          },
        });
      }
    }
    const gone = (
      await this.db
        .prepare("SELECT id FROM entities WHERE project_id = ? AND id NOT IN (SELECT value FROM json_each(?))")
        .bind(project.id, JSON.stringify(ids))
        .all<{ id: string }>()
    ).results.map((row) => row.id);
    if (gone.length) {
      writes.push(this.db.prepare("DELETE FROM entities WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(gone)));
      writes.push(this.db.prepare("DELETE FROM items WHERE entity_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(gone)));
    }

    // Relations: the project's own, replaced whole.
    writes.push(this.db.prepare("DELETE FROM relations WHERE project_id = ?").bind(project.id));
    for (const relation of built.relations) {
      const [from, to] = await Promise.all([entityId(workspace, relation.from.kind, relation.from.key), entityId(workspace, relation.to.kind, relation.to.key)]);
      writes.push(
        this.db
          .prepare("INSERT OR REPLACE INTO relations (workspace, from_id, kind, to_id, project_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(workspace, from, relation.kind, to, project.id, at),
      );
    }

    // Docs that changed: their pieces, for search.
    const repoPath = `/${repo.namespace}/${repo.name}`;
    const chunkIds: string[] = [];
    for (const file of files) {
      const doc = file.facts.doc;
      if (!doc || (!changed.includes(file.path) && !force)) continue;
      const docId = await entityId(workspace, "doc", `${project.slug}:${doc.path}`);
      writes.push(this.db.prepare("DELETE FROM items WHERE entity_id = ?").bind(docId));
      const url = `${repoPath}/blob/${defaultBranch}/${[rootDir, doc.path].filter(Boolean).join("/")}`;
      doc.chunks.forEach((text, i) => {
        const id = `${docId}:${i}`;
        chunkIds.push(id);
        writes.push(
          this.db
            .prepare(
              `INSERT OR REPLACE INTO items (id, workspace, kind, entity_id, project_id, project, repo_id, private, title, text, url, by, updated_at)
               VALUES (?, ?, 'doc', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
            )
            .bind(id, workspace, docId, project.id, project.slug, repoId, project.private ? 1 : 0, `${doc.title} (${doc.path})`, text, url, at),
        );
        toIndex.push({
          id,
          text: `${doc.title}\n${text}`,
          meta: { workspace, kind: "doc", project: project.slug, private: project.private, title: `${doc.title} (${doc.path})`, snippet: snippet(text), url, source: doc.path, by: "", at },
        });
      });
    }
    writes.push(
      this.db
        .prepare(
          `INSERT INTO scans (project_id, workspace, repo_id, "commit", tests, scanned_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id) DO UPDATE SET workspace = excluded.workspace, "commit" = excluded."commit", tests = excluded.tests, scanned_at = excluded.scanned_at`,
        )
        .bind(project.id, workspace, repoId, found.head, built.tests ? 1 : 0, at),
    );
    for (let i = 0; i < writes.length; i += 50) await this.db.batch(writes.slice(i, i + 50));
    await this.unindex(gone);
    stats.entities = drafts.length;
    stats.indexed = await this.index(workspace, toIndex);

    // What changed files say worth remembering, as memory candidates.
    const items: CaptureItem[] = built.hints
      .filter((hint) => force || changed.includes(hint.path))
      .map((hint) => ({
        scope: "project",
        repoId,
        kind: hint.kind,
        text: hint.text,
        confidence: hint.confidence,
        source: "doc",
        reference: `doc:${repoId}:${[rootDir, hint.path].filter(Boolean).join("/")}`,
        evidence: hint.evidence,
      }));
    for (let i = 0; i < items.length; i += 50) {
      const captured = await memoryReviewClient(this.env.WORK)
        .captureMemories(workspace, items.slice(i, i + 50), "g1t")
        .catch(() => null);
      stats.candidates += captured?.added ?? 0;
      stats.kept += captured?.kept ?? 0;
    }
    return stats;
  }

  // ---- Issues, pull requests and memory in search ------------------------

  private async repoOf(repoId: string): Promise<{ namespace: string; name: string } | null> {
    const response = await this.env.REPOS.fetch("https://repos/rpc/path_by_id", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: repoId }),
    });
    return response.ok ? ((await response.json()) as { namespace: string; name: string } | null) : null;
  }

  /** Stores and indexes issues and pull requests as search rows. */
  private async putItems(
    workspace: string,
    project: Project | null,
    repoId: string,
    rows: { kind: "issue" | "pull"; number: number; title: string; body: string | null; by: string | null; updatedAt: string; url: string; private: boolean }[],
  ): Promise<number> {
    const writes: D1PreparedStatement[] = [];
    const toIndex: { id: string; text: string; meta: IndexMeta }[] = [];
    for (const row of rows) {
      const id = `${row.kind}:${repoId}#${row.number}`;
      const title = `#${row.number} ${row.title}`;
      const text = (row.body ?? "").slice(0, ITEM_CHARS);
      writes.push(
        this.db
          .prepare(
            `INSERT OR REPLACE INTO items (id, workspace, kind, entity_id, project_id, project, repo_id, private, title, text, url, by, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, workspace, row.kind, project?.id ?? null, project?.slug ?? null, repoId, row.private ? 1 : 0, title, text, row.url, row.by, row.updatedAt),
      );
      toIndex.push({
        id,
        text: `${row.title}\n${text}`,
        meta: { workspace, kind: row.kind, project: project?.slug ?? "", private: row.private, title, snippet: snippet(text || row.title), url: row.url, source: row.kind === "issue" ? "issue" : "pull request", by: row.by ?? "", at: row.updatedAt },
      });
    }
    for (let i = 0; i < writes.length; i += 50) await this.db.batch(writes.slice(i, i + 50));
    return this.index(workspace, toIndex);
  }

  private async indexIssueOrPull(kind: "issue" | "pull", repoId: string, number: number): Promise<void> {
    const path = await this.repoOf(repoId);
    if (!path) return;
    const workspace = path.namespace.toLowerCase();
    const actor = await this.workspaceActor(workspace);
    if (!actor) return;
    const [repo, projects] = await Promise.all([reposClient(this.env.REPOS).get(path, actor), projectsClient(this.env.PROJECTS).byRepo(repoId)]);
    if (!repo.ok || repo.value.forkOf) return;
    const work = workClient(this.env.WORK);
    const base = `/${path.namespace}/${path.name}`;
    if (kind === "issue") {
      const found = await work.getIssue(path, number, actor);
      if (!found.ok) return;
      const issue = found.value.issue;
      await this.putItems(workspace, projects[0] ?? null, repoId, [
        { kind, number, title: issue.title, body: issue.body, by: issue.author.username, updatedAt: issue.updatedAt, url: `${base}/issues/${number}`, private: repo.value.isPrivate },
      ]);
    } else {
      const found = await work.getPull(path, number, actor);
      if (!found.ok) return;
      const pull = found.value.pull as { title: string; body: string | null; agent: string; updatedAt?: string; author?: { username: string } };
      await this.putItems(workspace, projects[0] ?? null, repoId, [
        { kind, number, title: pull.title, body: pull.body, by: pull.author?.username ?? pull.agent, updatedAt: pull.updatedAt ?? now(), url: `${base}/pull/${number}`, private: repo.value.isPrivate },
      ]);
    }
  }

  /** A memory in search while it is kept, and out of it otherwise. */
  private async indexMemories(workspace: string, memories: Memory[]): Promise<number> {
    const kept = memories.filter((memory) => (memory.status ?? "kept") === "kept");
    await this.unindex(memories.filter((memory) => !kept.includes(memory)).map((memory) => `memory:${memory.id}`));
    const projects = await projectsClient(this.env.PROJECTS)
      .list(workspace, (await this.workspaceActor(workspace)) ?? null)
      .then((found) => (found.ok ? found.value : []))
      .catch(() => [] as Project[]);
    const slugOf = (memory: Memory) =>
      memory.scope === "project" && memory.repo
        ? (projects.find(
            (project) =>
              project.source.kind === "hosted" &&
              project.primary &&
              project.source.repo.namespace.toLowerCase() === memory.repo!.namespace.toLowerCase() &&
              project.source.repo.name.toLowerCase() === memory.repo!.name.toLowerCase(),
          )?.slug ?? "")
        : "";
    return this.index(
      workspace,
      kept.map((memory) => ({
        id: `memory:${memory.id}`,
        text: `${memory.kind}: ${memory.text}`,
        meta: {
          workspace,
          kind: "memory",
          project: slugOf(memory),
          // Memory is for members, whatever its project.
          private: true,
          title: `${memory.kind[0].toUpperCase()}${memory.kind.slice(1)}${memory.scope === "workspace" ? " (workspace)" : ""}`,
          snippet: snippet(memory.text),
          url: memory.repo ? `/${memory.repo.namespace}/${memory.repo.name}/memory` : `/${workspace}/-/memory`,
          source: memorySource(memory),
          by: memory.createdBy,
          at: memory.updatedAt,
        },
      })),
    );
  }

  // ---- Events --------------------------------------------------------------

  async onEvent(event: G1tEvent): Promise<void> {
    switch (event.type) {
      case "git.push": {
        if (!event.data.defaultBranch) return;
        const projects = (await projectsClient(this.env.PROJECTS).byRepo(event.data.repoId)).slice(0, MAX_PROJECTS_PER_PUSH);
        if (projects.length === 0) return;
        const actor = await this.workspaceActor(projects[0].workspace);
        if (!actor) return;
        const cache = new WorkspaceCache(this.env, projects[0].workspace, actor);
        for (const project of projects) await this.scan(project, cache, event.data.after, false);
        return;
      }
      case "issue.opened":
      case "issue.updated":
      case "issue.closed":
        return this.indexIssueOrPull("issue", event.data.repoId, event.data.number);
      case "pull.ready":
      case "pull.merged":
        return this.indexIssueOrPull("pull", event.data.repoId, event.data.number);
      case "memory.changed": {
        const { memoryId, workspace, status } = event.data;
        if (status !== "kept") return this.unindex([`memory:${memoryId}`]);
        const memories = await memoryReviewClient(this.env.WORK).memoriesById(workspace, [memoryId]);
        await this.indexMemories(workspace, memories);
        return;
      }
      case "repo.transferred":
      case "repo.renamed": {
        // What the hub knew about the repository under its old path goes,
        // index included (its rows carry the path: a transfer's old
        // workspace, a rename's old name); the workspace it is in now is
        // built again, which reads it where and as it is now. Nothing here
        // is the only copy.
        const move = repoMove(event)!;
        const current = await currentMovedPath(this.env.REPOS, move);
        const stale = staleMovedPaths(move, current);
        if (stale.length === 0) return;
        const workspace = current.split("/")[0]!.toLowerCase();
        await this.forgetRepo(move.repoId, [...new Set(stale.map((path) => path.split("/")[0]!.toLowerCase()))]);
        const actor = await this.workspaceActor(workspace);
        if (actor) await this.backfill({ actor, workspace });
        return;
      }
      case "repo.deleted":
      case "repo.purged": {
        // Deleted, it is hidden: what the hub knew of it goes, index
        // included, so no search or agent finds it. A restore builds it
        // again; a purge finds nothing left.
        await this.forgetRepo(event.data.repoId, [event.data.namespace.toLowerCase()]);
        return;
      }
      case "repo.restored": {
        const workspace = event.data.namespace.toLowerCase();
        const actor = await this.workspaceActor(workspace);
        if (actor) await this.backfill({ actor, workspace });
        return;
      }
      case "workspace.deleted": {
        await this.forgetWorkspace(event.data.slug);
        return;
      }
      case "workspace.renamed": {
        const current = await currentWorkspaceSlug(this.env.IDENTITY, event.data);
        for (const old of staleSlugs(event.data, current)) {
          await this.db.batch(
            ["entities", "relations", "items", "scans", "usage"].map((table) =>
              this.db.prepare(`UPDATE OR IGNORE ${table} SET workspace = ? WHERE workspace = ?`).bind(current, old),
            ),
          );
          await this.db.prepare("DELETE FROM backfills WHERE workspace = ?").bind(old).run();
        }
        // The index's rows carry the slug: build them again under the new one.
        const actor = await this.workspaceActor(current);
        if (actor) await this.backfill({ actor, workspace: current });
        return;
      }
      default:
        return;
    }
  }

  // ---- Backfill ------------------------------------------------------------

  private async backfillRow(workspace: string): Promise<Backfill | null> {
    const row = await this.db.prepare("SELECT * FROM backfills WHERE workspace = ?").bind(workspace).first<Record<string, unknown>>();
    if (!row) return null;
    return {
      workspace,
      status: row.status as Backfill["status"],
      by: String(row.by),
      projects: Number(row.projects),
      done: Number(row.done),
      entities: Number(row.entities),
      candidates: Number(row.candidates),
      kept: Number(row.kept),
      indexed: Number(row.indexed),
      error: (row.error as string | null) ?? null,
      startedAt: String(row.started_at),
      finishedAt: (row.finished_at as string | null) ?? null,
    };
  }

  async backfill(a: { actor: User; workspace: string }): Promise<Result<Backfill>> {
    const workspace = a.workspace.toLowerCase();
    if (!isMember(a.actor, workspace)) return fail("forbidden", "Only members can rebuild a workspace's context.");
    const running = await this.backfillRow(workspace);
    if (running?.status === "running" && Date.now() - Date.parse(running.startedAt) < BACKFILL_STALE_MS) return ok(running);
    const actor = (await this.workspaceActor(workspace)) ?? a.actor;
    const listed = await projectsClient(this.env.PROJECTS).list(workspace, actor);
    if (!listed.ok) return listed;
    const projects = listed.value.filter((project) => project.source.kind === "hosted").slice(0, BACKFILL_PROJECTS);
    const at = now();
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO backfills (workspace, status, by, projects, done, entities, candidates, kept, indexed, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, NULL, ?, ?)`,
      )
      .bind(workspace, projects.length ? "running" : "done", a.actor.username, projects.length, at, projects.length ? null : at)
      .run();
    const jobs: { body: Job }[] = [
      ...projects.map((project) => ({ body: { type: "backfill_project", workspace, slug: project.slug } as Job })),
      { body: { type: "backfill_memory", workspace } },
    ];
    for (let i = 0; i < jobs.length; i += 100) await this.env.JOBS.sendBatch(jobs.slice(i, i + 100));
    return ok((await this.backfillRow(workspace))!);
  }

  async runJob(job: Job): Promise<void> {
    const actor = await this.workspaceActor(job.workspace);
    if (!actor) return;
    if (job.type === "backfill_memory") {
      const memories = await memoryReviewClient(this.env.WORK).searchMemories(job.workspace, null, { limit: 100 });
      const indexed = await this.indexMemories(job.workspace, memories);
      await this.db.prepare("UPDATE backfills SET indexed = indexed + ? WHERE workspace = ?").bind(indexed, job.workspace).run();
      return;
    }
    const stats: ScanStats = { entities: 0, candidates: 0, kept: 0, indexed: 0 };
    let error: string | null = null;
    try {
      const found = await projectsClient(this.env.PROJECTS).get(job.workspace, job.slug, actor);
      if (found.ok && found.value.source.kind === "hosted") {
        const project = found.value;
        const source = project.source as Extract<Project["source"], { kind: "hosted" }>;
        const cache = new WorkspaceCache(this.env, job.workspace, actor);
        Object.assign(stats, await this.scan(project, cache, null, true));
        if (project.primary) {
          // Decisions from merged pull requests, and people's corrections in their reviews.
          const seeded = await memoryReviewClient(this.env.WORK).seedFromPulls(source.repoId, BACKFILL_PULLS).catch(() => null);
          stats.candidates += seeded?.added ?? 0;
          stats.kept += seeded?.kept ?? 0;
          const work = workClient(this.env.WORK);
          const base = `/${source.repo.namespace}/${source.repo.name}`;
          const [issues, pulls] = await Promise.all([
            work.listIssues(source.repo, actor).catch(() => null),
            work.listPulls(source.repo, actor, "closed").catch(() => null),
          ]);
          stats.indexed += await this.putItems(job.workspace, project, source.repoId, [
            ...(issues?.ok ? issues.value.slice(0, BACKFILL_ITEMS) : []).map((issue) => ({
              kind: "issue" as const,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              by: issue.author.username,
              updatedAt: issue.updatedAt,
              url: `${base}/issues/${issue.number}`,
              private: project.private,
            })),
            ...(pulls?.ok ? pulls.value.filter((pull) => pull.status === "merged").slice(0, BACKFILL_ITEMS) : []).map((pull) => ({
              kind: "pull" as const,
              number: pull.number,
              title: pull.title,
              body: pull.body,
              by: (pull as { author?: { username: string } }).author?.username ?? pull.agent,
              updatedAt: pull.mergedAt ?? now(),
              url: `${base}/pull/${pull.number}`,
              private: project.private,
            })),
          ]);
        }
      }
    } catch (caught) {
      error = String(caught).slice(0, 300);
      console.error("backfill of", job.workspace, job.slug, "failed", caught);
    }
    await this.db
      .prepare(
        `UPDATE backfills SET done = done + 1, entities = entities + ?, candidates = candidates + ?, kept = kept + ?, indexed = indexed + ?,
           error = COALESCE(?, error),
           status = CASE WHEN done + 1 >= projects THEN 'done' ELSE status END,
           finished_at = CASE WHEN done + 1 >= projects THEN ? ELSE finished_at END
         WHERE workspace = ?`,
      )
      .bind(stats.entities, stats.candidates, stats.kept, stats.indexed, error, now(), job.workspace)
      .run();
  }

  // ---- Reading -------------------------------------------------------------

  /**
   * Who is reading, and what of the workspace they may see. Someone who can
   * read every repository in it (an owner, a member while its base
   * permission is Read or more, its own token) sees everything; anyone else
   * sees the projects the projects service lists for them, which are those
   * whose repositories they can read.
   */
  private async reader(workspace: string, viewer: Viewer): Promise<Reader> {
    const member = isMember(viewer, workspace);
    const full = member && !!viewer && granted(viewer, { id: "", namespace: workspace, isPrivate: true }) != null;
    if (full) return { workspace, member, full, visible: new Set() };
    const listed = await projectsClient(this.env.PROJECTS).list(workspace, viewer).catch(() => null);
    const projects = listed?.ok ? listed.value : [];
    return {
      workspace,
      member,
      full,
      visible: new Set(projects.map((p) => p.slug)),
      privateVisible: projects.some((p) => p.private),
      repos: new Set(
        projects.flatMap((p) => (p.source.kind === "hosted" ? [`${p.source.repo.namespace}/${p.source.repo.name}`.toLowerCase()] : [])),
      ),
    };
  }

  private visibleRow(row: { private: number; project: string | null }, reader: Reader): boolean {
    return readable({ workspace: reader.workspace, kind: "entity", project: row.project ?? "", private: !!row.private }, reader);
  }

  async status(a: { workspace: string; viewer: Viewer }): Promise<Result<ContextStatus>> {
    const workspace = a.workspace.toLowerCase();
    if (!isMember(a.viewer, workspace)) return fail("not_found", "There is no such workspace.");
    let backfill = await this.backfillRow(workspace);
    // The hub is never empty for long: a workspace's first look starts it.
    if (!backfill) {
      const actor = await this.workspaceActor(workspace);
      if (actor) {
        const started = await this.backfill({ actor: { ...actor, username: "g1t" }, workspace });
        backfill = started.ok ? started.value : null;
      }
    }
    // Counted over what the viewer may read: a member whose base permission
    // is None counts only the projects they were given.
    const reader = await this.reader(workspace, a.viewer);
    const [counted, usage] = await Promise.all([
      this.db
        .prepare("SELECT kind, project, private, COUNT(*) AS n FROM entities WHERE workspace = ? GROUP BY kind, project, private")
        .bind(workspace)
        .all<{ kind: EntityKind; project: string | null; private: number; n: number }>(),
      this.db.prepare("SELECT tokens, cost_micros FROM usage WHERE workspace = ? AND month = ?").bind(workspace, month()).first<{ tokens: number; cost_micros: number }>(),
    ]);
    return ok({
      backfill,
      counts: countVisible(counted.results, reader),
      usage: { month: month(), tokens: usage?.tokens ?? 0, costMicros: usage?.cost_micros ?? 0 },
      // Embeddings are compute: a paid plan or the trial (semanticOpen).
      semantic: !!(this.env.AI && this.env.VECTORS) && (await this.semanticOpen(workspace)),
    });
  }

  async catalog(a: { workspace: string; viewer: Viewer; kind?: EntityKind | null; project?: string | null }): Promise<Result<Catalog>> {
    const workspace = a.workspace.toLowerCase();
    const reader = await this.reader(workspace, a.viewer);
    let sql = "SELECT * FROM entities WHERE workspace = ?";
    const params: unknown[] = [workspace];
    if (a.kind) {
      sql += " AND kind = ?";
      params.push(a.kind);
    }
    if (a.project) {
      sql += " AND (project = ? OR project IS NULL)";
      params.push(a.project.toLowerCase());
    }
    sql += " ORDER BY kind, name COLLATE NOCASE LIMIT 2000";
    const rows = (await this.db.prepare(sql).bind(...params).all<EntityRow>()).results.filter((row) => this.visibleRow(row, reader));
    const ids = new Set(rows.map((row) => row.id));
    const relations = (
      await this.db.prepare("SELECT from_id, kind, to_id FROM relations WHERE workspace = ? LIMIT 10000").bind(workspace).all<{ from_id: string; kind: RelationKind; to_id: string }>()
    ).results
      .filter((row) => ids.has(row.from_id) && ids.has(row.to_id))
      .map((row) => ({ from: row.from_id, kind: row.kind, to: row.to_id }));
    const built = await this.db.prepare("SELECT MAX(scanned_at) AS at FROM scans WHERE workspace = ?").bind(workspace).first<{ at: string | null }>();
    return ok({ entities: rows.map(toEntity), relations, builtAt: built?.at ?? null });
  }

  async entity(a: { workspace: string; viewer: Viewer; kind: EntityKind; id: string }): Promise<Result<EntityDetail>> {
    const workspace = a.workspace.toLowerCase();
    if (!ENTITY_KINDS.includes(a.kind)) return fail("invalid", `kind is one of ${ENTITY_KINDS.join(", ")}.`);
    const reader = await this.reader(workspace, a.viewer);
    const row =
      (await this.db.prepare("SELECT * FROM entities WHERE workspace = ? AND id = ?").bind(workspace, a.id).first<EntityRow>()) ??
      (await this.db.prepare("SELECT * FROM entities WHERE workspace = ? AND kind = ? AND key = ? COLLATE NOCASE").bind(workspace, a.kind, a.id).first<EntityRow>());
    if (!row || row.kind !== a.kind || !this.visibleRow(row, reader)) return fail("not_found", `There is no such ${a.kind} in ${workspace}'s catalog.`);
    const [out, into] = await Promise.all([
      this.db
        .prepare("SELECT r.kind AS rel, e.* FROM relations r JOIN entities e ON e.id = r.to_id WHERE r.from_id = ? LIMIT 200")
        .bind(row.id)
        .all<EntityRow & { rel: RelationKind }>(),
      this.db
        .prepare("SELECT r.kind AS rel, e.* FROM relations r JOIN entities e ON e.id = r.from_id WHERE r.to_id = ? LIMIT 200")
        .bind(row.id)
        .all<EntityRow & { rel: RelationKind }>(),
    ]);
    const relations = [
      ...out.results.filter((r) => this.visibleRow(r, reader)).map((r) => ({ kind: r.rel, direction: "out" as const, entity: toEntity(r) })),
      ...into.results.filter((r) => this.visibleRow(r, reader)).map((r) => ({ kind: r.rel, direction: "in" as const, entity: toEntity(r) })),
    ];
    return ok({ entity: toEntity(row), relations });
  }

  async search(a: { workspace: string; viewer: Viewer; query: string; project?: string | null; kinds?: SearchKind[] | null; limit?: number | null }): Promise<Result<SearchResult>> {
    const workspace = a.workspace.toLowerCase();
    const query = (a.query ?? "").trim().slice(0, 500);
    if (!query) return fail("invalid", "Say what to search for.");
    const reader = await this.reader(workspace, a.viewer);
    if (!reader.full && !reader.member && reader.visible.size === 0) return ok({ query, hits: [], mode: "text" });
    const limit = Math.min(Math.max(a.limit ?? 20, 1), 50);
    const kinds = allowedKinds(reader, a.kinds);
    const wants = (kind: SearchKind) => !kinds || kinds.includes(kind);
    const project = a.project?.toLowerCase() || null;

    // Semantic: the index, filtered to what this reader may see.
    let semantic: SearchHit[] = [];
    let mode: SearchResult["mode"] = "text";
    const vector = await this.embedQuery(workspace, query);
    if (vector && this.env.VECTORS) {
      try {
        const found = await this.env.VECTORS.query(vector, { topK: 20, returnMetadata: "all", filter: indexFilter(reader, { project, kinds }) as VectorizeVectorMetadataFilter });
        mode = "semantic";
        semantic = found.matches
          .map((match) => ({ id: match.id, score: match.score, meta: match.metadata as unknown as IndexMeta }))
          .filter((match) => match.meta && readable(match.meta, reader))
          .map((match) => ({
            kind: match.meta.kind as SearchKind,
            id: match.id.startsWith("memory:") ? match.id.slice(7) : match.id,
            title: match.meta.title,
            snippet: match.meta.snippet,
            project: match.meta.project || null,
            url: match.meta.url || null,
            score: match.score,
            source: match.meta.source,
            by: match.meta.by || null,
            updatedAt: match.meta.at || null,
          }));
        // Memory changes after it is indexed: show only what is still kept.
        const memoryIds = semantic.filter((hit) => hit.kind === "memory").map((hit) => hit.id);
        if (memoryIds.length) {
          const kept = new Set(
            (await memoryReviewClient(this.env.WORK).memoriesById(workspace, memoryIds))
              .filter((memory) => (memory.status ?? "kept") === "kept" && memoryReadable(memory.repo, reader))
              .map((memory) => memory.id),
          );
          semantic = semantic.filter((hit) => hit.kind !== "memory" || kept.has(hit.id));
        }
      } catch (error) {
        console.error("semantic search failed; matching words instead", error);
      }
    }

    // Text: every word, in the catalog, docs, issues and pull requests, and memory.
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const like = (columns: string) => words.map(() => `(${columns}) LIKE ?`).join(" AND ");
    const patterns = words.map((word) => `%${word.replace(/[%_]/g, "")}%`);
    const text: SearchHit[] = [];
    const entityKinds = ENTITY_KINDS.filter(wants);
    if (entityKinds.length) {
      const rows = await this.db
        .prepare(
          `SELECT * FROM entities WHERE workspace = ? AND kind IN (SELECT value FROM json_each(?)) ${project ? "AND (project = ? OR project IS NULL)" : ""}
           AND ${like("lower(name || ' ' || COALESCE(summary, ''))")} LIMIT 30`,
        )
        .bind(workspace, JSON.stringify(entityKinds), ...(project ? [project] : []), ...patterns)
        .all<EntityRow>();
      for (const row of rows.results.filter((r) => this.visibleRow(r, reader))) {
        text.push({ kind: row.kind, id: row.id, title: row.name, snippet: snippet(row.summary), project: row.project, url: row.ref, score: 0.3, source: "catalog", by: null, updatedAt: row.updated_at });
      }
    }
    const itemKinds = (["doc", "issue", "pull"] as const).filter(wants);
    if (itemKinds.length) {
      const rows = await this.db
        .prepare(
          `SELECT * FROM items WHERE workspace = ? AND kind IN (SELECT value FROM json_each(?)) ${project ? "AND project = ?" : ""}
           AND ${like("lower(title || ' ' || text)")} ORDER BY updated_at DESC LIMIT 30`,
        )
        .bind(workspace, JSON.stringify(itemKinds), ...(project ? [project] : []), ...patterns)
        .all<ItemRow>();
      for (const row of rows.results.filter((r) => this.visibleRow(r, reader))) {
        text.push({ kind: row.kind, id: row.id, title: row.title, snippet: snippet(row.text), project: row.project, url: row.url, score: 0.2, source: row.kind === "doc" ? "doc" : row.kind, by: row.by, updatedAt: row.updated_at });
      }
    }
    if (reader.member && wants("memory")) {
      const memories = await memoryReviewClient(this.env.WORK).searchMemories(workspace, query, { limit: 10 }).catch(() => [] as Memory[]);
      for (const memory of memories.filter((m) => memoryReadable(m.repo, reader))) {
        text.push({
          kind: "memory",
          id: memory.id,
          title: `${memory.kind[0].toUpperCase()}${memory.kind.slice(1)}${memory.scope === "workspace" ? " (workspace)" : ""}`,
          snippet: snippet(memory.text),
          project: null,
          url: memory.repo ? `/${memory.repo.namespace}/${memory.repo.name}/memory` : `/${workspace}/-/memory`,
          score: memory.pinned ? 0.35 : 0.25,
          source: memorySource(memory),
          by: memory.createdBy,
          updatedAt: memory.updatedAt,
        });
      }
    }
    return ok({ query, hits: merge(semantic, text, limit), mode });
  }

  async scorecards(a: { workspace: string; viewer: Viewer }): Promise<Result<Scorecard[]>> {
    const workspace = a.workspace.toLowerCase();
    if (!isMember(a.viewer, workspace)) return fail("forbidden", "Scorecards are for members of the workspace.");
    const listed = await projectsClient(this.env.PROJECTS).list(workspace, a.viewer);
    if (!listed.ok) return listed;
    const [entities, scans, deploys, security] = await Promise.all([
      this.db
        .prepare("SELECT * FROM entities WHERE workspace = ? AND kind IN ('project', 'doc')")
        .bind(workspace)
        .all<EntityRow>(),
      this.db.prepare("SELECT project_id, tests FROM scans WHERE workspace = ?").bind(workspace).all<{ project_id: string; tests: number }>(),
      deploymentsClient(this.env.DEPLOYMENTS)
        .overview(workspace, a.viewer)
        .then((found) => (found.ok ? found.value : []))
        .catch(() => [] as ProjectDeploys[]),
      this.env.SECURITY
        ? securityClient(this.env.SECURITY)
            .workspace(workspace, a.viewer)
            .then((found) => (found.ok ? found.value : null))
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    const tests = new Map(scans.results.map((row) => [row.project_id, !!row.tests]));
    const cards: Scorecard[] = [];
    for (const project of listed.value) {
      if (project.source.kind !== "hosted") continue;
      const own = entities.results.filter((row) => row.project_id === project.id);
      const entry = own.find((row) => row.kind === "project");
      const data = entry ? toEntity(entry).data : {};
      const deploy = deploys.find((d) => d.slug === project.slug);
      const repoId = project.source.repoId;
      const findings = security?.find((repo) => repo.repoId === repoId);
      const rules = evaluate({
        name: project.name,
        owners: Array.isArray(data.owners) ? (data.owners as string[]) : [],
        docs: own.filter((row) => row.kind === "doc").map((row) => String(toEntity(row).data.path ?? "")),
        tests: tests.get(project.id) ?? false,
        testCommand: Array.isArray(data.testCommands) && data.testCommands.length ? String(data.testCommands[0]) : null,
        deploy: deploy
          ? {
              enabled: deploy.enabled,
              production: deploy.production ? { url: deploy.production.url } : null,
              latest: deploy.latest ? { kind: deploy.latest.kind, status: deploy.latest.status, error: deploy.latest.error } : null,
            }
          : null,
        secretFindings: security ? (findings?.secrets ?? 0) : null,
      });
      const applies = rules.filter((rule) => rule.status !== "na");
      cards.push({
        project: project.slug,
        name: project.name,
        repo: project.source.repo,
        passed: applies.filter((rule) => rule.status === "pass").length,
        total: applies.length,
        rules,
      });
    }
    return ok(cards);
  }

  /**
   * The Context section for an agent starting work, holding only what the
   * person it acts for (`requester`) may read: an outside collaborator's run
   * is told the project's memory, never the workspace's, and only the
   * projects around it they can read. No requester is the workspace's own
   * step. Never fails a run: on any trouble, nothing.
   */
  async runContext(a: { repoId: string; task?: string; budget?: number; requester?: Viewer }): Promise<RunContext> {
    try {
      const projects = (await projectsClient(this.env.PROJECTS).byRepo(a.repoId)).slice(0, 2);
      if (projects.length === 0) return { text: null, sources: [] };
      const workspace = projects[0].workspace;
      const actor = await this.workspaceActor(workspace);
      if (!actor) return { text: null, sources: [] };
      const reader = a.requester ? await this.reader(workspace, a.requester) : null;
      const home = projects.find((project) => project.source.kind === "hosted");
      const repoKey = home?.source.kind === "hosted" ? `${home.source.repo.namespace}/${home.source.repo.name}` : "";
      const cache = new WorkspaceCache(this.env, workspace, actor);
      const deploys = await cache.deployments();
      const live = new Map(deploys.map((d) => [d.slug, d]));
      const contexts: ProjectContext[] = [];
      for (const project of projects) {
        if (project.source.kind !== "hosted") continue;
        const rows = (await this.db.prepare("SELECT * FROM entities WHERE workspace = ? AND project_id = ?").bind(workspace, project.id).all<EntityRow>()).results.map(toEntity);
        const entry = rows.find((row) => row.kind === "project");
        const graph = await projectsClient(this.env.PROJECTS).graph(project.id).catch(() => ({ dependsOn: [], usedBy: [] }));
        const deploy = live.get(project.slug);
        contexts.push({
          slug: project.slug,
          name: project.name,
          repo: `${project.source.repo.namespace}/${project.source.repo.name}`,
          rootDir: project.source.rootDir,
          languages: Array.isArray(entry?.data.languages) ? (entry!.data.languages as string[]) : [],
          packages: rows.filter((row) => row.kind === "package").map((row) => row.name).slice(0, 5),
          testCommands: Array.isArray(entry?.data.testCommands) ? (entry!.data.testCommands as string[]) : [],
          owners: Array.isArray(entry?.data.owners) ? (entry!.data.owners as string[]) : [],
          dependsOn: graph.dependsOn
            .filter((dep) => projectReadable(dep.slug, reader))
            .map((dep) => ({ slug: dep.slug, as: dep.as, url: live.get(dep.slug)?.production?.url ?? null })),
          usedBy: graph.usedBy.filter((dep) => projectReadable(dep.slug, reader)).map((dep) => ({ slug: dep.slug })),
          environments: deploy?.enabled
            ? [{ name: "Production", url: deploy.production?.url ?? null, status: deploy.latest?.kind === "production" ? deploy.latest.status : deploy.production ? "ready" : null }]
            : [],
          docs: rows.filter((row) => row.kind === "doc").map((row) => String(row.data.path ?? row.name)),
        });
      }
      // Workspace memory (no project) only for a run its members may be told it.
      const slugs = new Set([...(reader && !reader.member ? [] : [""]), ...projects.map((project) => project.slug)]);
      const review = memoryReviewClient(this.env.WORK);
      // The memories closest to the task, less the pinned ones every run already has.
      let memories: ContextNote[] = [];
      const task = (a.task ?? "").trim();
      const vector = task ? await this.embedQuery(workspace, task.slice(0, 1500)) : null;
      if (vector && this.env.VECTORS) {
        const found = await this.env.VECTORS.query(vector, { topK: 20, returnMetadata: "all", filter: { workspace, kind: "memory" } }).catch(() => null);
        const ids = (found?.matches ?? [])
          .filter((match) => slugs.has(String((match.metadata as { project?: string } | undefined)?.project ?? "")) && match.score >= 0.5)
          .map((match) => match.id.slice("memory:".length));
        if (ids.length) {
          const byId = new Map((await review.memoriesById(workspace, ids)).map((memory) => [memory.id, memory]));
          memories = ids
            .map((id) => byId.get(id))
            .filter((memory): memory is Memory => !!memory && (memory.status ?? "kept") === "kept" && !memory.pinned && runMemoryReadable(memory, reader, repoKey))
            .slice(0, 6)
            .map((memory) => ({ id: memory.id, kind: memory.kind, text: memory.text, source: memorySource(memory) }));
        }
      }
      const shown = new Set(memories.map((note) => note.id));
      const decisions = (await review.searchMemories(workspace, null, { repoIds: [a.repoId], limit: 100 }).catch(() => [] as Memory[]))
        .filter((memory) => memory.kind === "decision" && !memory.pinned && !shown.has(memory.id) && runMemoryReadable(memory, reader, repoKey))
        .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
        .slice(0, 3)
        .map((memory) => ({ id: memory.id, kind: memory.kind, text: memory.text, source: memorySource(memory) }));
      return composeRunContext({ projects: contexts, memories, decisions, budget: Math.min(Math.max(a.budget ?? 4000, 500), 12_000) });
    } catch (error) {
      console.error("no run context for", a.repoId, error);
      return { text: null, sources: [] };
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (request.method !== "POST" || !match) return new Response("Not found\n", { status: 404 });
    const service = new Context(env);
    const args = (await request.json().catch(() => ({}))) as any;
    switch (match[1]) {
      case "catalog":
        return Response.json(await service.catalog(args));
      case "entity":
        return Response.json(await service.entity(args));
      case "search":
        return Response.json(await service.search(args));
      case "scorecards":
        return Response.json(await service.scorecards(args));
      case "backfill":
        return Response.json(await service.backfill(args));
      case "status":
        return Response.json(await service.status(args));
      case "run_context":
        return Response.json(await service.runContext(args));
      default:
        return new Response("Unknown method\n", { status: 404 });
    }
  },

  async queue(batch: MessageBatch<G1tEvent | Job>, env: Env): Promise<void> {
    const service = new Context(env);
    for (const message of batch.messages) {
      try {
        if (batch.queue === "g1t-context-jobs") await service.runJob(message.body as Job);
        else await service.onEvent(message.body as G1tEvent);
        message.ack();
      } catch (error) {
        console.error("context could not handle", (message.body as { type?: string }).type, error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, G1tEvent | Job>;
