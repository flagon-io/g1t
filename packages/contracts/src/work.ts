import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * The filter on lists of issues and pull requests. An open pull request is
 * a draft or one ready for review; a closed one was merged or closed
 * without merging.
 */
export type State = "open" | "closed";

/** Why an issue was closed. */
export type IssueReason = "completed" | "not_planned";

/**
 * Something that should change in a repository: a bug, a feature, a
 * question. Opened by a person, an agent or an integration. Pull requests
 * are made against it; the one that is merged resolves it.
 *
 * Issues and pull requests share one sequence of numbers per repository.
 */
export type Issue = {
  id: string;
  repoId: string;
  /** Shown as `#12`. */
  number: number;
  title: string;
  /** Markdown. Also what an agent is given to work from. */
  body: string;
  labels: string[];
  /** Commands that must pass for a pull request to be accepted. */
  checks: string[];
  state: State;
  /** Set when closed. */
  reason: IssueReason | null;
  /** The number of the pull request whose merge closed this issue. */
  resolvedBy: number | null;
  author: User;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  updatedAt: string;
  /** RFC 3339. */
  closedAt: string | null;
  /** Pull requests made against this issue, in any state. */
  pullCount: number;
  commentCount: number;
};

/** `draft` is still being worked on; `open` is ready for review. */
export type PullStatus = "draft" | "open" | "merged" | "closed";

/** Where the agent runs: on g1t's sandboxes, or in someone's own session. */
export type Runtime = "hosted" | "external";

/**
 * A proposed change. It is made either in a fork created for it, which is
 * how agents work, or on a branch pushed to the repository itself.
 */
export type Pull = {
  id: string;
  repoId: string;
  /** Shown as `#12`. */
  number: number;
  /** The number of the issue this is for, if any. */
  issue: number | null;
  title: string;
  /** Markdown: what changed and why. Set when marked ready. */
  body: string | null;
  /** A label for the agent doing the work, e.g. `claude-code`. */
  agent: string;
  runtime: Runtime;
  status: PullStatus;
  /** The fork holding the change, unless it is on a branch. */
  fork: RepoPath | null;
  /** The fork's repository id. */
  forkRepoId: string | null;
  /** The branch of the repository holding the change, unless it is in a fork. */
  branch: string | null;
  headCommit: string | null;
  /**
   * For a merged pull request, what the branch pointed to before the merge.
   * Comparing against it shows what the pull request changed.
   */
  mergeBase: string | null;
  /** Username of whoever merged it. */
  mergedBy: string | null;
  /** RFC 3339. */
  mergedAt: string | null;
  /**
   * Set on a pull request closed because another one for the same issue was
   * merged: that one's number.
   */
  supersededBy: number | null;
  /**
   * Where the latest run of the issue's acceptance checks stands, if there
   * has been one against the current head.
   */
  checkStatus: CheckStatus | null;
  author: User;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  updatedAt: string;
};

/** `queued` waits for a sandbox; `errored` means the checks could not be run. */
export type CheckStatus = "queued" | "running" | "passed" | "failed" | "errored";

/** How one acceptance check went. */
export type CheckResult = {
  command: string;
  passed: boolean;
  /** Null when the command was stopped for taking too long. */
  exitCode: number | null;
  /** What the command printed; the end of it, when there was a lot. */
  output: string;
  durationMs: number;
};

/**
 * One run of an issue's acceptance checks against a pull request's head, in
 * a sandbox that holds nothing but that commit.
 */
export type CheckRun = {
  id: string;
  /** The commit that was checked. */
  headCommit: string;
  status: CheckStatus;
  results: CheckResult[];
  /** Why the checks could not be run, when `status` is `errored`. */
  error: string | null;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  finishedAt: string | null;
};

/** A reviewer's decision on a pull request. */
export type Verdict = "approve" | "request_changes";

/**
 * A comment on an issue or a pull request. On a pull request it can sit on
 * one line of the change, and it can carry a reviewer's verdict.
 */
export type Comment = {
  id: string;
  author: User;
  /** Markdown. */
  body: string;
  /** The file commented on, for a comment on a line. */
  path: string | null;
  /** The line of that file, as numbered after the change. */
  line: number | null;
  verdict: Verdict | null;
  /** RFC 3339. */
  createdAt: string;
};

export type NewComment = {
  /** May be empty when approving. */
  body: string;
  path?: string;
  line?: number;
  verdict?: Verdict;
};

/** What a sandbox needs to carry out a check run. */
export type CheckJob = {
  runId: string;
  /** Lets the sandbox, and nothing else, report this run's results. */
  token: string;
  commands: string[];
  /** The repository holding the commit: the fork, or the repository itself. */
  source: RepoPath;
  commit: string;
  /** Who opened the pull request, and so can read its source. */
  author: User;
  /** Username of whoever wrote the checks: the issue's author. */
  requestedBy: string;
  repo: RepoPath;
  number: number;
};

export type CheckReport = { results?: CheckResult[]; error?: string; skip?: boolean };

export type SessionEntryKind = "prompt" | "message" | "tool_call" | "tool_result" | "note";

/** One step of an agent's session: the "why" behind a pull request's commits. */
export type SessionEntry = {
  seq: number;
  kind: SessionEntryKind;
  text: string;
  /** For tool calls and results. */
  tool: string | null;
  /** The fork's head commit when this entry was recorded, if known. */
  commit: string | null;
  /** RFC 3339. */
  at: string;
};

