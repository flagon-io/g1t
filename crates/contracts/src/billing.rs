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

/// `trial`: the free allowance on g1t's hosted models for a workspace that
/// is not otherwise open to them, so people can try g1t's agents without a
/// key of their own. Each workspace gets a few dollars of model cost, out
/// of one pool, until an end date. Returns `Trial`.
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
    /// Whether its agents may use g1t's hosted models on the allowance now.
    pub open: bool,
    /// What its runs on g1t's models have cost, in millionths of a dollar.
    pub used_micros: i64,
    pub limit_micros: i64,
    /// RFC 3339; when the allowance ends for everyone.
    pub ends_at: Option<String>,
    /// Why it is closed: `off` (no allowance), `ended`, `used` (this
    /// workspace's is spent) or `pool` (everyone's is).
    pub reason: Option<String>,
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
    /// What a run on the workspace's own model provider is charged: g1t's
    /// sandbox and orchestration, with the model paid for elsewhere.
    pub orchestration_fee_micros: i64,
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
    /// the workspace's own account did and only orchestration is charged.
    #[serde(default = "g1t")]
    pub billed_to: String,
    /// For a top-up: the username of whoever paid.
    pub created_by: Option<String>,
    /// RFC 3339.
    pub created_at: String,
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

/// `checkout`: starts a card payment for credit. Owners of the workspace
/// only. Returns `Outcome<Checkout>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutArgs {
    pub actor: User,
    pub workspace: String,
    /// How much credit to buy, in cents.
    pub amount_cents: u32,
    /// Where the payment page sends the person afterwards. The payment's
    /// id is appended as `session`.
    pub return_url: String,
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

/// A paid feature a workspace turns on with a monthly plan, the way
/// Cloudflare's Workers for Platforms or Vercel's Pro are bought. Never
/// free: `FREE_WHILE_BUILDING` and the free model allowance do not cover
/// it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    /// Previews per pull request and production on g1t.page.
    Deployments,
}

impl Feature {
    pub const ALL: [Feature; 1] = [Feature::Deployments];

    pub fn as_str(self) -> &'static str {
        match self {
            Feature::Deployments => "deployments",
        }
    }

    pub fn parse(name: &str) -> Option<Feature> {
        Feature::ALL.into_iter().find(|feature| feature.as_str() == name)
    }

    pub fn title(self) -> &'static str {
        match self {
            Feature::Deployments => "Deployments",
        }
    }
}

/// What the Deployments plan includes each month; usage past it is charged
/// at cost plus the margin. The billing service describes the plan with
/// these and the deployments service meters against them.
pub mod deployments_allowance {
    /// Apps deployed at once: production and previews together.
    pub const APPS: u32 = 10;
    pub const REQUESTS: u64 = 1_000_000;
    pub const CPU_MS: u64 = 3_000_000;
    /// What Cloudflare charges g1t past that, in millionths of a dollar.
    pub const MICROS_PER_APP_MONTH: i64 = 20_000;
    pub const MICROS_PER_MILLION_REQUESTS: i64 = 300_000;
    pub const MICROS_PER_MILLION_CPU_MS: i64 = 20_000;
    /// What one second of a build's sandbox costs g1t (Cloudflare
    /// Containers, standard-1: half a vCPU, 4 GiB, 8 GB disk), rounded up.
    /// Builds are not in the allowance: each is charged at this plus the
    /// margin.
    pub const MICROS_PER_BUILD_SECOND: i64 = 21;
}

/// Sandbox time: every sandbox g1t starts for a workspace (agents,
/// reviews, checks, the merge queue, workflow jobs) is metered by the
/// second. Deploy builds are charged by the Deployments plan instead.
pub mod sandbox_allowance {
    /// Free each calendar month (UTC): 500 minutes.
    pub const FREE_SECONDS: i64 = 30_000;
    /// What one second costs g1t (Cloudflare Containers, standard-1),
    /// rounded up. Recorded with every entry.
    pub const COST_MICROS_PER_SECOND: i64 = super::deployments_allowance::MICROS_PER_BUILD_SECOND;
    /// What one second past the free minutes is charged: $0.003 a minute.
    pub const MICROS_PER_SECOND: i64 = 50;
}

/// `record_sandbox`: how long one sandbox ran for a workspace, reported by
/// the runner when it stops. Recorded once per `reference`, with what it
/// cost g1t; seconds past the month's free minutes are charged at
/// `sandbox_allowance::MICROS_PER_SECOND`, unless `FREE_WHILE_BUILDING`.
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
    /// `deployments`.
    pub source: String,
    /// What it cost g1t so far this month, before the margin.
    pub cost_micros: i64,
}

/// `set_spend_limit`: the owner's own monthly ceiling, under g1t's; None
/// removes it. Owners only. Returns `Outcome<Limit>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSpendLimitArgs {
    pub actor: User,
    pub workspace: String,
    pub spend_limit_micros: Option<i64>,
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
    pub reason: String,
    pub created_at: String,
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn features_are_named_as_the_site_sends_them() {
        assert_eq!(
            serde_json::to_value(Feature::Deployments).unwrap(),
            serde_json::json!("deployments")
        );
        assert_eq!(Feature::parse("deployments"), Some(Feature::Deployments));
        assert!(SubscriptionStatus::Canceling.on());
        assert!(!SubscriptionStatus::PastDue.on());
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
