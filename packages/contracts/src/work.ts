import type { ChecksApi } from "./checks";
import type { CodeownersReport, PullCodeOwners } from "./codeowners";
import type { G1tEvent } from "./events";
import type { User, Viewer } from "./identity";
import type { PullBranchUpdate, RepoPath, UpdateMethod } from "./repos";
import type { MergeMethod } from "./rules";
import type { Result } from "./result";
import type { MergeRules, RulesApi } from "./rules";

/**
 * The filter on lists of work items and pull requests. An open pull
 * request is a draft or one ready for review; a closed one was merged or
 * closed without merging.
 */
export type State = "open" | "closed";

/** Why a work item was closed. */
export type CloseReason = "completed" | "not_planned";

/**
 * How a work item is linked to a repository: where it was filed (`origin`,
 * which keeps an old issue's number), where the work is meant to land
 * (`target`), or where work for it landed or is under way (`touched`).
 */
export type LinkRole = "origin" | "target" | "touched";

/** A repository a work item is linked to. */
export type ItemRepo = {
  repoId: string;
  /** `owner/name`, as it is now, or as it was when the repository was deleted. */
  path: string;
  role: LinkRole;
  /** For the origin of a work item moved from a repository's issues: its number there. */
  legacyNumber: number | null;
  /** A pull request or commit that closes it landed in this repository. */
  landed: boolean;
};

/** What resolved a work item in one repository: a pull request merged, or a commit pushed. */
export type Resolution = {
  /** `owner/name`. */
  repo: string;
  pull: number | null;
  commit: string | null;
  /** Who pushed that commit, by username. */
  pushedBy: string | null;
};

/**
 * Any tracked work of a workspace: a feature, a bug, a chore. Numbered in
 * the workspace with its new pull requests, and linked to the repositories
 * it concerns. It closes once what closes it has landed in every target,
 * or, with no targets, once anything that closes it lands. Mirrors
 * `crates/contracts/src/work/items.rs`.
 */
export type WorkItem = {
  /** `wki_…`; one moved from an issue keeps its `iss_…`. */
  id: string;
  /** The workspace's slug. */
  workspace: string;
  /** Shown as `#12`; on the site at `/<workspace>/-/work/<number>`. */
  number: number;
  title: string;
  /** Markdown. Also what an agent is given to work from. */
  body: string;
  labels: string[];
  state: State;
  /** Set when closed. */
  reason: CloseReason | null;
  /** What resolved it, in each repository it landed in, oldest first. */
  resolutions: Resolution[];
  /** Who opened it: a person, an integration, or g1t (`kind` `agent`) for one its agent filed while at work. */
  author: User;
  /**
   * For one g1t's agent filed: the person it was working for. They may
   * manage it as its author could. See `workOwner`.
   */
  requestedBy: User | null;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  updatedAt: string;
  /** RFC 3339. */
  closedAt: string | null;
  /** Pull requests made for it, in any state and repository. */
  pullCount: number;
  commentCount: number;
  /** Usernames of the people it is assigned to. */
  assignees: string[];
  /** The numbers of the work items of the workspace that have to land before this one is worked on. */
  blockedBy: number[];
  /**
   * The agent working on it now: the one behind its newest pull request
   * that is still in progress in a fork, such as `g1t`.
   */
  agent: string | null;
  /** The workspace milestone it is in, if any. */
  milestone?: MilestoneRef | null;
  /** The repositories it is linked to: its origin first, then targets, then those it touched. */
  repos: ItemRepo[];
};

/** The targets of a work item that have not landed yet, by path. */
export function missingTargets(repos: ItemRepo[]): string[] {
  return repos.filter((repo) => repo.role === "target" && !repo.landed).map((repo) => repo.path);
}

/** A work item and everything on it. */
export type WorkItemDetail = {
  item: WorkItem;
  /** Every pull request made for it, in the repositories the viewer may read, oldest first. */
  pulls: Pull[];
  comments: Comment[];
  /** How people (and g1t) reacted to its description. */
  reactions: ReactionGroup[];
};

/** What `#N` names (`resolveRef`): see `refs.ts` for the order it is read in. */
export type RefTarget =
  | { kind: "work_item"; workspace: string; number: number; itemId: string }
  | { kind: "pull"; repo: string; number: number }
  | { kind: "none" };

/**
 * What a comment, a reaction or a set of labels is on: a pull request of a
 * repository, or a work item of a workspace.
 */
export type Thread = { repo: RepoPath; number: number } | { workspace: string; number: number };

/** The thread's fields as the work service reads them. */
export function threadArgs(thread: Thread): { repo: RepoPath | null; workspace: string; number: number } {
  return "repo" in thread
    ? { repo: thread.repo, workspace: "", number: thread.number }
    : { repo: null, workspace: thread.workspace, number: thread.number };
}

/**
 * A label of a workspace: a name, a color and what it means. Work items and
 * the pull requests of its repositories carry labels by name; names are
 * lowercase.
 */
export type Label = {
  name: string;
  /** Six hex digits, without `#`. */
  color: string;
  description: string;
  /** How many work items carry it, open or closed. */
  items: number;
  /** How many pull requests carry it, in any state. */
  pulls: number;
};

/** A work item a commit resolved, as the commit page lists it. */
export type ClosedItem = { workspace: string; number: number; title: string; closed: boolean };

/** A milestone, as a work item or pull request names it. */
export type MilestoneRef = { number: number; title: string };

/**
 * A goal of a workspace, with an optional due date, that work items and
 * pull requests are gathered under. Its progress is how many of them are
 * closed.
 */
export type Milestone = {
  /** Numbered from 1 in each workspace, apart from work items. */
  number: number;
  title: string;
  /** Markdown. */
  description: string;
  /** `YYYY-MM-DD`. */
  dueOn: string | null;
  state: State;
  /** Open work items and pull requests in it. */
  openItems: number;
  /** Closed work items, and merged or closed pull requests, in it. */
  closedItems: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** For one moved from a repository when work items moved to the workspace: its id. */
  originRepoId?: string;
};

