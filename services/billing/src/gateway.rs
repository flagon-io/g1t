//! The AI Gateway: a workspace's own model requests, sent with one of its
//! access tokens to the model proxy at `models.g1t.sh/anthropic`.
//!
//! - **Admission.** Before a request goes to g1t's models the proxy asks
//!   `gateway_admit`. A workspace over its spend limit is refused, as one is
//!   for anything else. On the plan it needs AI credit or included usage
//!   left, as an agent run does (auto-reload is tried first). A workspace
//!   with no plan is refused: the gateway on g1t's key is paid for from AI
//!   credit, which comes with the plan. A 100% discount and an enterprise
//!   need nothing more. On the workspace's own provider key nothing is
//!   asked: those requests cost g1t nothing.
//! - **Charging.** Each request that used tokens on g1t's models is
//!   charged its tokens at the model's list price (`gateway_models`), plus
//!   the price book's `gateway_models` markup (0 while the gateway is in
//!   beta), on a ledger line of its own (task `gateway`, one request each).
//!   The plan's included usage pays first, then AI credit (`grants::replay`
//!   counts gateway lines as model usage). Not an agent run, so never the
//!   agent rate, and never trial credit or g1t's pools.
//! - **On the workspace's own key.** Logged with its tokens and charged
//!   nothing.
//! - **The log.** Every request is kept for `RETENTION_DAYS`, with its
//!   model, tokens by kind, cost, status and the token that sent it; never
//!   its prompt or answer.

use g1t_contracts::billing::{
    GatewayAdmitArgs, GatewayModel, GatewayRequest, GatewayRequests, GatewayRequestsArgs, LimitState, PlanKind, RecordGatewayArgs,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::credits::{Eligible, month_of};
use crate::features::thousands;
use crate::{Billing, margin_on, members_only, optional};

/// How long the log keeps a request.
pub(crate) const RETENTION_DAYS: u32 = 30;
/// A page of the log: this many when not asked, and at most.
const PAGE: u32 = 50;
const MAX_PAGE: u32 = 200;
const DAY_MS: u64 = 86_400_000;

/// What `tokens` (input, output, cache reads, cache writes) cost at a
/// model's prices per million, rounded up to a whole millionth of a dollar.
pub(crate) fn cost_micros(model: &GatewayModel, tokens: [u64; 4]) -> i64 {
    let prices = [model.input_micros, model.output_micros, model.cache_read_micros, model.cache_write_micros];
    let millionths: u128 = tokens
        .iter()
        .zip(prices)
        .map(|(n, price)| u128::from(*n) * u128::from(price.max(0).unsigned_abs()))
        .sum();
    i64::try_from(millionths.div_ceil(1_000_000)).unwrap_or(i64::MAX)
}

/// Where a workspace stands for a request on g1t's models.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Standing {
    /// Over its spend limit, with the limit's own message.
    Stopped(String),
    /// No plan.
    NoPlan,
    /// On the plan with no AI credit or included usage left.
    OutOfCredit { reload_failed: bool },
    Admitted,
}

/// Where a workspace within its limit stands, by its plan: `exhausted` is
/// `credit_exhausted`'s answer (asked only on the plan). A workspace with
/// no plan has no AI credit to spend; a 100% discount and an enterprise
/// need none.
pub(crate) fn plan_standing(plan: PlanKind, exhausted: Option<bool>) -> Standing {
    match plan {
        PlanKind::Free => Standing::NoPlan,
        PlanKind::Internal | PlanKind::Enterprise => Standing::Admitted,
        PlanKind::Paid => match exhausted {
            Some(reload_failed) => Standing::OutOfCredit { reload_failed },
            None => Standing::Admitted,
        },
    }
}

/// What one request costs g1t, to charge: its tokens at its model's prices
/// on g1t's key; nothing on the workspace's own key, or for a model g1t
/// has no price for.
pub(crate) fn request_cost(own_key: bool, model: Option<&GatewayModel>, tokens: [u64; 4]) -> i64 {
    match model {
        Some(model) if !own_key => cost_micros(model, tokens),
        _ => 0,
    }
}

