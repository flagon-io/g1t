import type { User, Viewer } from "./identity";
import type { Result } from "./result";
import type { Attempt } from "./work";

export type RunHostedInput = {
  /** How many agents to race on the intent, each in its own sandbox. */
  count: number;
  /** Extra guidance appended to the intent's brief for these runs. */
  instructions?: string;
};

/** Hosted agents: sandboxes on g1t that work on an intent. */
export interface RunnerApi {
  /** Whether this viewer may start hosted agents. */
  available(viewer: Viewer): Promise<boolean>;
  /**
   * Starts `count` attempts on the intent, each run by an agent in its own
   * sandbox. Returns as soon as the sandboxes are starting; progress shows
   * up in each attempt's session.
   */
  run(actor: User, intentId: string, input: RunHostedInput): Promise<Result<Attempt[]>>;
}
