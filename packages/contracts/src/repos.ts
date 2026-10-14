import type { Contributors, Languages, License, NewRelease, Release, ReleaseChange, RepoAbout, Stargazer, StarredRepo, Stars } from "./about";
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
  /**
   * Set when this repo is a pull request's working copy of another repo
   * (namespace `pulls`, hidden from listings). A fork someone made into a
   * workspace is an ordinary repository with `parentId` instead.
   */
  forkOf: string | null;
  /**
   * The repository this one was forked from, when someone forked it into
   * their workspace. Null once it is detached, or when its parent changed
   * who can see it.
   */
  parentId?: string | null;
  /**
   * What it was made a fork of, kept when it is detached: Actions and
   * issues stay off by default, and its pull requests into the parent
   * still merge.
   */
  forkedFrom?: string | null;
  /** Where `parentId` is, for a viewer who may read it (from `get`, `getById` and `forks`). */
  parent?: RepoPath | null;
  /** A private repository's admins let others fork it. Public ones can always be forked. */
  allowForking?: boolean;
  /** The most branches and tags one push may change; pushes over it are refused whole. Null for no limit. */
  maxRefUpdates?: number | null;
  /**
   * Whether the default branch is protected: it changes only by merging a
   * pull request, and pushes to it are refused.
   */
  protected: boolean;
  /** RFC 3339. */
  createdAt: string;
  /**
   * Words that say what it is about, for search and Explore: lowercase
   * letters, digits and hyphens, at most 20.
   */
  topics: string[];
  /** Its home page, an http(s) address. */
  website?: string | null;
  /**
   * RFC 3339: when it was archived. While archived it is read-only:
   * pushes, merges, agents and workflows are refused, and issues and pull
   * requests are locked. Null when it is not archived.
   */
  archivedAt?: string | null;
};

export type ForkRepoInput = {
  /** The workspace to fork it into. */
  namespace: string;
  /** The fork's name; the source's when absent. */
  name?: string;
  /** The source's when absent; an empty string clears it. */
  description?: string;
  /** Copy only the default branch (the default), or every branch and tag. */
  defaultBranchOnly?: boolean;
};

/** How a pull request's branch is brought up to date: a merge commit, or its commits made again on the base. */
export type UpdateMethod = "merge" | "rebase";

/** What `syncFork` did. */
export type SyncStatus = "up_to_date" | "fast_forwarded" | "merged" | "conflicted";

export type SyncedFork = {
  status: SyncStatus;
  branch: string;
  /** The branch's head after syncing. */
  head: string;
  /** Commits the parent's branch had that the fork's did not. */
  behind: number;
  /** Commits the fork's branch had that the parent's did not. */
  ahead: number;
  /** For `conflicted`: the files both sides changed (at most 20). */
  conflicts: string[];
};

/** How long a deleted repository can be restored before it is purged. */
export const RESTORE_DAYS = 30;

/** A deleted repository, as its workspace's Recently deleted list shows it. */
export type DeletedRepo = {
  id: string;
  namespace: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  /** RFC 3339. */
  deletedAt: string;
  /** The username of who deleted it. */
  deletedBy: string;
  /** RFC 3339: when it is purged, unless restored first. */
  purgeAfter: string;
};

/** Whether a repository is archived or deleted, for services deciding whether to act on it. */
export type RepoStatus = { archived: boolean; deleted: boolean };

/** The most topics a repository has, and the longest topic. */
export const MAX_TOPICS = 20;
export const MAX_TOPIC_CHARS = 35;

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

/**
 * Where repositories may be kept. `euAvailable`: an EU namespace takes new
 * repositories, so a workspace may keep its data in the EU.
 */
export type StorageOptions = { euAvailable: boolean };