/** One milestone and what is in it that the viewer may see, newest first. */
export type MilestoneDetail = { milestone: Milestone; items: WorkItem[]; pulls: Pull[] };

/** How `setLabels` changes an item's labels. */
export type LabelChange = "set" | "add" | "remove";

/**
 * Whose a work item or a pull request is to answer for: whoever asked g1t for
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
 * how agents work, on a branch pushed to the repository itself, or on a
 * branch of someone's fork of it (`headRepo`).
 */
export type Pull = {
  id: string;
  repoId: string;
  /** Shown as `#12`. New ones are numbered in the workspace's sequence, which work items share. */
  number: number;
  /** The work item this is for, if any, by number in the workspace. */
  item: number | null;
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
  /**
   * The branch holding the change, unless it is in a working copy (`fork`):
   * of `headRepo` when set, else of the repository.
   */
  branch: string | null;
  /**
   * A fork of the repository (its `parentId`, directly or through other
   * forks) whose `branch` holds the change, when it was opened from one.
   * Null for a branch of the repository itself and for a working copy.
   */
  headRepo?: RepoPath | null;
  /** `headRepo`'s id. */
  headRepoId?: string | null;
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
  /** How it merged, once merged. */
  mergeMethod?: MergeMethod | null;
  /** Where its merge left the base: the merge or squash commit, the last rebased one, or its head. */
  mergeCommit?: string | null;
  /** Merge it on its own once everything it needs is met, as a person asked. */
  autoMerge?: AutoMerge | null;
  /**
   * The work items it closes when it merges into the default branch, by
   * number: its own and those its title and description name after a
   * closing keyword (`Fixes #12`). Merging marks this repository's link to
   * each as landed.
   */
  closes?: number[];
  /** The work items it is part of (`Part of #12`, `Refs #12`): linked, never closed by it. */
  parts?: number[];
  /** Its branch was deleted after it merged or closed, and can be restored at `headCommit`. */
  headBranchDeleted?: boolean;
  /**
   * Set on a pull request closed because another one for the same work item
   * was merged: that one's number.
   */
  supersededBy: number | null;
  /**
   * Where the latest run of the work item's acceptance checks stands, if
   * there has been one against the current head.
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
   * For a change g1t made: the person who asked for it, by assigning a work item
   * or handing g1t the work. They answer for it as its author would. See
   * `workOwner`.
   */
  requestedBy: User | null;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  updatedAt: string;
  /** Who last moved its head (a user id), and when; absent until a push after rulesets arrived. */
  headPushedBy?: string;
  headPushedAt?: string;
};

/** One file a pull request changes, and by how much. */
export type ChangedFile = { path: string; additions: number; deletions: number };

/**
 * Another pull request in progress that changes some of the same files. Two
 * for the same work item are alternatives; two for different ones are
 * heading for a conflict.
 */
export type Overlap = {
  number: number;
  title: string;
  /** The number of the work item the other pull request is for. */
  item: number | null;
  /** The files both change. */
  paths: string[];
};

/**
 * On a pull request, `failed` means the merge queue took it out, until its
 * head moves. The other states are from runs of commands written on work items,
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
 * with why, or an earlier run of commands written on its work item.
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
 * A comment on a work item or a pull request. On a pull request it can sit on
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
  /** When its text was last edited, RFC 3339; absent if it never was. */
  editedAt?: string;
  /**
   * Set when one of the workspace's agents wrote it, as itself. `author`
   * is then the agent (its id, its handle as `username`, kind `agent`):
   * show it by `agent.displayName` with an Agent badge, never as a person.
   */
  agent?: AgentRef;
  /**
   * Who the agent acted for, whose access capped it. Set with `agent`, and
   * when g1t (`author`) wrote it, or did what an event notes, in a session
   * someone started: show "on behalf of @them".
   */
  actingFor?: User;
  /**
   * An agent's review. Its `verdict` (none for a review that only
   * comments) is shown but advisory: it never counts toward required
   * approvals or code owners, and never blocks a merge.
   */
  advisory?: boolean;
  /** How people (and g1t) reacted to it. Absent when nobody has. */
  reactions?: ReactionGroup[];
};

/** An emoji reaction: the same eight as everywhere else people react to code. */
export type ReactionContent = "+1" | "-1" | "laugh" | "hooray" | "confused" | "heart" | "rocket" | "eyes";

/** The reactions, in the order they are offered, with the emoji each shows. */
export const REACTIONS: { content: ReactionContent; emoji: string; label: string }[] = [
  { content: "+1", emoji: "👍", label: "Thumbs up" },
  { content: "-1", emoji: "👎", label: "Thumbs down" },
  { content: "laugh", emoji: "😄", label: "Laugh" },
  { content: "hooray", emoji: "🎉", label: "Hooray" },
  { content: "confused", emoji: "😕", label: "Confused" },
  { content: "heart", emoji: "❤️", label: "Heart" },
  { content: "rocket", emoji: "🚀", label: "Rocket" },
  { content: "eyes", emoji: "👀", label: "Eyes" },
];

/** Everyone who reacted one way to the same thing, first to react first; `g1t` for g1t. */
export type ReactionGroup = {
  content: ReactionContent;
  count: number;
  users: string[];
};

/**
 * One of a workspace's own agents, as a comment or review it wrote before
 * g1t's agents were removed shows it: Margo (@margo), with the face drawn
 * from `avatarSeed`. Kept so those comments still render.
 */
export type AgentRef = {
  id: string;
  handle: string;
  displayName: string;
  avatarSeed: string;
};

export type NewComment = {
  /** May be empty when approving. */
  body: string;
  path?: string;
  line?: number;
  verdict?: Verdict;
};

export type CheckReport = { results?: CheckResult[]; error?: string; skip?: boolean };

