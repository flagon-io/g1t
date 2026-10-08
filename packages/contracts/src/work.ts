import type { CodeownersReport, PullCodeOwners } from "./codeowners";
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
  state: State;
  /** Set when closed. */
  reason: IssueReason | null;
  /** The number of the pull request whose merge closed this issue. */
  resolvedBy: number | null;
  /** Who opened it: a person, an integration, or g1t (`kind` `agent`) for one its agent filed while at work. */
  author: User;
  /**
   * For an issue g1t's agent filed: the person it was working for. They may
   * manage it as its author could. See `workOwner`.
   */
  requestedBy: User | null;
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
   * that is still in progress in a fork, such as `g1t`.
   */
  agent: string | null;
  /** The milestone it is in, if any. */
  milestone?: MilestoneRef | null;
};

/**
 * A label of a repository: a name, a color and what it means. Issues and
 * pull requests carry labels by name; names are lowercase.
 */
export type Label = {
  name: string;
  /** Six hex digits, without `#`. */
  color: string;
  description: string;
  /** How many issues carry it, open or closed. */
  issues: number;
  /** How many pull requests carry it, in any state. */
  pulls: number;
};

/** A milestone, as an issue or pull request names it. */
export type MilestoneRef = { number: number; title: string };

/**
 * A goal, with an optional due date, that issues and pull requests are
 * gathered under. Its progress is how many of them are closed.
 */
export type Milestone = {
  /** Numbered from 1 in each repository, apart from issues. */
  number: number;
  title: string;
  /** Markdown. */
  description: string;
  /** `YYYY-MM-DD`. */
  dueOn: string | null;
  state: State;
  /** Open issues and pull requests in it. */
  openItems: number;
  /** Closed issues, and merged or closed pull requests, in it. */
  closedItems: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

/** One milestone and what is in it, newest first. */
export type MilestoneDetail = { milestone: Milestone; issues: Issue[]; pulls: Pull[] };

/** How `setLabels` changes an item's labels. */
export type LabelChange = "set" | "add" | "remove";

/**
 * Whose an issue or a pull request is to answer for: whoever asked g1t for
 * it, or its author. They may change, close and steer it, are never asked to
 * review it and cannot approve it, and see it as theirs. Mirrors
 * `Pull::owner` in the Rust contracts.
 */
export function workOwner(item: Pick<Pull, "author" | "requestedBy">): User {
  return item.requestedBy ?? item.author;
}

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
   * Those whose review was asked for: usernames, and `g1t` when a g1t
   * agent was asked.
   */
  reviewers: string[];
  /**
   * Teams whose review was asked for, as `workspace/slug`. A team stays here
   * after review assignment picks people from it, who are in `reviewers`.
   */
  teamReviewers?: string[];
  /** The labels it carries, by name. */
  labels?: string[];
  /** The milestone it is in, if any. */
  milestone?: MilestoneRef | null;
  /**
   * The branch it merges into. Lists and `getPull` name it; null only in
   * what services pass between themselves, for the default branch.
   */
  base?: string | null;
  /** Who opened it: a person, or g1t (`kind` `agent`, username `g1t`) for a change g1t made. */
  author: User;
  /**
   * For a change g1t made: the person who asked for it, by assigning an issue
   * or handing g1t the work. They answer for it as its author would. See
   * `workOwner`.
   */
  requestedBy: User | null;
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

/** An issue opened and handed to g1t in one step. The issue exists whatever became of the agent. */
export type Delegated = {
  issue: Issue;
  /** The pull request the agent opened, when it started. */
  pull: Pull | null;
  agent: AgentStart;
};

/**
 * What to put an agent on: an issue's title, and what to do in plain words,
 * with what done means if you like (a "Definition of done" section). What
 * has to pass before it merges is the branch's required checks.
 */
export type DelegateInput = {
  title: string;
  body: string;
  labels?: string[];
  /** Deprecated: commands, added to the body under "Definition of done". */
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

/**
 * On a pull request, `failed` means the merge queue took it out, until its
 * head moves. The other states are from runs of commands written on issues,
 * which g1t no longer runs.
 */
export type CheckStatus = "queued" | "running" | "passed" | "failed" | "errored";

/** How one command went, in a run recorded before checks were workflows. */
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
 * A record against a pull request's head: the merge queue taking it out,
 * with why, or an earlier run of commands written on its issue.
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
  /** Who the pull request is for (`workOwner`: whoever asked g1t for it, or its author), and so can read its source. */
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
  /** The latest record against its head: the merge queue taking it out. */
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
  /** Earlier records like `checks`, newest first, without their output. */
  earlierChecks?: CheckRun[];
  /**
   * The checks the default branch's protection requires, each as it stands
   * on the head commit. Empty when none are required.
   */
  requiredChecks?: RequiredCheck[];
  /**
   * Who owns the files it changes (the CODEOWNERS file of the branch it
   * merges into) and whose approval is still needed. Absent without one.
   */
  codeOwners?: PullCodeOwners | null;
};

/** Where a required check stands on a commit; `expected` when nothing has reported it yet. */
export type RequiredState = "success" | "failure" | "pending" | "expected";

/** One check a branch's protection requires, as it stands on a commit. */
export type RequiredCheck = {
  /** A workflow's name, such as `CI`, or another status's context. */
  name: string;
  state: RequiredState;
  description: string | null;
  /** Where to see more: the workflow run, for one a workflow reported. */
  targetUrl: string | null;
};

/** A check name reported on a repository's commits lately, for choosing required checks. */
export type SeenCheck = {
  name: string;
  /** The events it was reported for, such as `pull_request`; empty for a status that names none. */
  events: string[];
  /** RFC 3339. */
  lastSeen: string;
};

/**
 * A status context's check name: `CI / pull_request` is the `CI` check,
 * reported for a `pull_request` event. A context that does not end in an
 * event, such as `g1t / deploy`, is its own name. As the work service reads it.
 */
export function checkName(context: string): string {
  const at = context.lastIndexOf(" / ");
  if (at <= 0) return context;
  return STATUS_EVENTS.has(context.slice(at + 3)) ? context.slice(0, at) : context;
}

const STATUS_EVENTS = new Set([
  "push",
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "merge_group",
  "workflow_dispatch",
  "workflow_run",
  "workflow_call",
  "schedule",
  "release",
  "issues",
  "issue_comment",
  "repository_dispatch",
]);

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
  /** Who the pull request is for (`workOwner`: whoever asked g1t for it, or its author), and so can read its source. */
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
  /** Who the pull request belongs to (`workOwner`: whoever asked g1t for it, or its author). Sandboxes act as them. */
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
  /** What is true once it is done, in plain words; added to the issue's body under "Definition of done". */
  done: string[];
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
   * The checks that must pass on a pull request's head before it may merge
   * into the default branch, by name: a workflow's name (`CI`) or another
   * status's context (`g1t / deploy`). The same for people and agents, and
   * for the merge queue.
   */
  requiredChecks: string[];
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
  /** Whether someone who may merge can bypass required checks that have not passed. */
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
  /**
   * Refuse to merge until the code owners of every file it changes have
   * approved, as many as each section asks. People only; `g1t` only where
   * the file names `@g1t`.
   */
  requireCodeOwnerReview?: boolean;
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
  /** Who the pull request is for (`workOwner`: whoever asked g1t for it, or its author), and so can read its source. */
  author: User;
  /**
   * The files it changes, as of its latest push: how large the change is,
   * which decides the model that reviews it.
   */
  files: ChangedFile[];
  /**
   * What among them runs, configures or guards things (CI workflows,
   * secrets, infrastructure), once each. Any sends the review to the
   * larger model.
   */
  sensitive: string[];
};

