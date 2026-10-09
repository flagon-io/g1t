import type { ComputeKind, Reservation } from "./compute";
import type { PauseLevel } from "./platform";
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
  /** For usage: what the account's discount took off its price. */
  discountMicros?: number;
  /** For a credit from g1t, and for what of one expired or was revoked: its kind. */
  creditKind?: CreditKind;
};

/**
 * Why g1t gave a workspace credit. Promotional (a welcome, a referral) and
 * goodwill (an apology) are given away when spent; a refund gives back
 * money already paid, and never expires.
 */
export type CreditKind = "promotional" | "goodwill" | "refund" | "purchased";

/** One credit g1t gave, with what of it was used: spent before anything paid in advance, the soonest-expiring first. */
export type CreditGrant = {
  /** `crd_…`, the grant's ledger reference. */
  id: string;
  workspace: string;
  kind: CreditKind;
  amountMicros: number;
  usedMicros: number;
  /** What can still be spent: nothing once it expired or was revoked. */
  leftMicros: number;
  note: string;
  /** A refund: what it refunds, and the day of it. */
  refundFor?: string | null;
  refundDay?: string | null;
  /** RFC 3339; null never expires. */
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  state: "open" | "used" | "expired" | "revoked";
  closedAt?: string | null;
  closedNote?: string | null;
  closedBy?: string | null;
  /** What expiring or revoking took off the balance. */
  closedMicros?: number;
  /** What it pays for: all usage, or models only (spent first). */
  scope?: "all" | "models";
  /** Where it came from. */
  source?: "staff" | "purchase" | "promo_code" | "upgrade";
};

/** A workspace's credits from g1t, newest first. */
export type Credits = { grants: CreditGrant[]; leftMicros: number };

/** One month's credits of one kind: given, spent that month, and taken back unused. */
export type CreditMonth = {
  month: string;
  kind: CreditKind;
  givenMicros: number;
  grants: number;
  usedMicros: number;
  expiredMicros: number;
  revokedMicros: number;
};

/** Every credit g1t gave (at most 200, filtered), the last 12 months by kind, and who gave them. */
export type AdminCredits = { grants: CreditGrant[]; months: CreditMonth[]; staff: string[] };

/** What a credit from sudo is, past its amount and note. */
export type CreditOptions = {
  kind: CreditKind;
  /** RFC 3339; never for a refund. */
  expiresAt?: string | null;
  /** A refund: what it is for, and the day refunded (`YYYY-MM-DD`). */
  refundFor?: string | null;
  refundDay?: string | null;
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
/**
 * How an account is charged. Standard unless g1t set otherwise in sudo:
 * custom terms are a discount (0 to 100%), a ceiling, or both. A 100%
 * discount charges nothing and shows the usage at its price. `comped` is
 * from before discounts and reads as 100%; billing no longer writes it.
 */
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
  /** The card processing fee on top of `amountMicros` when charged to a card, and the tax Stripe added once known. */
  feeMicros?: number;
  taxMicros?: number;
};

