/**
 * The context hub: one place to ask about a workspace. The context service
 * keeps a **catalog** of what the workspace builds and runs (projects,
 * their apps, APIs, packages, languages, owners, environments, integrations
 * and docs, and how they relate), built by itself from the repositories and
 * from projects, deployments and integrations; **search** across the
 * catalog, docs, issues, pull requests and memory; and **scorecards** for
 * each project. Memory itself, candidates and their review, is kept by
 * the work service: see `memoryReviewClient`.
 */

import type { Memory, MemoryKind } from "./agents";
import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

export type EntityKind =
  | "project"
  | "app"
  | "api"
  | "package"
  | "language"
  | "owner"
  | "environment"
  | "integration"
  | "doc";

export const ENTITY_KINDS: EntityKind[] = ["project", "app", "api", "package", "language", "owner", "environment", "integration", "doc"];

export type RelationKind = "depends_on" | "owned_by" | "deploys_to" | "documented_by" | "exposes" | "uses";

export type Entity = {
  id: string;
  workspace: string;
  kind: EntityKind;
  /** Unique for its kind in the workspace: a project's slug, `npm:<name>`, a username. */
  key: string;
  name: string;
  summary: string | null;
  /** The project it belongs to, by slug; null for what the workspace shares (owners, languages, integrations). */
  project: string | null;
  /** Whether only members see it: it comes from a private repository. */
  private: boolean;
  /** What it is, by kind: a package's version and dependencies, an API's routes, an app's address. */
  data: Record<string, unknown>;
  /** Where it was found: `scan` (the repository), `projects`, `deployments`, `integrations`. */
  source: string;
  /** Where to see it: a path on g1t.sh, or an address. */
  ref: string | null;
  /** RFC 3339. */
  updatedAt: string;
};

export type Relation = { from: string; kind: RelationKind; to: string };

export type Catalog = {
  entities: Entity[];
  relations: Relation[];
  /** When the catalog was last built from the repositories. */
  builtAt: string | null;
};

export type EntityDetail = {
  entity: Entity;
  /** Each relation with the entity at its other end. */
  relations: { kind: RelationKind; direction: "out" | "in"; entity: Entity }[];
};

/** What search can return: a catalog entity's kind, or one of these. */
export type SearchKind = EntityKind | "memory" | "issue" | "pull";
export const SEARCH_KINDS: SearchKind[] = [...ENTITY_KINDS, "memory", "issue", "pull"];

export type SearchHit = {
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string;
  /** The project it is about, by slug. */
  project: string | null;
  /** Where to see it on g1t.sh, or an address. */
  url: string | null;
  /** Higher is closer; text matches score below semantic ones. */
  score: number;
  /** Where it came from, such as `AGENTS.md`, `review on #12`, `catalog`. */
  source: string;
  /** Who wrote it, for memory, issues and pull requests. */
  by: string | null;
  /** RFC 3339. */
  updatedAt: string | null;
};

export type SearchResult = {
  query: string;
  hits: SearchHit[];
  /** `semantic` when the search index answered; `text` when it fell back to matching words. */
  mode: "semantic" | "text";
};

export type SearchOptions = { project?: string | null; kinds?: SearchKind[] | null; limit?: number | null };

export type ScoreRule = "has_owner" | "has_readme" | "has_agents_md" | "tests_in_ci" | "production_green" | "no_secret_findings";

export type RuleResult = {
  rule: ScoreRule;
  title: string;
  /** `na` when the rule does not apply, such as production for a project that does not deploy. */
  status: "pass" | "fail" | "na";
  detail: string;
  /** For a failing rule: an issue an agent can fix it from. */
  fix: { title: string; body: string; checks: string[] } | null;
};

export type Scorecard = {
  project: string;
  name: string;
  repo: RepoPath;
  passed: number;
  /** The rules that apply. */
  total: number;
  rules: RuleResult[];
};

