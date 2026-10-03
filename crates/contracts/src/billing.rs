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
    /// An agent's run.
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

#[cfg(test)]
mod tests {
    use super::*;

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
