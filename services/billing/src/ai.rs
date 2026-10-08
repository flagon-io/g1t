//! Prepaid AI credit: what Agent and AI Gateway usage draws on, bought in
//! advance so g1t never fronts a model's cost.
//!
//! - **Buying.** An owner buys AI credit on Stripe's page: one payment by
//!   card, $10 to $1,000, with Stripe's card fee as its own line when the
//!   `card_fee` cost setting is on (`card_fee_cents`, a gross-up of the
//!   price book's `card_fee_percent` and `card_fee_fixed`). The card is
//!   kept for auto-reload. The credit is entered once, whichever comes
//!   first: the person coming back (`confirm_ai_credit`) or Stripe's
//!   `checkout.session.completed` (`webhooks.rs`). Both claim the same
//!   `checkouts` row, and the grant's id is the page's id, so a payment is
//!   credited exactly once.
//! - **What it is.** A `credit_grants` row of kind `purchased`, scope
//!   `models`, source `purchase`, expiring a year after purchase, and its
//!   ledger line (a payment: its reference is Stripe's id, never `crd…`).
//!   Model usage draws on it before anything else (`grants::replay`), and
//!   it counts as money paid, never as given.
//! - **Auto-reload.** Off by default. When AI credit falls below the
//!   threshold, the saved card is charged off-session to bring it back to
//!   the target, at most the monthly maximum. Each attempt has its own
//!   idempotency key (`ai_reloads.id`), so a retry is the same payment. A
//!   failed charge turns auto-reload off and tells the owners.
//! - **At $0.** A workspace on the plan with no AI credit and none of its
//!   included usage left cannot start a run on g1t's models: `start_run`
//!   refuses with what to do. Auto-reload, when on, is tried first. A 100%
//!   discount (Flagon) pays for everything, so nothing is needed; an
//!   enterprise is invoiced for models after use.
//! - **Once on upgrading.** A workspace that starts the paid plan is given
//!   $5 of AI credit once (promotional: given, not revenue), expiring in a
//!   year.
//! - **The agent rate.** Every agent run's tokens (input, output and
//!   cached, as the model proxy counts them) are charged at the price
//!   book's `agent_tokens` price per million, on a line of their own
//!   (`<run>/agent`), on top of the model at the provider's price
//!   (`agent_models`, no markup).

use g1t_contracts::billing::{
    AccountArgs, AiCredit, AiReload, BuyAiCreditArgs, CardFee, Checkout, ConfirmAiCreditArgs, CreditKind, EntryKind, PlanKind,
    SetAiReloadArgs, MICROS_PER_DOLLAR,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::features::cents;
use crate::{Billing, RunRow, members_only, optional};

/// What a checkout row for AI credit is marked with.
pub(crate) const AI_CREDIT: &str = "ai_credit";
/// The amounts offered, in cents, and the bounds of a custom one.
pub(crate) const PRESETS_CENTS: [u32; 4] = [1_000, 2_500, 5_000, 10_000];
pub(crate) const MIN_CENTS: u32 = 1_000;
pub(crate) const MAX_CENTS: u32 = 100_000;
/// Bought credit lasts a year.
pub(crate) const EXPIRES_DAYS: u64 = 365;
/// Given once, on starting the paid plan.
pub(crate) const UPGRADE_CREDIT_MICROS: i64 = 5_000_000;
/// Auto-reload's bounds: a reload of at least $10, a target of at most
/// $1,000, and at most $10,000 a month.
const MIN_RELOAD_MICROS: i64 = 10 * MICROS_PER_DOLLAR;
const MAX_TARGET_MICROS: i64 = 1_000 * MICROS_PER_DOLLAR;
const MAX_MONTHLY_MICROS: i64 = 10_000 * MICROS_PER_DOLLAR;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// The arithmetic, apart from the database so it can be tested.
// ---------------------------------------------------------------------

/// Whether an amount of AI credit can be bought, in cents.
pub(crate) fn amount_ok(cents: u32) -> std::result::Result<(), String> {
    if (MIN_CENTS..=MAX_CENTS).contains(&cents) && cents.is_multiple_of(100) {
        Ok(())
    } else {
        Err(format!("Buy between ${} and ${} of AI credit, in whole dollars.", MIN_CENTS / 100, crate::group(MAX_CENTS / 100)))
    }
}

/// The card fee on `credit_cents`, so that what is left after Stripe's fee
/// is the credit: the total is `(credit + fixed) / (1 − percent)`, rounded
/// up to the cent. None when the fee is off.
pub(crate) fn card_fee_cents(credit_cents: u32, fee: &CardFee) -> u32 {
    if !fee.on || credit_cents == 0 {
        return 0;
    }
    let rate = fee.percent_micros / MICROS_PER_DOLLAR as f64;
    if !(0.0..0.5).contains(&rate) {
        return 0;
    }
    let total = ((f64::from(credit_cents) + f64::from(fee.fixed_cents)) / (1.0 - rate)).ceil();
    (total as u32).saturating_sub(credit_cents)
}

/// What auto-reload should buy now, if anything: enough to bring the
/// credit from `balance` back to the target, in whole dollars, within
/// what is left of the monthly maximum, and never less than $10.
pub(crate) fn reload_amount(reload: &AiReload, balance: i64, reloaded_this_month: i64) -> Option<i64> {
    if !reload.enabled || reload.failed_at.is_some() || balance >= reload.threshold_micros {
        return None;
    }
    let wanted = (reload.target_micros - balance).max(MIN_RELOAD_MICROS);
    let wanted = (wanted + MICROS_PER_DOLLAR - 1) / MICROS_PER_DOLLAR * MICROS_PER_DOLLAR;
    let room = (reload.monthly_max_micros - reloaded_this_month).max(0) / MICROS_PER_DOLLAR * MICROS_PER_DOLLAR;
    let amount = wanted.min(room);
    (amount >= MIN_RELOAD_MICROS).then_some(amount)
}

/// What is wrong with auto-reload's settings, if anything.
pub(crate) fn reload_invalid(threshold: i64, target: i64, monthly_max: i64) -> Option<&'static str> {
    if threshold < 0 || target <= 0 || monthly_max <= 0 {
        return Some("Amounts are in dollars, more than $0.");
    }
    if target < threshold + MIN_RELOAD_MICROS {
        return Some("Reload to at least $10 more than the amount it reloads below.");
    }
    if target > MAX_TARGET_MICROS {
        return Some("Reload to at most $1,000.");
    }
    if monthly_max < target - threshold {
        return Some("The monthly maximum has to cover at least one reload.");
    }
    if monthly_max > MAX_MONTHLY_MICROS {
        return Some("The monthly maximum is at most $10,000.");
    }
    if [threshold, target, monthly_max].iter().any(|m| m % MICROS_PER_DOLLAR != 0) {
        return Some("Use whole dollars.");
    }
    None
}

