import type { User, Viewer } from "./identity";
import type { Result } from "./result";

export type Repo = {
  id: string;
  /** The slug of the workspace that owns it: the first URL segment. */
  namespace: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  ownerId: string;
  defaultBranch: string;
  /** Set when this repo is a pull request's working copy of another repo. */
  forkOf: string | null;
  /**
   * Whether the default branch is protected: it changes only by merging a
   * pull request, and pushes to it are refused.
   */
  protected: boolean;
  /** RFC 3339. */
  createdAt: string;
};

export type RepoPath = { namespace: string; name: string };

export type Commit = {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  parents: string[];
  /** RFC 3339. */
  authoredAt: string;
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
  /** The workspace to create it in; the creator must be a member. */
  namespace: string;
  name: string;
  description?: string | null;
  isPrivate?: boolean;
  /**
   * The https address of a public git repository to copy the default branch
   * of, such as `https://github.com/owner/repo`.
   */
  importUrl?: string;
};

/** Repositories: metadata, contents and git access. */
export interface ReposApi {
  get(path: RepoPath, viewer: Viewer): Promise<Result<Repo>>;
  getById(id: string, viewer: Viewer): Promise<Result<Repo>>;
  /**
   * The workspaces in which this account made a public repository, and so
   * a public project anyone can see. By account id.
   */
  publicNamespaces(ownerId: string): Promise<string[]>;
  /** Repos the viewer may see, newest first, optionally matching `query`. */
  list(
    viewer: Viewer,
    options?: {
      query?: string;
      /** Only repos in this workspace. */
      namespace?: string;
      /** Only repos in workspaces the viewer belongs to. */
      memberOnly?: boolean;
    },
  ): Promise<Repo[]>;
  create(owner: User, input: CreateRepoInput): Promise<Result<Repo>>;
  /**
   * Changes whichever details are given. Members of the repository's
   * workspace only. An empty description clears it.
   */
  update(
    actor: User,
    path: RepoPath,
    changes: { description?: string; isPrivate?: boolean; protected?: boolean },
  ): Promise<Result<Repo>>;

  tree(path: RepoPath, viewer: Viewer, ref: string | null, treePath: string): Promise<Result<TreeView>>;
  blob(path: RepoPath, viewer: Viewer, ref: string, filePath: string): Promise<Result<BlobView>>;
  log(path: RepoPath, viewer: Viewer, ref: string | null, limit: number): Promise<Result<Commit[]>>;
  /**
   * Who last changed each line of a file as of `ref` (the default branch if
   * null). Not found when the file is missing or is not text.
   */
  blame(path: RepoPath, viewer: Viewer, ref: string | null, filePath: string): Promise<Result<Blame>>;

  /**
   * A copy-on-write copy of `source`, hidden from listings, for one pull request
   * to work in.
   */
  forkForPull(sourceId: string, pullId: string, actor: User): Promise<Result<Repo>>;

  /**
   * Authorizes a git operation and returns where to send it. Pushing to a
   * repo that does not exist creates it in the pusher's own namespace.
   */
  gitAccess(path: RepoPath, viewer: Viewer, service: GitService): Promise<Result<GitAccess>>;

  /** The repository's branches, default branch first. */
  branches(path: RepoPath, viewer: Viewer): Promise<Result<Branch[]>>;

  /**
   * Moves a repository's default branch to the head of a pull request's
   * source: a fork (`sourceId` is the fork) or one of the repository's own
   * branches (`sourceId` is the repository, and `branch` is required).
   * Refused with "conflict" when the source is behind, since that would
   * discard commits.
   */
  land(sourceId: string, actor: User, branch?: string | null): Promise<Result<{ commit: string; previous: string | null }>>;

  /**
   * What `head` changes relative to `base`. `head` is a branch or a commit
   * and defaults to the default branch. With no `base`, a fork is compared
   * with the last commit it shares with the repository it came from, and a
   * branch with the point where it left the default branch.
   */
  compare(repoId: string, viewer: Viewer, base?: string | null, head?: string | null): Promise<Result<Comparison>>;
}

/** Lines `start` to `end` (inclusive, from 1) last changed by `commit`. */
export type BlameRange = { start: number; end: number; commit: string };

/** Who last changed each line of a file. */
export type Blame = {
  /** The commit the file was read at. */
  head: string;
  /** Every line, in order, in runs that share a commit. */
  ranges: BlameRange[];
  /** The commits the ranges name, each once. */
  commits: Commit[];
  /** True when the history was too long to read in full. */
  partial: boolean;
};

/** A branch and the commit it points to. */
export type Branch = { name: string; hash: string };

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
