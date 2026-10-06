import type { User, Viewer } from "./identity";
import type { PullBranchUpdate, RepoPath } from "./repos";
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
  /** Usernames of the people it is assigned to. */
  assignees: string[];
  /** The numbers of the issues that have to be merged before this one is worked on. */
  blockedBy: number[];
  /**
   * Whether a g1t agent takes it as soon as it can: at once, or when what it
   * is blocked by has merged.
   */
  queued: boolean;
  /**
   * The agent working on it now: the one behind its newest pull request
   * that is still in progress in a fork, such as `g1t-agent`.
   */
  agent: string | null;
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
  /** The files it changes, as of its latest push. */
  files: ChangedFile[];
  /** Usernames of the people it is assigned to. */
  assignees: string[];
  /**
   * Those whose review was asked for: usernames, and `g1t-agent` when a g1t
   * agent was asked.
   */
  reviewers: string[];
  author: User;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  updatedAt: string;
  /**
   * How sure g1t is of a g1t agent's change, from what it can observe, once
   * the agent has finished it. Absent before then, and on changes g1t is
   * not seeing through.
   */
  confidence?: Confidence | null;
};

/** How sure g1t is that an agent's change is right. */
export type ConfidenceLevel = "low" | "medium" | "high";

/**
 * How sure g1t is of a change an agent made, worked out from what can be
 * observed: its checks, how often it was sent back, the reviewer agent's
 * verdict, whether it touched tests, its size, where it reached, how close
 * it came to its guardrails, and what it asked without an answer. The
 * agent's own word can only lower it.
 */
export type Confidence = {
  level: ConfidenceLevel;
  /** A few words each, most telling first: what lowered it, or for `high`, what it rests on. */
  reasons: string[];
  /** What the agent said of its own change, if it said. */
  selfReported: ConfidenceLevel | null;
  /** What the agent said it was unsure about. */
  uncertainAbout: string[];
  /** The agent run it was worked out after. */
  runId: string | null;
  /** RFC 3339. */
  assessedAt: string;
};

/** What became of the agent when an issue was opened and handed to it in one step. */
export type AgentStartStatus = "started" | "queued" | "not_started";

/** Whether the agent started, and if not, why and what fixes it. */
export type AgentStart = {
  status: AgentStartStatus;
  /**
   * Why it did not start: `not_paid`, `trial_used`, `limit`, `paused`,
   * `issue_cap`, `billing_unavailable` or `no_model`; `waiting` when queued.
   */
  code: string | null;
  /** What happened, in a sentence or two, with what to do. */
  message: string | null;
  /** Where the fix is: the workspace's billing or model settings. */
  fixUrl: string | null;
};

/** An issue opened and handed to g1t-agent in one step. The issue exists whatever became of the agent. */
export type Delegated = {
  issue: Issue;
  /** The pull request the agent opened, when it started. */
  pull: Pull | null;
  agent: AgentStart;
};

/** What to put an agent on: an issue's title, what to do in plain words, and the checks that prove it done. */
export type DelegateInput = {
  title: string;
  body: string;
  labels?: string[];
  checks?: string[];
};

/** One file a pull request changes, and by how much. */
export type ChangedFile = { path: string; additions: number; deletions: number };

/**
 * Another pull request in progress that changes some of the same files. Two
 * for the same issue are alternatives; two for different issues are heading
 * for a conflict.
 */
