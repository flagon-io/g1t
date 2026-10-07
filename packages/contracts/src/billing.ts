import type { ComputeKind, Reservation } from "./compute";
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
  /** The card charged near the limit and when a month closes, if one is saved. */
  card?: { brand: string; last4: string; expMonth: number; expYear: number } | null;
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
  /** The workspace the line belongs to, which tells an enterprise's lines apart. */
  workspace?: string | null;
  /** For usage: what the plan's included usage paid of it. `amountMicros` is what is left to pay. */
  creditMicros?: number;
  /** For usage: what the workspace's trial credit paid of it. */
  trialMicros?: number;
  /** For usage: what g1t's open-source pool paid of it. */
  ossMicros?: number;
  /** For usage: what g1t covered itself, such as a trial's last run past its credit. */
  givenMicros?: number;
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
  /** Where an enterprise's invoices go. */
  billingEmail?: string | null;
  /** An enterprise's invoices, newest first. */
  invoices?: EnterpriseInvoice[];
  createdAt: string;
  /** What g1t staff set for the account beyond its terms. */
  allowances?: Allowances;
};

/** Set per account by g1t staff in sudo, on top of its terms. */
export type Allowances = {
  /** The g1t plan without its monthly price; usage is charged as usual. Comped accounts have it anyway. */
  plan: boolean;
  /** Each public repository's monthly cap on g1t's open-source pool; null for the default. */
  ossRepoMicros: number | null;
  /** Each workspace's trial credit, outside the monthly pool; null for the default. */
  trialMicros: number | null;
  /** Agents at once, in place of the plan's (2 in the first month or on the trial, then 10); null for the default. */
  maxConcurrentAgents?: number | null;
  /** One run's spend cap, in place of the owners' and the default $2; null for none. */
  runCapMicros?: number | null;
  /** What one issue's agents may spend in all, in place of the owners' and the default $10; null for none. */
  issueCapMicros?: number | null;
  /** Days of audit log its workspaces keep, in place of the plan's (7 free, 90 on the plan), longer or shorter; null for the plan's. */
  auditRetentionDays?: number | null;
  /** A hold on new compute, with why; null for none. */
  hold?: string | null;
};

// --- Entitlements, and compute started under a reservation ------------------
//
// Every service that starts compute asks billing first:
// 1. `entitlements(workspace)`: what it may do at all, its caps, and whether compute is paused.
// 2. `reserve(...)`: holds the estimate against what may pay for it, so starts at the same moment
//    cannot overshoot together. Answers who pays first, or refuses with a stable code
//    (`not_paid`, `trial_used`, `limit`, `paused`, `oss_pool_empty`) and a message for the owner.
// 3. `settle(reservationId, actualMicros)`: releases the hold. The charge goes on the ledger the usual way.
// A reservation never settled lapses after `RESERVATION_HOURS`.

/** A reservation that is never settled stops holding after this long. */
export const RESERVATION_HOURS = 3;
/** What a ceiling reads as when there is none (g1t's own workspaces). */
export const UNLIMITED_MICROS = 1_000_000_000_000_000;

/** What a workspace pays g1t on, as far as compute is concerned. Mirrors `PlanKind`. */
export type PlanKind = "free" | "paid" | "internal" | "enterprise";

// `ComputeKind` (what compute is for), `PaidBy` (who pays first: credit, trial, oss, on_demand) and
// `Reservation` are in `./compute`, with the gate that calls `reserve` and `settle`.

/** One level reached: 50, 75, 90 or 100 percent. */
export type UsageAlert = {
  /** `included` (the plan's included usage), `spend_limit` or `ceiling`. */
  meter: "included" | "spend_limit" | "ceiling" | string;
  level: number;
  usedMicros: number;
  limitMicros: number;
  message: string;
};

/** An hour's spend well above the workspace's usual: new compute waits for an owner. */
export type Spike = {
  id: string;
  /** `open` (waiting), `continued` (keep going) or `stopped`. */
  status: "open" | "continued" | "stopped" | string;
  hourMicros: number;
  averageMicros: number;
  detectedAt: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  /** While continued: until when, unless spend doubles again first. */
  until?: string | null;
};