export type Backfill = {
  workspace: string;
  status: "running" | "done" | "failed";
  by: string;
  projects: number;
  done: number;
  entities: number;
  /** Memory candidates added, and how many of them were kept at once. */
  candidates: number;
  kept: number;
  /** Things put in the search index. */
  indexed: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type ContextStatus = {
  backfill: Backfill | null;
  counts: Partial<Record<EntityKind, number>>;
  /** What the search index cost the workspace this month. */
  usage: { month: string; tokens: number; costMicros: number };
  /** Whether semantic search is available: set up, and on a paid plan or the trial. Text search always is. */
  semantic: boolean;
};

export type RunContext = {
  /** The Context section for an agent's prompt; null when there is nothing to say. */
  text: string | null;
  /** What it drew on, such as `catalog:web`, `memory:mem_…`. */
  sources: string[];
};

export interface ContextApi {
  /** The workspace's catalog, by kind and project. Members, or anyone for public projects' entries. */
  catalog(workspace: string, viewer: Viewer, filter?: { kind?: EntityKind | null; project?: string | null }): Promise<Result<Catalog>>;
  /** One entity, by its id or its key, with its relations. */
  entity(workspace: string, viewer: Viewer, kind: EntityKind, id: string): Promise<Result<EntityDetail>>;
  /** One search across the catalog, docs, issues, pull requests and, for members, memory. */
  search(workspace: string, viewer: Viewer, query: string, options?: SearchOptions): Promise<Result<SearchResult>>;
  /** Each project's scorecard. Members only. */
  scorecards(workspace: string, viewer: Viewer): Promise<Result<Scorecard[]>>;
  /** Builds the catalog for every project and seeds memory from docs and merged pull requests. Members only; once at a time. */
  backfill(actor: User, workspace: string): Promise<Result<Backfill>>;
  /** The hub's state for a workspace. Starts its first backfill when it has none. Members only. */
  status(workspace: string, viewer: Viewer): Promise<Result<ContextStatus>>;
  /**
   * For the runner: the Context section for an agent starting work in a
   * repository, within `budget` characters. `requester` is the person the
   * run acts for: it holds only what they may read. One who is not a member
   * of the workspace gets the project's memory only, never the workspace's,
   * and only the dependencies whose projects they can read.
   */
  runContext(repoId: string, task: string, budget?: number, requester?: Viewer): Promise<RunContext>;
}

async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
  return (await response.json()) as T;
}

export function contextClient(service: ServiceBinding): ContextApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    catalog: (workspace, viewer, filter = {}) => call("catalog", { workspace, viewer, ...filter }),
    entity: (workspace, viewer, kind, id) => call("entity", { workspace, viewer, kind, id }),
    search: (workspace, viewer, query, options = {}) => call("search", { workspace, viewer, query, ...options }),
    scorecards: (workspace, viewer) => call("scorecards", { workspace, viewer }),
    backfill: (actor, workspace) => call("backfill", { actor, workspace }),
    status: (workspace, viewer) => call("status", { workspace, viewer }),
    runContext: (repoId, task, budget, requester) => call("run_context", { repoId, task, budget, requester: requester ?? null }),
  };
}

// --- Memory capture and review (the work service) ---------------------------

/** Where a captured memory came from. */
export type CaptureSource = "run" | "review" | "pr" | "doc" | "manual";

export type CaptureItem = {
  scope: "project" | "workspace";
  /** For a project's memory: its repository's id. */
  repoId?: string | null;
  kind?: MemoryKind;
  text: string;
  confidence?: number | null;
  source: CaptureSource;
  /** One source: `doc:<repo id>:<path>`, `run:<id>`, `comment:<id>`, `pull:<repo id>#<n>`. */
  reference: string;
  evidence?: string | null;
  number?: number | null;
  runId?: string | null;
};

export type Captured = { added: number; merged: number; kept: number; refused: number };

export type ReviewDecision = "keep" | "dismiss";

export interface MemoryReviewApi {
  /** Candidates waiting for review in a workspace, or for one project. Members only. */
  listCandidates(viewer: Viewer, workspace: string, repo?: RepoPath | null): Promise<Result<Memory[]>>;
  /** Keep a candidate, edited or as it is, or dismiss it. Members only. */
  reviewMemory(
    actor: User,
    workspace: string,
    id: string,
    decision: ReviewDecision,
    change?: { text?: string; kind?: MemoryKind },
  ): Promise<Result<Memory>>;
  /** For services: candidates from docs and backfills. */
  captureMemories(workspace: string, items: CaptureItem[], by?: string): Promise<Captured>;
  /** For services: memories by id, in any status. */
  memoriesById(workspace: string, ids: string[]): Promise<Memory[]>;
  /** For services: kept memories with every word of `query`; the caller has checked the viewer may read them. */
  searchMemories(workspace: string, query: string | null, options?: { repoIds?: string[] | null; limit?: number }): Promise<Memory[]>;
  /** For services: decision and convention candidates from a repository's last merged pull requests. */
  seedFromPulls(repoId: string, limit?: number): Promise<Captured>;
}

/** Memory capture and review: methods of the work service. */
export function memoryReviewClient(service: ServiceBinding): MemoryReviewApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    listCandidates: (viewer, workspace, repo) => call("list_candidates", { viewer, workspace, repo: repo ?? null }),
    reviewMemory: (actor, workspace, id, decision, change = {}) => call("review_memory", { actor, workspace, id, decision, ...change }),
    captureMemories: (workspace, items, by) => call("capture_memories", { workspace, items, by: by ?? null }),
    memoriesById: (workspace, ids) => call("memories_by_id", { workspace, ids }),
    searchMemories: (workspace, query, options = {}) =>
      call("search_memories", { workspace, query, repoIds: options.repoIds ?? null, limit: options.limit ?? 20 }),
    seedFromPulls: (repoId, limit) => call("seed_from_pulls", { repoId, limit: limit ?? null }),
  };
}