export type OpenIssueInput = {
  title: string;
  body: string;
  labels?: string[];
  /** Deprecated: commands, added to the body under "Definition of done". */
  checks?: string[];
  /** The number of the milestone to put it in. Needs the Triage role. */
  milestone?: number;
};

export type UpdateIssueInput = {
  title?: string;
  body?: string;
  labels?: string[];
  /** Usernames of the people it is assigned to; replaces the whole set. */
  assignees?: string[];
  /** The number of the milestone to put it in; 0 takes it out. */
  milestone?: number;
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
  /** The branch to merge into: the default branch when left out. */
  base?: string;
};

/** One repository's pull requests from `pullsForRepos`, newest first. */
export type RepoPulls = {
  repoId: string;
  /** Draft and open. */
  open: Pull[];
  /** Merged and closed. */
  closed: Pull[];
};

/** Issues, pull requests, comments and sessions. */
export interface WorkApi {
  openIssue(actor: User, repo: RepoPath, input: OpenIssueInput): Promise<Result<Issue>>;
  /**
   * Opens an issue to put g1t on at once: refused, with nothing
   * opened, unless `actor` may put agents to work in `repo`. The runner's
   * `delegate` calls it, then starts the agent.
   */
  delegateIssue(actor: User, repo: RepoPath, input: DelegateInput): Promise<Result<Issue>>;
  /** Newest first. */
  listIssues(
    repo: RepoPath,
    viewer: Viewer,
    filter?: { state?: State; label?: string; milestone?: number },
  ): Promise<Result<Issue[]>>;
  getIssue(repo: RepoPath, number: number, viewer: Viewer): Promise<Result<IssueDetail>>;
  /** The author or a member of the workspace may. */
  updateIssue(actor: User, repo: RepoPath, number: number, input: UpdateIssueInput): Promise<Result<Issue>>;
  closeIssue(actor: User, repo: RepoPath, number: number, reason?: IssueReason): Promise<Result<Issue>>;
  reopenIssue(actor: User, repo: RepoPath, number: number): Promise<Result<Issue>>;
  /** A repository's labels, by name, each with how many issues and pull requests carry it. */
  listLabels(repo: RepoPath, viewer: Viewer): Promise<Result<Label[]>>;
  /**
   * Creates a label, or with `name` changes one; renaming it renames it on
   * everything that carries it. Needs the Triage role.
   */
  saveLabel(
    actor: User,
    repo: RepoPath,
    label: { name?: string; newName?: string; color?: string; description?: string },
  ): Promise<Result<Label>>;
  /** Removes a label from the repository and everything carrying it. */
  deleteLabel(actor: User, repo: RepoPath, name: string): Promise<Result<boolean>>;
  /** Adds the default labels the repository does not have yet; returns them all. */
  addDefaultLabels(actor: User, repo: RepoPath): Promise<Result<Label[]>>;
  /**
   * The labels of an issue or a pull request, replaced, added to or taken
   * from. Labels the repository lacks are created for someone with the
   * Triage role. Returns its labels now.
   */
  setLabels(
    actor: User,
    repo: RepoPath,
    number: number,
    labels: string[],
    change?: LabelChange,
  ): Promise<Result<string[]>>;
  /** Open ones by due date, then closed ones; both unless `state` says. */
  listMilestones(repo: RepoPath, viewer: Viewer, state?: State): Promise<Result<Milestone[]>>;
  getMilestone(repo: RepoPath, number: number, viewer: Viewer): Promise<Result<MilestoneDetail>>;
  /** Creates a milestone, or with `number` changes the fields given. Needs the Triage role. */
  saveMilestone(
    actor: User,
    repo: RepoPath,
    milestone: { number?: number; title?: string; description?: string; dueOn?: string; state?: State },
  ): Promise<Result<Milestone>>;
  deleteMilestone(actor: User, repo: RepoPath, number: number): Promise<Result<boolean>>;
  /** How many issues and pull requests are open. */
  counts(repo: RepoPath, viewer: Viewer): Promise<Result<{ issues: number; pulls: number }>>;