export type Overlap = {
  number: number;
  title: string;
  /** The number of the issue the other pull request is for. */
  issue: number | null;
  /** The files both change. */
  paths: string[];
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
  /**
   * Something a person or an agent wrote, or something that happened: an
   * assignment, a review asked for, a close.
   */
  kind: "comment" | "event";
  author: User;
  /**
   * Markdown. For an event, what its author did, as the rest of a sentence
   * that starts with their name: "assigned ana".
   */
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
  /** Other pull requests in progress that change the same files. */
  overlaps: Overlap[];
  /**
   * Whether the branch it would merge into has moved on without it, so that
   * it has to catch up before it can merge.
   */
  behind: boolean;
  /** Whether a g1t agent is reviewing it right now. */
  reviewPending: boolean;
  /**
   * Where it stands on its way to being merged, for a pull request g1t is
   * seeing through. Null on anyone else's.
   */
  lifecycle: Lifecycle | null;
  /**
   * A merge was asked for while it was behind: g1t is bringing it up to
   * date and will then land it.
   */
  landing: boolean;
  /** Why g1t stopped working on it, if it did. */
  stalled: string | null;
  /** Messages people sent the agent while it worked, oldest first. */
  messages: AgentMessage[];
  /** What workflow runs said about its head commit, one per workflow. */
  statuses?: CommitStatus[];
  /**
   * Whether it merges cleanly into the branch it targets, worked out ahead
   * of time whenever either side moves.
   */
  mergeable?: Mergeable;
  /** When `mergeable` is `conflicting`: the files that conflict. */
  conflicts?: string[];
  /** Earlier runs of its acceptance checks, newest first, without their output. */
  earlierChecks?: CheckRun[];
};

/**
 * Whether a pull request merges cleanly into the branch it targets:
 * `unknown` when it was never worked out or could not be, `checking` while
 * a probe merges the two.
 */
export type Mergeable = "clean" | "conflicting" | "unknown" | "checking";

/** What a sandbox needs to find out whether a pull request merges cleanly. */
export type MergecheckJob = {
  pullId: string;
  /** Lets the sandbox, and nothing else, report this probe. */
  token: string;
  repo: RepoPath;
  number: number;
  defaultBranch: string;
  /** The default branch's commit to merge into. */
  base: string;
  /** The repository holding the change: its fork, or the repository. */
  source: RepoPath;
  /** The branch of `source` holding it. */
  branch: string;
  /** The change's commit. */
  head: string;
  /** Who opened the pull request, and so can read its source. */
  author: User;
};

/** What a workflow run (or another tool) says about a commit. */
export type CommitStatus = {
  /** What reported it, such as `CI / push`. */
  context: string;
  state: "pending" | "success" | "failure" | "error";
  description: string | null;
  targetUrl: string | null;
  updatedAt: string;
};

/**
 * A step on the way from an assigned issue to a pull request that is ready
 * to merge. g1t takes each one without being asked: `working` (the agent is
 * making the change), `checking`, `reviewing`, `revising` (the agent is
 * addressing failed checks or a review), `catching_up` (merging in the
 * branch it would land on), `answering` (woken to answer another agent),
 * then `ready` for a person to merge. `needs_you`
 * means g1t has stopped and a person decides what happens next.
 */
export type Stage =
  | "working"
  | "checking"
  | "reviewing"
  | "revising"
  | "catching_up"
  | "answering"
  | "queued"
  | "ready"
  | "needs_you";

export type Lifecycle = {
  stage: Stage;
  /** One sentence saying what is happening, or why it stopped. */
  detail: string;
  /** How many times the agent has been sent back to revise it. */
  revisions: number;
};

/** What the runner needs to carry out a step of a pull request's lifecycle. */
export type LifecycleJob = {
  pullId: string;
  repo: RepoPath;
  number: number;
  /** Who the pull request belongs to. Sandboxes act as them. */
  author: User;
  /** The repository holding the change: its fork, or the repository itself. */
  source: RepoPath;
  /** The branch of the source holding the change; its default branch when null. */
  branch: string | null;
  defaultBranch: string;
  title: string;
  description: string;
  issue: Issue | null;
  /** For a revision: the failed checks or the review to address. */
  feedback: string;
  /** For a revision: which one this is, from 1. */
  round: number;
};

/** An agent woken to answer what other agents sent it while it was not at work. */
export type Wake = { job: LifecycleJob; messages: AgentMessage[] };

/**
 * `planning` while an agent reads the repository and writes it; `ready` for
 * a person to read and apply; `failed` if it could not be written;
 * `applied` once its issues are open.
 */
