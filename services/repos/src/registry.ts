import type { Repo, RepoPath, Viewer } from "@g1t/contracts";

type RepoRow = {
  id: string;
  namespace: string;
  name: string;
  description: string | null;
  is_private: number;
  owner_id: string;
  default_branch: string;
  fork_of: string | null;
  created_at: number;
};

function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    namespace: row.namespace,
    name: row.name,
    description: row.description,
    isPrivate: row.is_private === 1,
    ownerId: row.owner_id,
    defaultBranch: row.default_branch,
    forkOf: row.fork_of,
    createdAt: row.created_at * 1000,
  };
}

/** The key a repo is stored under in the git store. */
export function storeKey(repo: RepoPath): string {
  return `${repo.namespace}--${repo.name}`;
}

export function canRead(repo: Repo, viewer: Viewer): boolean {
  return !repo.isPrivate || repo.ownerId === viewer?.id;
}

export function canWrite(repo: Repo, viewer: Viewer): boolean {
  return repo.ownerId === viewer?.id;
}

/** Repository metadata in D1. */
export class RepoRegistry {
  constructor(private readonly db: D1Database) {}

  async byPath(path: RepoPath): Promise<Repo | null> {
    const row = await this.db
      .prepare("SELECT * FROM repos WHERE namespace = ? AND name = ?")
      .bind(path.namespace.toLowerCase(), path.name.toLowerCase())
      .first<RepoRow>();
    return row ? toRepo(row) : null;
  }

  async byId(id: string): Promise<Repo | null> {
    const row = await this.db
      .prepare("SELECT * FROM repos WHERE id = ?")
      .bind(id)
      .first<RepoRow>();
    return row ? toRepo(row) : null;
  }

  /** Excludes attempt forks. */
  async list(
    viewer: Viewer,
    options: { query?: string; namespace?: string },
  ): Promise<Repo[]> {
    const where = ["fork_of IS NULL", "(is_private = 0 OR owner_id = ?)"];
    const params: unknown[] = [viewer?.id ?? ""];
    if (options.namespace) {
      where.push("namespace = ?");
      params.push(options.namespace.toLowerCase());
    }
    if (options.query?.trim()) {
      where.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const pattern = `%${options.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      params.push(pattern, pattern);
    }
    const { results } = await this.db
      .prepare(
        `SELECT * FROM repos WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT 50`,
      )
      .bind(...params)
      .all<RepoRow>();
    return results.map(toRepo);
  }

  async insert(repo: Repo): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO repos
           (id, namespace, name, description, is_private, owner_id, default_branch, fork_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        repo.id,
        repo.namespace,
        repo.name,
        repo.description,
        Number(repo.isPrivate),
        repo.ownerId,
        repo.defaultBranch,
        repo.forkOf,
        Math.floor(repo.createdAt / 1000),
      )
      .run();
  }
}
