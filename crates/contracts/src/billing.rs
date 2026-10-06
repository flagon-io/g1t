//! The billing service: what agents cost, charged to the workspace they
//! worked for.
//!
//! A workspace buys credit and each agent run deducts what it cost, plus
//! g1t's margin. With no credit, no agent starts. Money is held in
//! millionths of a US dollar, so that a run costing a fraction of a cent is
//! recorded exactly.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::{User, Viewer};

/// Millionths of a US dollar in one dollar.
pub const MICROS_PER_DOLLAR: i64 = 1_000_000;

/// Whether workspaces are charged for agents at all, and with real money.
/// `status` takes nothing and returns this.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Status {
    /// False when no payment provider is configured: nothing is charged,
    /// and who may run agents is decided some other way.
    pub enabled: bool,
    /// False while the payment provider is in its test mode, where cards
    /// are not real.
    pub live: bool,
    /// True while g1t is being built out: runs are recorded, with what
    /// they cost, but nothing is charged and no credit is needed. Not a
    /// promise that it stays free.
    #[serde(default)]
    pub free: bool,
}

/// `trial`: a workspace's trial credit, so people can try g1t (its agents on
/// g1t's hosted models among it) without a key or a card of their own. Each
/// new workspace gets one grant of usage credit (`TRIAL_WORKSPACE_MICROS`),
/// made when it first uses something, out of a pool for everyone that
/// resets each calendar month (`TRIAL_MONTHLY_POOL_MICROS`). When this
/// month's pool is given out, new grants wait for the next month. Returns
/// `Trial`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialArgs {
    pub workspace: String,
    /// Workspaces open to hosted models anyway, whose use is not counted
    /// against the pool.
    #[serde(default)]
    pub exempt: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trial {
    /// Whether its agents may use g1t's hosted models on the trial now: it
    /// has credit left, or this month's pool can still grant it some.
    pub open: bool,
    /// What the trial has paid for so far, in millionths of a dollar.
    pub used_micros: i64,
    /// Its grant, or what it would be granted.
    pub limit_micros: i64,
    /// No longer used: the trial does not end on a date. Kept for older
    /// readers; always null.
    pub ends_at: Option<String>,
    /// Why it is closed: `off` (no trials), `used` (this workspace's grant
    /// is spent) or `pool` (this month's grants are all given out; see
    /// `waits_until`). `ended` is no longer sent.
    pub reason: Option<String>,
    /// Whether the workspace has its grant already.
    #[serde(default)]
    pub granted: bool,
    /// RFC 3339: when a workspace waiting for a grant can get one, the
    /// first of next month. Only with reason `pool`.
    #[serde(default)]
    pub waits_until: Option<String>,
}

/// A workspace's standing.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub workspace: String,
    /// Credit left, in millionths of a dollar. Can dip below zero by the
    /// cost of the runs that were under way when it ran out.
    pub balance_micros: i64,
    pub status: Status,
    /// What is added to a run's cost, in percent.
    pub margin_percent: u32,
    /// The card g1t charges as the workspace nears its limit and when a
    /// month closes, if one is on file.
    #[serde(default)]
    pub card: Option<Card>,
}

/// A saved card, as far as it is safe to show.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    /// `visa`, `mastercard`, ...
    pub brand: String,
    pub last4: String,
    pub exp_month: u32,
    pub exp_year: u32,
}

/// `billing_portal`: Stripe's hosted billing page for the workspace, where
/// an owner adds or replaces the card, sees invoices and receipts, and sets
/// the billing email and address. g1t never handles card numbers. Owners
/// only. Returns `Outcome<Checkout>` (its `url`); Stripe sends them back
/// to `return_url`.
#[derive(Debug, Serialize, Deserialize)]
pub struct BillingPortalArgs {
    pub actor: User,
    pub workspace: String,
    pub return_url: String,
}

/// `admin_billing_link`: for staff to send a customer: their Stripe billing
/// page. Returns `Outcome<BillingLink>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminBillingLinkArgs {
    pub workspace: String,
    pub by: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingLink {
    /// A one-time session on Stripe's billing page, signed in already.
    pub portal_url: String,
    /// The billing page's sign-in page, which does not expire: the
    /// customer signs in with the email Stripe has for them.
    pub login_url: Option<String>,
    pub customer_email: Option<String>,
    pub expires_note: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    /// Credit bought with a card.
    TopUp,
    /// An agent's run, or a paid feature's usage past its allowance.
    Usage,
}

/// One line of a workspace's statement.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub id: String,
    pub kind: EntryKind,
    /// Positive for credit added, negative for usage.
    pub amount_micros: i64,
    pub description: String,
    /// For usage: the repository and pull request the agent worked on.
    pub repo: Option<String>,
    pub number: Option<u32>,
    /// For usage: `implement`, `review` or `update`.
    pub task: Option<String>,
    /// For usage: the model, by its public name.
    pub model: Option<String>,
    /// For usage: `g1t` when g1t paid the model provider, `workspace` when
    /// the workspace's own account did. Runs on the workspace's own
    /// provider pay only their sandbox time now, so only older entries
    /// are `workspace`.
    #[serde(default = "g1t")]
    pub billed_to: String,
    /// For a top-up: the username of whoever paid.
    pub created_by: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    /// The workspace the line belongs to, which tells an enterprise's
    /// lines apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// For usage: what the g1t plan's monthly included usage paid of it.
    /// The entry's `amount_micros` is what is left to pay.
    #[serde(default)]
    pub credit_micros: i64,
    /// For usage: what the workspace's trial credit paid of it.
    #[serde(default)]
    pub trial_micros: i64,
    /// For usage: what g1t's open-source pool paid of it.
    #[serde(default)]
    pub oss_micros: i64,
    /// For usage: what g1t covered itself, such as the part of a free
    /// workspace's last trial run that went past its trial credit.
    #[serde(default)]
    pub given_micros: i64,
}

fn g1t() -> String {
    "g1t".to_owned()
}

/// `account` (`Outcome<Account>`) and `ledger` (`Outcome<Vec<LedgerEntry>>`,
/// newest first). Members of the workspace only.
#[derive(Debug, Serialize, Deserialize)]
pub struct AccountArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `checkout`: prepays usage: money paid in advance, drawn down by usage
/// after the plan's included usage, which raises what can be used before
/// work stops by the same amount at once. $25 at the least. By card, with
/// 3-D Secure; from $1,000 also by bank transfer. Owners of the workspace
/// only. Returns `Outcome<Checkout>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutArgs {
    pub actor: User,
    pub workspace: String,
    /// How much to prepay, in cents.
    pub amount_cents: u32,
    /// Where the payment page sends the person afterwards. The payment's
    /// id is appended as `session`.
    pub return_url: String,
    /// `card` (the default) or `bank_transfer` (from $1,000): Stripe gives
    /// the account details, and the money counts once it arrives.
    #[serde(default)]
    pub method: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Checkout {
    /// The payment page to send the person to.
    pub url: String,
}

/// `confirm`: credits a payment once the provider says it was made. Safe
/// to call any number of times. Returns `Outcome<Account>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfirmArgs {
    pub workspace: String,
    pub viewer: Viewer,
    /// The payment's id, as returned to `return_url`.
    pub session: String,
}

/// `can_start`: whether a workspace may start an agent now, asked before
/// anything is opened for it. Returns `Outcome<bool>`: a failure, with the
/// reason to show, when it has no credit.
#[derive(Debug, Serialize, Deserialize)]
pub struct CanStartArgs {
    pub workspace: String,
}

/// `start_run`: asks whether a workspace may start an agent, and opens the
/// run it will be charged for. Called by the runner service. Returns
/// `Outcome<Option<RunTicket>>`: no ticket when billing is off, a failure
/// when the workspace has no credit.
#[derive(Debug, Serialize, Deserialize)]
pub struct StartRunArgs {
    pub workspace: String,
    pub repo: RepoPath,
    pub number: u32,
    /// `implement`, `review` or `update`.
    pub task: String,
    /// The model, by its public name.
    pub model: String,
    /// `workspace` when the run uses the workspace's own model provider.
    /// The runner, which is TypeScript, sends it as `billedTo`.
    #[serde(default = "g1t", alias = "billedTo")]
    pub billed_to: String,
    /// The model session's id, when its requests go through g1t's AI
    /// Gateway: settling charges the run what the gateway priced them at.
    #[serde(default)]
    pub session: Option<String>,
    /// `small` or `large`: the tier g1t routed the run to, when g1t pays
    /// for its model. None on the workspace's own provider.
    #[serde(default)]
    pub tier: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTicket {
    pub run_id: String,
    /// Lets the sandbox, and nothing else, report what this run cost.
    pub token: String,
}

/// `finish_run`: what a run cost, as its sandbox reports it. Charged once.
/// Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishRunArgs {
    pub run_id: String,
    pub token: String,
    /// What the model provider charged, in US dollars.
    pub cost_usd: f64,
    #[serde(default)]
    pub turns: u32,
}


/// `usage`: what a workspace's agents cost over a period, broken down.
/// Members only. Returns `Outcome<Usage>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UsageArgs {
    pub workspace: String,
    pub viewer: Viewer,
    /// RFC 3339: the start of the period. The period runs to now.
    pub since: String,
}

/// One slice of usage: what it was for, what it cost, how many runs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSlice {
    pub key: String,
    pub micros: i64,
    pub runs: u32,
}

/// What a workspace's agents cost over a period.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub since: String,
    /// Charged, including g1t's margin.
    pub spent_micros: i64,
    /// What g1t's model provider charged, before the margin.
    pub cost_micros: i64,
    /// What runs on the workspace's own provider cost there, as the harness
    /// estimated it. Not charged by g1t.
    pub provider_micros: i64,
    /// What the runs used, at cost: g1t's models and the workspace's own
    /// provider together, whatever was charged for them.
    pub used_micros: i64,
    /// g1t charges nothing for now. The slices then measure usage at cost,
    /// since every charge is zero.
    pub free: bool,
    pub runs: u32,
    /// Spend per day (`YYYY-MM-DD`) and task, as `day/task` keys.
    pub by_day: Vec<UsageSlice>,
    /// Per task: implement, review, revise, update, plan.
    pub by_task: Vec<UsageSlice>,
    /// Per repository, `namespace/name`.
    pub by_repo: Vec<UsageSlice>,
    /// The pull requests that cost most, as `namespace/name#number`.
    pub by_pull: Vec<UsageSlice>,
    /// Per model, by its public name.
    pub by_model: Vec<UsageSlice>,
    /// Credit bought in the period.
    pub added_micros: i64,
}

