import type { Commit, GitAccess, TreeEntry } from "@g1t/contracts";

/**
 * The storage that actually holds git repositories. The repos service
 * depends on this port; Artifacts is one adapter for it.
 *
 * `key` is the store's own name for a repo.
 */
export interface GitStore {
  create(key: string, options: { description?: string; defaultBranch: string }): Promise<void>;
  /** A copy-on-write copy of `sourceKey`. */
  fork(sourceKey: string, targetKey: string): Promise<void>;
  /** A remote URL and short-lived credential for git itself. */
  access(key: string, scope: "read" | "write"): Promise<GitAccess>;

  /** Newest first along the first-parent chain; empty for an unknown ref. */
  log(key: string, ref: string, limit: number): Promise<Commit[]>;
  /** Null when the tree does not exist. */
  readTree(key: string, treeHash: string): Promise<TreeEntry[] | null>;
  readBlob(key: string, blobHash: string): Promise<Blob | null>;
  /** Null when the ref or path does not resolve to a file. */
  readFile(key: string, ref: string, path: string): Promise<Blob | null>;
}