export type PlanStatus = "planning" | "ready" | "failed" | "applied";

/** One issue a plan proposes. */
export type PlannedIssue = {
  title: string;
  /** Markdown: what to change, where, and why. */
  body: string;
  labels: string[];
  /** Commands that must pass once the change is made. */
  checks: string[];
  /** The files it will most likely change. */
  files: string[];
  /**
   * The positions, counting from 1, of earlier issues in the plan that have
   * to be merged first.
   */
  dependsOn: number[];
  /** Its number, once the plan has been applied and it was kept. */
  number: number | null;
};

/** An outcome someone wrote, and the issues an agent proposes to get there. */
export type Plan = {
  id: string;
  repoId: string;
  /** The outcome wanted, as written. */
  brief: string;
  status: PlanStatus;
  /** The agent's account of how it split the work. */
  summary: string;
  issues: PlannedIssue[];
  /** Why it could not be written, when `status` is `failed`. */
  error: string | null;
  author: User;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  finishedAt: string | null;
  /** Once applied: where each issue it opened stands now, in plan order. */
  progress: IssueProgress[];
  /** Questions and handoffs between its pull requests' agents, newest first. */
  exchanges: AgentMessage[];
};

/** What a sandbox needs to write a plan. */
export type PlanJob = {
  planId: string;
  /** Lets the sandbox, and nothing else, report this plan. */
  token: string;
  brief: string;
  repo: RepoPath;
};

/** An issue waiting for a g1t agent that can be given one now. */
export type ReadyIssue = {
  repo: RepoPath;
  number: number;
  /** Who queued it, on whose say-so the agent works. */
  actor: User;
};

/**
 * How a repository wants its pull requests handled. A repository that has
 * changed nothing has the defaults.
 */
export type RepoSettings = {
  /**
   * Land a g1t agent's pull request without a person once it is ready:
   * checks passed and approved as the settings below require.
   */
  autoMerge: boolean;
  /**
   * Refuse to merge a pull request that does not contain the default
   * branch's latest commits, so that what merges is what was checked. When
   * off, merging one that is behind brings it up to date first.
   */
  requireUpToDate: boolean;
  /**
   * How many approving reviews a pull request needs before it may merge. A
   * reviewer who has since asked for changes blocks it.
   */
  requiredApprovals: number;
  /** Whether a g1t agent's approval counts towards `requiredApprovals`. */
  countAgentApprovals: boolean;
  /** Whether a member may merge although the acceptance checks did not pass. */
  allowIgnoringChecks: boolean;
  /** Whether a g1t agent's pull request is reviewed by a second agent unasked. */
  agentReview: boolean;
  /**
   * How many times a g1t agent is sent back to its pull request before a
   * person is asked instead.
   */
  maxRevisions: number;
  /**
   * Merge through a queue: pull requests are tested together with those
   * ahead of them, and only a combination that passed reaches the default
   * branch.
   */
  mergeQueue: boolean;
  /**
   * Ask a person before merging a g1t agent's change whose confidence is
   * low: auto-merge and the merge queue leave it until a person approves it.
   */
  holdLowConfidence: boolean;
  /** Username of the member who last changed the settings, if anyone has. */
  updatedBy: string | null;
  /** RFC 3339. */
  updatedAt: string | null;
};

/** The settings a member can change. */
export type RepoSettingsInput = Omit<RepoSettings, "updatedBy" | "updatedAt">;

/** The next step for a pull request g1t is seeing through, already claimed. */
export type Advance =
  | { action: "none" }
  | { action: "review" | "revise" | "catch_up"; job: LifecycleJob };

/** What a sandbox needs to review a pull request. */
export type ReviewJob = {
  runId: string;
  /** Lets the sandbox, and nothing else, report this review. */
  token: string;
  /** The repository holding the commit: the fork, or the repository itself. */
  source: RepoPath;
  commit: string;
  repo: RepoPath;
  defaultBranch: string;
  number: number;
  title: string;
  description: string;
  /** The issue the pull request is for, which says what it should achieve. */
  issue: Issue | null;
  /** Who opened the pull request, and so can read its source. */
  author: User;
};