/// What a workspace pays a monthly price for. There is one plan, `plan`
/// ("g1t"): a flat price per workspace, never per person, with included
/// usage each month, more private storage, and deployments. Never free:
/// `FREE_WHILE_BUILDING` does not cover it.
///
/// `deployments` is not sold on its own any more: it comes with the plan.
/// A service that asks `has_feature` for it is told whether the workspace
/// has the plan, and a Deployments subscription bought before the change
/// keeps working until its period ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    /// The g1t plan. Older readers called it `team`.
    #[serde(alias = "team")]
    Plan,
    /// Previews per pull request and production on g1t.page: part of the
    /// plan.
    Deployments,
}

impl Feature {
    /// What is sold: the plan alone.
    pub const ALL: [Feature; 1] = [Feature::Plan];

    pub fn as_str(self) -> &'static str {
        match self {
            Feature::Plan => "plan",
            Feature::Deployments => "deployments",
        }
    }

    pub fn parse(name: &str) -> Option<Feature> {
        match name {
            "plan" | "team" => Some(Feature::Plan),
            "deployments" => Some(Feature::Deployments),
            _ => None,
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Feature::Plan => "g1t",
            Feature::Deployments => "Deployments",
        }
    }
}

/// What deployments cost g1t, in millionths of a dollar: fallbacks for
/// when billing's price book cannot be read. Nothing here is an allowance:
/// on the plan every unit is metered from the first, at cost plus the
/// margin, and drawn from the plan's included usage before anything is
/// charged. Projects, previews and the apps behind them are not metered at
/// all: Cloudflare's Workers for Platforms includes far more scripts than
/// g1t runs, so an app costs g1t only the requests and CPU it answers with.
pub mod deployment_costs {
    /// Workers for Platforms: $0.30 per million requests.
    pub const MICROS_PER_MILLION_REQUESTS: i64 = 300_000;
    /// $0.02 per million CPU milliseconds.
    pub const MICROS_PER_MILLION_CPU_MS: i64 = 20_000;
    /// What one second of a build's sandbox costs g1t (Cloudflare
    /// Containers, standard-1: half a vCPU, 4 GiB, 8 GB disk), rounded up,
    /// as the price keeper measured it on 2026-10-05 (14.5). Only a
    /// fallback: billing charges builds at the price book's `build_second`,
    /// which the keeper keeps current.
    pub const MICROS_PER_BUILD_SECOND: i64 = 15;
    /// What one custom hostname costs g1t a month (Cloudflare for SaaS):
    /// $0.10.
    pub const MICROS_PER_DOMAIN_MONTH: i64 = 100_000;
}

/// `record_sandbox`: how long one sandbox ran for a workspace, reported by
/// the runner when it stops. Every sandbox g1t starts for a workspace
/// (agents, reviews, checks, the merge queue, workflow jobs) is metered by
/// the second, from the first: recorded once per `reference`, with what it
/// cost g1t, and charged at the price book's `sandbox_second` price unless
/// `FREE_WHILE_BUILDING`. Deploy builds are charged by the Deployments plan
/// instead.
/// Returns `Outcome<bool>`: false if that reference was recorded before.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSandboxArgs {
    pub workspace: String,
    pub seconds: u32,
    /// What ran, e.g. `Checks on acme/api#12`.
    pub description: String,
    /// `namespace/name`.
    pub repo: Option<String>,
    /// Unique to the run.
    pub reference: String,
    /// What ran: `agent`, `check`, `workflow` or `queue`. Decides whether
    /// g1t's open-source pool may pay for it (checks, workflows and the
    /// merge queue on public repositories). Absent: not the pool.
    #[serde(default)]
    pub kind: Option<ComputeKind>,
    /// The vCPU-seconds the sandbox used, when it can tell. With it, the
    /// run is priced on its own CPU (`sandbox_base_second` per second plus
    /// `sandbox_cpu_second` per vCPU-second); without it, at the average
    /// (`sandbox_second`).
    #[serde(default, alias = "cpu_seconds")]
    pub cpu_seconds: Option<f64>,
    /// The reservation the work started under, settled with this cost.
    #[serde(default, alias = "reservation_id")]
    pub reservation_id: Option<String>,
    /// It ran on one of the workspace's self-hosted runners: recorded as
    /// self-hosted time, for the minutes, at $0.
    #[serde(default, alias = "self_hosted")]
    pub self_hosted: bool,
    /// The machine it ran on, by label (`g1t-4core`); absent, the standard
    /// one. A larger machine's memory and disk cost more each second.
    #[serde(default)]
    pub instance: Option<String>,
}

/// How much a workspace has earned g1t's trust with money, which sets how
/// far its unpaid usage can go before its work stops.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    /// No live payment yet: only a little past the free allowances.
    New,
    /// Has paid g1t real money: the ceiling grows with what it has paid.
    Paid,
    /// Has paid steadily for months, with nothing disputed or declined:
    /// the ceiling follows its monthly spend, up to $10,000, by itself.
    Established,
    /// A ceiling g1t set by hand, after talking to the workspace.
    Reviewed,
    /// g1t's own workspaces: no ceiling.
    Internal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitState {
    Ok,
    /// Past 80% of the ceiling.
    Warning,
    /// At or past it: no new sandboxes, builds or app requests.
    Stopped,
}

/// How far a workspace's unpaid usage has gone this month, and where its
/// work stops: like Fly's or Cloudflare's limits for new accounts, so no
/// one runs up costs g1t cannot collect. Usage counts at what it cost g1t
/// or what it is charged, whichever is more, so it counts while g1t is
/// free too.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub workspace: String,
    /// The account that pays, whose usage and payments the limit counts:
    /// the workspace's own, or its enterprise's.
    #[serde(default)]
    pub account: String,
    #[serde(default)]
    pub account_name: String,
    pub trust: Trust,
    /// Usage this month (UTC) less what was paid this month.
    pub exposure_micros: i64,
    /// Where work stops: the lower of g1t's ceiling and the owner's own
    /// spend limit. None for g1t's own workspaces.
    pub ceiling_micros: Option<i64>,
    /// The ceiling g1t sets from `trust`.
    pub trust_ceiling_micros: Option<i64>,
    /// The owner's own monthly limit, if they set one.
    pub spend_limit_micros: Option<i64>,
    pub state: LimitState,
    /// What to tell people when work is stopped or close to it.
    pub message: Option<String>,
    /// Charged this month, which the spend limit is measured against.
    #[serde(default)]
    pub spent_micros: i64,
    /// True while the owners have not chosen a spend limit of their own, so
    /// the automatic one applies: $200, or twice last month's spend.
    #[serde(default)]
    pub default_spend_limit: bool,
    /// The most the owners may set their own limit to: g1t's ceiling. To
    /// go past it, they contact g1t.
    #[serde(default)]
    pub available_micros: Option<i64>,
    /// How the ceiling grows from here, in a sentence.
    #[serde(default)]
    pub growth: Option<String>,
    /// Money paid in advance and not used yet. It raises what can be used
    /// before work stops by the same amount, at once.
    #[serde(default)]
    pub prepaid_micros: i64,
    /// The highest ceiling the workspace has ever had. Owners may set their
    /// spend limit anywhere up to it (plus what is prepaid) without asking.
    #[serde(default)]
    pub max_ceiling_micros: Option<i64>,
    /// The most the owners may raise the limit to themselves, once, with
    /// `raise_once`: twice the highest ceiling. None once it is used.
    #[serde(default)]
    pub raise_once_micros: Option<i64>,
    /// When the one-time raise was used, RFC 3339.
    #[serde(default)]
    pub raised_at: Option<String>,
    /// True in a paid workspace's first billing cycle, when the ceiling is
    /// the starting one (`LIMIT_PAID_START_MICROS`).
    #[serde(default)]
    pub first_month: bool,
}

/// `limit`: a workspace's limit, for its members. Returns `Outcome<Limit>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct LimitArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `check_limit`: the same, for the services that enforce it. Returns
/// `Outcome<Limit>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CheckLimitArgs {
    pub workspace: String,
}

/// `note_pending`: usage this month that will be charged later, such as
/// app traffic past a plan, so the workspace's limit counts it now. Each
/// report replaces the last for that workspace, source and month. Called
/// by the service that meters it. Returns `bool`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePendingArgs {
    pub workspace: String,
    /// `deployments`, `security` (scans), `context` (search embeddings),
    /// `storage` or `cache` (actions/cache, plan only). Billing charges
    /// `security`, `context`, `storage` and `cache` itself once the month
    /// is over; `deployments` charges its own.
    pub source: String,
    /// What it cost g1t so far this month, before the margin.
    pub cost_micros: i64,
    /// How much of it, for the Billing page: `1.2 million requests and
    /// 3.4 million CPU ms`, `2 custom domains`.
    #[serde(default)]
    pub detail: Option<String>,
}

/// `usage_meters`: this month's usage for a workspace, one line per kind
/// of meter, at what it is charged (cost plus the margin, on the account's
/// terms) before the plan's included usage, the trial or g1t's pools paid
/// for any of it. Members only. Returns `Outcome<Vec<MeterUsage>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UsageMetersArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// One kind of meter's usage this month.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterUsage {
    /// `agents` (agent runs, models and sandboxes for checks, workflows
    /// and the merge queue), `builds`, `requests` (app requests and CPU),
    /// `domains`, `git_storage` (git operations and private storage) or
    /// `search_scans` (search embeddings and security scans).
    pub key: String,
    pub label: String,
    /// At price, before what paid for it.
    pub micros: i64,
    /// How much, when it is known: `12 runs`, `41 build minutes`.
    #[serde(default)]
    pub quantity: Option<String>,
}

/// `set_spend_limit`: the owner's own monthly ceiling, under g1t's; None
/// removes it. Owners only. Returns `Outcome<Limit>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSpendLimitArgs {
    pub actor: User,
    pub workspace: String,
    /// A monthly limit, at most what is available; None goes back to the
    /// default.
    pub spend_limit_micros: Option<i64>,
    /// Use everything available, with no limit of their own.
    #[serde(default)]
    pub use_full_limit: bool,
    /// Use the one-time raise: up to twice the highest ceiling the
    /// workspace has had, without asking. Once per workspace.
    #[serde(default, alias = "raiseOnce")]
    pub raise_once: bool,
}