/// Whether a purchase's page was paid for what was asked: Stripe says it
/// is paid, and what was paid covers the credit (the fee is Stripe's).
pub(crate) fn purchase_paid(payment_status: &str, amount_total: Option<u32>, credit_cents: u32) -> std::result::Result<(), String> {
    if payment_status != "paid" {
        return Err("The payment is not finished yet. It is credited as soon as Stripe says it was paid.".to_owned());
    }
    if amount_total.unwrap_or(0) < credit_cents {
        return Err("Stripe says less was paid than the credit asked for; nothing was credited. Write to support@g1t.sh.".to_owned());
    }
    Ok(())
}

/// The id of the AI credit given for starting the plan: one per workspace,
/// so however often the plan is recorded, it is given once.
pub(crate) fn upgrade_reference(workspace: &str) -> String {
    format!("crd_upgrade_{}", workspace.to_lowercase())
}

/// The agent rate on `tokens`, at `per_million` micros a million, rounded
/// up to a whole millionth of a dollar.
pub(crate) fn agent_rate_micros(tokens: u64, per_million: f64) -> i64 {
    if tokens == 0 || !per_million.is_finite() || per_million <= 0.0 {
        return 0;
    }
    (tokens as f64 * per_million / 1_000_000.0).ceil() as i64
}

/// Whether a workspace's runs on g1t's models need AI credit (or included
/// usage) to start: on the plan, paying full or part price. A 100%
/// discount pays for all of it; an enterprise is invoiced after use; a
/// free workspace runs on its trial, which has its own limits.
pub(crate) fn needs_credit(plan: PlanKind) -> bool {
    plan == PlanKind::Paid
}

/// The refusal at $0.
pub(crate) fn out_of_credit_message(workspace: &str, reload_failed: bool) -> String {
    let reload = if reload_failed { " Auto-reload was turned off after its last charge failed." } else { "" };
    format!(
        "The {workspace} workspace is out of AI credit and has used this month's included usage, so g1t does not start new runs on its models.{reload} An owner can buy AI credit or turn on auto-reload at /{workspace}/-/billing#ai-credit."
    )
}

#[derive(Deserialize)]
struct ReloadRow {
    enabled: i64,
    threshold_micros: i64,
    target_micros: i64,
    monthly_max_micros: i64,
    failed_at: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Sum {
    micros: Option<f64>,
}

#[derive(Deserialize)]
struct Open {
    workspace: String,
    created_by: String,
    amount_cents: u32,
    fee_cents: Option<u32>,
}

impl Billing {
    // --- The price book ----------------------------------------------------

    /// The card fee, as the price book and the `card_fee` setting have it.
    pub(crate) async fn card_fee(&self) -> Result<CardFee> {
        #[derive(Deserialize)]
        struct Row {
            value: String,
        }
        let on = self
            .db
            .prepare("SELECT value FROM cost_settings WHERE key = 'card_fee'")
            .first::<Row>(None)
            .await?
            .is_none_or(|row| row.value.trim() != "off");
        let percent = self.price("card_fee_percent").await?.map_or(29_000.0, |(_, price)| price);
        let fixed = self.price("card_fee_fixed").await?.map_or(300_000.0, |(_, price)| price);
        Ok(CardFee { on, percent_micros: percent, fixed_cents: (fixed / 10_000.0).round().max(0.0) as u32 })
    }

    /// The agent rate per million tokens, at price.
    pub(crate) async fn agent_rate(&self) -> Result<f64> {
        Ok(self.price("agent_tokens").await?.map_or(0.0, |(_, price)| price))
    }

    /// The markup on a price-book meter, in percent.
    async fn markup_of(&self, meter: &str) -> Result<Option<u32>> {
        #[derive(Deserialize)]
        struct Row {
            markup_percent: u32,
        }
        Ok(self
            .db
            .prepare("SELECT markup_percent FROM prices WHERE meter = ?")
            .bind(&[meter.into()])?
            .first::<Row>(None)
            .await?
            .map(|row| row.markup_percent))
    }