export type OpenIssueInput = {
  title: string;
  body: string;
  labels?: string[];
  checks?: string[];
};

export type UpdateIssueInput = {
  title?: string;
  body?: string;
  labels?: string[];
  /** Usernames of the people it is assigned to; replaces the whole set. */
  assignees?: string[];
};

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
  /**
   * Opens an issue to put g1t-agent on at once: refused, with nothing
   * opened, unless `actor` may put agents to work in `repo`. The runner's
   * `delegate` calls it, then starts the agent.
   */
  delegateIssue(actor: User, repo: RepoPath, input: DelegateInput): Promise<Result<Issue>>;
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
  /** Begins a review by a g1t agent. For the runner service. */
  startReview(pullId: string): Promise<Result<ReviewJob>>;
  /** Records that a review could not be written. For the runner service. */
  failReview(runId: string, token: string, error: string): Promise<Result<boolean>>;
  /**
   * Claims the probe of whether a pull request merges cleanly that a
   * `pull.mergecheck` event asked for. Refused when it is no longer wanted
   * or the repository has as many running as it may. For the runner service.
   */
  startMergecheck(pullId: string): Promise<Result<MergecheckJob>>;
  /** Records that a probe could not be carried out. For the runner service. */
  failMergecheck(pullId: string, token: string, error: string): Promise<Result<Mergeable>>;

  /**
   * Works out the next step for a pull request g1t is seeing through and,
   * if there is one to take now, claims it, so that it is taken once
   * however often this is called. For the runner service.
   */
  advance(pullId: string): Promise<Advance>;
  /** Records that a step could not be carried out, so a person is asked. */
  stall(pullId: string, reason: string): Promise<boolean>;
  /** Ids of the open pull requests g1t is seeing through. */
  managedPulls(repoId?: string): Promise<string[]>;

  /** A repository's merge queue: what is in it, in order, and what recently left. */
  queue(repo: RepoPath, viewer: Viewer): Promise<Result<QueueView>>;
  /**
   * The next batch of combined states to test for a repository, one per
   * entry; empty while a batch is being tested or nothing waits.
   */
  queueBuild(repoId: string): Promise<QueueJob[]>;
  /** Reports that a combined state could not be built or checked. */
  failQueue(entryId: string, token: string, error: string): Promise<Result<QueueState>>;
  /** Sends the agent working on a pull request a message, for its next step. */
  messageAgent(actor: User, repo: RepoPath, number: number, body: string): Promise<Result<AgentMessage>>;
  /** Takes a pull request out of the merge queue. Members only. */
  removeFromQueue(actor: User, repo: RepoPath, number: number): Promise<Result<Pull>>;

  getSettings(repo: RepoPath, viewer: Viewer): Promise<Result<RepoSettings>>;
  /** Members of the repository's workspace only. */
  updateSettings(actor: User, repo: RepoPath, settings: RepoSettingsInput): Promise<Result<RepoSettings>>;
  /**
   * What the runner needs to bring a pull request up to date because a
   * merge of it was asked for. Null if none was.
   */
  catchUpJob(pullId: string): Promise<LifecycleJob | null>;
  /**
   * Claims a short step for the agent on a pull request to answer the
   * questions and handoffs it was sent while not at work, and hands them
   * over, marked read. Null when there is nothing waiting or it cannot
   * take a step now.
   */
  wakeForMessages(pullId: string): Promise<Wake | null>;

  /**
   * Opens a pull request: a draft with a fork to push to, or, given a
   * branch, one ready for review.
   */
  openPull(actor: User, repo: RepoPath, input: OpenPullInput): Promise<Result<Pull>>;
  /** Newest first. */
  listPulls(repo: RepoPath, viewer: Viewer, state?: State): Promise<Result<Pull[]>>;
  getPull(repo: RepoPath, number: number, viewer: Viewer): Promise<Result<PullDetail>>;
  /**
   * Changes who a pull request is assigned to and whose review is asked
   * for; each list given replaces the whole set. Asking for `g1t-agent`'s
   * review does not by itself start one: the runner's `review` does.
   */
  updatePull(
    actor: User,
    repo: RepoPath,
    number: number,
    changes: { assignees?: string[]; reviewers?: string[] },
  ): Promise<Result<Pull>>;
  /**
   * Brings a pull request up to date with the default branch in seconds,
   * without a sandbox, when the two changed different files: the merge
   * commit is pushed to its branch as `actor`, who must be whoever opened
   * it (for a fork) or a member (for a branch). Otherwise `needs_agent`, and
   * nothing is pushed: the runner's `update` is the way on.
   */
  catchUpPull(actor: User, repo: RepoPath, number: number): Promise<Result<PullBranchUpdate>>;
  /** Marks a draft ready for review and sets its description. */
  readyPull(actor: User, repo: RepoPath, number: number, summary: string): Promise<Result<Pull>>;
  closePull(actor: User, repo: RepoPath, number: number): Promise<Result<Pull>>;
  /**
   * Lands the pull request on the repository's default branch. Unless
   * `keepIssueOpen`, that resolves the issue it was for: the issue closes
   * naming this pull request, and the others still in progress for it close
   * as superseded. Only members of the repository's workspace may merge.
   *
   * If the default branch has moved, the pull request is brought up to date
   * first and lands when that is done; it comes back still open, and
   * `PullDetail.landing` is true meanwhile. A repository that requires pull
   * requests to be up to date refuses instead.
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
  /**
   * Drafts and open pull requests the viewer started, most recently active
   * first, each with where it stands if g1t is seeing it through.
   */
  listActivePulls(
    viewer: Viewer,
  ): Promise<{ pull: Pull; issue: Issue | null; lifecycle: Lifecycle | null }[]>;
  /**
   * The issues and pull requests a person opened, a page at a time, only
   * on repositories the viewer may read. Not found for no such account.
   */
  byAuthor(username: string, viewer: Viewer, filter?: AuthoredFilter): Promise<Result<Authored>>;

  /**
   * Records an outcome to plan for. Members only. For the runner service,
   * which starts the sandbox in which an agent writes the plan.
   */
  startPlan(actor: User, repo: RepoPath, brief: string): Promise<Result<PlanJob>>;
  /** Records that a plan could not be written. For the runner service. */
  failPlan(planId: string, token: string, error: string): Promise<Result<boolean>>;
  /** Members only. */
  getPlan(repo: RepoPath, viewer: Viewer, id: string): Promise<Result<Plan>>;
  /** Newest first. Members only. */
  listPlans(repo: RepoPath, viewer: Viewer): Promise<Result<Plan[]>>;
  /**
   * Opens a plan's issues, each blocked by the ones it depends on. With
   * `assign`, each is queued for a g1t agent. `keep` holds the positions,
   * from 1, of the issues to open; all of them when absent. Once.
   */
  applyPlan(
    actor: User,
    repo: RepoPath,
    id: string,
    options?: { assign?: boolean; keep?: number[] },
  ): Promise<Result<Plan>>;
  /** Asks for a g1t agent to take an issue as soon as it can, or withdraws that. */
  queueIssue(actor: User, repo: RepoPath, number: number, queued: boolean): Promise<Result<boolean>>;
  /** Issues waiting for a g1t agent that can be given one now. For the runner. */
  readyIssues(repoId?: string): Promise<ReadyIssue[]>;

  /** Open issues assigned to the viewer, most recently changed first. */
  listAssignedIssues(viewer: Viewer): Promise<Issue[]>;

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


