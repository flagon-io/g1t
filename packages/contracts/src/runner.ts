import type { AgentRun } from "./agents";
import type { Trial } from "./billing";
import type { User, Viewer } from "./identity";
import type { Result } from "./result";
import type { RepoPath } from "./repos";
import type { DelegateInput, Delegated, Plan, Pull } from "./work";

export type RunHostedInput = {
  /** Extra guidance given to the agent along with the issue. */
  instructions?: string;
};

/**
 * Sandboxes on g1t: agents that work on an issue, reviews, and the merge queue.
 *
 * Nobody who assigns a g1t agent picks a model. g1t routes each kind of
 * work itself, and says in the session which model ran.
 */
/**
 * How a workspace's agents reach a model. The workspace decides: its own
 * provider (`own` names it), or g1t's hosted models paid from its credit.
 */
export type ModelAccess = {
  /** The workspace's own model connection, by name, if it has one. */
  own: string | null;
  /** Whether g1t's hosted models are open to it, on its free allowance or otherwise. */
  hosted: boolean;
  /** Its free allowance, when that is how it reaches g1t's hosted models; null when it needs none. */
  trial: Trial | null;
  /**
   * True when hosted models are closed to it because billing takes no real
   * money yet: until then they are open only to the workspaces g1t lists,
   * and every other workspace uses its own provider.
   */
  preview: boolean;
};

/**
 * The files every g1t agent run in a repository reads as the repository's
 * instructions, as they are on its default branch.
 */
export type RepoInstructions = {
  branch: string;
  /** Null when the repository has no commits yet. */
  commit: string | null;
  files: {
    path: string;
    /** `root` is read by every run, `directory` by runs that touch files under it, `review` by reviews. */
    role: "root" | "directory" | "review";
    text: string;
    /** Longer than agents are given; they get the start of it. */
    truncated: boolean;
    lastChanged: { commit: string; message: string; author: string; at: string } | null;
  }[];
  /** How much of each file, and of all of them, an agent is given. */
  limits: { fileChars: number; totalChars: number };
};

export interface RunnerApi {
  /**
   * The repository's instructions for agents (`AGENTS.md`, `CLAUDE.md`,
   * `.g1t/review.md`), as they are on its default branch: what every g1t
   * agent run there reads. Whoever can see the repository may ask.
   */
  instructions(viewer: Viewer, repo: RepoPath): Promise<Result<RepoInstructions>>;
  /** How `workspace`'s agents would reach a model now. */
  modelAccess(workspace: string): Promise<ModelAccess>;
  /**
   * Whether `viewer` may put g1t's agents to work: in `repo`'s workspace,
   * or with none named, in any of theirs.
   */
  enabled(viewer: Viewer, repo?: RepoPath): Promise<boolean>;
  /**
   * Assigns the issue to a g1t agent: opens a draft pull request for it,
   * made by an agent in a sandbox of its own. Returns as soon as the
   * sandbox is starting; progress shows up in the pull request's session.
   * Scale comes from assigning many issues, each to its own agent.
   */
  run(actor: User, repo: RepoPath, issue: number, input?: RunHostedInput): Promise<Result<Pull>>;
  /**
   * Puts an agent on something in one step: opens an issue and assigns it
   * to g1t-agent. Refused, with nothing opened, unless `actor` may put
   * agents to work in `repo` (Write). Once opened, the issue stays whatever
   * becomes of the agent: `agent` says whether it started, waits for a
   * free slot, or did not start, why and where to fix it.
   */
  delegate(actor: User, repo: RepoPath, input: DelegateInput): Promise<Result<Delegated>>;
  /**
   * Has an agent read the repository and turn an outcome into a plan: the
   * issues that would get there and the order they have to land in. Returns
   * the plan's id as soon as the sandbox is starting; the plan fills in when
   * the agent has written it. Members of the repository's workspace only.
   */
  plan(actor: User, repo: RepoPath, brief: string): Promise<Result<{ planId: string }>>;
  /**
   * Opens a plan's issues. With `assign`, a g1t agent starts on each that
   * depends on nothing, and on the others as what they depend on merges.
   */
  applyPlan(
    actor: User,
    repo: RepoPath,
    planId: string,
    options?: { assign?: boolean; keep?: number[] },
  ): Promise<Result<Plan>>;
  /**
   * Brings a pull request up to date with the branch it would merge into,
   * in a sandbox. A clean merge is pushed as it is; a conflict is resolved
   * by a g1t agent. Whoever can push to the pull request's source may ask:
   * its author, or for one from a branch, a workspace member.
   */
  update(actor: User, repo: RepoPath, number: number): Promise<Result<boolean>>;
  /**
   * Has a g1t agent review a pull request: line comments, a summary and a
   * verdict, posted as `g1t-agent`.
   */
  review(actor: User, repo: RepoPath, number: number): Promise<Result<boolean>>;
  /**
   * Stops an agent run: marks it stopped, destroys its sandbox, and leaves
   * the pull request it was on for a person. Members of the workspace only.
   */
  stopRun(actor: User, repo: RepoPath, runId: string): Promise<Result<AgentRun>>;
}