/** What a workspace may do now. Mirrors `Entitlements` in `crates/contracts/src/billing.rs`. */
export type Entitlements = {
  workspace: string;
  plan: PlanKind;
  /** May start sandboxes, models, deployments and semantic search at all: paid, internal, enterprise, or free with trial credit left. */
  compute: boolean;
  /** The one-time trial credit left; 0 if none or used. */
  trialMicrosLeft: number;
  /** A card check has been done; the trial and the open-source pool need it. */
  trialVerified: boolean;
  /** A paid workspace still in its first billing cycle. */
  firstMonth: boolean;
  /** 2 in the first month or on the trial, 10 after; staff can override it. */
  maxConcurrentAgents: number;
  /** 60 in the first month or on the trial; otherwise the guardrails' own caps. */
  maxRunMinutes: number;
  /** One run's spend cap, $2 by default; staff can override it. */
  runCapMicros: number;
  /** Agent spend on one issue in all, $10 by default. */
  issueCapMicros: number;
  /** g1t's ceiling on usage not yet paid for; `UNLIMITED_MICROS` for g1t's own; 0 for free. */
  ceilingMicros: number;
  /** Usage not yet paid for this month, prepayment taken off. */
  exposureMicros: number;
  /** Why new compute is paused, for the owner; null when it is not. */
  paused: string | null;
  /** What open reservations hold now. */
  heldMicros?: number;
  /** Paid in advance and not used yet. */
  prepaidMicros?: number;
  /** The plan's included usage each month, and what of it is used. */
  includedMicros?: number;
  includedUsedMicros?: number;
  /** How far back the audit log can be read and exported, and what is kept: the plan's days, or what g1t staff set for the account. */
  auditRetentionDays: number;
  /** Whether `auditRetentionDays` is what staff set for the account rather than the plan's. */
  auditRetentionCustom?: boolean;
  /** Private repository storage free for every workspace: past it, the plan pays and a free workspace's pushes stop. */
  freePrivateStorageBytes: number;
  /** The last daily measure of the workspace's private repositories (a lower bound). */
  privateStorageBytes: number;
  /** On a paid plan: package storage past the free amounts is charged, never refused. */
  hasPlan?: boolean;
  /** Package storage free for every workspace (public, and private): past it a free workspace's pushes are refused. */
  packagePublicFreeBytes?: number;
  packagePrivateFreeBytes?: number;
  /** What g1t's open-source pool paid for the workspace this month. */
  ossPaidMicros: number;
  /** Deploy build time this month, every second of it metered. */
  buildSecondsUsed?: number;
  /** Git operations this month, and how many are free for every workspace. */
  gitOperations?: number;
  gitOperationsIncluded?: number;
  /** The smallest amount a card is charged when a month closes. */
  minChargeMicros: number;
  /** A spend spike waiting for an owner, or decided. */
  spike?: Spike | null;
  /** Where usage stands against what is included and the limits, from 50%. */
  alerts?: UsageAlert[];
};

/** A hold on a start's estimated cost, as billing answers it (`Reservation` in `./compute`, and more). */
export type ReservationHeld = Reservation & {
  /** What is held, at cost; may be less than the estimate for a free workspace's last bit of trial. */
  heldMicros?: number;
  /** When the hold lapses if never settled. */
  expiresAt?: string;
};

/** A request to g1t: a higher limit, or help with usage past what was meant. */
export type LimitRequest = {
  id: string;
  workspace: string;
  kind: "limit" | "overage" | string;
  amountMicros: number;
  reason: string;
  expectedMonthlyMicros: number;
  status: "open" | "approved" | "declined" | string;
  decidedMicros?: number | null;
  decidedBy?: string | null;
  /** The answer, as the owner sees it. */
  answer?: string | null;
  createdBy: string;
  createdAt: string;
  decidedAt?: string | null;
};

/** What staff see beside a request. */
export type WorkspaceHistory = {
  plan: PlanKind | null;
  months: MonthFigures[];
  paidClearedMicros: number;
  payments: number;
  disputes: number;
  declines: number;
  firstSeen: string | null;
  ceilingMicros: number | null;
  maxCeilingMicros: number | null;
  spendLimitMicros: number | null;
  lastHourMicros: number;
  averageHourMicros: number;
  lastDayMicros: number;
};

export type LimitRequestReview = { request: LimitRequest; history: WorkspaceHistory };

/** What a one-time goodwill credit comes to: the margin on the overage, always, plus its cost up to the cap. */
export type Goodwill = {
  overageMicros: number;
  marginMicros: number;
  costMicros: number;
  creditMicros: number;
  absorbedMicros: number;
};

/** A workspace whose month went well past its usual, or hit a spike. */
export type Overage = {
  workspace: string;
  plan: PlanKind;
  typicalMonthMicros: number;
  thisMonthMicros: number;
  costMicros: number;
  marginMicros: number;
  spike: Spike | null;
  topEntries: LedgerEntry[];
  goodwill: Goodwill;
  goodwillAvailable: boolean;
  lastGoodwillAt: string | null;
  request: LimitRequest | null;
};

/** One workspace's recent pace. */
export type Velocity = {
  workspace: string;
  plan: PlanKind;
  lastHourMicros: number;
  averageHourMicros: number;
  lastDayMicros: number;
  thisMonthMicros: number;
  ratio: number;
  spike: Spike | null;
  firstSeen: string | null;
};

/** g1t's capped budgets for free usage this month. */
export type Pools = {
  month: string;
  trialGrantedMicros: number;
  trialPoolMicros: number;
  trialGrants: number;
  ossUsedMicros: number;
  ossPoolMicros: number;
  ossRepoMicros: number;
};

export type AccountSummary = {
  account: PayingAccount;
  limit: Limit;
  chargedMicros: number;
  costMicros: number;
  paidMicros: number;
  /** The same figures for each of the account's workspaces that has any. */
  byWorkspace: WorkspaceFigures[];
  /** The last six months, oldest first. */
  months?: MonthFigures[];
};

