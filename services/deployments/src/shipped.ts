/**
 * What went live, and when: Home's "Live 9 min after merge".
 *
 * When a production deployment succeeds (`deployment_status.created`
 * with `success` in a production environment: a g1t.page build, or one a
 * workflow or the API reported, since builds are published into the same
 * model), its commit's history is read back from repos and every
 * commit in it that no production deployment shipped before is written
 * down as shipped by this one (`shipped_commits`, migration 0017). A
 * commit's first production deployment is the one that took it live: a
 * rollback to an older commit ships nothing new, and a deployment's event
 * delivered twice is walked once (`shipped_walks`).
 *
 * Asking (`shipped`) reads only what was written, so a page never walks
 * history. A change not shipped is `deploying` while a production
 * deployment after it is on its way, `failed` when the latest after it
 * failed, and `waiting` otherwise. A change that landed before recording
 * began for its repository is matched to the first production deployment
 * that succeeded after it instead.
 */
import type {
  Commit,
  DeploymentStatus,
  RepoDeployment,
  RepoPath,
  Result,
  ShipState,
  ShippedAsk,
  ShippedCommit,
  ShippedRepo,
  User,
  Viewer,
} from "@g1t/contracts";

/** Reads a commit's history back, newest first (repos' `log`). */
export type ReadLog = (repo: RepoPath, actor: User, ref: string, limit: number) => Promise<Result<Pick<Commit, "hash" | "parents">[]>>;

/** Commits read back per page of history, and the most pages one deployment walks. */
export const WALK_PAGE = 200;
export const WALK_PAGES = 5;
/** The most repositories, and commits in all, one `shipped` call asks about. */
export const MAX_REPOS = 20;
export const MAX_COMMITS = 300;

/** A production deployment that went live, as its event says. */
export type Shipment = {
  deploymentId: string;
  repoId: string;
  repo: RepoPath;
  sha: string;
  environment: string;
  deployedAt: string;
  /** Its page on the site. */
  url: string | null;
};

/**
 * The commits of one page of history this deployment ships: those not
 * known to be shipped already, each once. Whether to read the next page:
 * only when this page was full and held nothing shipped before, so the
 * walk stops at the last deployment's history.
 */
export function walkPage(page: Pick<Commit, "hash" | "parents">[], known: ReadonlySet<string>, full: boolean): { ship: string[]; more: boolean; next: string | null } {
  const ship = [...new Set(page.map((commit) => commit.hash).filter((hash) => !known.has(hash)))];
  const reachedKnown = page.some((commit) => known.has(commit.hash));
  const last = page.at(-1);
  const next = last?.parents[0] ?? null;
  return { ship, more: full && !reachedKnown && next != null, next };
}

/** A production attempt after a change landed, as either table keeps it. */
export type Attempt = { at: string; outcome: "live" | "running" | "failed"; url: string | null; environment: string };

/**
 * A change's state from what was recorded: shipped (its first production
 * deployment), else from the production attempts after it landed (oldest
 * first). `recordingStart` is when the repository's first walk went live:
 * a change that landed before it was never walked, so the first attempt
 * after it that went live shipped it.
 */
export function shipStateOf(
  ask: ShippedAsk,
  shipped: { deployed_at: string; url: string | null; environment: string } | null,
  attempts: Attempt[],
  recordingStart: string | null,
): ShippedCommit {
  const base = { sha: ask.sha };
  const after = attempts.filter((attempt) => attempt.at >= ask.landed_at);
  // Landed before anything was walked: the first walk wrote its history
  // down as of then, so the first deployment after it that went live is nearer.
  if (recordingStart == null || ask.landed_at < recordingStart) {
    const live = after.find((attempt) => attempt.outcome === "live");
    if (live) return { ...base, state: "live", deployed_at: live.at, url: live.url, environment: live.environment };
  }
  if (shipped) return { ...base, state: "live", deployed_at: shipped.deployed_at, url: shipped.url, environment: shipped.environment };
  const running = after.find((attempt) => attempt.outcome === "running");
  if (running) return { ...base, state: "deploying", deployed_at: null, url: running.url, environment: running.environment };
  const latest = after.at(-1);
  const state: ShipState = latest?.outcome === "failed" ? "failed" : "waiting";
  return { ...base, state, deployed_at: null, url: state === "failed" ? (latest?.url ?? null) : null, environment: latest?.environment ?? null };
}

/** A g1t.page build's outcome. */
function buildOutcome(status: string): Attempt["outcome"] | null {
  if (status === "ready" || status === "replaced" || status === "down") return "live";
  if (status === "queued" || status === "building") return "running";
  if (status === "failed") return "failed";
  return null;
}