export type NewSessionEntry = Pick<SessionEntry, "kind" | "text"> &
  Partial<Pick<SessionEntry, "tool" | "commit">>;

export type IssueDetail = {
  issue: Issue;
  /** Every pull request made against it, oldest first. */
  pulls: Pull[];
  comments: Comment[];
};

export type PullDetail = {
  pull: Pull;
  /** The issue it is for, if any. */
  issue: Issue | null;
  comments: Comment[];
  /** The latest run of the issue's acceptance checks. */
  checks: CheckRun | null;
};

export type OpenIssueInput = {
  title: string;
  body: string;
  labels?: string[];
  checks?: string[];
};

export type UpdateIssueInput = { title?: string; body?: string; labels?: string[] };

export type OpenPullInput = {
  /** The number of the issue this is for. */
  issue?: number;
  /** Defaults to the issue's title; required without an issue. */
  title?: string;
  /** What changed and why. Usually set later, when a draft is marked ready. */
  body?: string;
  /**
   * A branch of the repository that already holds the change. The pull
   * request is then ready for review at once and has no fork.
   */
  branch?: string;
  agent: string;
  runtime: Runtime;
};

/** Issues, pull requests, comments and sessions. */
export interface WorkApi {
  openIssue(actor: User, repo: RepoPath, input: OpenIssueInput): Promise<Result<Issue>>;
  /** Newest first. */
  listIssues(
    repo: RepoPath,
    viewer: Viewer,
    filter?: { state?: State; label?: string },
  ): Promise<Result<Issue[]>>;
  getIssue(repo: RepoPath, number: number, viewer: Viewer): Promise<Result<IssueDetail>>;
  /** The author or a member of the workspace may. */
  updateIssue(actor: User, repo: RepoPath, number: number, input: UpdateIssueInput): Promise<Result<Issue>>;
  closeIssue(actor: User, repo: RepoPath, number: number, reason?: IssueReason): Promise<Result<Issue>>;
  reopenIssue(actor: User, repo: RepoPath, number: number): Promise<Result<Issue>>;
  /** The default labels, then every other label in use on the repository. */
  listLabels(repo: RepoPath, viewer: Viewer): Promise<Result<string[]>>;
  /** How many issues and pull requests are open. */
  counts(repo: RepoPath, viewer: Viewer): Promise<Result<{ issues: number; pulls: number }>>;

  /**
   * On an issue or a pull request. On a pull request it may name a line of
   * the change and carry a verdict; nobody can give a verdict on their own.
   */
  addComment(actor: User, repo: RepoPath, number: number, comment: NewComment): Promise<Result<Comment>>;

  /**
   * Begins a run of the acceptance checks for a pull request that is ready
   * for review. For the runner service, which starts the sandbox.
   */
  startChecks(pullId: string): Promise<Result<CheckJob>>;
  /**
   * What a sandbox says about its run. With no results and no error it has
   * started; `skip` forgets a run that will not be carried out.
   */
  reportChecks(runId: string, token: string, report: CheckReport): Promise<Result<CheckRun>>;

  /**
   * Opens a pull request: a draft with a fork to push to, or, given a
   * branch, one ready for review.
   */
  openPull(actor: User, repo: RepoPath, input: OpenPullInput): Promise<Result<Pull>>;
  /** Newest first. */
  listPulls(repo: RepoPath, viewer: Viewer, state?: State): Promise<Result<Pull[]>>;
  getPull(repo: RepoPath, number: number, viewer: Viewer): Promise<Result<PullDetail>>;
  /** Marks a draft ready for review and sets its description. */
  readyPull(actor: User, repo: RepoPath, number: number, summary: string): Promise<Result<Pull>>;
  closePull(actor: User, repo: RepoPath, number: number): Promise<Result<Pull>>;
  /**
   * Lands the pull request on the repository's default branch. Unless
   * `keepIssueOpen`, that resolves the issue it was for: the issue closes
   * naming this pull request, and the others still in progress for it close
   * as superseded. Only members of the repository's workspace may merge.
   */
  mergePull(
    actor: User,
    repo: RepoPath,
    number: number,
    options?: {
      keepIssueOpen?: boolean;
      /** Merge although the acceptance checks have not passed. */
      ignoreChecks?: boolean;
    },
  ): Promise<Result<Pull>>;
  /** Drafts and open pull requests the viewer started, most recently active first. */
  listActivePulls(viewer: Viewer): Promise<{ pull: Pull; issue: Issue | null }[]>;

  appendSession(actor: User, repo: RepoPath, number: number, entries: NewSessionEntry[]): Promise<Result<{ count: number }>>;
  readSession(repo: RepoPath, number: number, viewer: Viewer, afterSeq?: number): Promise<Result<SessionEntry[]>>;
}

/**
 * What to pass `ReposApi.compare` to see what a pull request changes.
 *
 * A fork is compared as a whole. A branch is compared by name while the
 * pull request is open, and by the commit it was merged or closed at
 * afterwards, so later pushes to the branch do not change the record.
 */
export function pullComparison(pull: Pull): {
  repoId: string;
  base: string | null;
  head: string | null;
} {
  if (pull.forkRepoId) return { repoId: pull.forkRepoId, base: pull.mergeBase, head: null };
  const settled = pull.status === "merged" || pull.status === "closed";
  return {
    repoId: pull.repoId,
    base: pull.mergeBase,
    head: (settled && pull.headCommit) || pull.branch,
  };
}