export type SessionEntryKind = "prompt" | "message" | "tool_call" | "tool_result" | "note" | "skill";

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
  /**
   * Its text is not shown to this viewer (`text` is empty): a prompt shows
   * only to whoever typed it, and a tool's output to whoever ran it.
   */
  withheld?: boolean;
};

export type NewSessionEntry = Pick<SessionEntry, "kind" | "text"> &
  Partial<Pick<SessionEntry, "tool" | "commit">>;

export type PullDetail = {
  pull: Pull;
  /** The work item it is for, if any. */
  item: WorkItem | null;
  comments: Comment[];
  /** How people (and g1t) reacted to its description. */
  reactions: ReactionGroup[];
  /** The latest record against its head: the merge queue taking it out. */
  checks: CheckRun | null;
  /** Other pull requests in progress that change the same files. */
  overlaps: Overlap[];
  /**
   * Whether the branch it would merge into has moved on without it, so that
   * it has to catch up before it can merge.
   */
  behind: boolean;
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
  /**
   * The rules of the branch it merges into it does not meet yet, for whoever
   * is looking: what refuses the merge, what they may bypass, and what rulesets
   * in evaluate would refuse. Absent once it is closed or merged.
   */
  rules?: MergeRules | null;
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
  "work_item",
  "work_item_comment",
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
  /** The integration that reported it: `actions`, `deployments`, `security`, `g1t` or `api`. */
  source?: string;
  /** Set on the status a check run stands as: the check run's id. */
  checkRunId?: string;
};

/**
 * A step on the way from an assigned work item to a pull request that is ready
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
  /**
   * Merge through a queue: pull requests are tested together with those
   * ahead of them, and only a combination that passed reaches the default
   * branch.
   */
  mergeQueue: boolean;
  /**
   * Refuse to merge until the code owners of every file it changes have
   * approved, as many as each section asks. People only; `g1t` only where
   * the file names `@g1t`.
   */
  requireCodeOwnerReview?: boolean;
  /**
   * Whether work items can be filed from it (as their origin): null for the
   * default, which is on for a repository and off for a fork of one. Those
   * filed from it before stay readable, and it can always be a target.
   */
  hasWorkItems?: boolean | null;
  /** Whether work items can be filed from it now: `hasWorkItems`, or its default. */
  workItemsEnabled?: boolean;
  /** Which merge methods pull requests may use (at least one); rules can narrow them per branch. */
  allowMergeCommit: boolean;
  allowSquashMerge: boolean;
  allowRebaseMerge: boolean;
  allowFastForward: boolean;
  /** The method offered first, and used when none is named. */
  defaultMergeMethod: MergeMethod;
  /** What merge and squash commits say unless their merger writes it. */
  mergeCommitMessage: CommitMessageDefault;
  squashCommitMessage: CommitMessageDefault;
  /**
   * For `custom`: templates whose `{title}`, `{number}`, `{body}`, `{branch}`,
   * `{head_repo}`, `{base}`, `{author}`, `{commits}`, `{items}` and
   * `{co_authors}` are filled in.
   */
  mergeCommitTemplate: string | null;
  squashCommitTemplate: string | null;
  /** Offer to bring a pull request up to date whenever its base has new commits. */
  suggestUpdatingBranches: boolean;
  /** Let people turn on auto-merge for a pull request. */
  allowAutoMerge: boolean;
  /** Delete a pull request's branch once it merges (restorable from it). */
  deleteBranchOnMerge: boolean;
  /** Commits made on g1t.sh carry a `Signed-off-by:` trailer for whoever made them. */
  requireWebCommitSignOff: boolean;
  /** Let anyone who can read it comment on its commits. */
  allowCommitComments: boolean;
  /**
   * Land the work items a pull request names in this repository when it
   * merges into the default branch (and those a commit pushed there names),
   * closing those with nothing else left to land.
   */
  autoCloseItems: boolean;
  /** Username of the member who last changed the settings, if anyone has. */
  updatedBy: string | null;
  /** RFC 3339. */
  updatedAt: string | null;
};

/** What a merge or squash commit's message says by default (`pull_title_and_commits` is squash only). */
export type CommitMessageDefault = "default" | "pull_title" | "pull_title_and_description" | "pull_title_and_commits" | "custom";

/** A person's request that a pull request merge on its own once it may. */
export type AutoMerge = {
  method: MergeMethod;
  commitTitle: string | null;
  commitMessage: string | null;
  /** Username of who asked. */
  enabledBy: string;
  /** RFC 3339. */
  enabledAt: string;
};

/** A comment on a commit, or on one line (`path`, `line`) of a file it changed. */
export type CommitComment = {
  id: string;
  repoId: string;
  /** The commit's full hash. */
  commit: string;
  path: string | null;
  line: number | null;
  /** Username. */
  author: string;
  /** Markdown. */
  body: string;
  /** RFC 3339. */
  createdAt: string;
  updatedAt: string | null;
};

/** How a pull request may merge now, for whoever is looking (`mergeChoices`). */
export type MergeChoices = {
  /** The methods it may merge by: the repository's, as the rules for its base allow. In the order offered. */
  methods: MergeMethod[];
  /** The one offered first: the repository's default when it may be used, else the first of `methods`. */
  defaultMethod: MergeMethod | null;
  /** Each of `methods`, with its default commit message and whether it can be used now. */
  options: MergeChoice[];
  /** Its base has commits it does not have. */
  behind: boolean;
  /** It contains its base's head, so it can fast-forward as it is. */
  canFastForward: boolean;
  /** Offer to bring it up to date: it is behind, and the repository suggests (or requires) it. */
  suggestUpdate: boolean;
  /** The repository requires it to be up to date before it merges. */
  requireUpToDate: boolean;
  /** It merges through the merge queue, which lands it as tested whatever method is chosen. */
  mergeQueue: boolean;
  /** The viewer may turn on auto-merge for it. */
  autoMergeAllowed: boolean;
  /** Whether "delete the branch" starts ticked. */
  deleteBranchDefault: boolean;
  /** Its branch can be deleted once it merges (never a working copy's). */
  canDeleteBranch: boolean;
  /** Commits made merging it carry a `Signed-off-by:` trailer for the merger. */
  signOff: boolean;
};