/** A reported deployment's outcome: `inactive` is a success a newer one replaced. */
function reportedOutcome(state: string): Attempt["outcome"] | null {
  if (state === "success" || state === "inactive") return "live";
  if (state === "queued" || state === "in_progress" || state === "pending") return "running";
  if (state === "failure" || state === "error") return "failed";
  return null;
}

/** A site path from an address that may be the site's own, absolute. */
export function sitePath(url: string | null | undefined, site: string): string | null {
  if (!url) return null;
  if (url.startsWith("/")) return url;
  if (site && url.startsWith(site)) return url.slice(site.length) || "/";
  return null;
}

/**
 * The shipment a `deployment_status.created` event is, if it is one: a
 * success in a production environment. A g1t.page build links to its
 * page, a reported deployment to its workflow run, else to the
 * repository's deployments.
 */
export function shipmentOf(
  data: { repoId: string; deployment: Pick<RepoDeployment, "id" | "sha" | "environment" | "production_environment" | "source" | "project" | "run_url" | "updated_at">; deploymentStatus: Pick<DeploymentStatus, "state" | "created_at"> },
  repo: RepoPath,
  site: string,
): Shipment | null {
  const { deployment, deploymentStatus } = data;
  if (deploymentStatus?.state !== "success" || !deployment?.production_environment || !deployment.sha) return null;
  const own = `/${repo.namespace}/${repo.name}`;
  const url =
    deployment.source === "g1t_page" && deployment.project
      ? `/${repo.namespace}/${deployment.project}/deployments/${deployment.id}`
      : (sitePath(deployment.run_url, site) ?? `${own}/deployments`);
  return {
    deploymentId: deployment.id,
    repoId: data.repoId,
    repo,
    sha: deployment.sha,
    environment: deployment.environment,
    deployedAt: deploymentStatus.created_at || deployment.updated_at,
    url,
  };
}

type Env = { DB: D1Database; SITE: string };

/**
 * Only types are imported here, so the rules above are tested on their
 * own; the service hands in how to read history and as whom.
 */
export class Shipped {
  constructor(
    private readonly env: Env,
    /** Reads a workspace's repositories as the workspace itself. */
    private readonly actorFor: (workspace: string) => Promise<User | null>,
    private readonly readLog: ReadLog,
  ) {}

  private get db(): D1Database {
    return this.env.DB;
  }

  /** Writes down what a production deployment shipped. Once per deployment. */
  async record(shipment: Shipment): Promise<number> {
    const walked = await this.db
      .prepare(
        `INSERT INTO shipped_walks (deployment_id, repo_id, sha, environment, deployed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING RETURNING deployment_id`,
      )
      .bind(shipment.deploymentId, shipment.repoId, shipment.sha, shipment.environment, shipment.deployedAt)
      .first<{ deployment_id: string }>();
    if (!walked) return 0;
    const actor = await this.actorFor(shipment.repo.namespace);
    if (!actor) return 0;
    let ref: string | null = shipment.sha;
    let shipped = 0;
    try {
      for (let page = 0; page < WALK_PAGES && ref; page++) {
        const history = await this.readLog(shipment.repo, actor, ref, WALK_PAGE);
        if (!history.ok || history.value.length === 0) break;
        const hashes = history.value.map((commit) => commit.hash);
        const known = await this.db
          .prepare("SELECT sha FROM shipped_commits WHERE repo_id = ? AND sha IN (SELECT value FROM json_each(?))")
          .bind(shipment.repoId, JSON.stringify(hashes))
          .all<{ sha: string }>();
        const { ship, more, next } = walkPage(history.value, new Set(known.results.map((row) => row.sha)), history.value.length >= WALK_PAGE);
        if (ship.length > 0) {
          await this.db.batch(
            ship.map((sha) =>
              this.db
                .prepare(
                  `INSERT INTO shipped_commits (repo_id, sha, deployment_id, environment, deployed_at, url) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT DO NOTHING`,
                )
                .bind(shipment.repoId, sha, shipment.deploymentId, shipment.environment, shipment.deployedAt, shipment.url),
            ),
          );
          shipped += ship.length;
        }
        ref = more ? next : null;
      }
    } finally {
      await this.db.prepare("UPDATE shipped_walks SET commits = ? WHERE deployment_id = ?").bind(shipped, shipment.deploymentId).run();
    }
    return shipped;
  }