  /**
   * On an issue or a pull request. On a pull request it may name a line of
   * the change and carry a verdict; nobody can give a verdict on their own.
   */
  addComment(actor: User, repo: RepoPath, number: number, comment: NewComment): Promise<Result<Comment>>;

  /**
   * Always refused now: a pull request's checks are the workflows run on
   * it. Kept for a runner from before.
   */
  startChecks(pullId: string): Promise<Result<CheckJob>>;
  /**
   * What a sandbox says about a run from before checks were workflows: so
   * one still finishing is recorded.
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
  /** The check names reported on the repository's commits in the last 30 days, most recent first. */
  seenChecks(repo: RepoPath, viewer: Viewer): Promise<Result<SeenCheck[]>>;
  /** Members of the repository's workspace only. */
  updateSettings(actor: User, repo: RepoPath, settings: RepoSettingsInput): Promise<Result<RepoSettings>>;
  /** The CODEOWNERS file at a branch (the default when left out), checked. Needs Read. */
  codeownersErrors(repo: RepoPath, viewer: Viewer, ref?: string | null): Promise<Result<CodeownersReport>>;
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
  listPulls(
    repo: RepoPath,
    viewer: Viewer,
    state?: State,
    filter?: { label?: string; milestone?: number; base?: string },
  ): Promise<Result<Pull[]>>;
  /**
   * The newest `limit` open and closed pull requests of each repository,
   * in one call. Repositories the viewer cannot read, and forks, are left
   * out: ask those with `listPulls`.
   */
  pullsForRepos(repoIds: string[], viewer: Viewer, limit: number): Promise<RepoPulls[]>;
  getPull(repo: RepoPath, number: number, viewer: Viewer): Promise<Result<PullDetail>>;
  /**
   * Changes who a pull request is assigned to and whose review is asked
   * for; each list given replaces the whole set. Asking for `g1t`'s
   * review does not by itself start one: the runner's `review` does.
   */
  updatePull(
    actor: User,
    repo: RepoPath,
    number: number,
    changes: {
      assignees?: string[];
      reviewers?: string[];
      labels?: string[];
      /** 0 takes it out of its milestone. */
      milestone?: number;
      /** The branch it merges into. Needs the Write role. */
      base?: string;
    },
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
      /** Merge although required checks have not passed, where the repository allows bypassing them. */
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
  /** The branch it merges into, which it is compared from. */
  baseBranch: string | null;
} {
  const baseBranch = pull.base ?? null;
  if (pull.forkRepoId) return { repoId: pull.forkRepoId, base: pull.mergeBase, head: null, baseBranch };
  const settled = pull.status === "merged" || pull.status === "closed";
  return {
    repoId: pull.repoId,
    base: pull.mergeBase,
    head: (settled && pull.headCommit) || pull.branch,
    baseBranch,
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
  /** Always empty: the state is checked by the merge_group workflows run on it. */
  checks: string[];
  /** Always empty, as `checks`. */
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
