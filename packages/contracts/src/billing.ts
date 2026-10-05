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
  /**
   * True while g1t is being built out: runs are recorded with what they
   * cost, but nothing is charged and no credit is needed. Not forever.
   */
  free?: boolean;
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
/**
 * The free allowance on g1t's hosted models for a workspace not otherwise
 * open to them: a few dollars of model cost each, out of one pool, until a
 * date. Mirrors `Trial` in `crates/contracts/src/billing.rs`.
 */
/** How an account is charged. Standard unless g1t set otherwise in sudo. */
export type Terms = {
  kind: "standard" | "comped" | "custom";
  discountPercent: number;
  ceilingMicros: number | null;
  note: string;
  until: string | null;
  setBy: string | null;
  setAt: string | null;
};

/**
 * Who pays: a workspace's own account, or an enterprise's, which pays for
 * several workspaces with one bill and one limit.
 */
export type PayingAccount = {
  id: string;
  kind: "workspace" | "enterprise";
  name: string;
  terms: Terms;
  workspaces: string[];
  createdAt: string;
};

export type AccountSummary = {
  account: PayingAccount;
  limit: Limit;
  chargedMicros: number;
  costMicros: number;
  paidMicros: number;
};

export type AdminAction = { id: string; account: string; action: string; detail: string; by: string; createdAt: string };

export type AccountDetail = {
  summary: AccountSummary;
  workspaces: Limit[];
  ledger: LedgerEntry[];
  audit: AdminAction[];
};

/** Staff-only billing, for sudo.g1t.sh. Every change names who made it. */
export interface BillingAdminApi {
  accounts(query?: string): Promise<AccountSummary[]>;
  account(id: string): Promise<Result<AccountDetail>>;
  setTerms(id: string, terms: Terms, by: string): Promise<Result<PayingAccount>>;
  createEnterprise(name: string, workspaces: string[], by: string): Promise<Result<PayingAccount>>;
  attach(workspace: string, account: string | null, by: string): Promise<Result<PayingAccount>>;
  credit(workspace: string, amountMicros: number, note: string, by: string): Promise<Result<LedgerEntry>>;
}

/** How much a workspace has earned g1t's trust with money. */
export type Trust = "new" | "paid" | "reviewed" | "internal";

/**
 * How far a workspace's unpaid usage has gone this month, and where its
 * work stops: past `ceilingMicros`, no new sandboxes, builds or app
 * requests. Usage counts at its cost to g1t or its charge, whichever is
 * more, so it counts while g1t is free too.
 */
export type Limit = {
  workspace: string;
  /** The account that pays: the workspace's own (`ws_<slug>`), or its enterprise's. */
  account: string;
  accountName: string;
  trust: Trust;
  exposureMicros: number;
  /** The lower of g1t's ceiling and the owner's spend limit; null for g1t's own. */
  ceilingMicros: number | null;
  trustCeilingMicros: number | null;
  spendLimitMicros: number | null;
  state: "ok" | "warning" | "stopped";
  message: string | null;
};

/** One metered unit: what it costs g1t and what it is sold at; the price follows the cost. */
export type Price = {
  meter: "sandbox_second" | "build_second" | "app_requests" | "app_cpu" | "app_month" | string;
  title: string;
  unit: string;
  costMicros: number;
  markupPercent: number;
  priceMicros: number;
  /** `list`: Cloudflare's published price. `cloudflare`: measured from Cloudflare's bill. */
  source: "list" | "cloudflare" | string;
  checkedAt: string | null;
  updatedAt: string;
};

export type PriceChange = {
  meter: string;
  oldCostMicros: number;
  newCostMicros: number;
  markupPercent: number;
  reason: string;
  createdAt: string;
};

export type PriceBook = { prices: Price[]; changes: PriceChange[]; modelMarginPercent: number };

export type Trial = {
  open: boolean;
  usedMicros: number;
  limitMicros: number;
  endsAt: string | null;
  /** Why it is closed: `off`, `ended`, `used` (this workspace's) or `pool` (everyone's). */
  reason: "off" | "ended" | "used" | "pool" | null;
};

/**
 * A paid feature a workspace turns on with a monthly plan, as Cloudflare's
 * Workers for Platforms or Vercel's Pro are bought. Never free: neither
 * `free` nor the model allowance covers it. Mirrors `Feature` in
 * `crates/contracts/src/billing.rs`.
 */
export type Feature = "deployments";