/// Why a request is refused, in words for whoever sent it, or None.
pub(crate) fn refusal(workspace: &str, standing: &Standing) -> Option<String> {
    match standing {
        Standing::Admitted => None,
        Standing::Stopped(message) => Some(message.clone()),
        Standing::NoPlan => Some(format!(
            "The AI Gateway on g1t's models is paid for from AI credit, which comes with the g1t plan. An owner can start the plan for {workspace} at /{workspace}/-/billing, or connect the workspace's own Anthropic key under Integrations to use the gateway at no charge."
        )),
        Standing::OutOfCredit { reload_failed } => {
            let reload = if *reload_failed { " Auto-reload was turned off after its last charge failed." } else { "" };
            Some(format!(
                "The {workspace} workspace is out of AI credit and has used this month's included usage, so the AI Gateway refuses requests to g1t's models.{reload} An owner can buy AI credit or turn on auto-reload at /{workspace}/-/billing#ai-credit."
            ))
        }
    }
}

/// What a ledger line for one request says.
pub(crate) fn describe(model_name: &str, tokens: [u64; 4], token_name: Option<&str>) -> String {
    let used: u64 = tokens.iter().sum();
    let by = token_name.map(str::trim).filter(|name| !name.is_empty()).map_or(String::new(), |name| format!(", token {name}"));
    format!("AI Gateway: {model_name}, {} tokens{by}", thousands(used))
}