/// One metered unit: what it costs g1t, and what it is sold at. The price
/// is always `cost × (100 + markup) / 100`, so it follows the cost.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    /// `sandbox_second`, `build_second`, `app_requests`, `app_cpu`, `app_month`.
    pub meter: String,
    pub title: String,
    pub unit: String,
    /// Millionths of a dollar per unit; may have a fraction.
    pub cost_micros: f64,
    pub markup_percent: u32,
    pub price_micros: f64,
    /// `list`: Cloudflare's published price. `cloudflare`: what Cloudflare
    /// actually billed g1t, measured.
    pub source: String,
    /// When it was last checked against Cloudflare's bill.
    pub checked_at: Option<String>,
    pub updated_at: String,
}

impl Price {
    pub fn price_for(cost_micros: f64, markup_percent: u32) -> f64 {
        cost_micros * f64::from(100 + markup_percent) / 100.0
    }
}

/// A cost that moved.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceChange {
    pub meter: String,
    pub old_cost_micros: f64,
    pub new_cost_micros: f64,
    pub markup_percent: u32,
    /// The markup before, when the change was to the markup rather than
    /// to the cost. Absent when the markup stayed `markup_percent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_markup_percent: Option<u32>,
    pub reason: String,
    pub created_at: String,
    /// When a change still to come takes effect: a rise is announced
    /// before it is charged. Absent for changes already made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_at: Option<String>,
}

/// `prices`: every metered price and the recent changes. Public. Returns
/// `PriceBook`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceBook {
    pub prices: Vec<Price>,
    pub changes: Vec<PriceChange>,
    /// The margin on model usage, which is charged at what AI Gateway
    /// priced each request at.
    pub model_margin_percent: u32,
    /// Every plan, as it is sold now.
    #[serde(default)]
    pub plans: Vec<Plan>,
    /// What is free, and what pays for it.
    #[serde(default)]
    pub free: Option<FreeTier>,
}

/// What g1t gives without a plan, each with what pays for it: a capped
/// budget, never an open-ended allowance.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeTier {
    /// Each new workspace's trial credit, once.
    pub trial_workspace_micros: i64,
    /// Trial grants each month, in all; new trials wait when it is spent.
    pub trial_monthly_pool_micros: i64,
    /// g1t's open-source pool each month, and any one repository's share.
    pub oss_pool_micros: i64,
    pub oss_repo_micros: i64,
    /// Private repository storage that is free for every workspace. Past
    /// it, the plan pays at cost plus the margin; a free workspace's pushes
    /// to private repositories stop instead.
    pub free_private_storage_bytes: i64,
    /// Days of audit log a free workspace keeps.
    pub audit_retention_days: u32,
    /// Days of audit log the g1t plan keeps, and g1t's own and enterprise
    /// workspaces. Longer is by arrangement, set per account in sudo.
    #[serde(default)]
    pub plan_audit_retention_days: u32,
    /// The smallest amount a card is charged when a month closes; less
    /// carries over. Charges at a limit always go through.
    pub min_charge_micros: i64,
    /// Git operations (clones, fetches and pushes through g1t) that are
    /// free for every workspace each month. Past it, the plan pays at cost
    /// plus the margin and is never slowed; a free workspace is slowed
    /// down, never charged.
    #[serde(default)]
    pub git_operations_included: u64,
    /// A new paid workspace's ceiling in its first month.
    #[serde(default)]
    pub paid_start_ceiling_micros: i64,
    /// The most a one-click goodwill credit can cost g1t.
    #[serde(default)]
    pub overage_forgive_cost_micros: i64,
}

/// Who pays: a billing account. Every workspace has one; by default its
/// own. An enterprise account pays for several workspaces at once, as
/// GitHub Enterprise does: one bill, one limit, one set of terms.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingAccount {
    /// `ws_<slug>` for a workspace's own account; `ent_…` for an enterprise.
    pub id: String,
    pub kind: AccountKind,
    pub name: String,
    pub terms: Terms,
    /// The workspaces it pays for.
    pub workspaces: Vec<String>,
    /// Where an enterprise's invoices go.
    #[serde(default)]
    pub billing_email: Option<String>,
    /// An enterprise's invoices, newest first. Empty for a workspace's own.
    #[serde(default)]
    pub invoices: Vec<EnterpriseInvoice>,
    pub created_at: String,
    /// What g1t staff set for the account beyond its terms.
    #[serde(default)]
    pub allowances: Allowances,
}

/// Set per account by g1t staff in sudo, on top of its terms.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Allowances {
    /// The g1t plan without paying for its monthly price, such as for a
    /// partner. Usage is charged as usual. Comped accounts have it anyway.
    #[serde(default, alias = "team")]
    pub plan: bool,
    /// Each of the account's public repositories' monthly cap on g1t's
    /// open-source pool, in place of `OSS_REPO_MICROS`. None: the default.
    #[serde(default)]
    pub oss_repo_micros: Option<i64>,
    /// The trial credit each of its workspaces gets, in place of
    /// `TRIAL_WORKSPACE_MICROS`, outside the monthly pool. None: the default.
    #[serde(default)]
    pub trial_micros: Option<i64>,
    /// Agents at once, in place of the plan's (2 in the first month or on
    /// the trial, then 10). None: the default.
    #[serde(default)]
    pub max_concurrent_agents: Option<u32>,
    /// One run's spend cap, in place of `RUN_CAP_MICROS` and the owners'
    /// own. None: theirs, or the default.
    #[serde(default)]
    pub run_cap_micros: Option<i64>,
    /// What the agents on one issue may spend in all, in place of
    /// `ISSUE_CAP_MICROS` and the owners' own. None: theirs, or the default.
    #[serde(default)]
    pub issue_cap_micros: Option<i64>,
    /// Days of audit log its workspaces keep, in place of the plan's (7
    /// free, 90 on the plan), longer or shorter. None: the plan's.
    #[serde(default)]
    pub audit_retention_days: Option<u32>,
    /// A hold g1t staff put on new compute, with why. None: no hold.
    #[serde(default)]
    pub hold: Option<String>,
}

/// `admin_set_allowances`: the plan on or off without charge, overrides of
/// the plan's caps, a hold, and the account's share of g1t's pools.
/// Recorded with who and why. Returns `Outcome<BillingAccount>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminSetAllowancesArgs {
    pub id: String,
    pub allowances: Allowances,
    pub note: String,
    pub by: String,
}

// --- Entitlements, and compute started under a reservation -----------------
//
// Every service that starts compute (sandboxes for agents, checks,
// workflows and the merge queue; builds; models; semantic search) asks
// billing first:
//
// 1. `entitlements { workspace }` says what the workspace may do at all:
//    its plan, whether it may start compute, its caps, and whether compute
//    is paused.
// 2. `reserve { workspace, repo, public, kind, estimate_micros }` holds the
//    work's estimated cost against what may pay for it, so that starts at
//    the same moment cannot overshoot the ceiling together. It answers who
//    pays first, or refuses with a stable code and a message for the owner.
// 3. `settle { reservation_id, actual_micros }` releases the hold once the
//    work is done. The charge itself goes on the ledger the usual way
//    (`finish_run`, `record_sandbox`, `charge_feature`, `note_pending`).
//
// A reservation never settled expires after `RESERVATION_HOURS`.

/// A reservation that is never settled stops holding after this long.
pub const RESERVATION_HOURS: u64 = 3;
/// What a ceiling reads as when there is none (g1t's own workspaces): a
/// billion dollars, which JavaScript holds exactly.
pub const UNLIMITED_MICROS: i64 = 1_000_000_000_000_000;

/// What a workspace pays g1t on, as far as compute is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanKind {
    /// No plan: the forge is free; compute only from a trial or g1t's
    /// open-source pool, after a card check.
    Free,
    /// The g1t plan, paid for (or given by g1t staff without its price).
    Paid,
    /// g1t's own workspaces and Flagon's (comped terms): the plan without
    /// being charged. Usage is still recorded at what it cost.
    Internal,
    /// Paid for by an enterprise account, invoiced.
    Enterprise,
}

impl PlanKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanKind::Free => "free",
            PlanKind::Paid => "paid",
            PlanKind::Internal => "internal",
            PlanKind::Enterprise => "enterprise",
        }
    }

    /// Whether usage past what is included may be charged (on demand).
    pub fn on_demand(self) -> bool {
        !matches!(self, PlanKind::Free)
    }
}

/// What compute is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputeKind {
    /// An agent's run: its sandbox and its model.
    Agent,
    /// Checks on a pull request.
    Check,
    /// A workflow job.
    Workflow,
    /// The merge queue's checks.
    Queue,
    /// A deployment's build.
    Deploy,
    /// Semantic search: embeddings in the context hub.
    Embedding,
}

impl ComputeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ComputeKind::Agent => "agent",
            ComputeKind::Check => "check",
            ComputeKind::Workflow => "workflow",
            ComputeKind::Queue => "queue",
            ComputeKind::Deploy => "deploy",
            ComputeKind::Embedding => "embedding",
        }
    }

    /// Whether g1t's open-source pool may pay for it on a public
    /// repository: checks, workflows and the merge queue only.
    pub fn open_source_pool(self) -> bool {
        matches!(self, ComputeKind::Check | ComputeKind::Workflow | ComputeKind::Queue)
    }
}

/// Who pays first for reserved work. What the first source cannot cover
/// falls to the next, in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaidBy {
    /// The plan's included usage this month.
    Credit,
    /// The workspace's one-time trial credit.
    Trial,
    /// g1t's open-source pool.
    Oss,
    /// Charged to the workspace, at cost plus the margin.
    OnDemand,
}

/// `entitlements`: what a workspace may do now, for the services that
/// start compute and the pages that show it. Takes `EntitlementsArgs`;
/// returns `Entitlements`. No viewer: callers decide who sees it.
#[derive(Debug, Serialize, Deserialize)]
pub struct EntitlementsArgs {
    pub workspace: String,
}