/** One workspace's share of an `AccountSummary`. */
export type WorkspaceFigures = { workspace: string; chargedMicros: number; costMicros: number; paidMicros: number };

export type StripeStatus = {
  /** `test` or `live`, from the key; `off` without one. */
  mode: "test" | "live" | "off" | string;
  /** Whether `STRIPE_WEBHOOK_SECRET` is set, so events can be checked. */
  secretSet: boolean;
  /** The destination at billing's address in Stripe, as Stripe has it. */
  webhook: { url: string; endpointId: string; status: "enabled" | "disabled" | string; events: string[]; createdAt: string } | null;
  /** Events billing handles that the destination does not send. */
  missingEvents: string[];
  recentEvents: { id: string; kind: string; outcome: string; receivedAt: string }[];
  error: string | null;
};

/** An enterprise's invoice: one line per workspace, paid on Stripe's page. */
export type EnterpriseInvoice = {
  invoiceId: string;
  hostedUrl: string | null;
  amountMicros: number;
  status: "open" | "paid" | "overdue" | "void" | string;
  period: string;
  lines: { workspace: string; amountMicros: number }[];
  createdAt: string;
};

/** A workspace's invoice: monthly, or when charged near its limit. Itemised, in Stripe's billing page. */
export type WorkspaceInvoice = {
  invoiceId: string;
  workspace: string;
  reason: "month" | "threshold" | string;
  period: string;
  amountMicros: number;
  status: "paid" | "open" | "failed" | "void" | string;
  hostedUrl: string | null;
  pdfUrl: string | null;
  lines: { description: string; amountMicros: number }[];
  createdAt: string;
};

/** A month of the ledger, grouped by day or project, a line per kind of charge. */
export type Statement = {
  month: string;
  months: string[];
  groups: {
    key: string;
    label: string;
    /** `coveredMicros`: what the plan's included usage, the trial, the open-source pool or g1t paid, not in `chargedMicros`. */
    lines: { kind: string; count: number; chargedMicros: number; costMicros: number; coveredMicros?: number }[];
    chargedMicros: number;
  }[];
  totals: {
    chargedMicros: number;
    paidMicros: number;
    costMicros: number;
    entries: number;
    /** What paid for usage before it was charged, such as "Paid by g1t's open-source pool". */
    covered?: { source: "included" | "trial" | "oss_pool" | "given" | string; label: string; micros: number }[];
    /** Owed when the month closed but under the minimum charge: on the next invoice. */
    carriedMicros?: number;
  };
};

export type MonthFigures = {
  month: string;
  /** Usage charged, after what paid for it first. */
  chargedMicros: number;
  /** What usage cost g1t: never a workspace's own model provider. */
  costMicros: number;
  paidMicros: number;
  /** The plan's monthly price, paid. */
  plansMicros?: number;
  /** What g1t gave at price (internal use, trials, the open-source pool, goodwill, covered). Not margin. */
  givenMicros?: number;
};

/** What g1t gave this month from one source. */
export type GivenFigures = { source: "internal" | "trial" | "oss_pool" | "goodwill" | "covered" | string; label: string; micros: number; costMicros: number };

/** One internal workspace's use this month, and why it is not charged. */
export type InternalUse = { workspace: string; reason: string; costMicros: number; entries: number };

export type SignalKind = "at_limit" | "near_ceiling" | "declined" | "growing" | "established" | "first_payment" | "high_spend" | "cost_over_revenue";

/** Why a workspace is worth reaching out to. */
export type Signal = {
  workspace: string;
  kind: SignalKind;
  detail: string;
  valueMicros: number;
  stage: string | null;
  owner: string | null;
  nextStep?: string | null;
  /** When the next step is due, YYYY-MM-DD. */
  nextAt?: string | null;
};

/** One invoice g1t has sent, a workspace's or an enterprise's. */
export type InvoiceSummary = {
  invoiceId: string;
  kind: "workspace" | "enterprise";
  account: string;
  name: string;
  reason: string;
  period: string;
  amountMicros: number;
  status: string;
  hostedUrl: string | null;
  createdAt: string;
  paidAt: string | null;
};

export type SalesStage = "none" | "lead" | "contacted" | "negotiating" | "won" | "lost" | "churn_risk";

export type SalesRecord = {
  workspace: string;
  stage: SalesStage | string;
  owner: string | null;
  nextStep: string | null;
  nextAt: string | null;
  notes: { id: string; text: string; by: string; createdAt: string }[];
  updatedAt: string | null;
};