/** What the Deployments plan includes each month. Mirrors `deployments_allowance`. */
export const DEPLOYMENTS_ALLOWANCE = {
  apps: 10,
  requests: 1_000_000,
  cpuMs: 3_000_000,
  /** What Cloudflare charges g1t past that, in millionths of a dollar. */
  microsPerAppMonth: 20_000,
  microsPerMillionRequests: 300_000,
  microsPerMillionCpuMs: 20_000,
  /** One second of a build's sandbox; builds are charged, not included. */
  microsPerBuildSecond: 21,
} as const;

export type FeaturePlan = {
  feature: Feature;
  title: string;
  /** Charged every month while the plan is on, in cents. */
  monthlyCents: number;
  /** What the price includes, one line each. */
  includes: string[];
  /** How usage past the allowance is charged. */
  overage: string;
};

export type SubscriptionStatus = "active" | "canceling" | "past_due" | "canceled";

export type Subscription = {
  feature: Feature;
  status: SubscriptionStatus;
  /** RFC 3339: when the period paid for ends. */
  periodEnd: string | null;
  startedBy: string;
  startedAt: string;
};

/** A feature as a workspace sees it. */
export type FeatureState = {
  plan: FeaturePlan;
  subscription: Subscription | null;
  /** Whether the feature works for the workspace now. */
  on: boolean;
};

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
  /** A workspace's free allowance on g1t's hosted models; `exempt` are open to them anyway. */
  trial(workspace: string, exempt: string[]): Promise<Trial>;
  /**
   * Asks whether a workspace may start an agent and opens the run it will be
   * charged for. Null when billing is off; a failure when there is no credit.
   */
  /** Every paid feature and the workspace's plan for each. Members only. */
  features(workspace: string, viewer: Viewer): Promise<Result<FeatureState[]>>;
  /**
   * Starts the card page for a feature's monthly plan. Owners only. The
   * page's id comes back to `returnUrl` as `session`.
   */
  subscribe(actor: User, workspace: string, feature: Feature, returnUrl: string): Promise<Result<{ url: string }>>;
  /** Turns the feature on once the plan is paid for. Safe to repeat. */
  confirmSubscription(workspace: string, viewer: Viewer, session: string): Promise<Result<FeatureState>>;
  /** Ends a plan at the end of its period, or (`resume`) takes that back. Owners only. */
  cancelSubscription(actor: User, workspace: string, feature: Feature, resume?: boolean): Promise<Result<FeatureState>>;
  /** Whether a feature works for a workspace now; a failure with the reason when not. */
  hasFeature(workspace: string, feature: Feature): Promise<Result<boolean>>;
  /**
   * Usage past a plan's allowance, charged from credit at cost plus the
   * margin, once per `reference`. False if it was charged before.
   */
  chargeFeature(charge: {
    workspace: string;
    feature: Feature;
    costMicros: number;
    description: string;
    repo?: string | null;
    reference: string;
  }): Promise<Result<boolean>>;
  /**
   * Usage this month to be charged later (app traffic past a plan), so the
   * workspace's limit counts it now. Replaces the last report.
   */
  notePending(workspace: string, source: "deployments", costMicros: number): Promise<boolean>;
  /** Every metered price and the recent changes. Public. */
  prices(): Promise<PriceBook>;
  /** A workspace's limit, for its members. */
  limit(workspace: string, viewer: Viewer): Promise<Result<Limit>>;
  /** The same, for the services that enforce it. */
  checkLimit(workspace: string): Promise<Result<Limit>>;
  /** The owner's own monthly ceiling, under g1t's; null removes it. Owners only. */
  setSpendLimit(actor: User, workspace: string, spendLimitMicros: number | null): Promise<Result<Limit>>;
  /**
   * How long a sandbox ran for a workspace, reported when it stops. Its
   * cost is always recorded; seconds past the month's free minutes are
   * charged. False if `reference` was recorded before.
   */
  recordSandbox(usage: {
    workspace: string;
    seconds: number;
    description: string;
    repo?: string | null;
    reference: string;
  }): Promise<Result<boolean>>;
  startRun(run: {
    workspace: string;
    repo: RepoPath;
    number: number;
    task: string;
    model: string;
    /** `workspace` when the run uses the workspace's own model provider. */
    billedTo?: "g1t" | "workspace";
    /** The model session's id, so the run can be settled at AI Gateway's price. */
    session?: string | null;
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
  /** What the runs used, at cost: g1t's models and the workspace's own provider together. */
  usedMicros: number;
  /** g1t charges nothing for now; the slices then measure usage at cost. */
  free: boolean;
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