/** Where a pull request in a merge queue stands. */
/** Where one issue of an applied plan stands. */
export type IssueProgress = {
  number: number;
  title: string;
  /**
   * `blocked`, `waiting` (for an agent), `open`, a lifecycle stage,
   * `landed` or `closed`.
   */
  state: string;
  detail: string;
  /** The issues it is waiting on that are still open. */
  blockedBy: number[];
  pull: number | null;
  agent: string | null;
};

/** A message a person sent an agent at work on a pull request. */
export type AgentMessage = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** When the agent received it; null until then. */
  deliveredAt: string | null;
  /** `message` from a person; from an agent a `question`, `handoff` or `answer`. */
  kind: "message" | "question" | "handoff" | "answer";
  /** The pull request whose agent sent it, when an agent did. */
  fromNumber: number | null;
  /** The pull request it was sent to. */
  toNumber: number;
  /** The reply to a question or handoff, once there is one. */
  answer: string | null;
  declined: boolean;
  /** For the sending agent: what to expect when the one it asked is not at work. */
  hint?: string;
};

export type QueueState = "waiting" | "testing" | "passed" | "failed" | "landed" | "removed";

/** One pull request's place in a merge queue. */
export type QueueEntry = {
  id: string;
  number: number;
  title: string;
  agent: string;
  state: QueueState;
  /** The pull requests merged ahead of it in the state being tested, in order. */
  ahead: number[];
  baseCommit: string | null;
  combinedCommit: string | null;
  error: string | null;
  results: CheckResult[];
  /** Username of whoever merged it into the queue: a person, or `g1t`. */
  enqueuedBy: string;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  finishedAt: string | null;
};