    /// The markup on a model's provider price for agent runs: the price
    /// book's `agent_models` (0 from 2026-10-08), or `MARGIN_PERCENT`
    /// where the price book has no row.
    pub(crate) async fn model_markup(&self) -> Result<u32> {
        Ok(self.markup_of("agent_models").await?.unwrap_or(self.margin_percent))
    }

    /// The markup on AI Gateway's provider price: 0 while it is in beta.
    pub(crate) async fn gateway_markup(&self) -> Result<u32> {
        Ok(self.markup_of("gateway_models").await?.unwrap_or(0))
    }

    // --- Balances ------------------------------------------------------------

    /// AI credit left: the open grants scoped to models, by kind.
    pub(crate) async fn ai_balance(&self, workspace: &str) -> Result<(i64, i64, i64)> {
        let credits = self.credits_of(workspace).await?;
        let models: Vec<_> = credits.grants.iter().filter(|g| g.scope == "models").collect();
        let purchased = models.iter().filter(|g| g.kind == CreditKind::Purchased).map(|g| g.left_micros).sum();
        let given = models.iter().filter(|g| g.kind != CreditKind::Purchased).map(|g| g.left_micros).sum();
        Ok((purchased + given, purchased, given))
    }

    /// What is owed now, with the balance `balance`: credit scoped to
    /// models is not money for anything else, so what is left of it is
    /// owed on top of a balance it props up.
    pub(crate) async fn owed_with(&self, workspace: &str, balance: i64) -> Result<i64> {
        let (left, _, _) = self.ai_balance(workspace).await?;
        Ok((left - balance).max(0))
    }

