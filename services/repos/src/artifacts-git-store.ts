import type { Commit, GitAccess, TreeEntry } from "@g1t/contracts";

import type { GitStore } from "./git-store";

const TOKEN_TTL_SECONDS = 300;

function isCode(error: unknown, code: ArtifactsErrorCode): boolean {
  return (error as Partial<ArtifactsError> | null)?.code === code;
}

function toCommit(commit: ArtifactsCommitMetadata): Commit {
  return {
    hash: commit.hash,
    treeHash: commit.treeHash,
    message: commit.message,
    author: commit.author,
    parents: commit.parents,
    authoredAt: commit.authoredAt * 1000,
  };
}

/** {@link GitStore} backed by Cloudflare Artifacts. */
export class ArtifactsGitStore implements GitStore {
  constructor(private readonly artifacts: Artifacts) {}

  private async use<T>(key: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
    const repo = await this.artifacts.get(key);
    try {
      return await fn(repo);
    } finally {
      repo[Symbol.dispose]();
    }
  }

  async create(
    key: string,
    options: { description?: string; defaultBranch: string },
  ): Promise<void> {
    try {
      await this.artifacts.create(key, {
        description: options.description,
        setDefaultBranch: options.defaultBranch,
      });
    } catch (error) {
      // Left behind by an earlier failed attempt; adopt it.
      if (!isCode(error, "ALREADY_EXISTS")) throw error;
    }
  }

  async fork(sourceKey: string, targetKey: string): Promise<void> {
    await this.use(sourceKey, async (repo) => {
      try {
        await repo.fork(targetKey, { defaultBranchOnly: true });
      } catch (error) {
        if (!isCode(error, "ALREADY_EXISTS")) throw error;
      }
    });
  }

  async access(key: string, scope: "read" | "write"): Promise<GitAccess> {
    return this.use(key, async (repo) => {
      const [info, token] = await Promise.all([
        repo.info(),
        repo.createToken(scope, TOKEN_TTL_SECONDS),
      ]);
      return { remote: info.remote, token: token.plaintext };
    });
  }

  async log(key: string, ref: string, limit: number): Promise<Commit[]> {
    return this.use(key, async (repo) =>
      (await repo.log({ ref, limit })).map(toCommit),
    );
  }

  async readTree(key: string, treeHash: string): Promise<TreeEntry[] | null> {
    return this.use(key, async (repo) => {
      const entries = await repo.readTree(treeHash);
      return (
        entries?.map((entry) => ({
          name: entry.name,
          hash: entry.hash,
          kind: entry.type,
        })) ?? null
      );
    });
  }

  async readBlob(key: string, blobHash: string): Promise<Blob | null> {
    return this.use(key, (repo) => repo.readBlob(blobHash));
  }

  async readFile(key: string, ref: string, path: string): Promise<Blob | null> {
    return this.use(key, (repo) => repo.readFile({ ref, path }));
  }
}