/** Repositories: metadata, contents and git access. */
export interface ReposApi {
  get(path: RepoPath, viewer: Viewer): Promise<Result<Repo>>;
  getById(id: string, viewer: Viewer): Promise<Result<Repo>>;
  /**
   * Of these ids (at most 500), the repositories the viewer can read, in
   * one call. Forks and deleted repositories are left out.
   */
  readable(ids: string[], viewer: Viewer): Promise<Repo[]>;
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
    changes: {
      description?: string;
      isPrivate?: boolean;
      protected?: boolean;
      topics?: string[];
      /** An empty string clears it. */
      website?: string;
      /** Whether a private repository may be forked (Admin). */
      allowForking?: boolean;
      /** The most branches and tags one push may change (Admin); 0 for no limit. */
      maxRefUpdates?: number;
    },
  ): Promise<Result<Repo>>;
  /**
   * Deletes the repository. Owners only, who type its full name as
   * `confirm`. It is hidden at once and can be restored for
   * `RESTORE_DAYS` days, then purged. Publishes `repo.deleted`.
   */
  delete(actor: User, path: RepoPath, confirm: string): Promise<Result<DeletedRepo>>;
  /** A workspace's recently deleted repositories, newest first. Owners only; empty otherwise. */
  deleted(viewer: Viewer, namespace: string): Promise<DeletedRepo[]>;
  /** Brings a deleted repository back as it was. Owners only. Publishes `repo.restored`. */
  restore(actor: User, path: RepoPath): Promise<Result<Repo>>;
  /**
   * Removes a deleted repository for good now, its git data with it, and
   * frees its name. Owners only, who type its full name. Publishes `repo.purged`.
   */
  purge(actor: User, path: RepoPath, confirm: string): Promise<Result<boolean>>;
  /**
   * Renames the repository in its workspace. Owners only. The old path
   * redirects until a repository is made there. Publishes `repo.renamed`.
   */
  rename(actor: User, path: RepoPath, name: string): Promise<Result<Repo>>;
  /**
   * Archives the repository (read-only) or unarchives it. Owners only.
   * Publishes `repo.archived` or `repo.unarchived`.
   */
  archive(actor: User, path: RepoPath, archived: boolean): Promise<Result<Repo>>;
  /**
   * Makes the repository public or private. Owners only, who type its full
   * name as `confirm`. Publishes `repo.updated` and `repo.visibility_changed`.
   */
  setVisibility(actor: User, path: RepoPath, isPrivate: boolean, confirm: string): Promise<Result<Repo>>;
  /** Makes another existing branch the default. Members. */
  setDefaultBranch(actor: User, path: RepoPath, branch: string): Promise<Result<Repo>>;
  /**
   * Renames a branch; pull requests from it follow, and addresses naming the
   * old one redirect. Members; only owners rename the default branch.
   */
  renameBranch(actor: User, path: RepoPath, from: string, to: string): Promise<Result<Repo>>;
  /**
   * Makes a branch named `name` at `from`: a branch, a tag or a commit (the
   * default branch when empty). Needs push; the rules for creating it hold.
   * Restoring a deleted branch is making it again at the commit
   * `removeBranch` answered with.
   */
  createBranch(actor: User, path: RepoPath, name: string, from?: string): Promise<Result<Branch>>;
  /**
   * Deletes a branch, never the default. Needs push; the rules for deleting
   * it hold. Given `head`, a branch that has moved from it is left alone.
   * Answers with the branch as it was, to restore it with `createBranch`.
   */
  removeBranch(actor: User, path: RepoPath, branch: string, head?: string): Promise<Result<Branch>>;
  /** What a branch renamed away from `branch` is called now, or null. */
  resolveBranch(repoId: string, branch: string): Promise<string | null>;
  /** Whether a repository is archived or deleted; an unknown id answers as deleted. */
  statusById(id: string): Promise<RepoStatus>;
  /** What a workspace may choose about where its repositories are kept. */
  storageOptions(): Promise<StorageOptions>;
  /**
   * Moves the repository to the workspace `to`, keeping its name, id and
   * everything under it. The actor must own both workspaces. The old path
   * redirects until a repository is made there. Publishes `repo.transferred`.
   */
  transfer(actor: User, path: RepoPath, to: string): Promise<Result<Repo>>;
  /**
   * Where a repository transferred away from `path` is now; null when
   * `path` is a repository or never was one that moved. Callers check the
   * viewer may see it there.
   */
  resolvePath(path: RepoPath): Promise<RepoPath | null>;

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
   * Forks `path` into the workspace `input.namespace`: a new repository
   * with the source's code (its default branch unless
   * `defaultBranchOnly` is false) and description, nothing else. Public
   * repositories can always be forked, private ones when their admins
   * allow it; a fork is as visible as its source. Publishes `repo.created`
   * and `repo.forked`.
   */
  fork(actor: User, path: RepoPath, input: ForkRepoInput): Promise<Result<Repo>>;
  /** The forks of `path` the viewer may read, newest first. */
  forks(path: RepoPath, viewer: Viewer, limit?: number): Promise<Result<Repo[]>>;
  /**
   * Brings a fork's branch (its default branch when absent) up to date
   * with its parent's: fast-forwarded when only behind, merged when the
   * two changed different files, left alone (`conflicted`) otherwise.
   */
  syncFork(actor: User, path: RepoPath, branch?: string): Promise<Result<SyncedFork>>;
  /** Makes a fork an ordinary repository with no parent (Admin). */
  detachFork(actor: User, path: RepoPath): Promise<Result<Repo>>;

  /**
   * Authorizes a git operation and returns where to send it. Pushing to a
   * repo that does not exist creates it in the pusher's own namespace.
   */
  gitAccess(path: RepoPath, viewer: Viewer, service: GitService): Promise<Result<GitAccess>>;

  /** The repository's branches, default branch first. */
  branches(path: RepoPath, viewer: Viewer): Promise<Result<Branch[]>>;

  /** Which commit last changed each entry of a directory at `ref` (the default branch when null). */
  lastCommits(path: RepoPath, viewer: Viewer, ref: string | null, treePath: string): Promise<Result<LastCommits>>;

  /**
   * How far each branch head has moved from `base` (the default branch's
   * head commit), with each head's commit and `base`'s own, in one call.
   * Kept by the pair of hashes in the repos service.
   */
  branchDrift(path: RepoPath, viewer: Viewer, base: string, heads: string[]): Promise<Result<BranchDrifts>>;

  /** The repository's tags, newest commit first, at most 100. */
  tags(path: RepoPath, viewer: Viewer): Promise<Result<Tag[]>>;

  /**
   * The Files page's About in one answer: license, security policy,
   * languages, contributors, stars and releases. What comes from files and
   * history is kept by commit and worked out in the background when it is
   * behind the head (see `about.ts`).
   */
  about(path: RepoPath, viewer: Viewer): Promise<Result<RepoAbout>>;
  languages(path: RepoPath, viewer: Viewer): Promise<Result<Languages>>;
  /** Everyone whose commits are on the default branch, with their weeks. */
  contributors(path: RepoPath, viewer: Viewer): Promise<Result<Contributors>>;
  license(path: RepoPath, viewer: Viewer): Promise<Result<License | null>>;
  /** How many starred it, and whether the viewer did. */
  stars(path: RepoPath, viewer: Viewer): Promise<Result<Stars>>;
  /** Stars it for the actor, or takes the star back. */
  star(actor: User, path: RepoPath, starred: boolean): Promise<Result<Stars>>;
  /** Who starred it, newest first, 100 a page from 1. */
  stargazers(path: RepoPath, viewer: Viewer, page?: number): Promise<Result<Stargazer[]>>;
  /** What a person starred that the viewer can see, newest first, at most 100. */
  starred(username: string, viewer: Viewer): Promise<StarredRepo[]>;
  /** Releases, newest first, at most 100: drafts only for those who can push. */
  releases(path: RepoPath, viewer: Viewer): Promise<Result<Release[]>>;
  /** One release by id or tag, or the latest. */
  release(path: RepoPath, viewer: Viewer, which: { id?: string; tag?: string; latest?: boolean }): Promise<Result<Release>>;
  /** Needs Write. A tag that does not exist yet is made at `target`. */
  createRelease(actor: User, path: RepoPath, release: NewRelease): Promise<Result<Release>>;
  updateRelease(actor: User, path: RepoPath, id: string, change: ReleaseChange): Promise<Result<Release>>;
  /** The tag stays. */
  deleteRelease(actor: User, path: RepoPath, id: string): Promise<Result<boolean>>;

  /**
   * Every file at `ref` (the default branch when null), at most `limit`
   * (10,000 at most); symlinks too with `links`, for an archive. No viewer:
   * check access first.
   */
  listFiles(repoId: string, ref: string | null, limit: number, options?: { links?: boolean }): Promise<FileList>;

  /**
   * What an archive link's `token` (made by the API's tarball and zipball
   * routes) lets anyone holding it download from the repository at
   * `path`: one commit, for ten minutes. Null when it is not for this
   * repository, has ended or does not open. No viewer: the token is the
   * permission.
   */
  openArchiveToken(path: RepoPath, token: string): Promise<ArchiveGrant | null>;

  /** Blobs' bytes as standard base64, at most 100; `data` is null for one missing or over `maxBytes`. No viewer. */
  rawBlobs(repoId: string, hashes: string[], maxBytes: number): Promise<RawBlob[]>;

  /** One file's bytes at a branch, tag or commit; null when missing or over `maxBytes`. No viewer: check access first. */
  rawFile(repoId: string, ref: string, path: string, maxBytes: number): Promise<RawFile | null>;

  /**
   * Writes one file on a new branch made from the default branch's head, as
   * one commit by `actor`, for a change g1t proposes on their behalf (a
   * starter workflow). Refused unless they may push, when the branch exists,
   * or when the file is already there.
   */
  commitFile(
    repo: RepoPath,
    actor: User,
    file: { branch: string; path: string; content: string; message: string },
  ): Promise<Result<{ branch: string; commit: string }>>;

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
  /**
   * With no `base`, a branch is compared from where it left `baseBranch`
   * (the default branch when absent). With `paths`, only those files (at
   * most 50), with their lines: how a file a large comparison lists as
   * `omitted` is read. With `targetId` (no `base`), `repoId` is a fork of
   * that repository, directly or through other forks, and the head is
   * compared from where it left `baseBranch` there: a pull request from a
   * fork. Both must be readable.
   */
  compare(
    repoId: string,
    viewer: Viewer,
    base?: string | null,
    head?: string | null,
    baseBranch?: string | null,
    paths?: string[] | null,
    targetId?: string | null,
  ): Promise<Result<Comparison>>;

  /**
   * Services only, for the runner's sweep: up to `limit` queued nightly
   * backups, each now running with a token of its own, so long as no more
   * than `maxRunning` are then running. Empty when backups are off.
   */
  claimBackups(limit: number, maxRunning: number): Promise<BackupClaim[]>;

  /**
   * Services only: a backup's sandbox stopped before it reported, so the
   * job is tried again later. Refused harmlessly once it has reported.
   */
  failBackup(jobId: string, token: string, error: string): Promise<Result<boolean>>;
}