/** One way a pull request may merge. */
export type MergeChoice = {
  method: MergeMethod;
  /** For `merge` and `squash`: the commit's default title and the rest of its message. */
  commitTitle: string | null;
  commitMessage: string | null;
  /** Why it cannot merge this way now, if it cannot. */
  unavailable: string | null;
};

/** How a pull request merges, as the merger chose. */
export type MergeOptions = {
  /** Leave its work item open: this pull request is only part of the work. */
  keepItemOpen?: boolean;
  /** Merge although required checks have not passed, where the rule requiring them allows it. */
  ignoreChecks?: boolean;
  /** Merge past rules a ruleset lets the actor bypass. Recorded as a bypass. */
  bypassRules?: boolean;
  /** The repository's default when absent. */
  mergeMethod?: MergeMethod;
  /** For `merge` and `squash`: the commit's title and the rest of its message. */
  commitTitle?: string;
  commitMessage?: string;
  /** Refuse if its head is no longer this commit. */
  expectedHead?: string;
  /** Delete its branch once merged; the repository's setting when absent. */
  deleteBranch?: boolean;
};

/** The settings a member can change. */
export type RepoSettingsInput = Omit<RepoSettings, "updatedBy" | "updatedAt" | "workItemsEnabled">;

/**
 * What the runner is to do next for a pull request: always nothing now,
 * since no step of a pull request is carried out in a sandbox any more.
 */
export type Advance = { action: "none" };

export type OpenWorkItemInput = {
  /** The workspace; may be left out with `repo`, meaning the repository's. */
  workspace?: string;
  /** The repository it is filed from, its origin. Without one, only a member of the workspace may file it. */
  repo?: RepoPath;
  /** Repositories of the workspace where the work is meant to land. */
  targets?: RepoPath[];
  title: string;
  body: string;
  labels?: string[];
  /** The number of the workspace milestone to put it in. Needs the Triage role. */
  milestone?: number;
};

export type UpdateWorkItemInput = {
  title?: string;
  body?: string;
  labels?: string[];
  /** Usernames of the people it is assigned to; replaces the whole set. */
  assignees?: string[];
  /** The number of the workspace milestone to put it in; 0 takes it out. */
  milestone?: number;
  /** The work items of the workspace that have to land first, by number; replaces the whole set. */
  blocked_by?: number[];
};

/** The filters on `listWorkItems`. */
export type WorkItemFilter = {
  /** Only those linked to this repository (in any role, or in `role`). */
  repo?: RepoPath;
  role?: LinkRole;
  state?: State;
  label?: string;
  milestone?: number;
  /** Only those assigned to this username. */
  assignee?: string;
};

export type OpenPullInput = {
  /** The work item this is for, by number in the repository's workspace. */
  item?: number;
  /** Defaults to the work item's title; required without one. */
  title?: string;
  /** What changed and why. Usually set later, when a draft is marked ready. */
  body?: string;
  /**
   * A branch of the repository that already holds the change. The pull
   * request is then ready for review at once and has no fork.
   */
  branch?: string;
  /**
   * A fork of the repository (directly or through other forks) whose
   * `branch` holds the change. Needs `branch`.
   */
  headRepo?: RepoPath;
  agent: string;
  runtime: Runtime;
  /** The branch to merge into: the default branch when left out. */
  base?: string;
  /**
   * Opened from a branch as a draft, still being worked on: it can't merge
   * until it is marked ready.
   */
  draft?: boolean;
};

/** One repository's pull requests from `pullsForRepos`, newest first. */
export type RepoPulls = {
  repoId: string;
  /** Draft and open. */
  open: Pull[];
  /** Merged and closed. */
  closed: Pull[];
};

/** Where a comment is kept, for changing it: a repository's pull requests, or a workspace's work items. */
export type CommentScope = { repo: RepoPath } | { workspace: string };

