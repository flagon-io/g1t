//! How far a workspace can run up costs g1t has not been paid for.
//!
//! Every sandbox second, build, app request and model token costs g1t
//! money at Cloudflare or a model provider before the workspace pays for
//! it. So, like Fly or Cloudflare with new accounts, each workspace has a
//! ceiling on that unpaid usage, set by how much it has paid g1t before:
//!
//! - **New**: no live payment yet. A few dollars, enough for the free
//!   allowances and a little more.
//! - **Paid**: twice what it has paid g1t, within bounds.
//! - **Reviewed**: a ceiling g1t set by hand.
//! - **Internal**: g1t's own workspaces, with none.
//!
//! An owner can set a lower spend limit of their own. Past 80% the
//! workspace is warned; at the ceiling its work stops: no new sandboxes,
//! builds or app requests, until it pays or the month turns. Runs already
//! under way finish.
//!
//! Usage counts at what it cost g1t or what it is charged, whichever is
//! more, so it counts while g1t is free too: free is a price, not an
//! exemption from the ceiling. Test-mode payments are not money, so they
//! do not raise trust.

use g1t_contracts::billing::{CheckLimitArgs, Limit, LimitArgs, NotePendingArgs, TermsKind, LimitState, SetSpendLimitArgs, Trust};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{Env, Result};

use crate::features::dollars as dollars_plain;
use crate::{Billing, members_only};

/// The ceilings, from the billing service's variables.
pub(crate) struct Ceilings {
    /// `LIMIT_NEW_MICROS`.
    pub new: i64,
    /// `LIMIT_PAID_MIN_MICROS` and `LIMIT_PAID_MAX_MICROS`.
    pub paid_min: i64,
    pub paid_max: i64,
}

impl Ceilings {
    pub(crate) fn from_env(env: &Env) -> Self {
        let number = |name: &str, default: i64| {
            env.var(name).ok().and_then(|v| v.to_string().parse::<i64>().ok()).unwrap_or(default)
        };
        Ceilings {
            new: number("LIMIT_NEW_MICROS", 3_000_000),
            paid_min: number("LIMIT_PAID_MIN_MICROS", 25_000_000),
            paid_max: number("LIMIT_PAID_MAX_MICROS", 1_000_000_000),
        }
    }

    /// The ceiling for a workspace that has paid `paid` in live money.
    pub(crate) fn for_paid(&self, paid: i64) -> i64 {
        (paid * 2).clamp(self.paid_min, self.paid_max)
    }
}

/// Where a workspace stands against its ceiling.
pub(crate) fn state(exposure: i64, ceiling: Option<i64>) -> LimitState {
    match ceiling {
        Some(ceiling) if exposure >= ceiling => LimitState::Stopped,
        Some(ceiling) if exposure * 5 >= ceiling * 4 => LimitState::Warning,
        _ => LimitState::Ok,
    }
}

/// Never charged automatically for less.
const AUTOPAY_MIN_CENTS: i64 = 500;

#[derive(Deserialize)]
struct LimitRow {
    spend_limit_micros: Option<i64>,
    autopay_failed_at: Option<String>,
    autopay_error: Option<String>,
}

#[derive(Deserialize)]
struct Month {
    used: Option<i64>,
    paid: Option<i64>,
}

#[derive(Deserialize)]
struct Paid {
    paid: Option<i64>,
}