/// `audit_retention`: how many days of audit log each workspace keeps, for
/// the events service's daily purge. Takes `AuditRetentionArgs`; returns
/// `Vec<AuditRetention>`, one for each workspace asked about.
#[derive(Debug, Serialize, Deserialize)]
pub struct AuditRetentionArgs {
    pub workspaces: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuditRetention {
    pub workspace: String,
    pub days: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entitlements {
    pub workspace: String,
    pub plan: PlanKind,
    /// May start sandboxes, models, deployments and semantic search at all:
    /// paid, internal and enterprise workspaces, or a free one with trial
    /// credit left. A free workspace may still use the open-source pool
    /// for checks, workflows and the merge queue on public repositories
    /// after a card check; `reserve` decides that per start.
    pub compute: bool,
    /// The one-time trial credit left; 0 if none was granted or it is used.
    pub trial_micros_left: i64,
    /// A card check has been done. The trial and the open-source pool need
    /// it.
    pub trial_verified: bool,
    /// A paid workspace still in its first billing cycle.
    pub first_month: bool,
    /// Agents at once: 2 in the first month or on the trial, 10 after;
    /// staff can override it.
    pub max_concurrent_agents: u32,
    /// The longest one run may take: 60 minutes in the first month or on
    /// the trial; otherwise the guardrails' own caps (`MAX_MINUTES`).
    pub max_run_minutes: u32,
    /// One run's spend cap (`RUN_CAP_MICROS`, $2 by default); staff can
    /// override it.
    pub run_cap_micros: i64,
    /// What agents may spend on one issue in all (`ISSUE_CAP_MICROS`, $10
    /// by default); the owners can set it (`set_caps`), and staff override.
    pub issue_cap_micros: i64,
    /// Where on-demand work stops: g1t's ceiling on usage not yet paid
    /// for. `UNLIMITED_MICROS` for g1t's own workspaces; 0 for a free one,
    /// which has no on-demand usage.
    pub ceiling_micros: i64,
    /// Usage not yet paid for this month, with prepayment taken off.
    pub exposure_micros: i64,
    /// Why new compute is paused, for the owner: the limit is reached, a
    /// spend spike is waiting for an owner to confirm it, or g1t staff put
    /// a hold on it. None when it is not.
    pub paused: Option<String>,
    // What the workspace's plan gives it, for its pages.
    /// What open reservations hold now.
    #[serde(default)]
    pub held_micros: i64,
    /// Paid in advance and not used yet.
    #[serde(default)]
    pub prepaid_micros: i64,
    /// The plan's included usage each month, and what of it is used.
    #[serde(default)]
    pub included_micros: i64,
    #[serde(default)]
    pub included_used_micros: i64,
    /// How far back the audit log can be read and exported, and what is
    /// kept: the plan's days, or what g1t staff set for the account.
    pub audit_retention_days: u32,
    /// Whether `audit_retention_days` is what staff set for the account
    /// rather than the plan's.
    #[serde(default)]
    pub audit_retention_custom: bool,
    /// Private repository storage that is free for every workspace: past
    /// it, the plan pays for it and a free workspace's pushes stop.
    pub free_private_storage_bytes: i64,
    /// The last daily measure of the workspace's private repositories.
    pub private_storage_bytes: i64,
    /// What g1t's open-source pool paid for the workspace this month.
    pub oss_paid_micros: i64,
    /// Deploy build time this month, every second of it metered.
    #[serde(default)]
    pub build_seconds_used: u32,
    /// Git operations this month, and how many are free for every
    /// workspace (past it: metered on the plan, slowed when free).
    #[serde(default)]
    pub git_operations: u64,
    #[serde(default)]
    pub git_operations_included: u64,
    /// The smallest amount a card is charged when a month closes.
    pub min_charge_micros: i64,
    /// A spend spike waiting for an owner, or decided.
    #[serde(default)]
    pub spike: Option<Spike>,
    /// Where usage stands against what is included and the limits, from 50%.
    #[serde(default)]
    pub alerts: Vec<UsageAlert>,
}

/// One level reached: 50, 75, 90 or 100 percent of something.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAlert {
    /// `included` (the plan's included usage), `spend_limit` (the owners'
    /// own limit) or `ceiling` (g1t's, on usage not yet paid for).
    pub meter: String,
    pub level: u32,
    pub used_micros: i64,
    pub limit_micros: i64,
    pub message: String,
}

/// An hour's spend well above the workspace's usual pace: new compute
/// waits until an owner says to keep going.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spike {
    pub id: String,
    /// `open` (waiting for an owner), `continued` (an owner said keep
    /// going) or `stopped` (an owner said stop).
    pub status: String,
    /// The hour's spend when it was found, and the usual hour's.
    pub hour_micros: i64,
    pub average_micros: i64,
    pub detected_at: String,
    #[serde(default)]
    pub decided_by: Option<String>,
    #[serde(default)]
    pub decided_at: Option<String>,
    /// While continued: until when, unless spend doubles again first.
    #[serde(default)]
    pub until: Option<String>,
}

/// `reserve`: holds an estimate of a start's cost before the work starts.
/// Returns `Outcome<Reservation>`, or a failure whose code says why not:
///
/// - `paused`: a spend spike waiting for an owner, or a hold.
/// - `limit`: the spend limit or g1t's ceiling would be passed.
/// - `not_paid`: no plan, and nothing else pays for this kind of work (or
///   no card check yet).
/// - `trial_used`: the one-time trial is spent.
/// - `oss_pool_empty`: the open-source pool, or the repository's share of
///   it, is spent this month.
///
/// The message says exactly what to do, with the page to do it on (such as
/// `/acme/-/billing`).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReserveArgs {
    pub workspace: String,
    pub repo: RepoPath,
    /// Whether the repository is public: the open-source pool pays only for
    /// public repositories' checks, workflows and merge queue.
    pub public: bool,
    pub kind: ComputeKind,
    /// The most the work is expected to cost g1t, before the margin, in
    /// millionths of a dollar (billing adds the margin, as it does to every
    /// charge). For an agent, its model's average plus its sandbox for its
    /// whole time cap.
    #[serde(alias = "estimate_micros")]
    pub estimate_micros: i64,
    /// An agent run on g1t's hosted models (not the workspace's own
    /// provider). Unsaid, an agent run is taken to be one. g1t's daily
    /// spend breaker pauses these when g1t is paying for them.
    #[serde(default, alias = "hosted_model")]
    pub hosted_model: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reservation {
    pub id: String,
    pub paid_by: PaidBy,
    /// What is held, at cost; less than the estimate when a free
    /// workspace's last bit of trial credit is all there is.
    #[serde(default)]
    pub held_micros: i64,
    /// RFC 3339: when the hold lapses if never settled.
    #[serde(default)]
    pub expires_at: String,
}

/// `settle`: releases a reservation's hold with what the work cost. The
/// charge goes on the ledger the usual way. Safe to repeat. Returns
/// `Outcome<bool>`: false if it was settled or had lapsed before.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleArgs {
    #[serde(alias = "reservation_id")]
    pub reservation_id: String,
    /// What the work cost g1t, before the margin.
    #[serde(alias = "actual_micros")]
    pub actual_micros: i64,
}

// --- Card checks, the plan, prepayment -------------------------------------

/// `card_check`: starts Stripe's page to save and verify a card: a setup
/// with 3-D Secure where the card supports it, which the card's bank sees
/// as a $0 or $1 authorization that is never charged. The trial and the
/// open-source pool need it, and it is the card the plan uses. Owners only.
/// Returns `Outcome<Checkout>`; the page's id comes back to `return_url` as
/// `session`, for `confirm_card_check`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardCheckArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(alias = "return_url")]
    pub return_url: String,
}

/// `confirm_card_check`: records the check once Stripe says the card was
/// verified, and grants the trial if the month's pool has room and the card
/// has not had one before. Safe to repeat. Returns `Outcome<Entitlements>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfirmCardCheckArgs {
    pub workspace: String,
    pub viewer: Viewer,
    pub session: String,
}

// --- Limits: raising them, and spikes ---------------------------------------

/// A request to g1t: a higher limit, or help with usage that went past
/// what was meant.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitRequest {
    pub id: String,
    pub workspace: String,
    /// `limit` (raise my limit) or `overage` (spent more than meant to).
    pub kind: String,
    /// The limit asked for; for an overage, what they think went wrong.
    pub amount_micros: i64,
    pub reason: String,
    pub expected_monthly_micros: i64,
    /// `open`, `approved` or `declined`.
    pub status: String,
    /// What was approved, which may differ from what was asked.
    #[serde(default)]
    pub decided_micros: Option<i64>,
    #[serde(default)]
    pub decided_by: Option<String>,
    /// The answer, as the owner sees it.
    #[serde(default)]
    pub answer: Option<String>,
    pub created_by: String,
    pub created_at: String,
    #[serde(default)]
    pub decided_at: Option<String>,
}

/// `request_limit`: an owner asks g1t for more, or for help with usage past
/// what they meant. Answered within one business day, in the app and by
/// email. Owners only. Returns `Outcome<LimitRequest>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLimitArgs {
    pub actor: User,
    pub workspace: String,
    /// `limit` or `overage`.
    pub kind: String,
    #[serde(alias = "amount_micros")]
    pub amount_micros: i64,
    pub reason: String,
    #[serde(default, alias = "expected_monthly_micros")]
    pub expected_monthly_micros: i64,
}

/// `limit_requests`: a workspace's requests, newest first. Members only.
/// Returns `Outcome<Vec<LimitRequest>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct LimitRequestsArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `confirm_spike`: an owner's answer to a spend spike. Keep going lifts the
/// pause for 24 hours, or until the hour's spend doubles again; stop keeps
/// new compute paused until an owner says to keep going. Owners only.
/// Returns `Outcome<Entitlements>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmSpikeArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(alias = "keep_going")]
    pub keep_going: bool,
}

/// `set_caps`: the owners' own caps on agents: one run's spend ($0.10 to
/// $100) and what the agents on one issue may spend in all ($1 to $1,000).
/// None goes back to the default ($2 and $10). A cap g1t staff set for the
/// account wins over both. Owners only. Returns `Outcome<Entitlements>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCapsArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default, alias = "run_cap_micros")]
    pub run_cap_micros: Option<i64>,
    #[serde(default, alias = "issue_cap_micros")]
    pub issue_cap_micros: Option<i64>,
}