/** Work items, pull requests, comments and sessions. */
export interface WorkApi extends RulesApi, ChecksApi, CoordinationApi {
  /**
   * Files a work item: from `repo` (its origin) by anyone who may take part
   * there, or in the workspace alone by a member. `targets` are where it is
   * meant to land.
   */
  openWorkItem(actor: User, input: OpenWorkItemInput): Promise<Result<WorkItem>>;
  /** A workspace's work items the viewer may see, newest first. */
  listWorkItems(workspace: string, viewer: Viewer, filter?: WorkItemFilter): Promise<Result<WorkItem[]>>;
  getWorkItem(workspace: string, number: number, viewer: Viewer): Promise<Result<WorkItemDetail>>;
  /** Its owner, or someone with the Triage role on it, may. */
  updateWorkItem(actor: User, workspace: string, number: number, input: UpdateWorkItemInput): Promise<Result<WorkItem>>;
  /**
   * Closes it; with `by`, as the commit there (on its repository's default
   * branch, naming it after a closing keyword) would have: it lands there,
   * and closes once nothing else is left to land.
   */
  closeWorkItem(
    actor: User,
    workspace: string,
    number: number,
    reason?: CloseReason,
    by?: { repo: RepoPath; commit: string },
  ): Promise<Result<WorkItem>>;
  reopenWorkItem(actor: User, workspace: string, number: number): Promise<Result<WorkItem>>;
  /** Links a repository of the workspace as a target (or as touched), or changes how it is linked. Needs Triage. */
  linkWorkItem(actor: User, workspace: string, number: number, repo: RepoPath, role?: LinkRole): Promise<Result<WorkItem>>;
  /** Removes a repository's link (never its origin's). Needs Triage. */
  unlinkWorkItem(actor: User, workspace: string, number: number, repo: RepoPath): Promise<Result<WorkItem>>;
  /** What `#number` names for the viewer, read in a repository (and its workspace) or a workspace alone. */
  resolveRef(viewer: Viewer, context: { repo: RepoPath } | { workspace: string }, number: number): Promise<RefTarget>;
  /** The work items that a commit pushed to the repository's default branch resolved, of those the viewer may read. */
  closedByCommit(repo: RepoPath, commit: string, viewer: Viewer): Promise<Result<ClosedItem[]>>;
  /** A workspace's labels, by name, each with how many work items and pull requests carry it. */
  listLabels(workspace: string, viewer: Viewer): Promise<Result<Label[]>>;
  /**
   * Creates a label, or with `name` changes one; renaming it renames it on
   * everything that carries it. Needs the Write role in the workspace.
   */
  saveLabel(
    actor: User,
    workspace: string,
    label: { name?: string; newName?: string; color?: string; description?: string },
  ): Promise<Result<Label>>;
  /** Removes a label from the workspace and everything carrying it. */
  deleteLabel(actor: User, workspace: string, name: string): Promise<Result<boolean>>;
  /** Adds the default labels the workspace does not have yet; returns them all. */
  addDefaultLabels(actor: User, workspace: string): Promise<Result<Label[]>>;
  /**
   * The labels of a work item or a pull request, replaced, added to or
   * taken from. Labels the workspace lacks are created for someone who may
   * manage labels. Returns its labels now.
   */
  setLabels(actor: User, thread: Thread, labels: string[], change?: LabelChange): Promise<Result<string[]>>;
  /** A workspace's, open ones by due date, then closed ones; both unless `state` says. */
  listMilestones(workspace: string, viewer: Viewer, state?: State): Promise<Result<Milestone[]>>;
  getMilestone(workspace: string, number: number, viewer: Viewer): Promise<Result<MilestoneDetail>>;
  /** Creates a milestone, or with `number` changes the fields given. Needs the Write role in the workspace. */
  saveMilestone(
    actor: User,
    workspace: string,
    milestone: { number?: number; title?: string; description?: string; dueOn?: string; state?: State },
  ): Promise<Result<Milestone>>;
  deleteMilestone(actor: User, workspace: string, number: number): Promise<Result<boolean>>;
  /** How many work items linked to the repository, and how many of its pull requests, are open. */
  counts(repo: RepoPath, viewer: Viewer): Promise<Result<{ items: number; pulls: number }>>;
  /** Moves on the job that moves issues into work items; does nothing once done. */
  migrateWorkItems(): Promise<{ done: boolean; repos: number; numbered: number; unplaced: number }>;

  /**
   * On a work item or a pull request. On a pull request it may name a line
   * of the change and carry a verdict; nobody can give a verdict on their own.
   */
  addComment(actor: User, thread: Thread, comment: NewComment): Promise<Result<Comment>>;
  /**
   * Changes a comment's text. Its author may, and so may anyone with the
   * Maintain role or higher; notes of what happened cannot be changed.
   */
  editComment(actor: User, scope: CommentScope, commentId: string, body: string): Promise<Result<Comment>>;
  /**
   * Deletes a comment: its author, or anyone with the Maintain role or
   * higher. A review that gave a verdict cannot be deleted, only edited.
   */
  deleteComment(actor: User, scope: CommentScope, commentId: string): Promise<Result<boolean>>;
  /**
   * Reacts to comment `commentId` on a work item or pull request, or to its
   * description without one; with `remove`, takes it back. Anyone who can
   * read it may. What it has now.
   */
  react(
    actor: User,
    thread: Thread,
    reaction: { commentId?: string; content: ReactionContent; remove?: boolean },
  ): Promise<Result<ReactionGroup[]>>;