export type Overview = {
  month: string;
  months: MonthFigures[];
  byKind: { kind: string; chargedMicros: number; costMicros: number }[];
  payingWorkspaces: number;
  stopped: number;
  nearCeiling: number;
  declined: number;
  openInvoicesMicros: number;
  followUpsDue: number;
  /** g1t's capped budgets for free usage, this month. */
  pools?: Pools | null;
  /** Usage charged plus the plan's price paid, this month. */
  revenueMicros?: number;
  activePlans?: number;
  planMrrMicros?: number;
  /** What g1t gave this month, by source, apart from its margin. */
  given?: GivenFigures[];
  /** g1t's own and Flagon's workspaces: what their use cost, and why they are not charged. */
  internal?: InternalUse[];
  openRequests?: number;
  overages?: number;
  openSpikes?: number;
};

/** A customer's Stripe billing page, for staff to send them. */
export type BillingLink = {
  /** One-time and short-lived, signed in already. */
  portalUrl: string;
  /** The page's sign-in, which does not expire: the customer signs in by email. */
  loginUrl: string | null;
  customerEmail: string | null;
  expiresNote: string;
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
  /** Team on or off without charge, and the account's share of the pools. Needs a note. */
  setAllowances(id: string, allowances: Allowances, note: string, by: string): Promise<Result<PayingAccount>>;
  createEnterprise(name: string, workspaces: string[], by: string): Promise<Result<PayingAccount>>;
  attach(workspace: string, account: string | null, by: string): Promise<Result<PayingAccount>>;
  credit(workspace: string, amountMicros: number, note: string, by: string): Promise<Result<LedgerEntry>>;
  /** The workspace's Stripe billing page, to send to the customer. Logged. */
  billingLink(workspace: string, by: string): Promise<Result<BillingLink>>;
  /** Where billing stands with Stripe; with `setup`, registers the webhook first. */
  /** Stripe's state for billing; `fix` enables the destination and adds missing events first. */
  stripe(fix?: boolean, by?: string): Promise<StripeStatus>;
  /** Where an enterprise's invoices go; makes its Stripe customer. */
  enterpriseBilling(id: string, email: string, by: string): Promise<Result<PayingAccount>>;
  /** Sends an enterprise its invoice now, for what its workspaces owe. */
  invoiceEnterprise(id: string, by: string): Promise<Result<EnterpriseInvoice>>;
  /** Exactly these workspaces' accounts, such as one page of the list. */
  accountsFor(workspaces: string[]): Promise<AccountSummary[]>;
  /** Every workspace worth reaching out to, most urgent first. */
  signals(): Promise<Signal[]>;
  /** The business at a glance. */
  overview(): Promise<Overview>;
  /** A workspace's sales record. */
  sales(workspace: string): Promise<SalesRecord>;
  setSales(workspace: string, record: { stage: string; owner?: string | null; nextStep?: string | null; nextAt?: string | null }, by: string): Promise<Result<SalesRecord>>;
  addNote(workspace: string, text: string, by: string): Promise<Result<SalesRecord>>;
  /** A workspace's invoices from g1t, for staff. */
  workspaceInvoices(workspace: string): Promise<WorkspaceInvoice[]>;
  /** Every invoice g1t has sent, newest first. */
  allInvoices(filter?: { status?: string; month?: string }): Promise<InvoiceSummary[]>;
  /** Every change made in sudo and by Stripe, newest first, 100 at a time. */
  audit(filter?: { by?: string; action?: string; before?: string }): Promise<AdminAction[]>;
  /** Limit and overage requests, with each workspace's history; `open` by default. */
  limitRequests(status?: "open" | "approved" | "declined" | "all"): Promise<LimitRequestReview[]>;
  /** Approve (at the amount asked, or another) or decline; the owner is told in the app and by email. */
  decideLimitRequest(id: string, decision: "approve" | "decline", amountMicros: number | null, note: string, by: string): Promise<Result<LimitRequest>>;
  /** The Overages queue. */
  overages(): Promise<Overage[]>;
  /** A goodwill credit; no amount is the one-click credit. Larger, or a second in 12 months, needs a reason. */
  goodwill(workspace: string, amountMicros: number | null, reason: string, by: string, day?: string | null): Promise<Result<LedgerEntry>>;
  /** Workspaces spending in the last day, fastest first. */
  velocity(): Promise<Velocity[]>;
  /** Money that reached g1t outside the card pages, such as a bank transfer: entered as a payment. */
  recordPayment(workspace: string, amountMicros: number, reference: string, note: string, by: string): Promise<Result<LedgerEntry>>;
  /** Costs & margin: Cloudflare's bill against what g1t charged, over the last `days` (7 to 90, 30 by default). */
  costs(days?: number): Promise<CostsReport>;
  /** The open margin alerts, for the banner on every page. */
  costAlerts(): Promise<MarginAlert[]>;
  /** g1t's own spend against its caps: the daily breaker and comped budgets. */
  spendCaps(): Promise<SpendCaps>;
  /** Lets hosted-model runs start again for the rest of today (UTC); needs a note. */
  liftBreaker(note: string, by: string): Promise<Result<SpendCaps>>;
  /** Approve or reject a price proposal; a rejection needs a note. An approved rise waits out the notice period. */
  decideProposal(id: string, decision: "approve" | "reject", note: string, by: string): Promise<Result<PriceProposal>>;
  setCostSettings(settings: CostSettings, by: string): Promise<Result<CostSettings>>;
  setCostMapping(mapping: CostMappingInput, by: string): Promise<Result<CostMapping>>;
  /** Reads Cloudflare's bill and reconciles now, as the daily run does. */
  runCosts(by: string): Promise<Result<CostsRun>>;
}