/** A repository's merge queue: what is in it, in order, and what recently left. */
export type QueueView = {
  enabled: boolean;
  active: QueueEntry[];
  /** Newest first. */
  recent: QueueEntry[];
};

export type QueueStackItem = {
  number: number;
  title: string;
  /** The repository holding the change, and its branch. */
  source: RepoPath;
  branch: string;
  commit: string;
};

/** What a sandbox needs to build and check one combined state. */
export type QueueJob = {
  entryId: string;
  token: string;
  repo: RepoPath;
  defaultBranch: string;
  baseCommit: string;
  branch: string;
  stack: QueueStackItem[];
  checks: string[];
  /** The checks of issues already completed: the default branch's contract. */
  contractChecks: string[];
  actor: User;
};

// --- A person's work ---------------------------------------------------------
// Mirrors the `Authored*` types in `crates/contracts/src/work.rs`.

export type AuthoredKind = "issue" | "pull";
/** `closed` takes in merged pull requests too; `merged` is only those. */
export type AuthoredState = "open" | "closed" | "merged";
/** `created` is newest first, `updated` most recently changed, `oldest` oldest first. */
export type AuthoredSort = "created" | "updated" | "oldest";

/** The most items one `byAuthor` page holds. */
export const AUTHORED_PAGE = 25;

export type AuthoredFilter = {
  kind?: AuthoredKind;
  state?: AuthoredState;
  /** `namespace/name`. */
  repo?: string;
  sort?: AuthoredSort;
  /** The `next` of the page before. */
  before?: string;
  limit?: number;
};

export type AuthoredItem = {
  kind: AuthoredKind;
  repo: RepoPath;
  number: number;
  title: string;
  /** A merged pull request is closed. */
  state: State;
  /** A pull request's own status; null on an issue. */
  status: PullStatus | null;
  /** Why an issue was closed. */
  reason: IssueReason | null;
  draft: boolean;
  merged: boolean;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  updatedAt: string;
  /** RFC 3339. */
  mergedAt: string | null;
};

/** Over every repository the viewer may read, whatever the filters. */
export type AuthoredCounts = {
  pullsMerged: number;
  pullsOpen: number;
  pulls: number;
  issues: number;
  issuesOpen: number;
};

export type Authored = {
  items: AuthoredItem[];
  /** Pass as `before` for the next page; null on the last. */
  next: string | null;
  counts: AuthoredCounts;
  /** The repositories they worked in that the viewer may read, most work first. */
  repos: { repo: RepoPath; count: number }[];
};