/// What staff see beside a request: the workspace's history with g1t.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHistory {
    pub plan: Option<PlanKind>,
    /// The last six months, oldest first.
    pub months: Vec<MonthFigures>,
    /// Live payments that have cleared, and how many.
    pub paid_cleared_micros: i64,
    pub payments: u32,
    pub disputes: u32,
    pub declines: u32,
    /// The first time the workspace appears in billing, RFC 3339.
    pub first_seen: Option<String>,
    pub ceiling_micros: Option<i64>,
    pub max_ceiling_micros: Option<i64>,
    pub spend_limit_micros: Option<i64>,
    /// Recent velocity: the last hour, the usual hour over the last week,
    /// and the last 24 hours, at price.
    pub last_hour_micros: i64,
    pub average_hour_micros: i64,
    pub last_day_micros: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitRequestReview {
    pub request: LimitRequest,
    pub history: WorkspaceHistory,
}

/// `admin_limit_requests`: requests for staff, oldest open first. Returns
/// `Vec<LimitRequestReview>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminLimitRequestsArgs {
    /// `open` (the default), `approved`, `declined` or `all`.
    #[serde(default)]
    pub status: Option<String>,
}

/// `admin_decide_limit_request`: approve (at the amount asked, or
/// `amount_micros`) or decline. The owner is told in the app and by email.
/// Recorded with who and why. Returns `Outcome<LimitRequest>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminDecideLimitRequestArgs {
    pub id: String,
    /// `approve` or `decline`.
    pub decision: String,
    #[serde(default)]
    pub amount_micros: Option<i64>,
    /// What the owner is told, beside the decision.
    #[serde(default)]
    pub note: String,
    pub by: String,
}

/// `admin_record_payment`: money that reached g1t outside the card pages,
/// such as a bank transfer, entered as a payment (it raises the limit like
/// one). Recorded with who and the transfer's reference. Returns
/// `Outcome<LedgerEntry>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminRecordPaymentArgs {
    pub workspace: String,
    pub amount_micros: i64,
    /// The bank's reference for the transfer, or Stripe's payment id.
    pub reference: String,
    pub note: String,
    pub by: String,
}

// --- Overages and goodwill (sudo) --------------------------------------------

/// What a one-time goodwill credit would come to: g1t's margin on the
/// overage, always, plus as much of its underlying cost as the cap allows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goodwill {
    /// This month's charges above the workspace's typical month.
    pub overage_micros: i64,
    /// The part of the overage that is g1t's margin.
    pub margin_micros: i64,
    /// The part that is what g1t paid its providers.
    pub cost_micros: i64,
    /// The one-click credit: the margin plus the cost up to the cap.
    pub credit_micros: i64,
    /// Of the credit, the real cost g1t absorbs.
    pub absorbed_micros: i64,
}

/// A workspace whose month went well past its usual, or hit a spike.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overage {
    pub workspace: String,
    pub plan: PlanKind,
    /// The median of its last three months' charges.
    pub typical_month_micros: i64,
    pub this_month_micros: i64,
    /// What this month cost g1t, and what g1t keeps of it.
    pub cost_micros: i64,
    pub margin_micros: i64,
    /// A spike this month, if there was one.
    pub spike: Option<Spike>,
    /// The runs that cost the most this month.
    pub top_entries: Vec<LedgerEntry>,
    pub goodwill: Goodwill,
    /// False when a goodwill credit was given in the last 12 months.
    pub goodwill_available: bool,
    pub last_goodwill_at: Option<String>,
    /// An open overage request from the owner, if there is one.
    pub request: Option<LimitRequest>,
}

/// `admin_overages`: the Overages queue. Returns `Vec<Overage>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminOveragesArgs {}

/// `admin_goodwill`: credits a workspace for accidental usage. With no
/// amount, the one-click credit (`Goodwill::credit_micros`), once per
/// workspace in 12 months. A larger amount, or a second within 12 months,
/// needs a typed reason. It shows on the statement as "Credit from g1t:
/// accidental usage on <date>". Returns `Outcome<LedgerEntry>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminGoodwillArgs {
    pub workspace: String,
    #[serde(default)]
    pub amount_micros: Option<i64>,
    /// Why, typed by staff; needed past the one-click credit.
    #[serde(default)]
    pub reason: String,
    /// The day the accidental usage happened, `YYYY-MM-DD`; today if absent.
    #[serde(default)]
    pub day: Option<String>,
    pub by: String,
}

/// One workspace's recent pace, for sudo's velocity view.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Velocity {
    pub workspace: String,
    pub plan: PlanKind,
    pub last_hour_micros: i64,
    pub average_hour_micros: i64,
    pub last_day_micros: i64,
    pub this_month_micros: i64,
    /// The last hour over the usual hour; 0 with no history.
    pub ratio: f64,
    pub spike: Option<Spike>,
    pub first_seen: Option<String>,
}

/// `admin_velocity`: workspaces spending in the last day, fastest first.
/// Returns `Vec<Velocity>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminVelocityArgs {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    Workspace,
    Enterprise,
}

/// How an account is charged. Standard unless g1t set otherwise in sudo.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Terms {
    pub kind: TermsKind,
    /// Off every usage charge, in percent. Custom terms only.
    #[serde(default)]
    pub discount_percent: u32,
    /// A ceiling on unpaid usage that replaces the one trust would give.
    #[serde(default)]
    pub ceiling_micros: Option<i64>,
    /// Why, for whoever looks next.
    #[serde(default)]
    pub note: String,
    /// When the terms end and the account goes back to standard.
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub set_by: Option<String>,
    #[serde(default)]
    pub set_at: Option<String>,
}

impl Terms {
    pub fn standard() -> Self {
        Terms {
            kind: TermsKind::Standard,
            discount_percent: 0,
            ceiling_micros: None,
            note: String::new(),
            until: None,
            set_by: None,
            set_at: None,
        }
    }

    /// What a charge becomes under these terms.
    pub fn apply(&self, charge_micros: i64) -> i64 {
        match self.kind {
            TermsKind::Comped => 0,
            TermsKind::Custom => charge_micros * i64::from(100 - self.discount_percent.min(100)) / 100,
            TermsKind::Standard => charge_micros,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TermsKind {
    /// Prices as published, limits by trust.
    Standard,
    /// Nothing charged; usage still recorded with its cost. Paid features
    /// are on without a plan. For g1t's own workspaces, partners, and the
    /// like.
    Comped,
    /// A discount, a ceiling, or both.
    Custom,
}

/// `stripe_webhook`: an event from Stripe, as the API received it: the raw
/// body and its `Stripe-Signature` header. Billing checks the signature
/// against the secret of the endpoint it registered, and handles each
/// event once. Returns `Outcome<bool>`: false for one already handled.
#[derive(Debug, Serialize, Deserialize)]
pub struct StripeWebhookArgs {
    pub payload: String,
    pub signature: String,
}

/// `admin_stripe`: where billing stands with Stripe. Staff only. Returns
/// `StripeStatus`. With `fix: true`, first enables the destination at
/// billing's address and gives it the events billing needs.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminStripeArgs {
    #[serde(default)]
    pub fix: bool,
    #[serde(default)]
    pub by: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StripeStatus {
    /// `test` or `live`, from the key; `off` without one.
    pub mode: String,
    /// Whether `STRIPE_WEBHOOK_SECRET` is set, so events can be checked.
    pub secret_set: bool,
    /// The destination at billing's address in Stripe, as Stripe has it.
    pub webhook: Option<StripeWebhook>,
    /// Events billing handles that the destination does not send.
    pub missing_events: Vec<String>,
    /// The latest events handled, newest first.
    pub recent_events: Vec<StripeEventSummary>,
    /// What went wrong reading or fixing the destination, if it did.
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StripeWebhook {
    pub url: String,
    pub endpoint_id: String,
    /// `enabled` or `disabled`.
    pub status: String,
    pub events: Vec<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StripeEventSummary {
    pub id: String,
    pub kind: String,
    pub outcome: String,
    pub received_at: String,
}

/// `admin_enterprise_billing`: where an enterprise's invoices go. Creates
/// or updates its Stripe customer. Returns `Outcome<BillingAccount>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminEnterpriseBillingArgs {
    pub id: String,
    pub email: String,
    pub by: String,
}

/// `admin_invoice_enterprise`: sends an enterprise its invoice now, for
/// what its workspaces owe, rather than waiting for the month to close.
/// Returns `Outcome<EnterpriseInvoice>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminInvoiceEnterpriseArgs {
    pub id: String,
    pub by: String,
}

/// An enterprise's invoice: one line per workspace, paid on Stripe.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnterpriseInvoice {
    pub invoice_id: String,
    /// Stripe's page for it, where it is paid.
    pub hosted_url: Option<String>,
    pub amount_micros: i64,
    /// `open`, `paid`, `overdue` or `void`.
    pub status: String,
    pub period: String,
    pub lines: Vec<InvoiceLine>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceLine {
    pub workspace: String,
    pub amount_micros: i64,
}

/// A workspace's invoice from g1t: one per month, and one each time it is
/// charged near its limit. Itemised, charged to the card on file, and kept
/// in Stripe's billing page with its PDF.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInvoice {
    pub invoice_id: String,
    pub workspace: String,
    /// `month` (2026-10) or `threshold`.
    pub reason: String,
    pub period: String,
    pub amount_micros: i64,
    /// `paid`, `open`, `failed` or `void`.
    pub status: String,
    pub hosted_url: Option<String>,
    pub pdf_url: Option<String>,
    pub lines: Vec<InvoiceItem>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceItem {
    pub description: String,
    pub amount_micros: i64,
}

/// `invoices`: a workspace's invoices from g1t, newest first. Members
/// only. Returns `Outcome<Vec<WorkspaceInvoice>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct InvoicesArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `admin_workspace_invoices`: the same, for staff. Returns
/// `Vec<WorkspaceInvoice>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminWorkspaceInvoicesArgs {
    pub workspace: String,
}

/// `statement`: a month of a workspace's ledger, grouped by day (or by
/// project) with a line per kind of charge. Members only. Returns
/// `Outcome<Statement>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StatementArgs {
    pub workspace: String,
    pub viewer: Viewer,
    /// YYYY-MM; this month when absent.
    #[serde(default)]
    pub month: Option<String>,
    /// `day` (the default) or `project`.
    #[serde(default)]
    pub group: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    pub month: String,
    /// Months with any entries, newest first.
    pub months: Vec<String>,
    pub groups: Vec<StatementGroup>,
    pub totals: StatementTotals,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementGroup {
    /// The day (YYYY-MM-DD) or the project (`owner/name`, or empty).
    pub key: String,
    pub label: String,
    pub lines: Vec<StatementLine>,
    /// What the group's charges come to.
    pub charged_micros: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementLine {
    /// Agent runs, Sandbox time, Deployments, Payments, Credits from g1t,
    /// Refunds, and, for older entries, Runs on your own model provider.
    pub kind: String,
    pub count: u32,
    /// Charges positive; money in (payments, credits) negative.
    pub charged_micros: i64,
    pub cost_micros: i64,
    /// Of the usage on the line, what was paid for before it was charged:
    /// by the plan's included usage, the trial credit, g1t's open-source
    /// pool, or g1t itself. Not in `charged_micros`.
    #[serde(default)]
    pub covered_micros: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementTotals {
    pub charged_micros: i64,
    pub paid_micros: i64,
    pub cost_micros: i64,
    pub entries: u32,
    /// What paid for usage before it was charged, one line per source,
    /// such as "Paid by g1t's open-source pool".
    #[serde(default)]
    pub covered: Vec<Covered>,
    /// Owed when the month closed but under the minimum charge, so it
    /// carries over to the next invoice. Zero when nothing carried.
    #[serde(default)]
    pub carried_micros: i64,
}

/// One source that paid for usage before it was charged.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Covered {
    /// `included`, `trial`, `oss_pool` or `given`.
    pub source: String,
    /// "Paid by your plan's included usage", "Paid by your trial credit",
    /// "Paid by g1t's open-source pool", "Covered by g1t".
    pub label: String,
    pub micros: i64,
}

/// `statement_entries`: one statement line's entries, newest first, 50 at
/// a time (`before` = the last id seen). Returns `Outcome<Vec<LedgerEntry>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StatementEntriesArgs {
    pub workspace: String,
    pub viewer: Viewer,
    pub month: String,
    pub kind: String,
    #[serde(default)]
    pub day: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
}

// --- Sales (sudo.g1t.sh) ------------------------------------------------------
//
// What staff need to know to reach out: who is growing, who is close to
// their limit, who was declined, who has become a steady customer. And what
// was done about it: a stage, an owner on g1t's side, a next step, notes.

/// Why a workspace is worth a look.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalKind {
    /// At its limit, or its own spend limit: work is stopped.
    AtLimit,
    /// Past 80% of what is available to it: about to need more.
    NearCeiling,
    /// Its card was declined or a payment disputed.
    Declined,
    /// This month is well ahead of last month.
    Growing,
    /// Became Established: the ceiling now follows its spend.
    Established,
    /// Paid g1t for the first time.
    FirstPayment,
    /// Spending enough that custom terms or an enterprise may suit it.
    HighSpend,
    /// Costs g1t more on Cloudflare than it pays, over 30 days: a pricing
    /// gap or abuse to look at (billing's `margin`).
    CostOverRevenue,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub workspace: String,
    pub kind: SignalKind,
    /// One sentence, with the figures.
    pub detail: String,
    /// The figure that matters, such as this month's spend.
    pub value_micros: i64,
    /// Its sales stage, if staff gave it one.
    pub stage: Option<String>,
    pub owner: Option<String>,
    #[serde(default)]
    pub next_step: Option<String>,
    /// When the next step is due, `YYYY-MM-DD`.
    #[serde(default)]
    pub next_at: Option<String>,
}

/// `admin_invoices`: every invoice g1t has sent, workspaces' and
/// enterprises', newest first. Returns `Vec<InvoiceSummary>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminInvoicesArgs {
    /// `paid`, `open`, `failed`, `overdue` or `void`.
    #[serde(default)]
    pub status: Option<String>,
    /// YYYY-MM, by when it was sent.
    #[serde(default)]
    pub month: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceSummary {
    pub invoice_id: String,
    /// `workspace` or `enterprise`.
    pub kind: String,
    /// The workspace's slug, or the enterprise's account id.
    pub account: String,
    /// What to call it: the workspace, or the enterprise's name.
    pub name: String,
    pub reason: String,
    pub period: String,
    pub amount_micros: i64,
    pub status: String,
    pub hosted_url: Option<String>,
    pub created_at: String,
    pub paid_at: Option<String>,
}

/// `admin_audit`: every change made in sudo, and by Stripe, newest first.
/// Returns `Vec<AdminAction>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminAuditArgs {
    #[serde(default)]
    pub by: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    /// Only those before this time, for paging.
    #[serde(default)]
    pub before: Option<String>,
}