/** How much a workspace has earned g1t's trust with money. */
export type Trust = "new" | "paid" | "established" | "reviewed" | "internal";

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
  /** Charged this month: what the spend limit is measured against. */
  spentMicros?: number;
  /** True while the owners have not chosen a limit, so the automatic one applies: $200, or twice last month's spend. */
  defaultSpendLimit?: boolean;
  /** The most owners may set their own limit to without asking: the highest ceiling ever, plus what is prepaid. */
  availableMicros?: number | null;
  /** How the ceiling grows from here, in a sentence. */
  growth?: string | null;
  /** Paid in advance and not used yet; raises what can be used before work stops by as much. */
  prepaidMicros?: number;
  /** The highest ceiling the workspace has had. */
  maxCeilingMicros?: number | null;
  /** The most owners may raise the limit to themselves, once: twice the highest ceiling. Null once used. */
  raiseOnceMicros?: number | null;
  /** When the one-time raise was used. */
  raisedAt?: string | null;
  /** A paid workspace's first billing cycle, on the starting ceiling. */
  firstMonth?: boolean;
};

/** One metered unit: what it costs g1t and what it is sold at; the price follows the cost. */
export type Price = {
  meter:
    | "sandbox_second"
    | "build_second"
    | "app_requests"
    | "app_cpu"
    | "app_month"
    | "custom_domain_month"
    | "private_storage"
    | "embedding_tokens"
    | "scan_cpu"
    | "scan_rows"
    | string;
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
  /** The markup before, when the change was to the markup rather than the cost. */
  oldMarkupPercent?: number;
  reason: string;
  createdAt: string;
  /** When a change still to come takes effect: a rise is announced before it is charged. */
  effectiveAt?: string;
};

export type PriceBook = {
  prices: Price[];
  changes: PriceChange[];
  modelMarginPercent: number;
  /** Every plan, as sold now. */
  plans?: FeaturePlan[];
  /** What is free, and the capped budgets that pay for it. */
  free?: FreeTier | null;
};

/** One kind of meter's usage this month, from `usage_meters`. */
export type MeterUsage = {
  /** `agents`, `builds`, `requests`, `domains`, `git_storage` or `search_scans`. */
  key: string;
  label: string;
  /** At price (cost plus 20%, on the account's terms), before what paid for it. */
  micros: number;
  /** How much, when it is known: `12 runs`, `41 build minutes`. */
  quantity?: string | null;
};

/** What g1t gives without a plan; each is paid for by a capped budget. */
export type FreeTier = {
  /** Each new workspace's trial credit, once. */
  trialWorkspaceMicros: number;
  /** Trial grants each month, in all; new trials wait when it is spent. */
  trialMonthlyPoolMicros: number;
  /** g1t's open-source pool each month, and any one repository's share. */
  ossPoolMicros: number;
  ossRepoMicros: number;
  /** Private repository storage free for every workspace. Past it, the plan pays; a free workspace's pushes stop. */
  freePrivateStorageBytes: number;
  /** Days of audit log a free workspace keeps. */
  auditRetentionDays: number;
  /** Days of audit log the g1t plan keeps, and g1t's own and enterprise workspaces; longer by arrangement. */
  planAuditRetentionDays?: number;
  /** The smallest amount a card is charged when a month closes; less carries over. */
  minChargeMicros: number;
  /** Git operations free for every workspace each month. Past it, the plan pays; a free workspace is slowed down. */
  gitOperationsIncluded?: number;
  /** A new paid workspace's ceiling in its first month. */
  paidStartCeilingMicros?: number;
  /** The most a one-click goodwill credit can cost g1t. */
  overageForgiveCostMicros?: number;
};

/**
 * A workspace's trial credit: one grant per workspace, made the first time
 * it uses something, out of a pool that resets each calendar month. Mirrors
 * `Trial` in `crates/contracts/src/billing.rs`.
 */
export type Trial = {
  open: boolean;
  usedMicros: number;
  limitMicros: number;
  /** No longer used: trials do not end on a date. */
  endsAt: string | null;
  /** Why it is closed: `off`, `used` (this workspace's grant is spent) or `pool` (this month's are given out). */
  reason: "off" | "ended" | "used" | "pool" | null;
  /** Whether the workspace has its grant already. */
  granted?: boolean;
  /** With `pool`: when new trials start again, the first of next month. */
  waitsUntil?: string | null;
};

/**
 * What a workspace pays a monthly price for: the g1t plan (`plan`). Deployments
 * are part of it; `has_feature` for `deployments` answers whether the workspace
 * has the plan. Mirrors `Feature` in `crates/contracts/src/billing.rs`.
 */
export type Feature = "plan" | "deployments";