impl Billing {
    /// The workspace's limit, worked out from the ledger of the account
    /// that pays for it: its own, or its enterprise's, whose workspaces'
    /// usage and payments count together.
    pub(crate) async fn limit_of(&self, workspace: &str) -> Result<Limit> {
        let workspace = workspace.to_lowercase();
        let account = self.account_of(&workspace).await?;
        let row = self
            .db
            .prepare("SELECT spend_limit_micros, autopay_failed_at, autopay_error FROM limits WHERE workspace = ?")
            .bind(&[workspace.as_str().into()])?
            .first::<LimitRow>(None)
            .await?;
        let month_start = format!("{}-01", &rfc3339(now_ms())[..7]);
        let marks = vec!["?"; account.workspaces.len().max(1)].join(", ");
        let members: Vec<JsValue> = if account.workspaces.is_empty() {
            vec![JsValue::from(workspace.as_str())]
        } else {
            account.workspaces.iter().map(|w| JsValue::from(w.as_str())).collect()
        };
        let mut with_month = members.clone();
        with_month.push(month_start.as_str().into());
        // Each usage entry at its cost to g1t or its charge, whichever is
        // more; on the workspace's own provider, only g1t's fee is g1t's.
        let month = self
            .db
            .prepare(format!(
                "SELECT
                   SUM(CASE WHEN kind = 'usage' THEN
                         CASE WHEN COALESCE(billed_to, 'g1t') = 'g1t'
                              THEN MAX(COALESCE(cost_micros, 0), -amount_micros)
                              ELSE -amount_micros END
                       END) AS used,
                   SUM(CASE WHEN kind = 'top_up' THEN amount_micros END) AS paid
                 FROM ledger WHERE workspace IN ({marks}) AND created_at >= ?"
            ))
            .bind(&with_month)?
            .first::<Month>(None)
            .await?;
        let (used, paid_month) = month.map_or((0, 0), |m| (m.used.unwrap_or(0), m.paid.unwrap_or(0)));
        // And what is metered but not charged until the month closes.
        let mut pending_args = members.clone();
        pending_args.push(month_start[..7].into());
        let pending = self
            .db
            .prepare(format!(
                "SELECT SUM(charge_micros) AS paid FROM pending_usage WHERE workspace IN ({marks}) AND month = ?"
            ))
            .bind(&pending_args)?
            .first::<Paid>(None)
            .await?
            .and_then(|row| row.paid)
            .unwrap_or(0);
        let used = used + pending;
        // Test-mode payments are not money: they pay nothing off.
        let live = self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live);
        // Charges from earlier months still unpaid carry over, so a new
        // month is not a fresh allowance for an account that never pays.
        // Credits g1t gave count as paid; test-mode payments do not.
        let mut before = members.clone();
        before.push(month_start.as_str().into());
        let carried = self
            .db
            .prepare(format!(
                "SELECT SUM(CASE WHEN kind = 'usage' THEN amount_micros
                                 WHEN kind = 'top_up' AND ({live} = 1 OR reference LIKE 'crd%') THEN amount_micros
                                 ELSE 0 END) AS paid
                 FROM ledger WHERE workspace IN ({marks}) AND created_at < ?",
                live = u8::from(live)
            ))
            .bind(&before)?
            .first::<Paid>(None)
            .await?
            .and_then(|row| row.paid)
            .map_or(0, |balance| (-balance).max(0));
        let exposure = (used - if live { paid_month } else { 0 }).max(0) + carried;

        let (trust, trust_ceiling) = match account.terms.kind {
            TermsKind::Comped => (Trust::Internal, None),
            _ if account.terms.ceiling_micros.is_some() => (Trust::Reviewed, account.terms.ceiling_micros),
            _ => {
                let paid = self.live_paid(&members).await?;
                if paid > 0 {
                    (Trust::Paid, Some(self.ceilings.for_paid(paid)))
                } else {
                    (Trust::New, Some(self.ceilings.new))
                }
            }
        };
        let spend_limit = row.as_ref().and_then(|row| row.spend_limit_micros);
        // A card declined when g1t charged it at the limit stops work until
        // it is paid; any payment clears it.
        let declined = row.as_ref().and_then(|row| row.autopay_failed_at.clone().map(|at| (at, row.autopay_error.clone())));
        let ceiling = match (trust_ceiling, spend_limit) {
            (Some(ceiling), Some(own)) => Some(ceiling.min(own)),
            (None, Some(own)) => Some(own),
            (ceiling, None) => ceiling,
        };
        let state = if declined.is_some() && exposure > 0 { LimitState::Stopped } else { state(exposure, ceiling) };
        let who = if account.kind == g1t_contracts::billing::AccountKind::Enterprise {
            format!("The {} enterprise, which pays for {workspace},", account.name)
        } else {
            format!("The {workspace} workspace")
        };
        let message = match state {
            LimitState::Ok => None,
            LimitState::Warning => Some(format!(
                "{who} has used {} of its {} limit this month. At the limit, its sandboxes, builds and apps stop until it pays or the month turns.",
                dollars_plain(exposure),
                dollars_plain(ceiling.unwrap_or_default()),
            )),
            LimitState::Stopped if declined.is_some() => Some(format!(
                "{who} could not be charged for its usage ({}), so its sandboxes, builds and apps are stopped. An owner can pay under Billing with another card.",
                declined.as_ref().and_then(|(_, error)| error.clone()).unwrap_or_else(|| "the card was declined".to_owned()),
            )),
            LimitState::Stopped => Some(if spend_limit.is_some() && ceiling == spend_limit {
                format!(
                    "The {workspace} workspace reached the {} spend limit its owners set for this month, so its sandboxes, builds and apps are stopped. An owner can raise it under Billing.",
                    dollars_plain(ceiling.unwrap_or_default()),
                )
            } else {
                format!(
                    "{who} reached its {} limit for usage not yet paid for, so its sandboxes, builds and apps are stopped. The limit grows as a workspace pays g1t; an owner can pay under Billing, or write to support to have it raised.",
                    dollars_plain(ceiling.unwrap_or_default()),
                )
            }),
        };
        Ok(Limit {
            workspace,
            account: account.id,
            account_name: account.name,
            trust,
            exposure_micros: exposure,
            ceiling_micros: ceiling,
            trust_ceiling_micros: trust_ceiling,
            spend_limit_micros: spend_limit,
            state,
            message,
        })
    }

    /// Real money the workspaces have paid g1t. Nothing in test mode, and
    /// credits g1t gave are not payments.
    async fn live_paid(&self, members: &[JsValue]) -> Result<i64> {
        if !self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live) {
            return Ok(0);
        }
        let marks = vec!["?"; members.len().max(1)].join(", ");
        Ok(self
            .db
            .prepare(format!(
                "SELECT SUM(amount_micros) AS paid FROM ledger
                 WHERE workspace IN ({marks}) AND kind = 'top_up' AND reference NOT LIKE 'crd%'"
            ))
            .bind(members)?
            .first::<Paid>(None)
            .await?
            .and_then(|row| row.paid)
            .unwrap_or(0))
    }

    /// A refusal, with the reason, when the workspace's work is stopped.
    /// None while billing is off: a g1t without payments has no limits.
    pub(crate) async fn stopped<T>(&self, workspace: &str) -> Result<Option<Outcome<T>>> {
        if self.stripe.is_none() {
            return Ok(None);
        }
        let limit = self.limit_of(workspace).await?;
        Ok((limit.state == LimitState::Stopped).then(|| {
            Outcome::fail(
                FailureCode::PaymentRequired,
                limit.message.unwrap_or_else(|| "This workspace is over its limit.".to_owned()),
            )
        }))
    }

    pub(crate) async fn limit(&self, a: LimitArgs) -> Result<Outcome<Limit>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        Ok(Outcome::Ok(self.limit_of(&workspace).await?))
    }

    pub(crate) async fn note_pending(&self, a: NotePendingArgs) -> Result<bool> {
        let now = rfc3339(now_ms());
        let charge = crate::charge_micros(a.cost_micros.max(0) as f64 / g1t_contracts::billing::MICROS_PER_DOLLAR as f64, self.margin_percent);
        self.db
            .prepare(
                "INSERT INTO pending_usage (workspace, source, month, charge_micros, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (workspace, source, month) DO UPDATE SET charge_micros = ?4, updated_at = ?5",
            )
            .bind(&[
                a.workspace.to_lowercase().into(),
                a.source.as_str().into(),
                now[..7].into(),
                (charge as f64).into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(true)
    }

    /// Charges the saved card of each workspace nearing its limit, for what
    /// it owes, so that a workspace that pays never has its work stopped.
    /// Only with live payments: test-mode payments are not money and lower
    /// nothing. Not for a workspace's own spend limit, which means stop, nor
    /// for enterprises, which are invoiced.
    pub(crate) async fn autopay(&self) -> Result<()> {
        let Some(stripe) = self.stripe.as_ref().filter(|stripe| stripe.live()) else {
            return Ok(());
        };
        #[derive(Deserialize)]
        struct Candidate {
            workspace: String,
            customer_id: Option<String>,
        }
        let month_start = format!("{}-01", &rfc3339(now_ms())[..7]);
        let candidates = self
            .db
            .prepare(
                "SELECT DISTINCT ledger.workspace AS workspace, accounts.customer_id AS customer_id
                 FROM ledger JOIN accounts ON accounts.workspace = ledger.workspace
                 WHERE ledger.kind = 'usage' AND ledger.created_at >= ? AND accounts.customer_id IS NOT NULL",
            )
            .bind(&[month_start.as_str().into()])?
            .all()
            .await?
            .results::<Candidate>()?;
        for candidate in candidates {
            let Some(customer) = candidate.customer_id else { continue };
            let limit = self.limit_of(&candidate.workspace).await?;
            let own_limit = limit.spend_limit_micros.is_some() && limit.ceiling_micros == limit.spend_limit_micros;
            if limit.state == LimitState::Ok
                || own_limit
                || limit.trust == Trust::Internal
                || limit.account.starts_with("ent_")
            {
                continue;
            }
            // What it owes: its charges less what it has paid, never the cost
            // of what was free to it. At least the minimum, which is credit
            // toward what comes next.
            let balance = self.row(&candidate.workspace).await?.map_or(0, |row| row.balance_micros);
            let owed = (-balance).max(0);
            if owed == 0 {
                continue;
            }
            let cents = ((owed + 9_999) / 10_000).max(AUTOPAY_MIN_CENTS);
            let key = format!("autopay/{}/{}/{}", candidate.workspace, &month_start[..7], owed / 1_000_000);
            let description = format!("g1t usage for {}, paid automatically near its limit", candidate.workspace);
            let now = rfc3339(now_ms());
            match stripe.charge_saved_card(&customer, cents, &description, &key).await {
                Ok(payment) if payment.status == "succeeded" => {
                    // A retried charge is the same payment: credited once.
                    let seen = self
                        .db
                        .prepare("SELECT id FROM ledger WHERE reference = ?")
                        .bind(&[payment.id.as_str().into()])?
                        .first::<serde_json::Value>(None)
                        .await?;
                    if seen.is_some() {
                        continue;
                    }
                    self.enter(
                        &candidate.workspace,
                        g1t_contracts::billing::EntryKind::TopUp,
                        payment.amount_received.max(cents) * 10_000,
                        &format!("Paid automatically by card, near the {} limit", dollars_plain(limit.ceiling_micros.unwrap_or_default())),
                        &payment.id,
                        None,
                        None,
                        None,
                        Some(&customer),
                    )
                    .await?;
                    self.db
                        .prepare("UPDATE limits SET autopay_failed_at = NULL, autopay_error = NULL WHERE workspace = ?")
                        .bind(&[candidate.workspace.as_str().into()])?
                        .run()
                        .await?;
                }
                outcome => {
                    let error = match outcome {
                        Ok(payment) => format!("the payment is {}", payment.status.replace('_', " ")),
                        Err(error) => error.to_string().chars().take(200).collect(),
                    };
                    self.db
                        .prepare(
                            "INSERT INTO limits (workspace, autopay_failed_at, autopay_error, updated_at) VALUES (?1, ?2, ?3, ?2)
                             ON CONFLICT (workspace) DO UPDATE SET autopay_failed_at = ?2, autopay_error = ?3, updated_at = ?2",
                        )
                        .bind(&[candidate.workspace.as_str().into(), now.as_str().into(), error.as_str().into()])?
                        .run()
                        .await?;
                }
            }
        }
        Ok(())
    }

    /// Closes last month for each workspace with a card on file: charges
    /// what it owed when the month ended. Live payments only, once per
    /// workspace and month; a declined card stops work until it is paid.
    /// Comped workspaces owe nothing, and enterprises are invoiced.
    pub(crate) async fn close_months(&self) -> Result<()> {
        let Some(stripe) = self.stripe.as_ref().filter(|stripe| stripe.live()) else {
            return Ok(());
        };
        let now = rfc3339(now_ms());
        let month_start = format!("{}-01", &now[..7]);
        let closing = previous_month(&now[..7]);
        #[derive(Deserialize)]
        struct Open {
            workspace: String,
            customer_id: String,
            balance: Option<i64>,
        }
        let open = self
            .db
            .prepare(
                "SELECT accounts.workspace AS workspace, accounts.customer_id AS customer_id,
                        (SELECT SUM(amount_micros) FROM ledger
                          WHERE ledger.workspace = accounts.workspace AND ledger.created_at < ?1) AS balance
                 FROM accounts
                 WHERE accounts.customer_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM month_closes
                                    WHERE month_closes.workspace = accounts.workspace AND month_closes.month = ?2)
                 LIMIT 20",
            )
            .bind(&[month_start.as_str().into(), closing.as_str().into()])?
            .all()
            .await?
            .results::<Open>()?;
        for account in open {
            let record = |status: &str, amount: i64, payment: Option<&str>, error: Option<&str>| {
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO month_closes (workspace, month, status, amount_micros, payment_id, error, closed_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        account.workspace.as_str().into(),
                        closing.as_str().into(),
                        status.into(),
                        (amount as f64).into(),
                        crate::optional(payment),
                        crate::optional(error),
                        now.as_str().into(),
                    ])
            };
            let payer = self.account_of(&account.workspace).await?;
            if payer.terms.kind == TermsKind::Comped || payer.id.starts_with("ent_") {
                record("skipped", 0, None, None)?.run().await?;
                continue;
            }
            let owed = (-account.balance.unwrap_or(0)).max(0);
            if owed < 10_000 {
                // Under a cent: nothing worth charging.
                record("nothing", 0, None, None)?.run().await?;
                continue;
            }
            let cents = (owed + 9_999) / 10_000;
            let key = format!("close/{}/{closing}", account.workspace);
            let description = format!("g1t usage for {} in {closing}", account.workspace);
            match stripe.charge_saved_card(&account.customer_id, cents, &description, &key).await {
                Ok(payment) if payment.status == "succeeded" => {
                    let seen = self
                        .db
                        .prepare("SELECT id FROM ledger WHERE reference = ?")
                        .bind(&[payment.id.as_str().into()])?
                        .first::<serde_json::Value>(None)
                        .await?;
                    if seen.is_none() {
                        self.enter(
                            &account.workspace,
                            g1t_contracts::billing::EntryKind::TopUp,
                            payment.amount_received.max(cents) * 10_000,
                            &format!("Usage for {closing}, charged to the card on file when the month closed"),
                            &payment.id,
                            None,
                            None,
                            None,
                            Some(&account.customer_id),
                        )
                        .await?;
                    }
                    record("paid", cents * 10_000, Some(&payment.id), None)?.run().await?;
                }
                outcome => {
                    let error = match outcome {
                        Ok(payment) => format!("the payment is {}", payment.status.replace('_', " ")),
                        Err(error) => error.to_string().chars().take(200).collect(),
                    };
                    self.db
                        .prepare(
                            "INSERT INTO limits (workspace, autopay_failed_at, autopay_error, updated_at) VALUES (?1, ?2, ?3, ?2)
                             ON CONFLICT (workspace) DO UPDATE SET autopay_failed_at = ?2, autopay_error = ?3, updated_at = ?2",
                        )
                        .bind(&[account.workspace.as_str().into(), now.as_str().into(), error.as_str().into()])?
                        .run()
                        .await?;
                    record("failed", cents * 10_000, None, Some(&error))?.run().await?;
                }
            }
        }
        Ok(())
    }

    /// Emails a workspace's owners as it passes 50%, 80% and 100% of its
    /// limit, once each a month, and when its card was declined, so that
    /// work never stops without warning.
    pub(crate) async fn warn_limits(&self, identity: &worker::Fetcher) -> Result<()> {
        if self.stripe.is_none() {
            return Ok(());
        }
        let now = rfc3339(now_ms());
        let month = &now[..7];
        #[derive(Deserialize)]
        struct Candidate {
            workspace: String,
        }
        let candidates = self
            .db
            .prepare(
                "SELECT DISTINCT workspace FROM ledger WHERE kind = 'usage' AND created_at >= ?1
                 UNION SELECT workspace FROM limits WHERE autopay_failed_at IS NOT NULL",
            )
            .bind(&[format!("{month}-01").into()])?
            .all()
            .await?
            .results::<Candidate>()?;
        #[derive(Deserialize)]
        struct Told {
            warned_month: Option<String>,
            warned_level: Option<i64>,
            autopay_failed_at: Option<String>,
            declined_told_at: Option<String>,
        }
        for Candidate { workspace } in candidates {
            let limit = self.limit_of(&workspace).await?;
            let told = self
                .db
                .prepare("SELECT warned_month, warned_level, autopay_failed_at, declined_told_at FROM limits WHERE workspace = ?")
                .bind(&[workspace.as_str().into()])?
                .first::<Told>(None)
                .await?;
            let billing = format!("https://g1t.sh/{workspace}/-/billing");

            // A declined card, once per decline.
            if let Some(Told { autopay_failed_at: Some(failed), declined_told_at, .. }) = &told {
                if declined_told_at.as_deref().is_none_or(|at| at < failed.as_str()) {
                    let sent = notify(
                        identity,
                        &workspace,
                        &format!("g1t: the card for {workspace} was declined"),
                        &limit.message.clone().unwrap_or_else(|| format!("g1t could not charge the card on file for {workspace}.")),
                        "Update the card",
                        &billing,
                    )
                    .await;
                    if sent {
                        self.db
                            .prepare("UPDATE limits SET declined_told_at = ? WHERE workspace = ?")
                            .bind(&[now.as_str().into(), workspace.as_str().into()])?
                            .run()
                            .await?;
                    }
                }
            }

            let Some(ceiling) = limit.ceiling_micros.filter(|c| *c > 0) else { continue };
            let level = warning_level(limit.exposure_micros, ceiling);
            let already = told
                .as_ref()
                .filter(|t| t.warned_month.as_deref() == Some(month))
                .and_then(|t| t.warned_level)
                .unwrap_or(0);
            if level <= already {
                continue;
            }
            let (subject, intro) = match level {
                100 => (
                    format!("g1t: {workspace} reached its usage limit"),
                    limit.message.clone().unwrap_or_else(|| format!("{workspace} reached its usage limit.")),
                ),
                _ => (
                    format!("g1t: {workspace} has used {level}% of its usage limit"),
                    format!(
                        "{workspace} has used {} of its {} usage limit this month. At the limit its sandboxes, builds and apps stop until it pays or the month turns. With a card on file, g1t charges it as the limit nears, so work keeps going.",
                        dollars_plain(limit.exposure_micros),
                        dollars_plain(ceiling),
                    ),
                ),
            };
            if notify(identity, &workspace, &subject, &intro, "Open billing", &billing).await {
                self.db
                    .prepare(
                        "INSERT INTO limits (workspace, warned_month, warned_level, updated_at) VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (workspace) DO UPDATE SET warned_month = ?2, warned_level = ?3, updated_at = ?4",
                    )
                    .bind(&[workspace.as_str().into(), month.into(), (level as f64).into(), now.as_str().into()])?
                    .run()
                    .await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn check_limit(&self, a: CheckLimitArgs) -> Result<Outcome<Limit>> {
        Ok(Outcome::Ok(self.limit_of(&a.workspace).await?))
    }

    pub(crate) async fn set_spend_limit(&self, a: SetSpendLimitArgs) -> Result<Outcome<Limit>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can set the workspace's spend limit.",
            ));
        }
        if a.spend_limit_micros.is_some_and(|limit| limit < 0) {
            return Ok(Outcome::fail(FailureCode::Invalid, "A spend limit cannot be negative."));
        }
        let limit = a.spend_limit_micros.map_or(JsValue::NULL, |limit| (limit as f64).into());
        self.db
            .prepare(
                "INSERT INTO limits (workspace, spend_limit_micros, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (workspace) DO UPDATE SET spend_limit_micros = ?2, updated_at = ?3",
            )
            .bind(&[workspace.as_str().into(), limit, rfc3339(now_ms()).into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(self.limit_of(&workspace).await?))
    }
}