/**
 * A nightly backup to start (`g1t_contracts::backups`): the sandbox is
 * given the job's id and token, and nothing else.
 */
export type BackupClaim = {
  jobId: string;
  token: string;
  repoId: string;
  path: RepoPath;
};

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
  /** True when the history was too long to read in full (too many commits, or too long to read). */
  partial: boolean;
};

/** A branch and the commit it points to. */
export type Branch = { name: string; hash: string };

/** Each entry's last commit; `complete` is false when some were not reached. */
export type LastCommits = { entries: { name: string; commit: Commit }[]; complete: boolean };

/** Commits a branch has that the default branch does not, and the other way round. */
export type BranchDriftCount = { ahead: number; behind: number };

/**
 * `base`'s commit, and each head's commit and drift in the order asked;
 * `drift` is null when the two histories do not meet within what is read.
 */
export type BranchDrifts = {
  base: Commit | null;
  branches: { head: string; commit: Commit | null; drift: BranchDriftCount | null }[];
};

/** A tag, and its commit when it could be read. */
export type Tag = { name: string; commit: Commit | null };

/** Files at a commit, and whether there were more than were listed. */
export type FileList = {
  commit: string | null;
  /** When the commit was made (RFC 3339). */
  date?: string;
  /** `kind`: `exec` for an executable file, `symlink` for a link (its blob is where it points). */
  files: { path: string; hash: string | null; kind?: "blob" | "exec" | "symlink" }[];
  truncated: boolean;
};

