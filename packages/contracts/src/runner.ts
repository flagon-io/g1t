import type { User, Viewer } from "./identity";
import type { Result } from "./result";
import type { RepoPath } from "./repos";
import type { Pull } from "./work";

/** A model a g1t agent can run on, as offered to the person starting it. */
export type AgentModel = {
  /** Stable name used in requests, e.g. `balanced`. */
  id: string;
  label: string;
  description: string;
  /** The model behind it, by its public name, e.g. `Claude Sonnet 5.5`. */
  modelName: string;
};

export type RunHostedInput = {
  /** How many agents to put on the issue, each in its own sandbox. */
  count: number;
  /** Extra guidance given to the agents along with the issue. */
  instructions?: string;
  /** One of the offered model ids; the first offered when absent. */
  model?: string;
};

/** Sandboxes on g1t: agents that work on an issue, and acceptance checks. */
export interface RunnerApi {
  /** The models this viewer may run g1t agents on; empty if they may not. */
  models(viewer: Viewer): Promise<AgentModel[]>;
  /**
   * Opens `count` draft pull requests for the issue, each made by an agent
   * in its own sandbox. Returns as soon as the sandboxes are starting;
   * progress shows up in each pull request's session.
   */
  run(actor: User, repo: RepoPath, issue: number, input: RunHostedInput): Promise<Result<Pull[]>>;
  /**
   * Runs the acceptance checks of a pull request again. Whoever opened it,
   * or a member of the repository's workspace, may ask.
   */
  recheck(actor: User, repo: RepoPath, number: number): Promise<Result<boolean>>;
}