/**
 * What deployments cost g1t, in millionths of a dollar: fallbacks for when
 * billing's price book cannot be read. Not an allowance: on the plan every
 * unit is metered from the first, at cost plus 20%, and drawn from the
 * plan's included usage first. Projects, previews and the apps behind them
 * are not metered at all. Mirrors `deployment_costs`.
 */
export const DEPLOYMENT_COSTS = {
  microsPerMillionRequests: 300_000,
  microsPerMillionCpuMs: 20_000,
  /** One second of a build's sandbox: a fallback; billing charges the price book's `build_second`. */
  microsPerBuildSecond: 15,
  /** One custom domain for a month. */
  microsPerDomainMonth: 100_000,
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
  /** On without a plan: comped terms, or given by g1t. Nothing to pay or turn off. */
  included?: boolean;
};

export interface BillingApi {
  status(): Promise<BillingStatus>;
  /** Members of the workspace only. */
  account(workspace: string, viewer: Viewer): Promise<Result<BillingAccount>>;
  /** Newest first. Members of the workspace only. */
  ledger(workspace: string, viewer: Viewer): Promise<Result<LedgerEntry[]>>;
  /** A month of the ledger, grouped by `day` (default) or `project`. Members only. */
  statement(workspace: string, viewer: Viewer, month?: string | null, group?: "day" | "project"): Promise<Result<Statement>>;
  /** One statement line's entries, 50 at a time; `before` is the last id seen. */
  statementEntries(
    workspace: string,
    viewer: Viewer,
    filter: { month: string; kind: string; day?: string | null; project?: string | null; before?: string | null },
  ): Promise<Result<LedgerEntry[]>>;
  /** What the workspace's agents cost since `since`, broken down. Members only. */
  usage(workspace: string, viewer: Viewer, since: string): Promise<Result<Usage>>;
  /**
   * The model tokens the workspace's runs used, day by day over the last
   * `days` (42, at most 366), for everyone or for one `person`. Members
   * only; a member may ask only for themselves, an owner for anyone.
   */
  tokenUsage(workspace: string, viewer: User, options?: { person?: string; days?: number }): Promise<Result<TokenUsage>>;
  /**
   * What one model answer used, added to its run's count for the day. The
   * model proxy sends it; for usage views only, as runs are priced from AI
   * Gateway. False when there was nothing to count.
   */
  recordTokens(usage: {
    workspace: string;
    /** The model session's id, one per run. */
    session: string;
    /** The person the run is for, by username. */
    person?: string | null;
    model: string;
    tier?: "small" | "large" | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }): Promise<Result<boolean>>;
  /**
   * Prepays usage ($25 at least) and returns the page to send the person to:
   * by card with 3-D Secure, or by bank transfer from $1,000. Owners only.
   * The payment's id comes back to `returnUrl` as `session`.
   */
  checkout(
    actor: User,
    workspace: string,
    amountCents: number,
    returnUrl: string,
    method?: "card" | "bank_transfer",
  ): Promise<Result<{ url: string }>>;
  /**
   * Stripe's hosted billing page for the workspace: card, invoices, billing
   * email and address. g1t never handles card numbers. Owners only.
   */
  billingPortal(actor: User, workspace: string, returnUrl: string): Promise<Result<{ url: string }>>;
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
    /** For a build: how long it ran, so the plan's included build time pays for what it can. */
    buildSeconds?: number | null;
  }): Promise<Result<boolean>>;
  /**
   * What a source cost g1t so far this month, so the workspace's limit
   * counts it now. Replaces the last report. Billing charges `context`
   * and `security` itself once the month is over; `deployments` charges
   * its own.
   */
  notePending(
    workspace: string,
    source: "deployments" | "domains" | "context" | "security",
    costMicros: number,
    /** How much of it, for the Billing page: `1.2 million requests and 3.4 million CPU ms`. */
    detail?: string | null,
  ): Promise<boolean>;
  /**
   * This month's usage, one line per kind of meter, at what it is charged
   * before the plan's included usage or a pool paid for it. Members only.
   */
  usageMeters(workspace: string, viewer: Viewer): Promise<Result<MeterUsage[]>>;
  /** What the workspace may do now: its plan, caps, pause, trial, and what the plan gives it. */
  entitlements(workspace: string): Promise<Entitlements>;
  /**
   * Holds a start's estimated cost before the work starts. A failure's code says why not:
   * `paused`, `limit`, `not_paid`, `trial_used` or `oss_pool_empty`, with a message for the owner.
   */
  reserve(reservation: {
    workspace: string;
    repo: RepoPath;
    public: boolean;
    kind: ComputeKind;
    /** The most the work is expected to cost g1t, before the margin. */
    estimateMicros: number;
  }): Promise<Result<ReservationHeld>>;
  /** Releases a reservation's hold with what the work cost g1t, before the margin. Safe to repeat. */
  settle(reservationId: string, actualMicros: number): Promise<Result<boolean>>;
  /** Stripe's page to save and verify a card (3-D Secure, never charged). Owners only. */
  cardCheck(actor: User, workspace: string, returnUrl: string): Promise<Result<{ url: string }>>;
  /** Records the card check once Stripe says it passed, and grants the trial if it can. Safe to repeat. */
  confirmCardCheck(workspace: string, viewer: Viewer, session: string): Promise<Result<Entitlements>>;
  /** An owner asks for a higher limit, or for help with usage past what was meant. */
  requestLimit(
    actor: User,
    workspace: string,
    request: { kind: "limit" | "overage"; amountMicros: number; reason: string; expectedMonthlyMicros: number },
  ): Promise<Result<LimitRequest>>;
  /** The workspace's requests and their answers, newest first. Members only. */
  limitRequests(workspace: string, viewer: Viewer): Promise<Result<LimitRequest[]>>;
  /**
   * The owners' own caps on agents: one run's spend ($0.10 to $100) and one issue's ($1 to $1,000).
   * Null goes back to the default ($2 and $10). A cap staff set wins. Owners only.
   */
  setCaps(actor: User, workspace: string, caps: { runCapMicros: number | null; issueCapMicros: number | null }): Promise<Result<Entitlements>>;
  /** An owner's answer to a spend spike: keep going for 24 hours, or stop. */
  confirmSpike(actor: User, workspace: string, keepGoing: boolean): Promise<Result<Entitlements>>;
  /** Every metered price and the recent changes. Public. */
  prices(): Promise<PriceBook>;
  /** A workspace's limit, for its members. */
  limit(workspace: string, viewer: Viewer): Promise<Result<Limit>>;
  /** The same, for the services that enforce it. */
  checkLimit(workspace: string): Promise<Result<Limit>>;
  /**
   * The owners' own monthly limit, up to what is available; null goes back
   * to the default, and `useFullLimit` uses everything available. Owners only.
   */
  setSpendLimit(
    actor: User,
    workspace: string,
    spendLimitMicros: number | null,
    useFullLimit?: boolean,
    /** Use the one-time raise: up to twice the highest ceiling, once per workspace. */
    raiseOnce?: boolean,
  ): Promise<Result<Limit>>;
  /** The workspace's invoices from g1t, newest first. Members only. */
  invoices(workspace: string, viewer: Viewer): Promise<Result<WorkspaceInvoice[]>>;
  /**
   * How long a sandbox ran for a workspace, reported when it stops. Its
   * cost is recorded and every second is charged, from the first. False if
   * `reference` was recorded before.
   */
  recordSandbox(usage: {
    workspace: string;
    seconds: number;
    description: string;
    repo?: string | null;
    reference: string;
    /** What ran; checks, workflows and the merge queue on public repositories may use the open-source pool. */
    kind?: ComputeKind | null;
    /** vCPU-seconds used, when the sandbox can tell: the run is priced on its own CPU. */
    cpuSeconds?: number | null;
    /** The reservation it started under, settled with this cost. */
    reservationId?: string | null;
    /** It ran on one of the workspace's self-hosted runners: its minutes go on usage at $0. */
    selfHosted?: boolean;
    /** The machine it ran on, by label (`g1t-4core`); absent, the standard one. */
    instance?: string | null;
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
    /** `small` or `large`: the tier g1t routed the run to, on its hosted models. */
    tier?: "small" | "large" | null;
  }): Promise<Result<RunTicket | null>>;
}