/// `admin_signals`: every workspace worth reaching out to, most urgent
/// first. Returns `Vec<Signal>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminSignalsArgs {}

/// What staff are doing about a workspace.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesRecord {
    pub workspace: String,
    /// `none`, `lead`, `contacted`, `negotiating`, `won`, `lost` or `churn_risk`.
    pub stage: String,
    /// The staff member looking after it.
    pub owner: Option<String>,
    pub next_step: Option<String>,
    /// RFC 3339 date.
    pub next_at: Option<String>,
    pub notes: Vec<SalesNote>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesNote {
    pub id: String,
    pub text: String,
    pub by: String,
    pub created_at: String,
}

/// `admin_sales`: a workspace's sales record. Returns `SalesRecord`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminSalesArgs {
    pub workspace: String,
}

/// `admin_set_sales`: its stage, owner and next step. Returns `Outcome<SalesRecord>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminSetSalesArgs {
    pub workspace: String,
    pub stage: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub next_step: Option<String>,
    #[serde(default)]
    pub next_at: Option<String>,
    pub by: String,
}

/// `admin_add_note`. Returns `Outcome<SalesRecord>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminAddNoteArgs {
    pub workspace: String,
    pub text: String,
    pub by: String,
}

/// `admin_overview`: the business at a glance. Returns `Overview`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminOverviewArgs {}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// YYYY-MM.
    pub month: String,
    /// The last six months, oldest first, all workspaces together.
    pub months: Vec<MonthFigures>,
    /// This month by kind of usage: models, sandbox, deployments, plans.
    pub by_kind: Vec<KindFigures>,
    pub paying_workspaces: u32,
    pub stopped: u32,
    pub near_ceiling: u32,
    pub declined: u32,
    /// Sent and not yet paid, workspaces and enterprises.
    pub open_invoices_micros: i64,
    /// Follow-ups due today or earlier.
    pub follow_ups_due: u32,
    /// The capped budgets g1t pays from, this month.
    #[serde(default)]
    pub pools: Option<Pools>,
    /// This month's revenue: usage charged plus the plan's price paid.
    #[serde(default)]
    pub revenue_micros: i64,
    /// Workspaces on the paid plan now, and what their price comes to a
    /// month.
    #[serde(default)]
    pub active_plans: u32,
    #[serde(default)]
    pub plan_mrr_micros: i64,
    /// What g1t gave this month, by source, apart from its margin.
    #[serde(default)]
    pub given: Vec<GivenFigures>,
    /// g1t's own and Flagon's workspaces this month: what their use cost,
    /// and why they are not charged.
    #[serde(default)]
    pub internal: Vec<InternalUse>,
    /// Open limit requests, and workspaces in the Overages queue.
    #[serde(default)]
    pub open_requests: u32,
    #[serde(default)]
    pub overages: u32,
    /// Spend spikes waiting for an owner.
    #[serde(default)]
    pub open_spikes: u32,
}

/// What g1t gave this month from one source.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GivenFigures {
    /// `internal`, `trial`, `oss_pool`, `goodwill` or `covered`.
    pub source: String,
    pub label: String,
    /// At price, and what it cost g1t.
    pub micros: i64,
    pub cost_micros: i64,
}

/// One internal workspace's use this month.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalUse {
    pub workspace: String,
    /// Why it is not charged: its terms' note.
    pub reason: String,
    pub cost_micros: i64,
    pub entries: u32,
}

/// g1t's capped budgets for free usage, this calendar month (UTC).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pools {
    /// YYYY-MM.
    pub month: String,
    /// Trial grants made this month, against the month's pool.
    pub trial_granted_micros: i64,
    pub trial_pool_micros: i64,
    pub trial_grants: u32,
    /// What the open-source pool paid this month, against its cap.
    pub oss_used_micros: i64,
    pub oss_pool_micros: i64,
    /// Each public repository's monthly cap on the pool.
    pub oss_repo_micros: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindFigures {
    pub kind: String,
    pub charged_micros: i64,
    pub cost_micros: i64,
}

// --- Staff (sudo.g1t.sh) ------------------------------------------------------
//
// Called only by the sudo app, which only g1t staff can reach (behind
// Cloudflare Access). Each change names who made it, and is kept in the
// audit log.

/// `admin_accounts`: every billing account, with where each stands this
/// month. Returns `Vec<AccountSummary>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminAccountsArgs {
    #[serde(default)]
    pub query: Option<String>,
    /// Exactly these workspaces' accounts, such as one page of sudo's
    /// list; every account with activity when absent.
    #[serde(default)]
    pub workspaces: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub account: BillingAccount,
    pub limit: Limit,
    /// Charged this month, after terms.
    pub charged_micros: i64,
    /// What this month's usage cost g1t.
    pub cost_micros: i64,
    /// Paid, ever.
    pub paid_micros: i64,
    /// The same figures for each of the account's workspaces that has
    /// any, so staff can see what one member of an enterprise used.
    #[serde(default)]
    pub by_workspace: Vec<WorkspaceFigures>,
    /// The last six months, oldest first, for trends.
    #[serde(default)]
    pub months: Vec<MonthFigures>,
}

/// One month of an account's billing.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthFigures {
    /// YYYY-MM.
    pub month: String,
    /// Usage charged, after what paid for it first.
    pub charged_micros: i64,
    /// What usage cost g1t: only what g1t paid for, never a workspace's own
    /// model provider.
    pub cost_micros: i64,
    pub paid_micros: i64,
    /// The plan's monthly price, paid.
    #[serde(default)]
    pub plans_micros: i64,
    /// What g1t gave, at price: internal (comped) use, trials, the
    /// open-source pool, goodwill credits and what g1t covered. Not margin.
    #[serde(default)]
    pub given_micros: i64,
}

/// One workspace's share of an [`AccountSummary`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFigures {
    pub workspace: String,
    pub charged_micros: i64,
    pub cost_micros: i64,
    pub paid_micros: i64,
}