/// Whether a request id is one the proxy makes: `gw_` and up to 64 letters,
/// digits, `_` and `-`.
pub(crate) fn valid_id(id: &str) -> bool {
    id.starts_with("gw_") && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[derive(Deserialize)]
struct ModelRow {
    model: String,
    name: String,
    provider: String,
    input_micros: i64,
    output_micros: i64,
    cache_read_micros: i64,
    cache_write_micros: i64,
}

impl From<ModelRow> for GatewayModel {
    fn from(row: ModelRow) -> Self {
        GatewayModel {
            model: row.model,
            name: row.name,
            provider: row.provider,
            input_micros: row.input_micros,
            output_micros: row.output_micros,
            cache_read_micros: row.cache_read_micros,
            cache_write_micros: row.cache_write_micros,
        }
    }
}

#[derive(Deserialize)]
struct RequestRow {
    id: String,
    created_at: String,
    model: String,
    token_id: String,
    token_name: Option<String>,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cost_micros: f64,
    charged_micros: f64,
    status: f64,
    own_key: f64,
    streamed: f64,
    duration_ms: f64,
    error: Option<String>,
}

impl From<RequestRow> for GatewayRequest {
    fn from(row: RequestRow) -> Self {
        let n = |v: f64| v.max(0.0) as u64;
        GatewayRequest {
            id: row.id,
            created_at: row.created_at,
            model: row.model,
            token_id: row.token_id,
            token_name: row.token_name,
            input: n(row.input),
            output: n(row.output),
            cache_read: n(row.cache_read),
            cache_write: n(row.cache_write),
            cost_micros: row.cost_micros as i64,
            charged_micros: row.charged_micros as i64,
            status: row.status as u16,
            own_key: row.own_key != 0.0,
            streamed: row.streamed != 0.0,
            duration_ms: n(row.duration_ms),
            error: row.error,
        }
    }
}

/// D1 takes numbers as doubles; counts and amounts here fit exactly.
fn number(n: u64) -> JsValue {
    JsValue::from_f64(n as f64)
}

impl Billing {
    /// `gateway_models`: what the gateway offers on g1t's key, with prices.
    pub(crate) async fn gateway_models(&self) -> Result<Vec<GatewayModel>> {
        Ok(self
            .db
            .prepare("SELECT * FROM gateway_models ORDER BY position, model")
            .all()
            .await?
            .results::<ModelRow>()?
            .into_iter()
            .map(GatewayModel::from)
            .collect())
    }

    async fn gateway_model(&self, model: &str) -> Result<Option<GatewayModel>> {
        Ok(self
            .db
            .prepare("SELECT * FROM gateway_models WHERE model = ?")
            .bind(&[model.into()])?
            .first::<ModelRow>(None)
            .await?
            .map(GatewayModel::from))
    }

    /// Where a workspace stands for a request on g1t's models.
    pub(crate) async fn gateway_standing(&self, workspace: &str) -> Result<Standing> {
        if self.stripe.is_none() || self.free {
            return Ok(Standing::Admitted);
        }
        let limit = self.limit_of(workspace).await?;
        if limit.state == LimitState::Stopped {
            return Ok(Standing::Stopped(limit.message.unwrap_or_else(|| "This workspace is over its limit.".to_owned())));
        }
        if let Some(Outcome::Fail(failure)) = self.out_of_credit::<bool>(workspace).await? {
            return Ok(Standing::Stopped(failure.message));
        }
        let account = self.account_of(workspace).await?;
        let plan = self.plan_kind_for(workspace, &account).await?;
        // Only a workspace paying on the plan needs credit to spend.
        let exhausted = if plan == PlanKind::Paid { self.credit_exhausted(workspace).await? } else { None };
        Ok(plan_standing(plan, exhausted))
    }

    /// `gateway_admit`.
    pub(crate) async fn gateway_admit(&self, a: GatewayAdmitArgs) -> Result<Outcome<bool>> {
        let workspace = a.workspace.trim().to_lowercase();
        if workspace.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace."));
        }
        let standing = self.gateway_standing(&workspace).await?;
        Ok(match refusal(&workspace, &standing) {
            Some(why) => Outcome::fail(FailureCode::PaymentRequired, why),
            None => Outcome::Ok(true),
        })
    }

    /// `record_gateway`: logs a request once, and charges it once when it
    /// used tokens on g1t's models.
    pub(crate) async fn record_gateway(&self, a: RecordGatewayArgs) -> Result<Outcome<bool>> {
        if !valid_id(&a.id) {
            return Ok(Outcome::fail(FailureCode::Invalid, "A gateway request's id is gw_ and up to 64 letters and digits."));
        }
        let workspace = a.workspace.trim().to_lowercase();
        if workspace.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace."));
        }
        let tokens = [a.input, a.output, a.cache_read, a.cache_write];
        let model_name: String = a.model.trim().chars().take(200).collect();
        let token_name = a.token_name.as_deref().map(|name| name.trim().chars().take(100).collect::<String>());
        let priced = if a.own_key { None } else { self.gateway_model(&model_name).await? };
        let cost = request_cost(a.own_key, priced.as_ref(), tokens);
        let now = now_ms();
        let timestamp = rfc3339(now);
        // Claimed first: the same request recorded twice is one row and one charge.
        let claimed = self
            .db
            .prepare(
                "INSERT OR IGNORE INTO gateway_requests
                   (id, workspace, created_at, token_id, token_name, model, input, output, cache_read, cache_write,
                    cost_micros, charged_micros, status, own_key, streamed, duration_ms, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
                 RETURNING id",
            )
            .bind(&[
                a.id.as_str().into(),
                workspace.as_str().into(),
                timestamp.as_str().into(),
                a.token_id.chars().take(64).collect::<String>().into(),
                optional(token_name.as_deref()),
                model_name.as_str().into(),
                number(a.input),
                number(a.output),
                number(a.cache_read),
                number(a.cache_write),
                (cost as f64).into(),
                f64::from(a.status).into(),
                f64::from(u8::from(a.own_key)).into(),
                f64::from(u8::from(a.streamed)).into(),
                number(a.duration_ms),
                optional(a.error.as_deref().map(|e| e.chars().take(500).collect::<String>()).as_deref()),
            ])?
            .first::<serde_json::Value>(None)
            .await?;
        if claimed.is_none() {
            return Ok(Outcome::Ok(false));
        }
        // Without a card processor there is no bill to put it on.
        let Some(model) = priced.filter(|_| cost > 0 && self.stripe.is_some()) else {
            return Ok(Outcome::Ok(true));
        };
        let base = margin_on(cost, self.gateway_markup().await?);
        let (charge, terms_note, discount) = self.charged(&workspace, base).await?;
        // Included usage pays first, then AI credit. Never the trial or
        // g1t's pools, and g1t never covers the rest.
        let eligible = Eligible { trial: false, repo: None, cover_rest: false };
        let drawn = self.draw(&workspace, charge, &month_of(&timestamp), &eligible).await?;
        let owed = charge - drawn.total();
        let description = format!("{}{terms_note}{}", describe(&model.name, tokens, token_name.as_deref()), drawn.note());
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO ledger
                           (id, workspace, kind, amount_micros, description, task, model, cost_micros, reference, created_at,
                            billed_to, credit_micros, trial_micros, oss_micros, given_micros, price_version, quantity)
                         VALUES (?, ?, 'usage', ?, ?, 'gateway', ?, ?, ?, ?, 'g1t', ?, ?, ?, ?, ?, 1)",
                    )
                    .bind(&[
                        new_id("led", now).into(),
                        workspace.as_str().into(),
                        (-(owed as f64)).into(),
                        description.as_str().into(),
                        model.model.as_str().into(),
                        (cost as f64).into(),
                        a.id.as_str().into(),
                        timestamp.as_str().into(),
                        (drawn.credit as f64).into(),
                        (drawn.trial as f64).into(),
                        (drawn.oss as f64).into(),
                        (drawn.given as f64).into(),
                        optional(self.version_now("gateway_models").await?.as_deref()),
                    ])?,
                self.db
                    .prepare(
                        "INSERT INTO accounts (workspace, balance_micros, created_at)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT (workspace) DO UPDATE SET balance_micros = balance_micros + ?2",
                    )
                    .bind(&[workspace.as_str().into(), (-(owed as f64)).into(), timestamp.as_str().into()])?,
                self.db
                    .prepare("UPDATE gateway_requests SET charged_micros = ? WHERE id = ?")
                    .bind(&[(charge as f64).into(), a.id.as_str().into()])?,
            ])
            .await?;
        self.record_discount(&a.id, discount).await?;
        self.count_spend(&workspace, cost, owed, &drawn).await;
        Ok(Outcome::Ok(true))
    }

    /// `gateway_requests`: the log, newest first, for members.
    pub(crate) async fn gateway_requests(&self, a: GatewayRequestsArgs) -> Result<Outcome<GatewayRequests>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let limit = a.limit.unwrap_or(PAGE).clamp(1, MAX_PAGE);
        let mut binds: Vec<JsValue> = vec![workspace.as_str().into()];
        let older = match a.before.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            Some(before) => {
                binds.push(before.into());
                " AND (created_at, id) < (SELECT created_at, id FROM gateway_requests WHERE id = ?2)"
            }
            None => "",
        };
        binds.push(f64::from(limit + 1).into());
        let at = binds.len();
        let mut rows = self
            .db
            .prepare(format!(
                "SELECT * FROM gateway_requests WHERE workspace = ?1{older} ORDER BY created_at DESC, id DESC LIMIT ?{at}"
            ))
            .bind(&binds)?
            .all()
            .await?
            .results::<RequestRow>()?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let requests: Vec<GatewayRequest> = rows.into_iter().map(GatewayRequest::from).collect();
        let next = if more { requests.last().map(|r| r.id.clone()) } else { None };
        Ok(Outcome::Ok(GatewayRequests { requests, next, retention_days: RETENTION_DAYS }))
    }

    /// Daily: requests older than the log keeps are deleted.
    pub(crate) async fn forget_gateway_requests(&self) -> Result<()> {
        let cutoff = rfc3339(now_ms().saturating_sub(u64::from(RETENTION_DAYS) * DAY_MS));
        self.db
            .prepare("DELETE FROM gateway_requests WHERE created_at < ?")
            .bind(&[cutoff.into()])?
            .run()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sonnet() -> GatewayModel {
        GatewayModel {
            model: "claude-sonnet-5-5".into(),
            name: "Claude Sonnet 5.5".into(),
            provider: "anthropic".into(),
            input_micros: 2_000_000,
            output_micros: 10_000_000,
            cache_read_micros: 200_000,
            cache_write_micros: 2_500_000,
        }
    }

    #[test]
    fn a_request_costs_its_tokens_at_the_models_prices() {
        // A million of each: $2 + $10 + $0.20 + $2.50.
        assert_eq!(cost_micros(&sonnet(), [1_000_000; 4]), 14_700_000);
        // 1,000 input and 500 output: $0.002 + $0.005.
        assert_eq!(cost_micros(&sonnet(), [1_000, 500, 0, 0]), 7_000);
        // Nothing used costs nothing.
        assert_eq!(cost_micros(&sonnet(), [0; 4]), 0);
    }

    #[test]
    fn a_fraction_of_a_millionth_rounds_up() {
        // One cache-read token: 0.2 millionths.
        assert_eq!(cost_micros(&sonnet(), [0, 0, 1, 0]), 1);
        // A negative price in the table is never a credit: it counts as nothing.
        let odd = GatewayModel { input_micros: -5, ..sonnet() };
        assert_eq!(cost_micros(&odd, [10, 0, 0, 0]), 0);
    }

    #[test]
    fn the_markup_is_the_price_books_and_zero_in_beta_charges_the_cost() {
        let cost = cost_micros(&sonnet(), [12_000, 800, 40_000, 0]);
        assert_eq!(margin_on(cost, 0), cost);
        assert_eq!(margin_on(1_000, 20), 1_200);
    }

    #[test]
    fn the_workspaces_own_key_is_counted_and_never_charged() {
        let tokens = [50_000, 2_000, 0, 0];
        assert_eq!(request_cost(false, Some(&sonnet()), tokens), 120_000);
        assert_eq!(request_cost(true, Some(&sonnet()), tokens), 0);
        // A model g1t has no price for is never charged a guess.
        assert_eq!(request_cost(false, None, tokens), 0);
    }

    #[test]
    fn out_of_credit_on_the_plan_is_refused_and_the_rest_by_plan() {
        assert_eq!(plan_standing(PlanKind::Paid, None), Standing::Admitted);
        assert_eq!(plan_standing(PlanKind::Paid, Some(false)), Standing::OutOfCredit { reload_failed: false });
        assert_eq!(plan_standing(PlanKind::Paid, Some(true)), Standing::OutOfCredit { reload_failed: true });
        assert_eq!(plan_standing(PlanKind::Free, None), Standing::NoPlan);
        // Comped and invoiced workspaces need no credit.
        assert_eq!(plan_standing(PlanKind::Internal, Some(false)), Standing::Admitted);
        assert_eq!(plan_standing(PlanKind::Enterprise, Some(false)), Standing::Admitted);
        assert!(refusal("acme", &plan_standing(PlanKind::Paid, Some(false))).is_some());
    }

    #[test]
    fn only_an_admitted_workspace_is_let_through() {
        assert_eq!(refusal("acme", &Standing::Admitted), None);
        let out = refusal("acme", &Standing::OutOfCredit { reload_failed: false }).unwrap();
        assert!(out.contains("out of AI credit") && out.contains("/acme/-/billing#ai-credit"), "{out}");
        assert!(!out.contains("Auto-reload"));
        let failed = refusal("acme", &Standing::OutOfCredit { reload_failed: true }).unwrap();
        assert!(failed.contains("Auto-reload was turned off"));
        let no_plan = refusal("acme", &Standing::NoPlan).unwrap();
        assert!(no_plan.contains("g1t plan") && no_plan.contains("own Anthropic key"), "{no_plan}");
        assert_eq!(refusal("acme", &Standing::Stopped("Over the limit.".into())).as_deref(), Some("Over the limit."));
    }

    #[test]
    fn a_ledger_line_names_the_model_tokens_and_token() {
        assert_eq!(describe("Claude Sonnet 5.5", [12_000, 800, 0, 0], Some("ci")), "AI Gateway: Claude Sonnet 5.5, 12,800 tokens, token ci");
        assert_eq!(describe("Claude Haiku 4.5", [5, 0, 0, 0], None), "AI Gateway: Claude Haiku 4.5, 5 tokens");
        assert_eq!(describe("Claude Haiku 4.5", [5, 0, 0, 0], Some("  ")), "AI Gateway: Claude Haiku 4.5, 5 tokens");
    }

    #[test]
    fn request_ids_are_the_proxys() {
        assert!(valid_id("gw_01kkr2m4c8f1t7qh3d6n9w5p0x"));
        assert!(valid_id("gw_a-b_c"));
        assert!(!valid_id("run_1"));
        assert!(!valid_id("gw_x'; DROP TABLE ledger"));
        assert!(!valid_id(&format!("gw_{}", "a".repeat(80))));
    }

    #[test]
    fn the_migration_prices_every_model_it_offers() {
        let sql = include_str!("../migrations/0045_gateway.sql");
        for model in ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"] {
            assert!(sql.contains(&format!("('{model}', ")), "{model}");
        }
        // Sonnet 5.5 at $2 / $10, cache reads $0.20, five-minute cache writes $2.50.
        assert!(sql.contains("('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'anthropic', 2000000, 10000000, 200000, 2500000"));
    }
}