/** One slice of usage: what it was for, what it cost, how many runs. */
export type UsageSlice = { key: string; micros: number; runs: number };

/** The model tokens runs used over a window of days. */
export type TokenUsage = {
  /** `YYYY-MM-DD`, the first day counted. */
  since: string;
  /** The window's length: 42 unless asked, 366 at most. */
  days: number;
  /** Null for the whole workspace. */
  person: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What those runs were charged, as `usage` measures it. */
  costMicros: number;
  /** Days in the window with any tokens. */
  activeDays: number;
  /** Every day in the window, oldest first, zeros included. */
  byDay: { day: string; tokens: number }[];
};

/** What a workspace's agents cost over a period. */
export type Usage = {
  since: string;
  /** Charged, including g1t's margin. */
  spentMicros: number;
  /** What g1t's usage came to at price, less what was charged: the plan's included usage, the trial, a pool or a free period paid it. Usage at price is `spentMicros` plus this. */
  coveredMicros?: number;
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

/** One of g1t's products (a "bucket") on one day. Money in micros. */
export type CostDay = { day: string; bucket: string; cfCostMicros: number; ownCostMicros: number; valueMicros: number; cashMicros: number };

/** One product over the range: what customers were charged at price against what it cost. */
export type ProductMargin = {
  bucket: string;
  title: string;
  /** Cloudflare's bill, or g1t's own figure where Cloudflare does not bill it (`costSource`). */
  costMicros: number;
  cfCostMicros: number;
  ownCostMicros: number;
  valueMicros: number;
  marginMicros: number;
  marginPercent: number | null;
  costSource: "cloudflare" | "ledger" | string;
  /** Running g1t, paid for by the plan. */
  overhead: boolean;
};

/** All of g1t: money in (usage and the plan) against every cost. */
export type OverallMargin = { usageMicros: number; plansMicros: number; costMicros: number; marginMicros: number; marginPercent: number | null };

/** A count, cost or leak that does not add up. */
export type CostDrift = {
  bucket: string;
  title: string;
  kind: "count" | "cost" | "leak" | string;
  ours: number;
  cloudflare: number;
  deltaPercent: number | null;
  detail: string;
  foundAt: string;
};

export type MarginAlert = {
  id: string;
  kind: "margin" | "overall" | "leak" | "drift" | "workspace" | string;
  /** The product, or the workspace. */
  subject: string;
  detail: string;
  since: string;
  openedAt: string;
  emailedAt: string | null;
};

/** A change to a price, measured from what Cloudflare charged. */
export type PriceProposal = {
  id: string;
  meter: string;
  title: string;
  unit: string;
  currentCostMicros: number;
  proposedCostMicros: number;
  changePercent: number;
  markupPercent: number;
  reason: string;
  source: "keeper" | "reconciler" | string;
  /** Far off the current cost: look before approving. */
  suspect: boolean;
  status: "open" | "applied" | "approved" | "rejected" | "superseded" | string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  effectiveAt: string | null;
};

/** One version of one meter's price; never changed once written. */
export type PriceVersion = {
  id: string;
  meter: string;
  version: number;
  costMicros: number;
  markupPercent: number;
  priceMicros: number;
  effectiveAt: string;
  reason: string;
  createdBy: string;
  appliedAt: string | null;
};

export type WorkspaceCost = { workspace: string; costMicros: number; revenueMicros: number; internal: boolean };

export type CostLineSummary = {
  product: string;
  meter: string;
  rawName: string;
  unit: string;
  source: string;
  quantity: number;
  costMicros: number;
  /** Absent when no mapping claims it. */
  bucket: string | null;
};

export type CostMapping = {
  product: string;
  meter: string;
  bucket: string;
  priceMeter: string | null;
  ownMeter: string | null;
  scaleToOwn: boolean;
  driftPercent: number;
  note: string;
  updatedAt: string;
  updatedBy: string;
};

export type CostMappingInput = {
  product: string;
  meter: string;
  bucket?: string;
  priceMeter?: string | null;
  ownMeter?: string | null;
  scaleToOwn?: boolean;
  driftPercent?: number | null;
  note?: string;
  remove?: boolean;
};

export type CostSettings = {
  autoApply: boolean;
  autoApplyPercent: number;
  noticeDays: number;
  marginFloorPercent: number;
  alertDays: number;
  minDailyCostMicros: number;
  anomalyFactor: number;
  anomalyFloorMicros: number;
};

export type CostsReport = {
  configured: boolean;
  fetchedAt: string | null;
  since: string;
  until: string;
  days: CostDay[];
  products: ProductMargin[];
  overall: OverallMargin;
  drift: CostDrift[];
  alerts: MarginAlert[];
  proposals: PriceProposal[];
  versions: PriceVersion[];
  topWorkspaces: WorkspaceCost[];
  lines: CostLineSummary[];
  mappings: CostMapping[];
  settings: CostSettings;
  /** g1t's own spend against its two caps. */
  caps: SpendCaps;
};

/** What g1t pays for itself, at cost, against its caps (billing's `budget`). */
export type SpendCaps = {
  /** Today (UTC), YYYY-MM-DD, and this month, YYYY-MM. */
  day: string;
  month: string;
  /** What g1t paid for itself today across every workspace. */
  todayMicros: number;
  /** `PLATFORM_DAILY_SPEND_CAP_MICROS`; 0: no breaker. */
  dailyCapMicros: number;
  /** New hosted-model agent runs g1t would pay for are paused. */
  tripped: boolean;
  trippedAt: string | null;
  liftedBy: string | null;
  liftedAt: string | null;
  liftNote: string | null;
  /** This month so far, by what paid: comped, trial, oss, given, unpaid. */
  monthBuckets: { bucket: string; title: string; micros: number }[];
  comped: CompedBudget[];
  /** Free workspaces' share of reconciled costs this month (git, storage, platform). */
  freeTierMicros: number;
  /** `CLOUDFLARE_FIXED_MONTHLY_MICROS`: Cloudflare subscriptions, an estimate. */
  fixedMonthlyMicros: number;
  /** Money in this month, through the last reconciled day. */
  revenueMicros: number;
};

/** A comped account's monthly budget, at cost. */
export type CompedBudget = {
  account: string;
  name: string;
  usedMicros: number;
  /** 0: no budget. */
  ceilingMicros: number;
  /** `COMPED_MONTHLY_CEILING_MICROS`, not the account's own limit. */
  defaultCeiling: boolean;
  /** 50, 75, 90, 100, or 0. */
  level: number;
};

export type CostsRun = { lines: number; days: number; proposals: number; alerts: number; problems: string[] };