/// `admin_account`: one account in full. Returns `Outcome<AccountDetail>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminAccountArgs {
    /// An account id, or a workspace slug.
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDetail {
    pub summary: AccountSummary,
    /// Each workspace's limit, for an enterprise.
    pub workspaces: Vec<Limit>,
    pub ledger: Vec<LedgerEntry>,
    pub audit: Vec<AdminAction>,
}

/// `admin_set_terms`. Returns `Outcome<BillingAccount>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminSetTermsArgs {
    pub id: String,
    pub terms: Terms,
    pub by: String,
}

/// `admin_create_enterprise`. Returns `Outcome<BillingAccount>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminCreateEnterpriseArgs {
    pub name: String,
    pub workspaces: Vec<String>,
    pub by: String,
}

/// `admin_attach`: moves a workspace onto an enterprise account, or back
/// onto its own with `account: None`. Returns `Outcome<BillingAccount>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminAttachArgs {
    pub workspace: String,
    pub account: Option<String>,
    pub by: String,
}

/// `admin_credit`: money g1t gives a workspace, such as a refund or a
/// goodwill credit. Returns `Outcome<LedgerEntry>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminCreditArgs {
    pub workspace: String,
    pub amount_micros: i64,
    pub note: String,
    pub by: String,
}

/// One change made in sudo.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminAction {
    pub id: String,
    pub account: String,
    pub action: String,
    pub detail: String,
    pub by: String,
    pub created_at: String,
}

/// What a feature's plan costs and includes.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub feature: Feature,
    pub title: String,
    /// Charged every month while the plan is on, in cents.
    pub monthly_cents: u32,
    /// What the monthly price includes, one line each, for people to read.
    pub includes: Vec<String>,
    /// How usage past the allowance is charged, for people to read.
    pub overage: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionStatus {
    /// Paid up; the feature works.
    Active,
    /// Paid up to the end of the period, and ends then.
    Canceling,
    /// The last payment failed; the feature is off until it is paid.
    PastDue,
    /// Ended.
    Canceled,
}

impl SubscriptionStatus {
    /// Whether the feature works in this state.
    pub fn on(self) -> bool {
        matches!(self, SubscriptionStatus::Active | SubscriptionStatus::Canceling)
    }
}

/// A workspace's plan for one feature.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub feature: Feature,
    pub status: SubscriptionStatus,
    /// RFC 3339: when the period paid for ends, and the plan renews or
    /// ends.
    pub period_end: Option<String>,
    /// Username of whoever turned it on.
    pub started_by: String,
    /// RFC 3339.
    pub started_at: String,
}

/// A feature as a workspace sees it: what it costs, and its plan if it has
/// one.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureState {
    pub plan: Plan,
    pub subscription: Option<Subscription>,
    /// Whether the feature works for the workspace now.
    pub on: bool,
    /// On without a plan: comped terms, or given by g1t. Nothing to pay
    /// and nothing to turn off.
    #[serde(default)]
    pub included: bool,
}

/// `features`: every paid feature and the workspace's plan for each.
/// Members only. Returns `Outcome<Vec<FeatureState>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct FeaturesArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `subscribe`: starts the card page for a feature's monthly plan. Owners
/// only. Returns `Outcome<Checkout>`; the page's id comes back to
/// `return_url` as `session`, for `confirm_subscription`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeArgs {
    pub actor: User,
    pub workspace: String,
    pub feature: Feature,
    pub return_url: String,
}

/// `confirm_subscription`: turns the feature on once the processor says
/// the plan was paid for. Safe to call any number of times. Returns
/// `Outcome<FeatureState>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfirmSubscriptionArgs {
    pub workspace: String,
    pub viewer: Viewer,
    pub session: String,
}

/// `close_workspace`: settles a workspace that is about to be deleted.
/// Owners only. Refused while it has an invoice that failed, while it
/// holds prepaid credit, or while it owes money it cannot be charged for
/// now; otherwise what it owes is invoiced to its card at once (no
/// minimum), its plan is cancelled at Stripe straight away, and its
/// account is marked closed, so the month-end close, autopay and limit
/// warnings pass it by. Its ledger, invoices and statements stay. With
/// `dry_run`, only says whether it could, changing nothing. Returns
/// `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseWorkspaceArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default)]
    pub dry_run: bool,
}

/// `cancel_subscription` (`resume` false) ends a plan at the end of the
/// period paid for; with `resume` true, takes that back. Owners only.
/// Returns `Outcome<FeatureState>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CancelSubscriptionArgs {
    pub actor: User,
    pub workspace: String,
    pub feature: Feature,
    #[serde(default)]
    pub resume: bool,
}

/// `has_feature`: whether a feature works for a workspace now, asked by the
/// service that provides it before doing paid work. Returns
/// `Outcome<bool>`: a failure, with the reason to show, when it does not.
/// True everywhere when no card processor is configured.
#[derive(Debug, Serialize, Deserialize)]
pub struct HasFeatureArgs {
    pub workspace: String,
    pub feature: Feature,
}

/// `charge_feature`: usage of a feature past its plan's allowance, charged
/// from the workspace's credit at cost plus the margin, whatever
/// `FREE_WHILE_BUILDING` says. Called by the service that provides it.
/// Charged once per `reference`. Returns `Outcome<bool>`: false if that
/// reference was charged before.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChargeFeatureArgs {
    pub workspace: String,
    pub feature: Feature,
    /// What it cost g1t, in millionths of a dollar, before the margin.
    pub cost_micros: i64,
    pub description: String,
    /// `namespace/name`, when the usage was one repository's.
    pub repo: Option<String>,
    /// Unique to this charge, e.g. `deployments/acme/2026-10`.
    pub reference: String,
    /// For a build: how long it ran. The plan's included build time this
    /// month pays for what it can, and only the rest of `cost_micros` is
    /// charged.
    #[serde(default)]
    pub build_seconds: Option<u32>,
}

// ---------------------------------------------------------------------
// Costs and margin: what Cloudflare charges g1t against what g1t
// charges (billing's costs.rs, margin.rs and pricing.rs). Staff only.
// ---------------------------------------------------------------------

/// `admin_costs`: the Costs & margin page. Returns `CostsReport`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminCostsArgs {
    /// How many days back, 7 to 90; 30 when absent.
    #[serde(default)]
    pub days: Option<u32>,
}

/// One of g1t's products on one day.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostDay {
    pub day: String,
    pub bucket: String,
    /// What Cloudflare charged g1t.
    pub cf_cost_micros: i64,
    /// What g1t's meters recorded it cost, at the price book's cost.
    pub own_cost_micros: i64,
    /// What customers were charged for it at price, before included
    /// usage, trials and pools paid for some.
    pub value_micros: i64,
    /// Of that, what workspaces paid.
    pub cash_micros: i64,
}

/// One product over the range.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductMargin {
    pub bucket: String,
    pub title: String,
    /// The cost the margin is taken from: Cloudflare's bill, or g1t's own
    /// figure for what Cloudflare does not bill (models).
    pub cost_micros: i64,
    pub cf_cost_micros: i64,
    pub own_cost_micros: i64,
    pub value_micros: i64,
    pub margin_micros: i64,
    pub margin_percent: Option<f64>,
    /// `cloudflare` or `ledger`.
    pub cost_source: String,
    /// Running g1t itself, paid for by the plan.
    pub overhead: bool,
}

/// All of g1t over the range: money in against every cost.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverallMargin {
    /// What workspaces paid for usage, and for the plan.
    pub usage_micros: i64,
    pub plans_micros: i64,
    pub cost_micros: i64,
    pub margin_micros: i64,
    pub margin_percent: Option<f64>,
}

/// A count, cost or leak that does not add up.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostDrift {
    pub bucket: String,
    pub title: String,
    /// `count` (units g1t counted against Cloudflare's), `cost` (the bill
    /// against the price book's cost of the same usage), or `leak`.
    pub kind: String,
    pub ours: f64,
    pub cloudflare: f64,
    pub delta_percent: Option<f64>,
    pub detail: String,
    pub found_at: String,
}

/// A margin alert, open while its condition lasts.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginAlert {
    pub id: String,
    /// `margin`, `overall`, `leak`, `drift` or `workspace`.
    pub kind: String,
    /// The product, or the workspace.
    pub subject: String,
    pub detail: String,
    pub since: String,
    pub opened_at: String,
    pub emailed_at: Option<String>,
}

/// A change to a price the reconciler measured.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceProposal {
    pub id: String,
    pub meter: String,
    pub title: String,
    pub unit: String,
    pub current_cost_micros: f64,
    pub proposed_cost_micros: f64,
    pub change_percent: f64,
    pub markup_percent: u32,
    pub reason: String,
    /// `keeper` or `reconciler`.
    pub source: String,
    /// Far off the current cost: look before approving.
    pub suspect: bool,
    /// `open`, `applied`, `approved`, `rejected` or `superseded`.
    pub status: String,
    pub created_at: String,
    pub decided_at: Option<String>,
    pub decided_by: Option<String>,
    pub note: Option<String>,
    /// When it takes or took effect, once approved or applied.
    pub effective_at: Option<String>,
}

/// One version of one meter's price. Never changed once written.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceVersion {
    pub id: String,
    pub meter: String,
    pub version: u32,
    pub cost_micros: f64,
    pub markup_percent: u32,
    pub price_micros: f64,
    pub effective_at: String,
    pub reason: String,
    pub created_by: String,
    /// When the price book took it on; absent while it waits for its date.
    pub applied_at: Option<String>,
}

/// What a workspace cost g1t over the range, Cloudflare's costs shared
/// out by g1t's own meters, against what it paid.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCost {
    pub workspace: String,
    pub cost_micros: i64,
    pub revenue_micros: i64,
    /// One of g1t's own (comped) workspaces.
    pub internal: bool,
}

/// One Cloudflare meter over the range, and the product it is a cost of.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostLineSummary {
    pub product: String,
    pub meter: String,
    pub raw_name: String,
    pub unit: String,
    pub source: String,
    pub quantity: f64,
    pub cost_micros: i64,
    /// Absent when no mapping claims it.
    pub bucket: Option<String>,
}

/// A row of the mapping from Cloudflare's meters to g1t's products.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostMapping {
    pub product: String,
    pub meter: String,
    pub bucket: String,
    pub price_meter: Option<String>,
    pub own_meter: Option<String>,
    pub scale_to_own: bool,
    pub drift_percent: f64,
    pub note: String,
    pub updated_at: String,
    pub updated_by: String,
}