/** A month of the ledger, grouped by day or project, a line per kind of charge. */
export type Statement = {
  month: string;
  months: string[];
  groups: {
    key: string;
    label: string;
    /** `coveredMicros`: what the plan's included usage, the trial, the open-source pool or g1t paid, not in `chargedMicros`. */
    /** `priceMicros`: usage at its price; `discountMicros`: what the account's discount took off it. */
    lines: {
      kind: string;
      count: number;
      chargedMicros: number;
      costMicros: number;
      coveredMicros?: number;
      priceMicros?: number;
      discountMicros?: number;
      /** On `Tax` and `Card processing fees` lines: what was paid with payments on top of what reached the balance. Never charged. */
      passedMicros?: number;
    }[];
    chargedMicros: number;
    priceMicros?: number;
    discountMicros?: number;
  }[];
  totals: {
    chargedMicros: number;
    paidMicros: number;
    costMicros: number;
    entries: number;
    /** Usage at price, and what the discount took off: charged is the price less the discount and what paid for it. */
    priceMicros?: number;
    discountMicros?: number;
    /** The account's discount now, in percent; absent without one. */
    discountPercent?: number | null;
    /** What paid for usage before it was charged, such as "Paid by g1t's open-source pool". */
    covered?: { source: "included" | "trial" | "oss_pool" | "given" | string; label: string; micros: number }[];
    /** Owed when the month closed but under the minimum charge: on the next invoice. */
    carriedMicros?: number;
    /** Tax and card processing fees paid with the month's payments, on top of `paidMicros`. */
    taxMicros?: number;
    cardFeeMicros?: number;
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
  /** Credit for a workspace: promotional, goodwill or a refund; the owners are emailed. */
  credit(workspace: string, amountMicros: number, note: string, by: string, options?: CreditOptions): Promise<Result<LedgerEntry>>;
  /** Every credit g1t gave, filtered, with each month's totals by kind. */
  credits(filter?: { workspace?: string | null; kind?: CreditKind | null; month?: string | null; by?: string | null }): Promise<AdminCredits>;
  /** What is left of a credit, taken back, with why. */
  revokeCredit(id: string, note: string, by: string): Promise<Result<CreditGrant>>;
  /** A test workspace's billing wiped, to start again as a new customer. Only on Stripe's test key; never comped or enterprise. Logged. */
  resetBilling(workspace: string, confirm: string, note: string, by: string): Promise<Result<BillingReset>>;
  /** The workspace's Stripe billing page, to send to the customer. Logged. */
  billingLink(workspace: string, by: string): Promise<Result<BillingLink>>;
  /** Where billing stands with Stripe; with `setup`, registers the webhook first. */
  /** Stripe's state for billing; `fix` enables the destination and adds missing events first. */
  stripe(fix?: boolean, by?: string): Promise<StripeStatus>;
  /** Where an enterprise's invoices go; makes its Stripe customer. */
  enterpriseBilling(id: string, email: string, by: string): Promise<Result<PayingAccount>>;
  /** The enterprise's billing address and tax ID, on its Stripe customer: Stripe Tax works its invoices out from them. */
  enterpriseAddress(id: string, address: PostalAddress, taxIdType: string | null, taxId: string | null, by: string): Promise<Result<boolean>>;
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
  /** Platform pauses, the last hour of platform usage, the month so far and the last day's breaches (billing's platform.rs). */
  platformGuard(): Promise<PlatformGuard>;
  /** Pauses or resumes one level across g1t; needs a note, recorded in the audit log. */
  setPause(level: PauseLevel, paused: boolean, note: string, by: string): Promise<Result<PlatformGuard>>;
  /** Approve or reject a price proposal; a rejection needs a note. An approved rise waits out the notice period. */
  decideProposal(id: string, decision: "approve" | "reject", note: string, by: string): Promise<Result<PriceProposal>>;
  setCostSettings(settings: CostSettings, by: string): Promise<Result<CostSettings>>;
  setCostMapping(mapping: CostMappingInput, by: string): Promise<Result<CostMapping>>;
  /** Reads Cloudflare's bill and reconciles now, as the daily run does. */
  runCosts(by: string): Promise<Result<CostsRun>>;
  /** Agents & models: the catalogue, each purpose's default, and the latest checks. */
  models(): Promise<AdminModels>;
  /** Approve a model (its prices confirmed), retire it, or restore it. Needs a reason. */
  decideModel(
    model: string,
    decision: "approve" | "retire" | "restore",
    details: { name?: string | null; tierHint?: string | null; prices?: ModelPrices | null },
    reason: string,
    by: string,
  ): Promise<Result<CatalogueModel>>;
  /** One purpose's default: a model, or for a job its tier and effort. Needs a reason. */
  setModelDefault(
    purpose: string,
    value: { model?: string | null; tier?: string | null; effort?: string | null },
    reason: string,
    by: string,
  ): Promise<Result<ModelDefault>>;
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
  /** The budget's alerts, in percent of the spend limit: some of 50, 75, 90 and 100. */
  alertLevels?: number[];
  /** Whether usage pauses at the spend limit (the default); off, it only alerts. */
  pauseAtLimit?: boolean;
  /** An HTTPS address told of each budget alert. */
  budgetWebhook?: string | null;
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
 * What a workspace pays a monthly price for: the g1t plan (`plan`), and the
 * Security and quality activation (`security`), sold on its own. Deployments
 * are part of the plan; `has_feature` for `deployments` answers whether the
 * workspace has the plan. Mirrors `Feature` in `crates/contracts/src/billing.rs`.
 */
export type Feature = "plan" | "deployments" | "security";

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
  /** Charged every month while the plan is on, in cents, excluding tax. */
  monthlyCents: number;
  /** The card processing fee on top each month, in cents (0 when off), excluding tax. */
  cardFeeCents?: number;
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
  /** Credits from g1t, newest first, with what is left of each. Members only. */
  credits(workspace: string, viewer: Viewer): Promise<Result<Credits>>;
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
  /** What the AI Gateway offers on g1t's key, with prices per million tokens. */
  gatewayModels(): Promise<GatewayModel[]>;
  /** Every purpose's default model as it applies now, and each job's tier and effort. */
  modelDefaults(): Promise<ModelDefaults>;
  /** What one provider lists now, from the models service's discovery. */
  recordDiscovery(provider: string, models: ProviderModel[], by: string, error?: string | null): Promise<DiscoveryResult>;
  /**
   * Whether a workspace's next AI Gateway request may go to g1t's models:
   * fails with `payment_required` and what to do when it is over its spend
   * limit, out of AI credit, or not on the plan.
   */
  gatewayAdmit(workspace: string): Promise<Result<boolean>>;
  /** Logs one AI Gateway request, and charges it when it used tokens on g1t's models. */
  recordGateway(record: GatewayRecord): Promise<Result<boolean>>;
  /** A workspace's recent AI Gateway requests, newest first. Members only. */
  gatewayRequests(workspace: string, viewer: Viewer, options?: { limit?: number; before?: string | null }): Promise<Result<GatewayRequests>>;
  recordTokens(usage: {
    workspace: string;
    /** The model session's id, one per run. */
    session: string;
    /** The person the run is for, by username. */
    person?: string | null;
    model: string;
    tier?: "small" | "large" | "frontier" | null;
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
  /** Which of the workspaces are free (on no paid plan); none where payments are not set up. */
  freeWorkspaces(workspaces: string[]): Promise<string[]>;
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
    /**
     * The model session's id: the run is settled at AI Gateway's price by
     * it, and on the workspace's own provider its tokens are counted under
     * it for the agent rate.
     */
    session?: string | null;
    /** The tier g1t routed the run to: `small`, `large` or `frontier`. */
    tier?: "small" | "large" | "frontier" | null;
  }): Promise<Result<RunTicket | null>>;
  /** Usage over a range of days (`YYYY-MM-DD`, both included), at price, by product, meter, project and day. Members only. */
  usageReport(
    workspace: string,
    viewer: Viewer,
    range: { from: string; until: string; products?: string[]; projects?: string[] },
  ): Promise<Result<UsageReport>>;
  /** The workspace's prepaid AI credit, auto-reload and prices. Members only. */
  aiCredit(workspace: string, viewer: Viewer): Promise<Result<AiCredit>>;
  /** Stripe's page to buy AI credit ( to ,000, the card fee on its own line). Owners only. The page's id comes back to `returnUrl` as `ai_credit`. */
  buyAiCredit(actor: User, workspace: string, amountCents: number, returnUrl: string): Promise<Result<{ url: string }>>;
  /** Credits a purchase once Stripe says it was paid, once. Safe to repeat. */
  confirmAiCredit(workspace: string, viewer: Viewer, session: string): Promise<Result<AiCredit>>;
  /** Auto-reload's settings. Owners only. */
  setAiReload(
    actor: User,
    workspace: string,
    reload: { enabled: boolean; thresholdMicros: number; targetMicros: number; monthlyMaxMicros: number },
  ): Promise<Result<AiCredit>>;
  /** The monthly budget: the spend limit, its alerts, whether usage pauses at 100%, and a webhook. Owners only. */
  setBudget(
    actor: User,
    workspace: string,
    budget: { amountMicros: number | null; alerts: number[]; pauseAtLimit: boolean; webhook: string | null; keepLimit?: boolean },
  ): Promise<Result<Limit>>;
  /** Invoice details from the Stripe customer, the default payment method, invoices and the next invoice. Members only. */
  billingDetails(workspace: string, viewer: Viewer): Promise<Result<BillingDetails>>;
  /** Saves invoice details on the Stripe customer; absent fields stay, empty clears. Owners only. */
  setBillingDetails(actor: User, workspace: string, details: BillingDetailsInput): Promise<Result<BillingDetails>>;
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

// --- AI Gateway -------------------------------------------------------------

/** A model the AI Gateway offers on g1t's key, with its prices per million tokens. */
export type GatewayModel = {
  /**
   * The provider's own id, such as `claude-sonnet-5-5` or
   * `@cf/openai/gpt-oss-120b`. A request names it as it is or with its
   * provider in front (`anthropic/claude-sonnet-5-5`).
   */
  model: string;
  /** For people: `Claude Sonnet 5.5`. */
  name: string;
  /** `anthropic` or `workers-ai`. */
  provider: string;
  /** `chat`, or `embeddings` for a model that only embeds text. */
  kind?: "chat" | "embeddings";
  inputMicros: number;
  outputMicros: number;
  cacheReadMicros: number;
  /** Cache writes that live five minutes. */
  cacheWriteMicros: number;
  /** Cache writes that live an hour. */
  cacheWrite1hMicros?: number;
  /**
   * Priced by the prompt's length: a request whose prompt (input, cache
   * read and cache write tokens) is longer than this is charged entirely at
   * the `over` prices. 0 or absent for one price.
   */
  threshold?: number;
  overInputMicros?: number;
  overOutputMicros?: number;
  overCacheReadMicros?: number;
  overCacheWriteMicros?: number;
  overCacheWrite1hMicros?: number;
};

// --- The model catalogue ------------------------------------------------------

/** Where a model stands: only `available` ones are routed to. */
export type ModelStatus = "available" | "new" | "deprecated" | "retired";

/** One model in g1t's catalogue: its prices and what g1t knows about it. */
export type CatalogueModel = GatewayModel & {
  /** Other ids the provider lists it by, such as a dated one. */
  aliases: string[];
  family: string;
  /** The agent tier it suits: `small`, `large`, `frontier`, or empty. */
  tierHint: string;
  contextWindow: number;
  maxOutput: number;
  /** Any of `effort`, `thinking`, `tools`, `vision`, `embeddings`. */
  capabilities: string[];
  dimensions: number;
  status: ModelStatus;
  /** Its prices are known. An unpriced model is never routed to, offered or charged for. */
  priced: boolean;
  source: "discovered" | "staff";
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  missingSince: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  note: string;
  /** A typical agent run on it, in millionths of a dollar; 0 when unpriced or embeddings. */
  typicalRunMicros: number;
};

/** One model as its provider lists it, from the models service's discovery. */
export type ProviderModel = {
  id: string;
  name: string;
  /** `chat`, `embeddings`, or anything else (counted as listed, never added). */
  kind: string;
  contextWindow: number;
  maxOutput: number;
  capabilities: string[];
  /** Workers AI lists a price per million tokens; Anthropic does not. */
  price: { inputMicros: number; outputMicros: number } | null;
};

/** What one check of a provider found. */
export type DiscoveryResult = {
  provider: string;
  checkedAt: string;
  by: string;
  listed: number;
  added: string[];
  deprecated: string[];
  restored: string[];
  error: string | null;
};

/** The purposes a default model is chosen for. */
export type ModelPurpose = "tier_small" | "tier_large" | "tier_frontier" | "background" | "gateway_first";

/** One purpose's default, as staff last set it. */
export type ModelDefault = {
  /** A `ModelPurpose`, or `job_<kind>`. */
  purpose: string;
  model: string | null;
  /** For a job: `small`, `large`, `frontier` or `change`. */
  tier: string | null;
  effort: string | null;
  updatedAt: string;
  updatedBy: string;
  reason: string;
};

/** A model purpose's default as it applies now. */
export type ResolvedModel = {
  purpose: string;
  chosen: string;
  /** The model to use; null when nothing suits (callers keep their own fallback). */
  model: GatewayModel | null;
  capabilities: string[];
  /** Why it is not the chosen model, in a sentence. */
  note: string | null;
};

/** One kind of agent job's starting tier and effort. */
export type JobDefault = { kind: string; tier: string; effort: string | null };

/** Every purpose's model as it applies now, and each job's tier and effort. */
export type ModelDefaults = { models: ResolvedModel[]; jobs: JobDefault[] };

/** One check of one provider. */
export type ModelCheck = {
  id: string;
  provider: string;
  checkedAt: string;
  by: string;
  listed: number;
  added: string[];
  deprecated: string[];
  error: string | null;
};

/** The tokens of the typical agent run estimates are priced from. */
export type TypicalRun = { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number };

/** sudo's Agents & models. */
export type AdminModels = {
  catalogue: CatalogueModel[];
  defaults: ModelDefault[];
  resolved: ModelDefaults;
  checks: ModelCheck[];
  typical: TypicalRun;
};

/** A model's prices as staff confirm them, per million tokens in millionths of a dollar. */
export type ModelPrices = {
  inputMicros: number;
  outputMicros: number;
  cacheReadMicros: number;
  cacheWriteMicros: number;
  cacheWrite1hMicros: number;
  threshold: number;
  overInputMicros: number;
  overOutputMicros: number;
  overCacheReadMicros: number;
  overCacheWriteMicros: number;
  overCacheWrite1hMicros: number;
};

/** The models service's `Discovery` entrypoint, for sudo's "Check for new models". */
export interface ModelDiscoveryApi {
  /** Lists every provider's models now and records what changed: one result per provider. */
  check(by: string): Promise<DiscoveryResult[]>;
}

/** The format a gateway request was sent in. */
export type GatewayFormat = "anthropic" | "openai";

/** One AI Gateway request, as the model proxy reports it to billing. */
export type GatewayRecord = {
  /** `gw_…`, chosen by the proxy; recording it twice records it once. */
  id: string;
  workspace: string;
  tokenId: string;
  tokenName?: string | null;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  /** Every cache write, of either lifetime. */
  cacheWrite: number;
  /** Of `cacheWrite`, those that live an hour. */
  cacheWriteHour?: number;
  /** The HTTP status the caller was answered with. */
  status: number;
  /** On the workspace's own provider key: counted, never charged. */
  ownKey: boolean;
  format: GatewayFormat;
  /**
   * Who served it: `anthropic` or `workers-ai` on g1t's key, the
   * connection's provider on the workspace's own. Empty when it never got
   * that far.
   */
  provider: string;
  /** On the workspace's own provider: the connection's name. */
  connection?: string | null;
  streamed: boolean;
  durationMs: number;
  error?: string | null;
};

/** One AI Gateway request, as its log keeps it. */
export type GatewayRequest = {
  id: string;
  createdAt: string;
  model: string;
  tokenId: string;
  tokenName: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Of `cacheWrite`, those that live an hour. */
  cacheWriteHour: number;
  /** What the tokens cost at the model's price. */
  costMicros: number;
  /** What the workspace was charged, before included usage and credit paid for it; 0 on its own key. */
  chargedMicros: number;
  status: number;
  ownKey: boolean;
  format: GatewayFormat;
  /** `anthropic` or `workers-ai` on g1t's key; the connection's provider on the workspace's own. */
  provider: string;
  /** On the workspace's own provider: the connection's name. */
  connection: string | null;
  streamed: boolean;
  durationMs: number;
  error: string | null;
};

/** A page of AI Gateway requests, newest first. */
export type GatewayRequests = {
  requests: GatewayRequest[];
  /** The `before` for the next page, when there is one. */
  next: string | null;
  /** How many days requests are kept. */
  retentionDays: number;
};

/** What a workspace's agents cost over a period. */
export type Usage = {
  since: string;
  /** Charged, including g1t's margin. */
  spentMicros: number;
  /** What g1t's usage came to at price, less what was charged: the plan's included usage, the trial, a pool or a free period paid it. Usage at price is `spentMicros` plus this. */
  coveredMicros?: number;
  /** What the account's discount took off the price; usage at price is spent + covered + this. */
  discountMicros?: number;
  /** The account's discount now, in percent; with one, the slices are at price. */
  discountPercent?: number | null;
  /** Usage at price: spent + covered + discount, from the same ledger lines. The one usage figure every page shows. */
  priceMicros?: number;
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
export type OverallMargin = {
  usageMicros: number;
  plansMicros: number;
  costMicros: number;
  marginMicros: number;
  marginPercent: number | null;
  /** Of costMicros, what went on usage g1t gave away on purpose: comped workspaces, free periods, the trial and the open-source pool. */
  givenMicros?: number;
  /** Money in against costMicros - givenMicros. */
  soldMarginMicros?: number;
  soldMarginPercent?: number | null;
  /** Usage sold: usageMicros against what that usage cost, less what was given. */
  usageCostMicros?: number;
  usageMarginMicros?: number;
  usageMarginPercent?: number | null;
  /** Running g1t: plansMicros against the platform's cost, less its given share. */
  runningCostMicros?: number;
  /** Cost no mapping names, less its given share. */
  unmappedCostMicros?: number;
  /** givenMicros by why. Free is free periods, free allowances and overruns g1t covered. */
  givenCompedMicros?: number;
  givenFreeMicros?: number;
  givenTrialMicros?: number;
  givenPoolMicros?: number;
  /** What discounts on an account's terms took below cost plus the margin: given, not margin lost. */
  givenDiscountMicros?: number;
  /** Credits from g1t spent on usage, by kind: given, never money in. Refunds come off money in instead. */
  givenCreditPromotionalMicros?: number;
  givenCreditGoodwillMicros?: number;
  /** What testing resets wiped that g1t paid for: the usage still happened, so its cost is given, never a leak. */
  givenResetMicros?: number;
  /** Credits over the range: given (every kind), spent on usage, and refunds' money given back. */
  creditsGivenMicros?: number;
  creditsUsedMicros?: number;
  creditsRefundedMicros?: number;
  /** costMicros by who g1t pays: Cloudflare's bill (billed, after included allowances) and model providers (tokens, not on Cloudflare's bill). */
  /** What the plan's included usage paid for, at price: money in for usage, paid out of plansMicros. */
  includedMicros?: number;
  cloudflareCostMicros?: number;
  modelsCostMicros?: number;
  /** Tax collected with payments over the range, net of refunds: owed to tax authorities, never cash or revenue. */
  taxCollectedMicros?: number;
  /** Card processing fees passed on with card payments, net of refunds: they pay Stripe's fee, not revenue. */
  cardFeesMicros?: number;
  /** What workspaces were charged while payments were not live (Stripe's test mode): given, never money in. */
  givenUnpaidMicros?: number;
  /** Cloudflare's subscriptions over the range: each day's share of the billing cycle it is in. */
  subscriptionsMicros?: number;
  /** What AI Gateway priced g1t's own provider traffic at over the range, beside the ledger's model cost. */
  gatewayCostMicros?: number;
};

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
  /**
   * What `costMicros` is: `cost`, what g1t pays for a unit; `rate`, a price
   * g1t sets with no cost behind it (the agent rate), so it is no cost;
   * `weight`, a multiplier in millionths, not money. Absent from older
   * billing: read as `cost`.
   */
  basis?: "cost" | "rate" | "weight" | "";
};

/** What `resetBilling` removed. */
export type BillingReset = { workspace: string; rows: number; refreshed?: boolean };

export type WorkspaceCost = { workspace: string; costMicros: number; revenueMicros: number; givenMicros?: number; internal: boolean };

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
  /** Pass Stripe's card fee on as its own line when AI credit is bought by card. */
  cardFee: boolean;
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
  /** Cloudflare's current billing cycle: usage cost so far by meter, and the projection. Absent until the bill is read. */
  cycle?: CloudflareCycle | null;
  /** The last read of Cloudflare's billable usage: what came back. */
  billRead?: BillRead | null;
  /** Of the range's cost, what no workspace's usage could carry: running g1t, attributed to no one. */
  unattributedMicros?: number;
};

/** Cloudflare's billing cycle, as its Billable usage page shows it. */
export type CloudflareCycle = {
  /** First and last days, YYYY-MM-DD, UTC. */
  start: string;
  end: string;
  days: number;
  /** Days from its start to today, today included. */
  daysElapsed: number;
  /** Usage cost so far, after the included allowances. */
  usageMicros: number;
  /** usageMicros over the days elapsed, times the cycle's days. */
  projectedMicros: number;
  averageDailyMicros: number;
  /** Cloudflare's subscriptions for the cycle (not on the usage bill). */
  subscriptionsMicros: number;
  meters: CycleMeter[];
};

/** One of Cloudflare's meters over the cycle so far. */
export type CycleMeter = {
  product: string;
  meter: string;
  rawName: string;
  unit: string;
  quantity: number;
  /** What the cycle includes; null without a list price. */
  included: number | null;
  billableQuantity: number;
  costMicros: number;
  /** cloudflare: Cloudflare's own cost; list: the list price past the included amount; none: no list price known. */
  basis: "cloudflare" | "list" | "none" | string;
};

/** What the last read of Cloudflare's billable usage got back. */
export type BillRead = {
  readAt: string;
  since: string;
  until: string;
  rows: number;
  pages: number;
  consumedRows: number;
  pricingOnlyRows: number;
  costedRows: number;
};

/** One level of the platform pause, as sudo shows it. Snake case, as billing sends it. */
export type PauseState = {
  level: PauseLevel;
  paused: boolean;
  note: string | null;
  set_by: string | null;
  set_at: string | null;
  /** Set by billing's usage watcher, not a person. */
  auto: boolean;
};

/** One platform metric over an hour or the month so far. */
export type PlatformMetric = {
  metric: string;
  title: string;
  value: number;
  /** Its hourly threshold (`PLATFORM_HOURLY_*`); 0: none. */
  threshold: number;
  /** The script, queue, database or namespace that counted most. */
  top_name: string | null;
  top_value: number | null;
};

/** A breach billing's usage watcher found. */
export type PlatformBreach = {
  id: string;
  metric: string;
  hour: string;
  rule: "threshold" | "spike";
  value: number;
  threshold: number;
  severe: boolean;
  top_name: string | null;
  detail: string;
  /** Levels it paused. */
  paused: PauseLevel[];
  opened_at: string;
  emailed_at: string | null;
};

/** Billing's `admin_platform_guard`: the platform pause and usage watcher (docs/SPEND-GUARDRAILS.md). */
export type PlatformGuard = {
  levels: PauseState[];
  /** The last hour read, `YYYY-MM-DDTHH:00:00Z`. */
  hour: string | null;
  last_hour: PlatformMetric[];
  month: string;
  month_to_date: PlatformMetric[];
  breaches: PlatformBreach[];
  /** Whether billing can read Cloudflare's analytics. */
  can_read: boolean;
  /** `AUTO_PAUSE`: the levels a severe breach may pause. */
  auto_pause: PauseLevel[];
  /** What the latest run could not see: each query that failed, with its error. */
  blind?: { key: string; dataset: string; error: string }[];
  /** The latest run found every dataset empty: the wrong account, or a token that cannot see it. */
  empty?: boolean;
  /** The hour the latest run read. */
  last_run?: string | null;
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
  /** Cloudflare's subscriptions a month: read from Cloudflare each day, else `CLOUDFLARE_FIXED_MONTHLY_MICROS`, an estimate. */
  fixedMonthlyMicros: number;
  fixedSource?: "cloudflare" | "estimate" | string;
  fixedReadAt?: string | null;
  /** Each subscription, when read from Cloudflare. */
  fixedItems?: { name: string; monthlyMicros: number }[];
  /** Of fixedMonthlyMicros, this calendar month's days so far, each at its billing cycle's daily share. */
  fixedMonthMicros?: number;
  /** Money in this month, through the last reconciled day. */
  revenueMicros: number;
  /**
   * Of this month's buckets, what was spent on workspaces whose billing a
   * testing reset later wiped (still g1t's spend; the reconciled figures
   * have it only where the reset kept it), and those workspaces.
   */
  resetMicros?: number;
  resetWorkspaces?: string[];
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

/** The product families the Usage page groups meters into, in order. */
export const PRODUCTS = [
  { key: "agent", label: "Agent" },
  { key: "sandboxes", label: "Sandboxes" },
  { key: "gateway", label: "AI Gateway" },
  { key: "deployments", label: "Deployments" },
  { key: "git_storage", label: "Git & storage" },
  { key: "packages", label: "Packages" },
  { key: "security", label: "Security & quality" },
  { key: "search", label: "Search" },
] as const;

export type ProductKey = (typeof PRODUCTS)[number]["key"];

/** What usage came to over a range, and what paid for it: price − discount − included − credits = charged. */
export type UsageTotals = {
  /** Usage at price, pending usage included. */
  priceMicros: number;
  discountMicros: number;
  /** Paid by the plan's included usage, the trial and g1t's pools. */
  includedMicros: number;
  /** Paid by AI credit and credit from g1t. */
  creditsMicros: number;
  /** Left for the workspace to pay. */
  chargedMicros: number;
  /** Metered this month, charged when it closes. */
  pendingMicros: number;
  costMicros: number;
};

export type UsageDay = { day: string; product: string; micros: number };

export type UsageAllowance = { used: number; of: number; unit: string };

export type ProjectUsage = { project: string; micros: number; quantity: number };

/** One meter over a range. */
export type MeterLine = {
  key: string;
  label: string;
  product: string;
  /** `tokens`, `seconds`, `bytes`, `operations`, `requests` or `entries`. */
  unit: string;
  quantity: number;
  micros: number;
  pendingMicros?: number;
  /** Every day of the range, oldest first, at price. */
  daily: number[];
  allowance?: UsageAllowance | null;
  byProject: ProjectUsage[];
  /** How the quantity is counted, when that needs saying (the agent rate's token weights). */
  note?: string | null;
};

export type FeatureUsage = { key: string; label: string; micros: number; count: number };

export type ProductUsage = { key: string; label: string; micros: number; meters: MeterLine[]; features?: FeatureUsage[] };

/** The tokens one model used over a range, as the model proxy counted them. */
export type ModelTokens = { model: string; input: number; output: number; cacheRead: number; cacheWrite: number };

export type UsageReport = {
  from: string;
  until: string;
  totals: UsageTotals;
  days: UsageDay[];
  products: ProductUsage[];
  projects: string[];
  /** Agent tokens by model over the range, most first. */
  models?: ModelTokens[];
  /** The plan's included usage this month, in micros. */
  included?: UsageAllowance | null;
  discountPercent?: number | null;
  aiCreditMicros: number;
  creditMicros: number;
  trialMicros?: number | null;
  plan: PlanKind;
  free: boolean;
};

export type AiReload = {
  enabled: boolean;
  thresholdMicros: number;
  targetMicros: number;
  monthlyMaxMicros: number;
  reloadedMicros?: number;
  failedAt?: string | null;
  error?: string | null;
};

export type CardFee = { on: boolean; percentMicros: number; fixedCents: number };

/** Prepaid AI credit: what Agent and AI Gateway usage draws on. */
export type AiCredit = {
  balanceMicros: number;
  purchasedMicros: number;
  givenMicros: number;
  grants: CreditGrant[];
  /** A 100% discount pays for AI usage: nothing to buy. */
  freeViaDiscount: boolean;
  /** Invoiced after use (an enterprise). */
  postpaid: boolean;
  /** New runs on g1t's models are refused for want of credit. */
  blocked: boolean;
  canBuy: boolean;
  presetsCents: number[];
  minCents: number;
  maxCents: number;
  cardFee: CardFee;
  reload: AiReload;
  /** The agent rate per million tokens, at price. */
  agentRateMicros: number;
  modelMarkupPercent: number;
  gatewayMarkupPercent: number;
  upgradeCreditMicros: number;
  expiresDays: number;
};

export type PostalAddress = { line1: string; line2: string; city: string; state: string; postalCode: string; country: string };

export type PaymentMethod = {
  kind: string;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
};

export type StripeInvoice = {
  id: string;
  number?: string | null;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: string;
  description?: string | null;
  hostedUrl?: string | null;
  pdfUrl?: string | null;
};

export type UpcomingInvoice = { closesAt: string; subscriptionsMicros: number; usageMicros: number; totalMicros: number };

export type BillingDetails = {
  customer: boolean;
  email: string | null;
  name: string | null;
  address: PostalAddress | null;
  taxIdType: string | null;
  taxId: string | null;
  poNumber: string | null;
  language: string | null;
  paymentMethod: PaymentMethod | null;
  invoices: StripeInvoice[];
  upcoming: UpcomingInvoice;
  unavailable?: string | null;
  /** Whether Stripe Tax can place the customer from the address; without it nothing is charged. */
  taxLocation?: boolean;
  /** Set when g1t did not charge for want of a billing address. */
  taxAddressNeededAt?: string | null;
  /** Stripe's check of the tax ID: pending, verified, unverified or unavailable. */
  taxIdStatus?: string | null;
  /** none, exempt or reverse, as set at Stripe. */
  taxExempt?: string | null;
};

export type BillingDetailsInput = {
  email?: string;
  name?: string;
  address?: PostalAddress;
  taxIdType?: string;
  taxId?: string;
  poNumber?: string;
  language?: string;
};