/// Which warning a workspace has reached: 100, 80, 50 or none (0).
pub(crate) fn warning_level(exposure: i64, ceiling: i64) -> i64 {
    if exposure >= ceiling {
        100
    } else if exposure * 5 >= ceiling * 4 {
        80
    } else if exposure * 2 >= ceiling {
        50
    } else {
        0
    }
}

/// Emails the workspace's owners through identity. False if nothing was sent.
async fn notify(identity: &worker::Fetcher, workspace: &str, subject: &str, intro: &str, action: &str, link: &str) -> bool {
    let args = g1t_contracts::identity::NotifyOwnersArgs {
        workspace: workspace.to_owned(),
        subject: subject.to_owned(),
        intro: intro.to_owned(),
        action: action.to_owned(),
        link: link.to_owned(),
        footer: "You get this because you own this workspace on g1t. Usage limits are explained at https://docs.g1t.sh/guides/usage-and-billing/#usage-limits".to_owned(),
    };
    match g1t_kit::call::<_, u32>(identity, "notify_owners", &args).await {
        Ok(sent) => sent > 0,
        Err(error) => {
            worker::console_error!("could not tell {workspace}'s owners: {error}");
            false
        }
    }
}

/// `2026-09` for `2026-10`, and `2025-12` for `2026-01`.
pub(crate) fn previous_month(month: &str) -> String {
    let year: i32 = month[..4].parse().unwrap_or(1970);
    let number: u32 = month[5..7].parse().unwrap_or(1);
    if number == 1 {
        format!("{}-12", year - 1)
    } else {
        format!("{year}-{:02}", number - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warnings_come_at_half_four_fifths_and_the_limit() {
        assert_eq!(warning_level(0, 300), 0);
        assert_eq!(warning_level(149, 300), 0);
        assert_eq!(warning_level(150, 300), 50);
        assert_eq!(warning_level(240, 300), 80);
        assert_eq!(warning_level(300, 300), 100);
    }

    #[test]
    fn the_month_before_wraps_the_year() {
        assert_eq!(previous_month("2026-10"), "2026-09");
        assert_eq!(previous_month("2026-01"), "2025-12");
    }

    fn ceilings() -> Ceilings {
        Ceilings { new: 3_000_000, paid_min: 25_000_000, paid_max: 1_000_000_000 }
    }

    #[test]
    fn trust_grows_with_what_was_paid_within_bounds() {
        assert_eq!(ceilings().for_paid(5_000_000), 25_000_000);
        assert_eq!(ceilings().for_paid(100_000_000), 200_000_000);
        assert_eq!(ceilings().for_paid(10_000_000_000), 1_000_000_000);
    }

    #[test]
    fn work_warns_at_eighty_percent_and_stops_at_the_ceiling() {
        assert_eq!(state(0, Some(100)), LimitState::Ok);
        assert_eq!(state(79, Some(100)), LimitState::Ok);
        assert_eq!(state(80, Some(100)), LimitState::Warning);
        assert_eq!(state(100, Some(100)), LimitState::Stopped);
        assert_eq!(state(1_000_000, None), LimitState::Ok);
    }
}
