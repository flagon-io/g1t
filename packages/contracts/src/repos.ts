import type { User, Viewer } from "./identity";
import type { Result } from "./result";

export type Repo = {
  id: string;
  /** The owning user's (later, workspace's) name: the first URL segment. */
  namespace: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  ownerId: string;
  defaultBranch: string;
  /** Set when this repo is an attempt's working copy of another repo. */
  forkOf: string | null;
  createdAt: number;
};

export type RepoPath = { namespace: string; name: string };

export type Commit = {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  parents: string[];
  authoredAt: number;
};

export type TreeEntry = {
  name: string;
  hash: string;
  kind: "tree" | "blob" | "symlink" | "gitlink" | "exec";
};

export type TreeView = {
  repo: Repo;
  ref: string;
  path: string;
  /** Null when the repo has no commits yet. */
  head: Commit | null;
  entries: TreeEntry[];
  readme: { name: string; text: string | null } | null;
};

export type BlobView = {
  repo: Repo;
  ref: string;
  path: string;
  size: number;
  /** Null when the file is binary or too large to show. */
  text: string | null;
};

/** A git remote and a short-lived credential for it. */
export type GitAccess = { remote: string; token: string };

export type GitService = "git-upload-pack" | "git-receive-pack";

export type CreateRepoInput = {
  name: string;
  description?: string | null;
  isPrivate?: boolean;
};

/** Repositories: metadata, contents and git access. */
export interface ReposApi {
  get(path: RepoPath, viewer: Viewer): Promise<Result<Repo>>;
  getById(id: string, viewer: Viewer): Promise<Result<Repo>>;
  /** Repos the viewer may see, newest first, optionally matching `query`. */
  list(viewer: Viewer, options?: { query?: string; namespace?: string }): Promise<Repo[]>;
  create(owner: User, input: CreateRepoInput): Promise<Result<Repo>>;

  tree(path: RepoPath, viewer: Viewer, ref: string | null, treePath: string): Promise<Result<TreeView>>;
  blob(path: RepoPath, viewer: Viewer, ref: string, filePath: string): Promise<Result<BlobView>>;
  log(path: RepoPath, viewer: Viewer, ref: string | null, limit: number): Promise<Result<Commit[]>>;

  /**
   * A copy-on-write copy of `source`, hidden from listings, for one attempt
   * to work in.
   */
  forkForAttempt(sourceId: string, attemptId: string, actor: User): Promise<Result<Repo>>;

  /**
   * Authorizes a git operation and returns where to send it. Pushing to a
   * repo that does not exist creates it in the pusher's own namespace.
   */
  gitAccess(path: RepoPath, viewer: Viewer, service: GitService): Promise<Result<GitAccess>>;

  /**
   * Moves the default branch of the repo a fork came from to the fork's
   * head. Refused with "conflict" when the fork is behind, since that would
   * discard commits.
   */
  land(forkId: string, actor: User): Promise<Result<{ commit: string; previous: string | null }>>;

  /**
   * What a repository's head changes. An attempt's fork is compared with the
   * last commit it shares with the repository it came from, unless `base`
   * says otherwise.
   */
  compare(repoId: string, viewer: Viewer, base?: string | null): Promise<Result<Comparison>>;
}

export type DiffLine = {
  kind: "context" | "add" | "delete";
  /** Line number in the old file; null for added lines. */
  old: number | null;
  /** Line number in the new file; null for deleted lines. */
  new: number | null;
  text: string;
};

/** A run of changed lines with their surrounding context. */
export type Hunk = { lines: DiffLine[] };

export type FileDiff = {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  /** True when the file is binary or too large, so no lines are shown. */
  binary: boolean;
  hunks: Hunk[];
};

/** What changed between two commits. */
export type Comparison = {
  base: string | null;
  head: string;
  files: FileDiff[];
  /** True when the change was too large to return in full. */
  truncated: boolean;
};