  /** Whether each change asked about is live (see the module's notes). Members of the workspace only. */
  async answer(a: { workspace: string; viewer: Viewer; repos: { repo_id: string; commits: ShippedAsk[] }[] }): Promise<Result<ShippedRepo[]>> {
    const workspace = String(a.workspace ?? "").toLowerCase();
    if (!a.viewer?.workspaces?.some((membership) => membership.slug === workspace)) {
      return { ok: false, error: { code: "forbidden", message: "Only members can see a workspace's deployments." } };
    }
    const asked = (Array.isArray(a.repos) ? a.repos : []).slice(0, MAX_REPOS);
    let budget = MAX_COMMITS;
    const out: ShippedRepo[] = [];
    for (const repo of asked) {
      const commits = (Array.isArray(repo.commits) ? repo.commits : [])
        .filter((ask) => typeof ask?.sha === "string" && typeof ask?.landed_at === "string")
        .slice(0, Math.max(0, budget));
      budget -= commits.length;
      out.push(await this.forRepo(String(repo.repo_id), workspace, commits));
    }
    return { ok: true, value: out };
  }

  private async forRepo(repoId: string, workspace: string, commits: ShippedAsk[]): Promise<ShippedRepo> {
    // Only this workspace's repositories: the g1t.page builds and the
    // reported deployments say whose they are.
    const oldest = commits.reduce<string | null>((min, ask) => (min == null || ask.landed_at < min ? ask.landed_at : min), null);
    const [shipped, start, builds, reported] = await Promise.all([
      commits.length
        ? this.db
            .prepare(
              "SELECT sha, deployed_at, url, environment FROM shipped_commits WHERE repo_id = ? AND sha IN (SELECT value FROM json_each(?))",
            )
            .bind(repoId, JSON.stringify(commits.map((ask) => ask.sha)))
            .all<{ sha: string; deployed_at: string; url: string | null; environment: string }>()
        : null,
      this.db.prepare("SELECT MIN(deployed_at) AS at FROM shipped_walks WHERE repo_id = ?").bind(repoId).first<{ at: string | null }>(),
      this.db
        .prepare(
          `SELECT id, slug, status, created_at, finished_at FROM deployments
           WHERE repo_id = ? AND workspace = ? AND kind = 'production' AND created_at >= ? ORDER BY created_at LIMIT 200`,
        )
        .bind(repoId, workspace, oldest ?? "9999")
        .all<{ id: string; slug: string; status: string; created_at: string; finished_at: string | null }>(),
      this.db
        .prepare(
          `SELECT id, environment, state, run_url, created_at, updated_at FROM reported_deployments
           WHERE repo_id = ? AND production_environment = 1 AND created_at >= ? ORDER BY created_at LIMIT 200`,
        )
        .bind(repoId, oldest ?? "9999")
        .all<{ id: string; environment: string; state: string; run_url: string | null; created_at: string; updated_at: string }>(),
    ]);
    const deploys =
      (builds.results.length > 0 || reported.results.length > 0 || (start?.at ?? null) != null) ||
      (await this.deploysAtAll(repoId, workspace));
    const attempts: Attempt[] = [
      ...builds.results.flatMap((row) => {
        const outcome = buildOutcome(row.status);
        return outcome
          ? [{ at: outcome === "running" ? row.created_at : (row.finished_at ?? row.created_at), outcome, url: `/${workspace}/${row.slug}/deployments/${row.id}`, environment: "production" }]
          : [];
      }),
      ...reported.results.flatMap((row) => {
        const outcome = reportedOutcome(row.state);
        // A success replaced since (`inactive`) was last changed when it was replaced: it went live nearer its start.
        const at = outcome === "running" || row.state === "inactive" ? row.created_at : row.updated_at;
        return outcome ? [{ at, outcome, url: sitePath(row.run_url, this.env.SITE), environment: row.environment }] : [];
      }),
    ].sort((x, y) => x.at.localeCompare(y.at));
    const byHash = new Map((shipped?.results ?? []).map((row) => [row.sha, row]));
    return {
      repo_id: repoId,
      deploys,
      commits: deploys ? commits.map((ask) => shipStateOf(ask, byHash.get(ask.sha) ?? null, attempts, start?.at ?? null)) : [],
    };
  }

  /** Whether the repository ever deployed to production. */
  private async deploysAtAll(repoId: string, workspace: string): Promise<boolean> {
    const [build, reported] = await Promise.all([
      this.db.prepare("SELECT 1 AS x FROM deployments WHERE repo_id = ? AND workspace = ? AND kind = 'production' LIMIT 1").bind(repoId, workspace).first(),
      this.db.prepare("SELECT 1 AS x FROM reported_deployments WHERE repo_id = ? AND production_environment = 1 LIMIT 1").bind(repoId).first(),
    ]);
    return build != null || reported != null;
  }

  /** A repository purged: what it shipped goes with it. */
  async purge(repoId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM shipped_commits WHERE repo_id = ?").bind(repoId),
      this.db.prepare("DELETE FROM shipped_walks WHERE repo_id = ?").bind(repoId),
    ]);
  }
}
