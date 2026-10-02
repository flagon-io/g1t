import type { User, Viewer } from "./identity";
import type { Result } from "./result";
import type { Attempt } from "./work";

/** A model a g1t agent can run on, as offered to the person starting it. */
export type AgentModel = {
  /** Stable name used in requests, e.g. `balanced`. */
  id: string;
  label: string;
  description: string;
};

export type RunHostedInput = {
  /** How many agents to race on the intent, each in its own sandbox. */
  count: number;
  /** Extra guidance appended to the intent's brief for these runs. */
  instructions?: string;
  /** One of the offered model ids; the first offered when absent. */
  model?: string;
};

/** Hosted agents: sandboxes on g1t that work on an intent. */
export interface RunnerApi {
  /** The models this viewer may run g1t agents on; empty if they may not. */
  models(viewer: Viewer): Promise<AgentModel[]>;
  /**
   * Starts `count` attempts on the intent, each run by an agent in its own
   * sandbox. Returns as soon as the sandboxes are starting; progress shows
   * up in each attempt's session.
   */
  run(actor: User, intentId: string, input: RunHostedInput): Promise<Result<Attempt[]>>;
}