  /**
   * What a sandbox says about a run from before checks were workflows: so
   * one still finishing is recorded.
   */
  reportChecks(runId: string, token: string, report: CheckReport): Promise<Result<CheckRun>>;
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
  /**
   * Ids of the open pull requests to move along: those g1t merges by itself
   * or someone set to auto-merge; with `repoId`, also every open one whose
   * lifecycle is remembered, to bring it up to date after a merge there.
   */
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
   * Delivery for up to 100 repositories over UTC days `from` through
   * `until`, over their whole history. Repositories the viewer cannot read,
   * and forks, are left out of `projects`.
   */
  deliveryInsights(repoIds: string[], viewer: Viewer, from: string, until: string): Promise<DeliveryInsights>;
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
  catchUpPull(
    actor: User,
    repo: RepoPath,
    number: number,
    options?: { updateMethod?: UpdateMethod; expectedHead?: string },
  ): Promise<Result<PullBranchUpdate>>;
  /**
   * Turns a pull request's auto-merge on (with how to merge) or off. On needs
   * Write, since it merges as whoever turned it on; its author may also turn
   * it off. Refused where the repository does not allow auto-merge or the
   * method. One that may merge already merges at once.
   */
  setAutoMerge(
    actor: User,
    repo: RepoPath,
    number: number,
    enabled: boolean,
    options?: { mergeMethod?: MergeMethod; commitTitle?: string; commitMessage?: string },
  ): Promise<Result<Pull>>;
  /** How a pull request may merge now: methods, default messages, auto-merge and branch deletion. */
  mergeChoices(viewer: Viewer, repo: RepoPath, number: number): Promise<Result<MergeChoices>>;
  /** Deletes a merged or closed pull request's branch (Push on where it is). */
  deleteHeadBranch(actor: User, repo: RepoPath, number: number): Promise<Result<Pull>>;
  /** Makes a deleted pull request branch again at its head. */
  restoreHeadBranch(actor: User, repo: RepoPath, number: number): Promise<Result<Pull>>;
  /** A commit's comments, oldest first; with no commit, the repository's, newest first, 30 a page. */
  commitComments(viewer: Viewer, repo: RepoPath, commit?: string | null, page?: number): Promise<Result<CommitComment[]>>;
  /** Comments on a commit, or on one line of a file it changed. Needs Read, where commit comments are on. */
  addCommitComment(
    actor: User,
    repo: RepoPath,
    commit: string,
    body: string,
    at?: { path: string; line: number },
  ): Promise<Result<CommitComment>>;
  editCommitComment(actor: User, repo: RepoPath, id: string, body: string): Promise<Result<CommitComment>>;
  deleteCommitComment(actor: User, repo: RepoPath, id: string): Promise<Result<boolean>>;
  /** Marks a draft ready for review and sets its description. */
  readyPull(actor: User, repo: RepoPath, number: number, summary: string): Promise<Result<Pull>>;
  closePull(actor: User, repo: RepoPath, number: number): Promise<Result<Pull>>;
  /** Opens a closed pull request again, as the draft it was if it was closed as one. Never a merged one. */
  reopenPull(actor: User, repo: RepoPath, number: number): Promise<Result<Pull>>;
  /** Turns an open pull request back into a draft; it leaves the merge queue. */
  convertPullToDraft(actor: User, repo: RepoPath, number: number): Promise<Result<Pull>>;
  /**
   * Lands the pull request on the repository's default branch. Unless
   * `keepItemOpen`, that lands the work items it closes in this repository
   * (each closing once nothing else is left to land), and the others still
   * in progress here for its own close as superseded. Only members of the
   * repository's workspace may merge.
   *
   * If the default branch has moved, the pull request is brought up to date
   * first and lands when that is done; it comes back still open, and
   * `PullDetail.landing` is true meanwhile. A repository that requires pull
   * requests to be up to date refuses instead.
   */
  mergePull(actor: User, repo: RepoPath, number: number, options?: MergeOptions): Promise<Result<Pull>>;
  /**
   * Drafts and open pull requests the viewer started, most recently active
   * first, each with where it stands if g1t is seeing it through.
   */
  listActivePulls(
    viewer: Viewer,
  ): Promise<{ pull: Pull; item: WorkItem | null; lifecycle: Lifecycle | null }[]>;
  /**
   * The work items and pull requests a person opened, a page at a time,
   * only those the viewer may read. Not found for no such account.
   */
  byAuthor(username: string, viewer: Viewer, filter?: AuthoredFilter): Promise<Result<Authored>>;
  /**
   * What a person did each day of the last year (work items and pull requests
   * opened, reviews given), only on repositories the viewer may read: the
   * calendar on their profile. Not found for no such account.
   */
  contributions(username: string, viewer: Viewer): Promise<Result<Contributions>>;



  appendSession(actor: User, repo: RepoPath, number: number, entries: NewSessionEntry[]): Promise<Result<{ count: number }>>;
  readSession(repo: RepoPath, number: number, viewer: Viewer, afterSeq?: number): Promise<Result<SessionEntry[]>>;
}

/**
 * What to pass `ReposApi.compare` to see what a pull request changes.
 *
 * A working copy is compared as a whole. A branch, of the repository or of
 * a fork of it, is compared by name while the pull request is open, and by
 * the commit it was merged or closed at afterwards, so later pushes to the
 * branch do not change the record. A fork's branch is compared from the
 * repository it merges into (`targetId`).
 */
export function pullComparison(pull: Pull): {
  repoId: string;
  base: string | null;
  head: string | null;
  /** The branch it merges into, which it is compared from. */
  baseBranch: string | null;
  /** For a fork's branch: the repository it merges into. */
  targetId: string | null;
} {
  const baseBranch = pull.base ?? null;
  if (pull.forkRepoId) return { repoId: pull.forkRepoId, base: pull.mergeBase, head: null, baseBranch, targetId: null };
  const settled = pull.status === "merged" || pull.status === "closed";
  return {
    repoId: pull.headRepoId ?? pull.repoId,
    base: pull.mergeBase,
    // A fork's branch by the commit it was last seen at, which the repository
    // it merges into holds too, so those who read that repository can read it.
    head: ((settled || pull.headRepoId) && pull.headCommit) || pull.branch,
    baseBranch,
    targetId: pull.headRepoId ? pull.repoId : null,
  };
}

/** The id of the repository holding a pull request's change: its working copy, its fork, or the repository. */
export function pullSourceId(pull: Pull): string {
  return pull.forkRepoId ?? pull.headRepoId ?? pull.repoId;
}


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
  /** How it lands: the state is built with its commits made this way. */
  method?: MergeMethod;
  /** For merge and squash: the commit's message. */
  message?: string;
  /** For squash: who the commit is by. */
  author?: User;
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

export type AuthoredKind = "item" | "pull";
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
  /** The workspace it is numbered in. */
  workspace: string;
  /** A pull request's repository, or the repository a work item was filed from, if it was. */
  repo: RepoPath | null;
  number: number;
  title: string;
  /** A merged pull request is closed. */
  state: State;
  /** A pull request's own status; null on a work item. */
  status: PullStatus | null;
  /** Why a work item was closed. */
  reason: CloseReason | null;
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
  items: number;
  itemsOpen: number;
};

export type Authored = {
  items: AuthoredItem[];
  /** Pass as `before` for the next page; null on the last. */
  next: string | null;
  counts: AuthoredCounts;
  /** The repositories they worked in that the viewer may read, most work first. */
  repos: { repo: RepoPath; count: number }[];
};

// Mirrors `Contributions` in `crates/contracts/src/work.rs`.

/** How many days `contributions` covers: today and the 364 before it. */
export const CONTRIBUTION_DAYS = 365;

/** One day with something on it; days with nothing are left out. */
export type ContributionDay = {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  /** Everything that day, commits included. */
  count: number;
  /** How many of `count` are commits they pushed to a default branch. */
  commits?: number;
};

/** A person's year, as far as the viewer may see. */
export type Contributions = {
  /** Oldest first. */
  days: ContributionDay[];
  total: number;
  /** The first day counted, `YYYY-MM-DD`; the last is today (UTC). */
  from: string;
};

