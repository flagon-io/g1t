import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/** Millionths of a US dollar in one dollar: the unit money is held in. */
export const MICROS_PER_DOLLAR = 1_000_000;

/** Whether workspaces are charged for agents at all, and with real money. */
export type BillingStatus = {
  /**
   * False when no card processor is configured: nothing is charged, and who
   * may run agents is decided some other way.
   */
  enabled: boolean;
  /** False while the card processor is in its test mode, where cards are not real. */
  live: boolean;
};

/** A workspace's standing. */
export type BillingAccount = {
  workspace: string;
  /**
   * Credit left, in millionths of a dollar. Can dip below zero by the cost
   * of the runs that were under way when it ran out.
   */
  balanceMicros: number;
  status: BillingStatus;
  /** What is added to a run's cost, in percent. */
  marginPercent: number;
  /** What a run on the workspace's own model provider is charged instead. */
  orchestrationFeeMicros: number;
};

/** One line of a workspace's statement. */
export type LedgerEntry = {
  id: string;
  /** Credit bought with a card, or an agent's run. */
  kind: "top_up" | "usage";
  /** Positive for credit added, negative for usage. */
  amountMicros: number;
  description: string;
  /** For usage: the repository and pull request the agent worked on. */
  repo: string | null;
  number: number | null;
  /** For usage: `implement`, `review` or `update`. */
  task: string | null;
  /** For usage: the model, by its public name. */
  model: string | null;
  /** For usage: who paid the model provider. */
  billedTo: "g1t" | "workspace";
  /** For a top-up: the username of whoever paid. */
  createdBy: string | null;
  /** RFC 3339. */
  createdAt: string;
};

/** What lets a sandbox, and nothing else, report what its run cost. */
export type RunTicket = { runId: string; token: string };

/**
 * What agents cost, charged to the workspace they worked for. A workspace
 * buys credit; each run deducts its cost plus g1t's margin; with no credit,
 * no agent starts.
 */
export interface BillingApi {
  status(): Promise<BillingStatus>;
  /** Members of the workspace only. */
  account(workspace: string, viewer: Viewer): Promise<Result<BillingAccount>>;
  /** Newest first. Members of the workspace only. */
  ledger(workspace: string, viewer: Viewer): Promise<Result<LedgerEntry[]>>;
  /** What the workspace's agents cost since `since`, broken down. Members only. */
  usage(workspace: string, viewer: Viewer, since: string): Promise<Result<Usage>>;
  /**
   * Starts a card payment for credit and returns the page to send the
   * person to. Owners only. The payment's id comes back to `returnUrl` as
   * `session`.
   */
  checkout(actor: User, workspace: string, amountCents: number, returnUrl: string): Promise<Result<{ url: string }>>;
  /** Credits a payment once the processor says it was made. Safe to repeat. */
  confirm(workspace: string, viewer: Viewer, session: string): Promise<Result<BillingAccount>>;
  /**
   * Whether a workspace may start an agent now, asked before anything is
   * opened for it. A failure, with the reason to show, when it has no credit.
   */
  canStart(workspace: string): Promise<Result<boolean>>;
  /**
   * Asks whether a workspace may start an agent and opens the run it will be
   * charged for. Null when billing is off; a failure when there is no credit.
   */
  startRun(run: {
    workspace: string;
    repo: RepoPath;
    number: number;
    task: string;
    model: string;
    /** `workspace` when the run uses the workspace's own model provider. */
    billedTo?: "g1t" | "workspace";
  }): Promise<Result<RunTicket | null>>;
}


/** One slice of usage: what it was for, what it cost, how many runs. */
export type UsageSlice = { key: string; micros: number; runs: number };

/** What a workspace's agents cost over a period. */
export type Usage = {
  since: string;
  /** Charged, including g1t's margin. */
  spentMicros: number;
  /** What g1t's model provider charged, before the margin. */
  costMicros: number;
  /** What runs on the workspace's own provider cost there, estimated. Not charged by g1t. */
  providerMicros: number;
  runs: number;
  /** Spend per day and task, keyed `YYYY-MM-DD/task`. */
  byDay: UsageSlice[];
  byTask: UsageSlice[];
  byRepo: UsageSlice[];
  /** Keyed `namespace/name#number`. */
  byPull: UsageSlice[];
  byModel: UsageSlice[];
  /** Credit bought in the period. */
  addedMicros: number;
};
