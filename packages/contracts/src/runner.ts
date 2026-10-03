import type { User, Viewer } from "./identity";
import type { Result } from "./result";
import type { RepoPath } from "./repos";
import type { Plan, Pull } from "./work";

export type RunHostedInput = {
  /** Extra guidance given to the agent along with the issue. */
  instructions?: string;
};

/**
 * Sandboxes on g1t: agents that work on an issue, and acceptance checks.
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
  /** Whether g1t's hosted models are open to it. */
  hosted: boolean;
};

export interface RunnerApi {
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
   * Runs the acceptance checks of a pull request again. Whoever opened it,
   * or a member of the repository's workspace, may ask.
   */
  recheck(actor: User, repo: RepoPath, number: number): Promise<Result<boolean>>;
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
}