// --- Coordinating work: sessions, claims and dependencies -----------------
// Mirrors `crates/contracts/src/work/coordination.rs`.

/** The harness a session runs in. */
export type Harness = "claude_code" | "claude_managed_agents" | "codex" | "cursor" | "copilot" | "other";

/** A session as a mark on something it made. */
export type SessionRef = { id: string; harness: Harness };

/** The sessions tied to one pull request (`pullSessions`). */
export type PullSessions = { number: number; sessions: SessionRef[] };

/** Active: heard from in 15 minutes; idle: not since; ended: ended, or quiet for 2 hours. */
export type SessionState = "active" | "idle" | "ended";

/** One run of someone's own harness on a repository. */
export type WorkSession = {
  /** `ses_…`. */
  id: string;
  repoId: string;
  /** The work item it works on, by number in the repository's workspace. */
  item: number | null;
  pull: number | null;
  branch: string | null;
  actor: { id: string; username: string };
  harness: Harness;
  harnessSessionId: string | null;
  title: string | null;
  state: SessionState;
  headCommit: string | null;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  /** What the harness said, or `timed_out`. */
  endReason: string | null;
  /** For a subagent: the session that started it. */
  parentId?: string | null;
  /** For a subagent: its kind (Explore, security-reviewer). */
  agentType?: string | null;
  /** For a subagent: the task it was given, in a few words. */
  task?: string | null;
  /** For a subagent: the prompt its parent gave it. */
  prompt?: string | null;
  /** What it reported when it finished: a subagent's final message. */
  result?: string | null;
  model?: string | null;
  /** How many subagents it started. */
  subagents?: number;
  /** In a list, for one with no title: the start of the first prompt it recorded. */
  firstPrompt?: string | null;
};

/** What kind of thing a session touched. */
export type TouchKind = "file" | "commit" | "branch" | "pull" | "item";

/** Something a session touched, kept once per session. A work item's `value` is its number. */
export type SessionTouch = { sessionId: string; kind: TouchKind; value: string; at: string };

/** How a session was tied to a work item or pull request. */
export type LinkVia = "attached" | "claim" | "branch" | "commit" | "trailer" | "opened" | "ref";

/** A work item or pull request a session, or one of its subagents, worked on. */
export type SessionLink = {
  kind: "item" | "pull";
  number: number;
  title: string;
  /** The work item's state or the pull request's status. */
  state: string;
  via: LinkVia[];
  sessionIds: string[];
};

/** A skill a session used, by name. */
export type SessionSkill = { sessionId: string; name: string; uses: number };

export type ClaimState = "active" | "released" | "expired" | "handed_off";

/** An advisory, expiring "I'm working on #N". Never a lock. */
export type Claim = {
  /** `clm_…`. */
  id: string;
  /** The repository of the checkout it was made from, if any. */
  repoId: string | null;
  /** The work item it is on: its workspace and number. */
  workspace: string;
  item: number;
  sessionId: string | null;
  actor: { id: string; username: string };
  harness: Harness | null;
  note: string | null;
  state: ClaimState;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
  /** For a hand-off: who it was handed to; null for anyone. */
  handoffTo: string | null;
};

/** `session.started` and `session.ended`. */
export type SessionEventData = { repoId: string; number?: number; item?: number; session: WorkSession };

/** `work.claimed`, `work.released`, `work.claim_expired` and `work.handoff_requested`. */
export type ClaimEventData = {
  repoId?: string;
  workspace: string;
  number: number;
  item: number;
  /** The repositories the work item is linked to. */
  repoIds: string[];
  claim: Claim;
  others?: Claim[];
  tookOver?: string;
  reason?: string;
  from?: string;
  to?: string;
  note?: string;
};

/** `dependency.changed`. */
export type DependencyChangedData = {
  workspace: string;
  number: number;
  item: number;
  repoIds: string[];
  blockedBy: number[];
  added: number[];
  removed: number[];
  cleared: number[];
  remaining: number[];
  mergedPull?: number;
};

/** `overlap.detected` between two pull requests, sent once for each side of a new overlap. */
export type PullOverlapData = {
  repoId: string;
  number: number;
  pull: number;
  otherPull: number;
  files: string[];
  item?: number;
  otherItem?: number;
};

/** `overlap.detected` between two sessions that touched the same files (siblings included), once for each side. */
export type SessionOverlapData = {
  repoId: string;
  number?: number;
  sessionId: string;
  otherSessionId: string;
  otherActor: string;
  files: string[];
  item?: number;
  otherItem?: number;
};

/** `overlap.detected`: between pull requests, or between sessions (with `sessionId`). */
export type OverlapDetectedData = PullOverlapData | SessionOverlapData;

/** `session.progressed`: a session recorded more (at most every few seconds). */
export type SessionProgressedData = { repoId: string; number?: number; sessionId: string; rootId?: string };

/** A work item in brief. */
export type ItemBrief = { number: number; title: string; state: State };

/** A pull request in brief. */
export type PullBrief = { number: number; title: string; status: PullStatus };

/** A work item another is blocked by, and where it stands. */
export type Blocker = {
  number: number;
  title: string;
  state: State;
  /** Active claims on it. */
  claims: Claim[];
  pulls: PullBrief[];
};

/** A pull request's place in the merge queue; `position` 1 is the front. */
export type QueuePlace = { state: QueueState; position: number };

/** One of a work item's pull requests, with where it stands. */
export type WorkPull = {
  /** Its repository, `owner/name`. */
  repo: string;
  number: number;
  title: string;
  status: PullStatus;
  branch: string | null;
  headCommit: string | null;
  author: { id: string; username: string };
  /** `failed` when the merge queue took it out, until its head moves. */
  checkStatus: CheckStatus | null;
  requiredChecks: RequiredCheck[];
  mergeable: Mergeable;
  /** Other pull requests in progress changing the same files. */
  overlaps: Overlap[];
  /** Its place in the merge queue, while it is in it. */
  queue: QueuePlace | null;
};