    async fn reload_settings(&self, workspace: &str) -> Result<AiReload> {
        let row = self
            .db
            .prepare("SELECT enabled, threshold_micros, target_micros, monthly_max_micros, failed_at, error FROM ai_reload WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<ReloadRow>(None)
            .await?;
        let reloaded = self.reloaded_this_month(workspace).await?;
        Ok(match row {
            Some(row) => AiReload {
                enabled: row.enabled != 0,
                threshold_micros: row.threshold_micros,
                target_micros: row.target_micros,
                monthly_max_micros: row.monthly_max_micros,
                reloaded_micros: reloaded,
                failed_at: row.failed_at,
                error: row.error,
            },
            // The suggestion the form starts from: below $10, back to $25,
            // at most $100 a month.
            None => AiReload {
                enabled: false,
                threshold_micros: 10 * MICROS_PER_DOLLAR,
                target_micros: 25 * MICROS_PER_DOLLAR,
                monthly_max_micros: 100 * MICROS_PER_DOLLAR,
                reloaded_micros: reloaded,
                failed_at: None,
                error: None,
            },
        })
    }

    async fn reloaded_this_month(&self, workspace: &str) -> Result<i64> {
        let month = &rfc3339(now_ms())[..7];
        Ok(self
            .db
            .prepare("SELECT SUM(amount_micros) AS micros FROM ai_reloads WHERE workspace = ? AND month = ? AND status IN ('paid', 'pending')")
            .bind(&[workspace.into(), month.into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0.0) as i64)
    }

    /// What the plan's included usage has left this month, on the plan.
    async fn included_left(&self, workspace: &str) -> Result<i64> {
        let month = crate::credits::month_of(&rfc3339(now_ms()));
        let used = self.allowance_used("plan_credit", workspace, &month).await?;
        Ok(crate::credits::left(self.plans.plan_included_micros, used))
    }

    // --- The page --------------------------------------------------------------

    /// `ai_credit`: the workspace's AI credit, for its members.
    pub(crate) async fn ai_credit(&self, a: AccountArgs) -> Result<Outcome<AiCredit>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        Ok(Outcome::Ok(self.ai_credit_of(&workspace).await?))
    }

    pub(crate) async fn ai_credit_of(&self, workspace: &str) -> Result<AiCredit> {
        let account = self.account_of(workspace).await?;
        let plan = self.plan_kind_for(workspace, &account).await?;
        let credits = self.credits_of(workspace).await?;
        let grants: Vec<_> = credits.grants.into_iter().filter(|g| g.scope == "models").collect();
        let purchased: i64 = grants.iter().filter(|g| g.kind == CreditKind::Purchased).map(|g| g.left_micros).sum();
        let given: i64 = grants.iter().filter(|g| g.kind != CreditKind::Purchased).map(|g| g.left_micros).sum();
        let balance = purchased + given;
        let reload = self.reload_settings(workspace).await?;
        let blocked = self.stripe.is_some()
            && !self.free
            && needs_credit(plan)
            && balance <= 0
            && self.included_left(workspace).await? <= 0;
        Ok(AiCredit {
            balance_micros: balance,
            purchased_micros: purchased,
            given_micros: given,
            grants,
            free_via_discount: account.terms.full_discount(),
            postpaid: plan == PlanKind::Enterprise,
            blocked,
            can_buy: self.stripe.is_some() && plan == PlanKind::Paid,
            presets_cents: PRESETS_CENTS.to_vec(),
            min_cents: MIN_CENTS,
            max_cents: MAX_CENTS,
            card_fee: self.card_fee().await?,
            reload,
            agent_rate_micros: self.agent_rate().await?,
            model_markup_percent: self.model_markup().await?,
            gateway_markup_percent: self.gateway_markup().await?,
            upgrade_credit_micros: UPGRADE_CREDIT_MICROS,
            expires_days: EXPIRES_DAYS as u32,
        })
    }

    // --- Buying --------------------------------------------------------------

    /// `buy_ai_credit`: Stripe's page for a purchase.
    pub(crate) async fn buy_ai_credit(&self, a: BuyAiCreditArgs) -> Result<Outcome<Checkout>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can buy AI credit for the workspace."));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Payments are not set up on this g1t."));
        };
        if let Err(why) = amount_ok(a.amount_cents) {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        let account = self.account_of(&workspace).await?;
        if account.terms.full_discount() {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{workspace}'s AI usage is free under its discount: there is nothing to buy.")));
        }
        match self.plan_kind_for(&workspace, &account).await? {
            PlanKind::Paid => {}
            PlanKind::Enterprise => {
                return Ok(Outcome::fail(FailureCode::Conflict, format!("{workspace} is invoiced for AI usage after use, through its enterprise.")));
            }
            _ => {
                return Ok(Outcome::fail(FailureCode::PaymentRequired, format!("AI credit is for workspaces on the g1t plan. Start the plan for {workspace} first; it comes with $5 of AI credit.")));
            }
        }
        let fee = card_fee_cents(a.amount_cents, &self.card_fee().await?);
        let customer = self.row(&workspace).await?.and_then(|row| row.customer_id);
        let purchase = |customer| crate::stripe::CreditPurchase {
            workspace: &workspace,
            credit_cents: a.amount_cents,
            fee_cents: fee,
            customer,
            return_url: &a.return_url,
        };
        let started = match stripe.start_credit_checkout(&purchase(customer.as_deref())).await {
            Err(error) if customer.is_some() && crate::stripe::is_missing(&error) => {
                self.forget_customer(&workspace).await?;
                stripe.start_credit_checkout(&purchase(None)).await
            }
            other => other,
        };
        self.page_opened(started, &workspace, a.amount_cents, fee, &a.actor.username, Some(AI_CREDIT)).await
    }

    /// `confirm_ai_credit`: back from Stripe's page.
    pub(crate) async fn confirm_ai_credit(&self, a: ConfirmAiCreditArgs) -> Result<Outcome<AiCredit>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let mine = self
            .db
            .prepare("SELECT workspace FROM checkouts WHERE id = ? AND workspace = ? AND feature = ?")
            .bind(&[a.session.as_str().into(), workspace.as_str().into(), AI_CREDIT.into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if mine.is_some() {
            match self.settle_ai_credit(&a.session).await {
                Ok(Ok(_)) => {}
                Ok(Err(why)) => return Ok(Outcome::fail(FailureCode::Conflict, why)),
                Err(error) => return Ok(Outcome::fail(FailureCode::Conflict, crate::stripe::friendly(&error))),
            }
        }
        Ok(Outcome::Ok(self.ai_credit_of(&workspace).await?))
    }

    /// Credits a purchase whose page is paid, once. What happened, or why
    /// it was not credited (yet).
    pub(crate) async fn settle_ai_credit(&self, session_id: &str) -> Result<std::result::Result<String, String>> {
        let Some(open) = self
            .db
            .prepare("SELECT workspace, created_by, amount_cents, fee_cents FROM checkouts WHERE id = ? AND feature = ? AND status = 'open'")
            .bind(&[session_id.into(), AI_CREDIT.into()])?
            .first::<Open>(None)
            .await?
        else {
            return Ok(Ok("ignored: already credited or not AI credit".to_owned()));
        };
        let Some(stripe) = &self.stripe else { return Ok(Ok("ignored: payments off".to_owned())) };
        let session = stripe.session(session_id).await?;
        if let Err(why) = purchase_paid(&session.payment_status, session.amount_total, open.amount_cents) {
            return Ok(Err(why));
        }
        let claimed = self
            .db
            .prepare("UPDATE checkouts SET status = 'paid' WHERE id = ? AND status = 'open' RETURNING id")
            .bind(&[session_id.into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if claimed.is_none() {
            return Ok(Ok("ignored: credited meanwhile".to_owned()));
        }
        let micros = i64::from(open.amount_cents) * 10_000;
        let fee = i64::from(open.fee_cents.unwrap_or(0)) * 10_000;
        self.grant_purchased(&open.workspace, session_id, micros, fee, &open.created_by, session.customer.as_deref())
            .await?;
        Ok(Ok(format!("{}: {} of AI credit bought", open.workspace, cents(micros))))
    }

    /// Enters bought AI credit: its grant and its ledger line, once for
    /// `reference` (Stripe's id for the payment).
    pub(crate) async fn grant_purchased(
        &self,
        workspace: &str,
        reference: &str,
        micros: i64,
        fee_micros: i64,
        by: &str,
        customer: Option<&str>,
    ) -> Result<bool> {
        let now = now_ms();
        let expires = rfc3339(now + EXPIRES_DAYS * DAY_MS);
        let fee = if fee_micros > 0 { format!(" (card fee {} paid to Stripe)", cents(fee_micros)) } else { String::new() };
        let note = format!("AI credit bought{fee}");
        let inserted = self
            .db
            .prepare(
                "INSERT OR IGNORE INTO credit_grants (id, workspace, kind, scope, source, amount_micros, note, expires_at, created_by, created_at)
                 VALUES (?, ?, 'purchased', 'models', 'purchase', ?, ?, ?, ?, ?) RETURNING id",
            )
            .bind(&[
                reference.into(),
                workspace.into(),
                (micros as f64).into(),
                note.as_str().into(),
                expires.as_str().into(),
                by.into(),
                rfc3339(now).into(),
            ])?
            .first::<serde_json::Value>(None)
            .await?;
        if inserted.is_none() {
            return Ok(false);
        }
        let description = format!("AI credit bought: {}, until {}", cents(micros), &expires[..10]);
        self.enter(workspace, EntryKind::TopUp, micros, &description, reference, None, None, Some(by), customer).await?;
        self.db
            .prepare("UPDATE ledger SET credit_kind = 'purchased' WHERE reference = ?")
            .bind(&[reference.into()])?
            .run()
            .await?;
        let account = self.account_of(workspace).await?;
        self.audit(&account.id, "ai_credit", &format!("{workspace}: {} of AI credit bought{fee}", cents(micros)), by).await?;
        Ok(true)
    }

    /// The $5 of AI credit a workspace gets once, on starting the paid
    /// plan. Promotional: given, not revenue. Never twice, and never for a
    /// workspace whose discount pays for everything anyway.
    pub(crate) async fn grant_upgrade_credit(&self, workspace: &str) -> Result<()> {
        let workspace = workspace.to_lowercase();
        if self.terms_of(&workspace).await?.full_discount() {
            return Ok(());
        }
        let reference = upgrade_reference(&workspace);
        let now = now_ms();
        let expires = rfc3339(now + EXPIRES_DAYS * DAY_MS);
        let inserted = self
            .db
            .prepare(
                "INSERT OR IGNORE INTO credit_grants (id, workspace, kind, scope, source, amount_micros, note, expires_at, created_by, created_at)
                 VALUES (?, ?, 'promotional', 'models', 'upgrade', ?, 'AI credit for starting the g1t plan', ?, 'g1t', ?) RETURNING id",
            )
            .bind(&[
                reference.as_str().into(),
                workspace.as_str().into(),
                (UPGRADE_CREDIT_MICROS as f64).into(),
                expires.as_str().into(),
                rfc3339(now).into(),
            ])?
            .first::<serde_json::Value>(None)
            .await?;
        if inserted.is_none() {
            return Ok(());
        }
        let description = format!("Credit from g1t (promotional, until {}): AI credit for starting the g1t plan", &expires[..10]);
        self.enter(&workspace, EntryKind::TopUp, UPGRADE_CREDIT_MICROS, &description, &reference, None, None, Some("g1t"), None).await?;
        self.db
            .prepare("UPDATE ledger SET credit_kind = 'promotional' WHERE reference = ?")
            .bind(&[reference.as_str().into()])?
            .run()
            .await?;
        let account = self.account_of(&workspace).await?;
        self.audit(&account.id, "credit", &format!("{} promotional AI credit to {workspace} for starting the plan", cents(UPGRADE_CREDIT_MICROS)), "g1t")
            .await?;
        Ok(())
    }

    // --- At $0 -----------------------------------------------------------------

    /// Why a run on g1t's models cannot start for want of AI credit, if it
    /// cannot. Auto-reload, when on, is tried first.
    pub(crate) async fn ai_refusal(&self, workspace: &str) -> Result<Option<String>> {
        if self.stripe.is_none() || self.free {
            return Ok(None);
        }
        let account = self.account_of(workspace).await?;
        if !needs_credit(self.plan_kind_for(workspace, &account).await?) {
            return Ok(None);
        }
        if self.included_left(workspace).await? > 0 {
            return Ok(None);
        }
        let (balance, _, _) = self.ai_balance(workspace).await?;
        if balance > 0 {
            return Ok(None);
        }
        let reload = self.reload_settings(workspace).await?;
        if reload.enabled && reload.failed_at.is_none() {
            if let Err(error) = self.reload_now(workspace).await {
                worker::console_error!("{workspace}: auto-reload at a run's start failed: {error}");
            }
            if self.ai_balance(workspace).await?.0 > 0 {
                return Ok(None);
            }
        }
        let failed = self.reload_settings(workspace).await?.failed_at.is_some();
        Ok(Some(out_of_credit_message(workspace, failed)))
    }

    // --- Auto-reload ---------------------------------------------------------

    /// `set_ai_reload`: owners only.
    pub(crate) async fn set_ai_reload(&self, a: SetAiReloadArgs) -> Result<Outcome<AiCredit>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can change auto-reload."));
        }
        if let Some(why) = reload_invalid(a.threshold_micros, a.target_micros, a.monthly_max_micros) {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        if a.enabled {
            let credit = self.ai_credit_of(&workspace).await?;
            if !credit.can_buy {
                return Ok(Outcome::fail(FailureCode::Conflict, "Auto-reload is for workspaces on the g1t plan that buy AI credit."));
            }
            let has_card = match (&self.stripe, self.row(&workspace).await?.and_then(|row| row.customer_id)) {
                (Some(stripe), Some(customer)) => stripe.default_payment_method(&customer).await.ok().flatten().is_some(),
                _ => false,
            };
            if !has_card {
                return Ok(Outcome::fail(FailureCode::Conflict, "Auto-reload charges the workspace's saved card, and it has none. Buy AI credit once, or add a card on Stripe's billing page, first."));
            }
        }
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO ai_reload (workspace, enabled, threshold_micros, target_micros, monthly_max_micros, updated_by, updated_at, failed_at, error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL)
                 ON CONFLICT (workspace) DO UPDATE SET enabled = ?2, threshold_micros = ?3, target_micros = ?4, monthly_max_micros = ?5,
                   updated_by = ?6, updated_at = ?7, failed_at = NULL, error = NULL",
            )
            .bind(&[
                workspace.as_str().into(),
                i32::from(a.enabled).into(),
                (a.threshold_micros as f64).into(),
                (a.target_micros as f64).into(),
                (a.monthly_max_micros as f64).into(),
                a.actor.username.as_str().into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        let account = self.account_of(&workspace).await?;
        self.audit(
            &account.id,
            "ai_reload",
            &format!(
                "{workspace}: auto-reload {}: below {}, back to {}, at most {} a month",
                if a.enabled { "on" } else { "off" },
                cents(a.threshold_micros),
                cents(a.target_micros),
                cents(a.monthly_max_micros)
            ),
            &a.actor.username,
        )
        .await?;
        // Below the threshold already: reload now rather than at the next run.
        if a.enabled
            && let Err(error) = self.reload_now(&workspace).await
        {
            worker::console_error!("{workspace}: auto-reload right after turning it on failed: {error}");
        }
        Ok(Outcome::Ok(self.ai_credit_of(&workspace).await?))
    }

    /// Every workspace with auto-reload on that is below its threshold,
    /// reloaded: each cron run.
    pub(crate) async fn reload_ai_credit(&self) -> Result<u32> {
        if self.stripe.is_none() {
            return Ok(0);
        }
        #[derive(Deserialize)]
        struct Row {
            workspace: String,
        }
        let due = self
            .db
            .prepare("SELECT workspace FROM ai_reload WHERE enabled = 1 AND failed_at IS NULL LIMIT 100")
            .all()
            .await?
            .results::<Row>()?;
        let mut done = 0;
        for Row { workspace } in due {
            match self.reload_now(&workspace).await {
                Ok(Some(_)) => done += 1,
                Ok(None) => {}
                Err(error) => worker::console_error!("{workspace}: auto-reload failed: {error}"),
            }
        }
        Ok(done)
    }

    /// Reloads the workspace's AI credit if it is below its threshold.
    /// What was reloaded, or None.
    pub(crate) async fn reload_now(&self, workspace: &str) -> Result<Option<i64>> {
        let Some(stripe) = &self.stripe else { return Ok(None) };
        let reload = self.reload_settings(workspace).await?;
        let (balance, _, _) = self.ai_balance(workspace).await?;
        let Some(amount) = reload_amount(&reload, balance, reload.reloaded_micros) else {
            return Ok(None);
        };
        let Some(customer) = self.row(workspace).await?.and_then(|row| row.customer_id) else {
            self.reload_failed(workspace, None, amount, "the workspace has no saved card").await?;
            return Ok(None);
        };
        let method = match stripe.default_payment_method(&customer).await {
            Ok(Some(method)) => method,
            Ok(None) => {
                self.reload_failed(workspace, None, amount, "the workspace has no saved card").await?;
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let month = rfc3339(now_ms())[..7].to_owned();
        // One key per attempt: the month and how many reloads came before.
        // A retry after a crash is the same attempt, so the same payment.
        #[derive(Deserialize)]
        struct Count {
            n: Option<f64>,
        }
        let before = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM ai_reloads WHERE workspace = ? AND month = ? AND status = 'paid'")
            .bind(&[workspace.into(), month.as_str().into()])?
            .first::<Count>(None)
            .await?
            .and_then(|c| c.n)
            .unwrap_or(0.0) as u32;
        let key = format!("reload/{workspace}/{month}/{}", before + 1);
        let credit_cents = (amount / 10_000) as u32;
        let fee_cents = card_fee_cents(credit_cents, &self.card_fee().await?);
        self.db
            .prepare(
                "INSERT OR IGNORE INTO ai_reloads (id, workspace, month, amount_micros, fee_micros, status, created_at)
                 VALUES (?, ?, ?, ?, ?, 'pending', ?)",
            )
            .bind(&[
                key.as_str().into(),
                workspace.into(),
                month.as_str().into(),
                (amount as f64).into(),
                (f64::from(fee_cents) * 10_000.0).into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        let charge = crate::stripe::SavedCharge {
            workspace,
            customer: &customer,
            payment_method: &method.id,
            credit_cents,
            fee_cents,
            key: &key,
        };
        let paid = match stripe.charge_saved(&charge).await {
            Ok(intent) if intent["status"].as_str() == Some("succeeded") => intent["id"].as_str().map(str::to_owned),
            Ok(intent) => {
                let status = intent["status"].as_str().unwrap_or("unknown").to_owned();
                self.reload_failed(workspace, Some(&key), amount, &format!("the card needs the bank's approval ({status})")).await?;
                return Ok(None);
            }
            Err(error) if crate::stripe::is_card_error(&error) => {
                self.reload_failed(workspace, Some(&key), amount, &crate::stripe::friendly(&error)).await?;
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let Some(intent) = paid else { return Ok(None) };
        self.db
            .prepare("UPDATE ai_reloads SET status = 'paid', payment_intent = ? WHERE id = ?")
            .bind(&[intent.as_str().into(), key.as_str().into()])?
            .run()
            .await?;
        self.grant_purchased(workspace, &intent, amount, i64::from(fee_cents) * 10_000, "g1t", Some(&customer)).await?;
        Ok(Some(amount))
    }

    /// A reload that could not be charged: auto-reload is turned off, and
    /// the owners are told.
    async fn reload_failed(&self, workspace: &str, key: Option<&str>, amount: i64, why: &str) -> Result<()> {
        let now = rfc3339(now_ms());
        if let Some(key) = key {
            self.db
                .prepare("UPDATE ai_reloads SET status = 'failed', error = ? WHERE id = ?")
                .bind(&[why.into(), key.into()])?
                .run()
                .await?;
        }
        self.db
            .prepare("UPDATE ai_reload SET enabled = 0, failed_at = ?, error = ? WHERE workspace = ?")
            .bind(&[now.as_str().into(), why.into(), workspace.into()])?
            .run()
            .await?;
        let account = self.account_of(workspace).await?;
        self.audit(&account.id, "ai_reload_failed", &format!("{workspace}: auto-reload of {} failed ({why}); turned off", cents(amount)), "g1t")
            .await?;
        if let Some(identity) = &self.identity {
            crate::limits::notify_with(
                identity,
                workspace,
                &format!("g1t: auto-reload for {workspace} failed and is off"),
                &format!(
                    "g1t tried to reload {} of AI credit for {workspace} and could not: {why}. Auto-reload is off until an owner turns it on again. Until then, runs on g1t's models stop once the AI credit is spent."
                , cents(amount)),
                "Open billing",
                &format!("https://g1t.sh/{workspace}/-/billing#ai-credit"),
                "You get this because you own this workspace on g1t. AI credit is explained at https://docs.g1t.sh/guides/usage-and-billing/#ai-credit",
            )
            .await;
        }
        Ok(())
    }

    // --- The agent rate --------------------------------------------------------

    /// Charges a run's agent rate for the tokens counted since it was last
    /// charged, once each: when the run reports and again when it is
    /// settled, so tokens counted late are charged too.
    pub(crate) async fn charge_agent_rate(&self, run_id: &str, run: &RunRow) -> Result<()> {
        if self.stripe.is_none() {
            return Ok(());
        }
        #[derive(Deserialize)]
        struct Row {
            session_id: Option<String>,
            agent_tokens: Option<f64>,
            created_at: String,
        }
        let Some(row) = self
            .db
            .prepare("SELECT session_id, agent_tokens, created_at FROM runs WHERE id = ?")
            .bind(&[run_id.into()])?
            .first::<Row>(None)
            .await?
        else {
            return Ok(());
        };
        let Some(session) = row.session_id else { return Ok(()) };
        let counted = self
            .db
            .prepare(
                "SELECT SUM(input + output + cache_read + cache_write) AS micros FROM token_usage
                 WHERE workspace = ? AND session = ? AND day >= ?",
            )
            .bind(&[run.workspace.as_str().into(), session.as_str().into(), row.created_at[..10].into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0.0) as u64;
        let charged = row.agent_tokens.unwrap_or(0.0) as u64;
        if counted <= charged {
            return Ok(());
        }
        // Claimed first: two callers never charge the same tokens.
        let claimed = self
            .db
            .prepare("UPDATE runs SET agent_tokens = ?1 WHERE id = ?2 AND agent_tokens = ?3 RETURNING id")
            .bind(&[(counted as f64).into(), run_id.into(), (charged as f64).into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if claimed.is_none() {
            return Ok(());
        }
        let tokens = counted - charged;
        let base = agent_rate_micros(tokens, self.agent_rate().await?);
        // Before the rate takes effect: counted, and nothing charged.
        if base == 0 {
            return Ok(());
        }
        let (charge, terms_note, discount) = self.charged(&run.workspace, base).await?;
        let now = rfc3339(now_ms());
        let eligible = crate::credits::eligible_for(Some(g1t_contracts::billing::ComputeKind::Agent), None);
        let drawn = self.draw(&run.workspace, charge, &crate::credits::month_of(&now), &eligible).await?;
        let reference = if charged == 0 { format!("{run_id}/agent") } else { format!("{run_id}/agent/{counted}") };
        let what = match run.task.as_str() {
            "plan" => format!("planning for {}", run.repo),
            "review" => format!("the review of {}#{}", run.repo, run.number),
            "update" => format!("catching up {}#{}", run.repo, run.number),
            _ => format!("work on {}#{}", run.repo, run.number),
        };
        let description = format!(
            "g1t agent rate: {} tokens for {what}{terms_note}{}",
            crate::features::thousands(tokens),
            drawn.note()
        );
        self.enter(&run.workspace, EntryKind::Usage, -(charge - drawn.total()), &description, &reference, Some(run), Some(0), None, None)
            .await?;
        self.db
            .prepare("UPDATE ledger SET quantity = ?, price_version = ? WHERE reference = ?")
            .bind(&[(tokens as f64).into(), optional(self.version_now("agent_tokens").await?.as_deref()), reference.as_str().into()])?
            .run()
            .await?;
        self.record_drawn(&reference, &drawn).await?;
        self.record_discount(&reference, discount).await?;
        self.count_spend(&run.workspace, 0, charge - drawn.total(), &drawn).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fee(on: bool) -> CardFee {
        CardFee { on, percent_micros: 29_000.0, fixed_cents: 30 }
    }

    #[test]
    fn the_card_fee_is_stripes_fee_grossed_up_and_off_when_switched_off() {
        // $25 of credit: ($25 + $0.30) / 0.971 = $26.06, so a $1.06 fee.
        assert_eq!(card_fee_cents(2_500, &fee(true)), 106);
        // What is left after Stripe's 2.9% + 30¢ is at least the credit.
        for credit in [1_000u32, 2_500, 5_000, 10_000, 100_000] {
            let total = credit + card_fee_cents(credit, &fee(true));
            let net = f64::from(total) - (f64::from(total) * 0.029).round() - 30.0;
            assert!(net >= f64::from(credit) - 1.0, "{credit}: {total} leaves {net}");
        }
        assert_eq!(card_fee_cents(2_500, &fee(false)), 0);
        assert_eq!(card_fee_cents(0, &fee(true)), 0);
    }

    #[test]
    fn amounts_are_whole_dollars_from_ten_to_a_thousand() {
        assert!(amount_ok(1_000).is_ok() && amount_ok(100_000).is_ok() && amount_ok(2_500).is_ok());
        assert!(amount_ok(999).is_err() && amount_ok(100_100).is_err() && amount_ok(1_050).is_err());
    }

    fn reload(threshold: i64, target: i64, max: i64) -> AiReload {
        AiReload { enabled: true, threshold_micros: threshold, target_micros: target, monthly_max_micros: max, ..AiReload::default() }
    }

    const D: i64 = MICROS_PER_DOLLAR;

    #[test]
    fn auto_reload_tops_up_to_the_target_below_the_threshold_within_the_monthly_maximum() {
        let r = reload(10 * D, 25 * D, 100 * D);
        // Above the threshold: nothing.
        assert_eq!(reload_amount(&r, 10 * D, 0), None);
        // Below it: back to the target, in whole dollars.
        assert_eq!(reload_amount(&r, 9 * D, 0), Some(16 * D));
        assert_eq!(reload_amount(&r, 9_500_000, 0), Some(16 * D));
        // Owing more than the target is still a reload to the target.
        assert_eq!(reload_amount(&r, -3 * D, 0), Some(28 * D));
        // Never less than $10.
        assert_eq!(reload_amount(&reload(10 * D, 12 * D, 100 * D), 9 * D, 0), Some(10 * D));
        // The monthly maximum caps it, and below $10 of room nothing is done.
        assert_eq!(reload_amount(&r, 0, 90 * D), Some(10 * D));
        assert_eq!(reload_amount(&r, 0, 95 * D), None);
        assert_eq!(reload_amount(&r, 0, 100 * D), None);
    }

    #[test]
    fn a_failed_or_disabled_reload_does_nothing() {
        let off = AiReload { enabled: false, ..reload(10 * D, 25 * D, 100 * D) };
        assert_eq!(reload_amount(&off, 0, 0), None);
        let failed = AiReload { failed_at: Some("2026-10-08T00:00:00Z".into()), ..reload(10 * D, 25 * D, 100 * D) };
        assert_eq!(reload_amount(&failed, 0, 0), None);
    }

    #[test]
    fn auto_reload_settings_are_checked() {
        assert_eq!(reload_invalid(10 * D, 25 * D, 100 * D), None);
        assert!(reload_invalid(10 * D, 15 * D, 100 * D).is_some());
        assert!(reload_invalid(10 * D, 2_000 * D, 10_000 * D).is_some());
        assert!(reload_invalid(10 * D, 25 * D, 10 * D).is_some());
        assert!(reload_invalid(10 * D, 25 * D, 20_000 * D).is_some());
        assert!(reload_invalid(10 * D, 25_500_000, 100 * D).is_some());
        assert!(reload_invalid(-1, 25 * D, 100 * D).is_some());
    }

    #[test]
    fn the_agent_rate_is_per_million_tokens_rounded_up() {
        // $0.25 a million: 2 million tokens are 50 cents.
        assert_eq!(agent_rate_micros(2_000_000, 250_000.0), 500_000);
        assert_eq!(agent_rate_micros(1, 250_000.0), 1);
        assert_eq!(agent_rate_micros(0, 250_000.0), 0);
        // Before it takes effect the price book says 0.
        assert_eq!(agent_rate_micros(5_000_000, 0.0), 0);
    }

    #[test]
    fn only_workspaces_paying_on_the_plan_need_ai_credit() {
        assert!(needs_credit(PlanKind::Paid));
        assert!(!needs_credit(PlanKind::Internal));
        assert!(!needs_credit(PlanKind::Enterprise));
        assert!(!needs_credit(PlanKind::Free));
        assert!(out_of_credit_message("acme", false).contains("/acme/-/billing#ai-credit"));
        assert!(out_of_credit_message("acme", true).contains("Auto-reload was turned off"));
    }

    #[test]
    fn a_purchase_is_credited_only_once_paid_and_only_for_what_was_paid() {
        assert!(purchase_paid("paid", Some(2_606), 2_500).is_ok());
        assert!(purchase_paid("unpaid", Some(2_606), 2_500).unwrap_err().contains("not finished"));
        assert!(purchase_paid("paid", Some(2_000), 2_500).is_err());
        assert!(purchase_paid("paid", None, 2_500).is_err());
        // The grant's id is the page's id and the ledger's reference is
        // unique, and the checkout row is claimed open → paid before either
        // is written: the webhook and the person coming back credit once.
        let source = include_str!("ai.rs");
        assert!(source.contains("UPDATE checkouts SET status = 'paid' WHERE id = ? AND status = 'open' RETURNING id"));
        assert!(source.contains("INSERT OR IGNORE INTO credit_grants"));
    }

    #[test]
    fn the_upgrade_credit_is_one_grant_per_workspace() {
        assert_eq!(upgrade_reference("Acme"), upgrade_reference("acme"));
        assert!(upgrade_reference("acme").starts_with("crd"), "given, never a payment");
        assert_eq!(UPGRADE_CREDIT_MICROS, 5_000_000);
    }
}