/** One commit of a repository an archive link lets its holder download. */
export type ArchiveGrant = { repoId: string; namespace: string; name: string; commit: string };

/** One blob's bytes, standard base64; null when missing or too large. */
export type RawBlob = { hash: string; size: number; data: string | null };

/** One file's bytes, standard base64. */
export type RawFile = { size: number; data: string };

/**
 * What came of bringing a pull request up to date with the default branch
 * without a sandbox. `needs_agent` pushed nothing: the runner's `update`
 * merges it in a sandbox, with an agent if it conflicts.
 */
export type PullBranchUpdate =
  | { outcome: "updated"; commit: string; previous: string }
  | { outcome: "up_to_date"; commit: string }
  | {
      outcome: "needs_agent";
      /**
       * `overlap`: both sides changed some of the same files. `conflicting`:
       * merging is known to conflict. `unsupported`: it could not be worked
       * out without git, such as for a very large change.
       */
      reason: "overlap" | "conflicting" | "unsupported";
      detail: string;
      /** The files both changed, or that conflict, when known. */
      paths: string[];
    };

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
  /**
   * True when the comparison reached its limit on lines before this file,
   * so it is listed without its lines or counts: `compare` with its path
   * in `paths` has them.
   */
  omitted?: boolean;
};

/** What changed between two commits. */
export type Comparison = {
  base: string | null;
  head: string;
  files: FileDiff[];
  /** True when more files changed than are listed. */
  truncated: boolean;
};