// --- Decision records (crates/contracts/src/decisions.rs) ------------------

export type DecisionKind =
  | "proposal"
  | "claim"
  | "integration_failure"
  | "integration_passed"
  | "fix"
  | "approval"
  | "merge"
  | "note";

/** Claimed: someone said so. Tested: a check or the merge queue proved it. Approved: a person approved it. */
export type DecisionConfidence = "claimed" | "tested" | "approved";

/** A structured reason kept on a work item or pull request, with how sure it is. */
export type Decision = {
  /** `dec_…`. */
  id: string;
  /** The work item it is about, by number in its workspace. */
  item: number | null;
  pull: number | null;
  sessionId: string | null;
  /** Username of who recorded it; null when g1t did. */
  actor: string | null;
  kind: DecisionKind;
  confidence: DecisionConfidence;
  summary: string;
  /**
   * What it rests on, kept as recorded, in snake_case: `commit`, `check`
   * (`name`, `conclusion`, `url`), `combination`, `other_pulls`,
   * `suspects`, `bisected`, `merge_queue`.
   */
  evidence: Record<string, unknown>;
  /** RFC 3339. */
  createdAt: string;
};

/** One repository a work item is linked to, with what landed there and its pull requests for it. */
export type WorkRepo = ItemRepo & {
  /** The checks every pull request into its default branch must pass. */
  requiredChecks: string[];
  /** Its pull requests for the work item, oldest first. */
  pulls: WorkPull[];
};

/** A repository of the workspace the work may belong in; confirming it is `linkWorkItem` as a target. */
export type SuggestedTarget = { repoId: string; path: string; why: string; score: number };

/** Everything about a work item an agent needs to pick it up: `get_work`. */
export type WorkContext = {
  item: WorkItem;
  /** The items under its "Definition of done" heading. */
  definitionOfDone: string[];
  /** Its repositories: origin, then targets, then touched. */
  repos: WorkRepo[];
  /** The targets it has not landed in yet, by path. */
  missing: string[];
  /** Repositories it may belong in, likeliest first, each with why. */
  suggestedTargets: SuggestedTarget[];
  /** Active claims on it. */
  claims: Claim[];
  /** Sessions on it or its pull requests, most recently heard from first. */
  sessions: WorkSession[];
  blockedBy: Blocker[];
  /** The work items it blocks. */
  blocks: ItemBrief[];
  /** On it and its pull requests, newest first. */
  decisions: Decision[];
  /** The latest `integration_failure` decision among them. */
  lastIntegrationFailure: Decision | null;
  /** Its latest coordination events, newest first. */
  recent: G1tEvent[];
};

/** A harness session and what it recorded. */
export type WorkSessionDetail = {
  /** Pending repository coordination events; reading does not acknowledge them. */
  updates?: { id: string; kind: string; data: unknown; at: string }[];
  session: WorkSession;
  entries: SessionEntry[];
  /** Its subagents and theirs, in the order they started. */
  children?: WorkSession[];
  /** What it and its subagents touched. */
  touched?: SessionTouch[];
  /** The work items and pull requests it and its subagents worked on. */
  links?: SessionLink[];
  skills?: SessionSkill[];
  /** For a subagent: the session at the top of its tree. */
  root?: WorkSession | null;
  /**
   * The viewer is not a member of the repository's workspace: the session
   * shows that it runs, who runs it and what it is tied to, nothing more.
   */
  limited?: boolean;
};

/** Reading coordination: work service methods (services/work/src/coordination, decisions.rs). */
export interface CoordinationApi {
  getWork(workspace: string, number: number, viewer: Viewer): Promise<Result<WorkContext>>;
  /**
   * A workspace's claims on the work items the viewer may see, newest
   * first; active ones unless `state` says otherwise. With `repo`, those
   * made from it or on work items linked to it.
   */
  listClaims(
    workspace: string,
    viewer: Viewer,
    filter?: { state?: ClaimState; item?: number; repo?: RepoPath },
  ): Promise<Result<Claim[]>>;
  /** Most recently heard from first; `item` is a work item of the repository's workspace. */
  listWorkSessions(
    repo: RepoPath,
    viewer: Viewer,
    filter?: { state?: SessionState; item?: number; pull?: number; path?: string; subagents?: boolean },
  ): Promise<Result<WorkSession[]>>;
  getWorkSession(repo: RepoPath, id: string, viewer: Viewer, afterSeq?: number): Promise<Result<WorkSessionDetail>>;
  /**
   * Ends a session by hand, from the site: the actor's own, or anyone's
   * when they have write access to the repository. It ends as
   * `ended by hand by @actor`, with its subagents still going
   * (`end_session` with `by_hand`; g1t_contracts::work::session_end_reason).
   */
  endWorkSession(actor: User, repo: RepoPath, id: string): Promise<Result<WorkSession>>;
  /**
   * The harness sessions tied to some pull requests (at most 100), any way
   * a session is tied to one; a subagent's as the session that started it.
   * Only pull requests with any are listed.
   */
  pullSessions(repo: RepoPath, viewer: Viewer, numbers: number[]): Promise<Result<PullSessions[]>>;
  /** A work item's (with its pull requests') or a pull request's, oldest first. */
  listDecisions(thread: Thread, viewer: Viewer): Promise<Result<Decision[]>>;
}

/**
 * Delivery counts cover the requested UTC days; waiting counts are current.
 * `checking` and `failed` count each open pull request once, by its head's
 * checks (statuses, check runs and g1t Actions jobs); one with none is in neither.
 */
export type DeliveryMetrics = { repoId: string; opened: number; merged: number; active: number; unreviewed: number; checking: number; failed: number; queued: number; leadSeconds: number; reviewSeconds: number; reviewed: number };
/** `checksUnavailable`: g1t Actions could not be read, so `checking` and `failed` are not known. */
export type DeliveryInsights = { projects: DeliveryMetrics[]; days: { day: string; merged: number }[]; checksUnavailable: boolean };