/// The guardrails on prices and the alerts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSettings {
    /// Apply small moves without staff.
    pub auto_apply: bool,
    /// The largest move applied without staff, either way, in percent.
    pub auto_apply_percent: f64,
    /// Days between telling customers of a rise and charging it.
    pub notice_days: u32,
    /// Below this margin, in percent, for `alert_days` days in a row, alert.
    pub margin_floor_percent: f64,
    pub alert_days: u32,
    /// Days with less cost than this say nothing about a margin.
    pub min_daily_cost_micros: i64,
    /// A workspace costing more than its revenue times this, over 30 days,
    /// and at least `anomaly_floor_micros`, is flagged.
    pub anomaly_factor: f64,
    pub anomaly_floor_micros: i64,
}

impl Default for CostSettings {
    fn default() -> Self {
        CostSettings {
            auto_apply: true,
            auto_apply_percent: 25.0,
            notice_days: 14,
            margin_floor_percent: 10.0,
            alert_days: 3,
            min_daily_cost_micros: 100_000,
            anomaly_factor: 1.0,
            anomaly_floor_micros: 1_000_000,
        }
    }
}

/// The Costs & margin page.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostsReport {
    /// A token to read Cloudflare's bill is set.
    pub configured: bool,
    /// When Cloudflare's bill was last read.
    pub fetched_at: Option<String>,
    /// The days shown, YYYY-MM-DD.
    pub since: String,
    pub until: String,
    pub days: Vec<CostDay>,
    pub products: Vec<ProductMargin>,
    pub overall: OverallMargin,
    pub drift: Vec<CostDrift>,
    pub alerts: Vec<MarginAlert>,
    pub proposals: Vec<PriceProposal>,
    pub versions: Vec<PriceVersion>,
    pub top_workspaces: Vec<WorkspaceCost>,
    pub lines: Vec<CostLineSummary>,
    pub mappings: Vec<CostMapping>,
    pub settings: CostSettings,
    /// g1t's own spend against its two caps.
    #[serde(default)]
    pub caps: SpendCaps,
}

/// What g1t itself pays for, against its caps (billing's `budget`): the
/// daily breaker on all of it, and each comped account's monthly budget.
/// At cost, never at price. What sudo's Costs page and its red bar show.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendCaps {
    /// Today (UTC), YYYY-MM-DD, and this month, YYYY-MM.
    pub day: String,
    pub month: String,
    /// What g1t paid for itself today across every workspace: comped work,
    /// the trial and open-source pools, free workspaces' overruns, and
    /// anything charged without real money behind it.
    pub today_micros: i64,
    /// `PLATFORM_DAILY_SPEND_CAP_MICROS`. Zero: no breaker.
    pub daily_cap_micros: i64,
    /// The breaker is open: new hosted-model agent runs that g1t would pay
    /// for wait until tomorrow (UTC) or until staff lift it.
    pub tripped: bool,
    pub tripped_at: Option<String>,
    /// Staff lifted it for the rest of the day.
    pub lifted_by: Option<String>,
    pub lifted_at: Option<String>,
    pub lift_note: Option<String>,
    /// This month so far, by what paid: `comped`, `trial`, `oss`, `given`,
    /// `unpaid`.
    pub month_buckets: Vec<SpendBucket>,
    /// Each comped account's monthly budget.
    pub comped: Vec<CompedBudget>,
    /// Free workspaces' share of this month's reconciled costs (git,
    /// storage, platform), through yesterday.
    pub free_tier_micros: i64,
    /// `CLOUDFLARE_FIXED_MONTHLY_MICROS`: Cloudflare subscriptions, an estimate.
    pub fixed_monthly_micros: i64,
    /// Money in this month, through the last reconciled day.
    pub revenue_micros: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendBucket {
    pub bucket: String,
    pub title: String,
    pub micros: i64,
}

/// A comped account's monthly budget: what its work cost g1t this month.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompedBudget {
    pub account: String,
    pub name: String,
    pub used_micros: i64,
    /// Zero: no budget.
    pub ceiling_micros: i64,
    /// The ceiling is `COMPED_MONTHLY_CEILING_MICROS`, not the account's own.
    pub default_ceiling: bool,
    /// 50, 75, 90, 100, or 0.
    pub level: u32,
}

/// `admin_spend_caps`: g1t's own spend against its caps. Returns `SpendCaps`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminSpendCapsArgs {}

/// `admin_lift_breaker`: lets hosted-model runs start again for the rest
/// of today (UTC), with why. Recorded in the audit log. Returns
/// `Outcome<SpendCaps>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminLiftBreakerArgs {
    pub note: String,
    pub by: String,
}

/// `admin_cost_alerts`: the open margin alerts, for sudo's banner.
/// Returns `Vec<MarginAlert>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminCostAlertsArgs {}

/// `admin_decide_proposal`: approve or reject a price proposal. An
/// approved rise takes effect after the notice period. Returns
/// `Outcome<PriceProposal>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminDecideProposalArgs {
    pub id: String,
    /// `approve` or `reject`.
    pub decision: String,
    #[serde(default)]
    pub note: String,
    pub by: String,
}

/// `admin_set_cost_settings`. Returns `Outcome<CostSettings>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminSetCostSettingsArgs {
    pub settings: CostSettings,
    pub by: String,
}

/// `admin_set_cost_mapping`: adds, changes or (with `remove`) removes a
/// mapping row. Returns `Outcome<CostMapping>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminSetCostMappingArgs {
    pub product: String,
    pub meter: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default)]
    pub price_meter: Option<String>,
    #[serde(default)]
    pub own_meter: Option<String>,
    #[serde(default)]
    pub scale_to_own: bool,
    #[serde(default)]
    pub drift_percent: Option<f64>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub remove: bool,
    pub by: String,
}

/// `admin_run_costs`: reads Cloudflare's bill and reconciles now, as the
/// daily run does. Returns `Outcome<CostsRun>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminRunCostsArgs {
    #[serde(default)]
    pub by: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostsRun {
    pub lines: u32,
    pub days: u32,
    pub proposals: u32,
    pub alerts: u32,
    /// What could not be read, in words.
    pub problems: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_account_carries_no_run_fee() {
        let account = Account {
            workspace: "acme".into(),
            balance_micros: 0,
            status: Status { enabled: true, live: false, free: false },
            margin_percent: 20,
            card: None,
        };
        let json = serde_json::to_value(account).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["balanceMicros", "card", "marginPercent", "status", "workspace"]);
    }

    #[test]
    fn a_price_change_says_when_the_markup_moved() {
        let change = PriceChange {
            meter: "sandbox_second".into(),
            old_cost_micros: 21.0,
            new_cost_micros: 21.0,
            markup_percent: 20,
            old_markup_percent: Some(138),
            reason: "Sandbox time is now charged at cost plus 20% from the first second".into(),
            created_at: "2026-10-05T00:00:00Z".into(),
            effective_at: None,
        };
        assert_eq!(serde_json::to_value(&change).unwrap()["oldMarkupPercent"], 138);
        let cost_only = PriceChange { old_markup_percent: None, ..change };
        assert!(serde_json::to_value(&cost_only).unwrap().get("oldMarkupPercent").is_none());
    }

    #[test]
    fn features_are_named_as_the_site_sends_them() {
        assert_eq!(
            serde_json::to_value(Feature::Deployments).unwrap(),
            serde_json::json!("deployments")
        );
        assert_eq!(Feature::parse("deployments"), Some(Feature::Deployments));
        assert_eq!(serde_json::to_value(Feature::Plan).unwrap(), serde_json::json!("plan"));
        assert_eq!(Feature::parse("plan"), Some(Feature::Plan));
        // Older readers named the plan Team.
        assert_eq!(Feature::parse("team"), Some(Feature::Plan));
        assert_eq!(serde_json::from_value::<Feature>(serde_json::json!("team")).unwrap(), Feature::Plan);
        assert_eq!(Feature::ALL, [Feature::Plan]);
        assert!(SubscriptionStatus::Canceling.on());
        assert!(!SubscriptionStatus::PastDue.on());
    }

    #[test]
    fn a_reservation_is_asked_for_and_answered_in_camel_case() {
        let asked: ReserveArgs = serde_json::from_value(serde_json::json!({
            "workspace": "acme",
            "repo": { "namespace": "acme", "name": "web" },
            "public": true,
            "kind": "check",
            "estimateMicros": 2_000_000,
        }))
        .unwrap();
        assert_eq!(asked.kind, ComputeKind::Check);
        assert!(asked.kind.open_source_pool());
        assert!(!ComputeKind::Agent.open_source_pool());
        // Rust callers that write snake_case are read too.
        let snake: ReserveArgs = serde_json::from_value(serde_json::json!({
            "workspace": "acme",
            "repo": { "namespace": "acme", "name": "web" },
            "public": false,
            "kind": "agent",
            "estimate_micros": 1,
        }))
        .unwrap();
        assert_eq!(snake.estimate_micros, 1);
        let answer = Reservation { id: "rsv_1".into(), paid_by: PaidBy::OnDemand, held_micros: 5, expires_at: String::new() };
        assert_eq!(serde_json::to_value(&answer).unwrap()["paidBy"], "on_demand");
        assert_eq!(serde_json::to_value(PlanKind::Internal).unwrap(), "internal");
        assert!(!PlanKind::Free.on_demand() && PlanKind::Enterprise.on_demand());
    }

    #[test]
    fn a_refusal_carries_its_own_code() {
        let refused: crate::Outcome<Reservation> =
            crate::Outcome::fail(crate::FailureCode::OssPoolEmpty, "The open-source pool is spent.");
        let json = serde_json::to_value(&refused).unwrap();
        assert_eq!(json["error"]["code"], "oss_pool_empty");
        assert_eq!(crate::FailureCode::NotPaid.http_status(), 402);
        assert_eq!(crate::FailureCode::Paused.http_status(), 409);
    }

    #[test]
    fn who_pays_is_read_as_the_runner_sends_it() {
        let run: StartRunArgs = serde_json::from_value(serde_json::json!({
            "workspace": "acme",
            "repo": { "namespace": "acme", "name": "web" },
            "number": 7,
            "task": "implement",
            "model": "Claude Sonnet 5.5",
            "billedTo": "workspace",
        }))
        .unwrap();
        assert_eq!(run.billed_to, "workspace");
    }
}
