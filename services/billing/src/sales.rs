//! What g1t's team needs to sell and support: month-by-month figures, the
//! signals that say a workspace is worth a call, and what was done about
//! it. Staff only, through sudo.g1t.sh.

use g1t_contracts::billing::{
    AdminAddNoteArgs, AdminOverviewArgs, AdminOveragesArgs, AdminSalesArgs, AdminSetSalesArgs, AdminSignalsArgs, GivenFigures,
    InternalUse, KindFigures, LimitState, MonthFigures, Overview, SalesNote, SalesRecord, Signal, SignalKind, TermsKind, Trust,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Billing;
use crate::features::dollars;
use crate::limits::previous_month;

pub(crate) const STAGES: &[&str] = &["none", "lead", "contacted", "negotiating", "won", "lost", "churn_risk"];

/// A workspace this much ahead of last month's pace is growing.
const GROWING_FACTOR: f64 = 1.5;
/// Below this last month, growth is noise.
const GROWING_FROM_MICROS: i64 = 10_000_000;
/// Spending this much a month may suit custom terms or an enterprise.
const HIGH_SPEND_MICROS: i64 = 500_000_000;

/// The six months ending with `month`, oldest first.
pub(crate) fn last_months(month: &str, count: usize) -> Vec<String> {
    let mut months = vec![month.to_owned()];
    while months.len() < count {
        let earlier = previous_month(months.last().unwrap());
        months.push(earlier);
    }
    months.reverse();
    months
}

/// How urgent a kind of signal is: lower first.
fn urgency(kind: SignalKind) -> u8 {
    match kind {
        SignalKind::AtLimit => 0,
        SignalKind::Declined => 1,
        SignalKind::NearCeiling => 2,
        SignalKind::CostOverRevenue => 2,
        SignalKind::HighSpend => 3,
        SignalKind::Growing => 4,
        SignalKind::Established => 5,
        SignalKind::FirstPayment => 6,
    }
}

/// Whether this month, at its pace so far, is well ahead of last month.
pub(crate) fn growing(this_month: i64, last_month: i64, day: u32, days_in_month: u32) -> bool {
    if last_month < GROWING_FROM_MICROS || day == 0 {
        return false;
    }
    let pace = this_month as f64 * f64::from(days_in_month) / f64::from(day);
    pace >= last_month as f64 * GROWING_FACTOR
}

fn days_in(month: &str) -> u32 {
    let year: i32 = month[..4].parse().unwrap_or(1970);
    match month[5..7].parse::<u32>().unwrap_or(1) {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// An account row on a 100% discount (`Terms::full_discount`), as SQL:
/// `custom` terms at 100%, or `comped` from before discounts.
pub(crate) const FULL_DISCOUNT_SQL: &str = "(terms_kind = 'comped' OR (terms_kind = 'custom' AND discount_percent >= 100))";

/// The workspaces g1t does not charge (a 100% discount): its own and
/// Flagon's, and any enterprise on one. Their usage is recorded at its
/// price, discounted in full, and shown as given, apart from margin.
pub(crate) const INTERNAL_SQL: &str = "SELECT substr(id, 4) FROM billing_accounts
       WHERE kind = 'workspace' AND (terms_kind = 'comped' OR (terms_kind = 'custom' AND discount_percent >= 100))
     UNION SELECT m.workspace FROM account_members m JOIN billing_accounts b ON b.id = m.account_id
       WHERE b.terms_kind = 'comped' OR (b.terms_kind = 'custom' AND b.discount_percent >= 100)";

/// One group of ledger rows in a month, as sudo's figures add them up.
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct LedgerGroup {
    pub month: String,
    /// `usage` or `top_up`.
    pub kind: String,
    /// `g1t`, or `workspace` for a run on the workspace's own provider.
    pub billed_to: Option<String>,
    /// A credit from g1t rather than a payment (`crd…`), and of those, one
    /// given away (promotional or goodwill, not a refund), less what of it
    /// expired or was revoked.
    pub credit: i64,
    pub goodwill: i64,
    /// One of g1t's own workspaces (comped).
    pub internal: i64,
    pub amount: Option<i64>,
    pub cost: Option<i64>,
    /// What the trial, the open-source pool and g1t itself paid.
    pub pools: Option<i64>,
}

/// A month's figures from its ledger groups and the plan's price paid.
///
/// - **Cost** is only what g1t paid: a run on the workspace's own model
///   provider was paid for there, so its cost is never g1t's.
/// - **Given** is what g1t gave at price, apart from its margin: internal
///   use (its cost plus the margin, since nothing was charged), what the
///   trial, the open-source pool and g1t itself paid, and promotional and
///   goodwill credits as they are given (a refund gives money back).
/// - **Paid** is money in: payments, never credits from g1t.
pub(crate) fn fold_month(month: &str, groups: &[LedgerGroup], plans: i64, margin_percent: u32) -> MonthFigures {
    let mut figures = MonthFigures { month: month.to_owned(), plans_micros: plans, ..MonthFigures::default() };
    for g in groups.iter().filter(|g| g.month == month) {
        let amount = g.amount.unwrap_or(0);
        let own_provider = g.billed_to.as_deref() == Some("workspace");
        if g.kind == "usage" {
            figures.charged_micros += -amount;
            if !own_provider {
                let cost = g.cost.unwrap_or(0);
                figures.cost_micros += cost;
                if g.internal == 1 {
                    figures.given_micros += crate::credits::with_margin(cost, margin_percent);
                }
            }
            figures.given_micros += g.pools.unwrap_or(0);
        } else if g.credit == 0 {
            figures.paid_micros += amount;
        } else if g.goodwill == 1 {
            figures.given_micros += amount;
        }
    }
    figures
}

#[derive(Deserialize)]
struct RecordRow {
    stage: String,
    owner: Option<String>,
    next_step: Option<String>,
    next_at: Option<String>,
    updated_at: String,
}

#[derive(Deserialize)]
struct NoteRow {
    id: String,
    text: String,
    by: String,
    created_at: String,
}

impl Billing {
    /// Month-by-month figures for some workspaces (all, when empty): usage
    /// charged, what it cost g1t (never a workspace's own provider), money
    /// paid, the plan's price paid, and what g1t gave.
    pub(crate) async fn months_for(&self, workspaces: &[String], count: usize) -> Result<Vec<MonthFigures>> {
        let months = last_months(&rfc3339(now_ms())[..7], count);
        let since = format!("{}-01", months[0]);
        let (filter, values): (String, Vec<JsValue>) = if workspaces.is_empty() {
            (String::new(), vec![])
        } else {
            let marks = vec!["?"; workspaces.len()].join(", ");
            (format!("AND workspace IN ({marks})"), workspaces.iter().map(|w| JsValue::from(w.as_str())).collect())
        };
        let groups = self
            .db
            .prepare(format!(
                "SELECT substr(created_at, 1, 7) AS month, kind, COALESCE(billed_to, 'g1t') AS billed_to,
                        CASE WHEN reference LIKE 'crd%' THEN 1 ELSE 0 END AS credit,
                        CASE WHEN credit_kind IN ('promotional', 'goodwill') THEN 1 ELSE 0 END AS goodwill,
                        CASE WHEN workspace IN ({INTERNAL_SQL}) THEN 1 ELSE 0 END AS internal,
                        SUM(amount_micros) AS amount, SUM(cost_micros) AS cost,
                        SUM(trial_micros + oss_micros + given_micros) AS pools
                 FROM ledger WHERE created_at >= '{since}' {filter} GROUP BY 1, 2, 3, 4, 5, 6",
            ))
            .bind(&values)?
            .all()
            .await?
            .results::<LedgerGroup>()?;
        #[derive(Deserialize)]
        struct Plans {
            month: String,
            micros: Option<i64>,
        }
        let plans = self
            .db
            .prepare(format!(
                "SELECT substr(paid_at, 1, 7) AS month, SUM(amount_micros) AS micros FROM plan_payments
                 WHERE paid_at >= '{since}' {filter} GROUP BY 1"
            ))
            .bind(&values)?
            .all()
            .await?
            .results::<Plans>()?;
        Ok(months
            .into_iter()
            .map(|month| {
                let paid_plans = plans.iter().find(|p| p.month == month).and_then(|p| p.micros).unwrap_or(0);
                fold_month(&month, &groups, paid_plans, self.margin_percent)
            })
            .collect())
    }

    async fn record_row(&self, workspace: &str) -> Result<Option<RecordRow>> {
        self.db
            .prepare("SELECT * FROM sales_records WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<RecordRow>(None)
            .await
    }

    pub(crate) async fn admin_sales(&self, a: AdminSalesArgs) -> Result<SalesRecord> {
        let workspace = a.workspace.trim().to_lowercase();
        let row = self.record_row(&workspace).await?;
        let notes = self
            .db
            .prepare("SELECT id, text, by, created_at FROM sales_notes WHERE workspace = ? ORDER BY created_at DESC LIMIT 100")
            .bind(&[workspace.as_str().into()])?
            .all()
            .await?
            .results::<NoteRow>()?
            .into_iter()
            .map(|n| SalesNote { id: n.id, text: n.text, by: n.by, created_at: n.created_at })
            .collect();
        Ok(match row {
            Some(row) => SalesRecord {
                workspace,
                stage: row.stage,
                owner: row.owner,
                next_step: row.next_step,
                next_at: row.next_at,
                notes,
                updated_at: Some(row.updated_at),
            },
            None => SalesRecord {
                workspace,
                stage: "none".to_owned(),
                owner: None,
                next_step: None,
                next_at: None,
                notes,
                updated_at: None,
            },
        })
    }

    pub(crate) async fn admin_set_sales(&self, a: AdminSetSalesArgs) -> Result<Outcome<SalesRecord>> {
        let workspace = a.workspace.trim().to_lowercase();
        if workspace.is_empty() || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace, and who is making the change."));
        }
        if !STAGES.contains(&a.stage.as_str()) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("A stage is one of: {}.", STAGES.join(", "))));
        }
        let clean = |value: &Option<String>| value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
        let (owner, next_step, next_at) = (clean(&a.owner), clean(&a.next_step), clean(&a.next_at));
        let before = self.record_row(&workspace).await?;
        self.db
            .prepare(
                "INSERT INTO sales_records (workspace, stage, owner, next_step, next_at, updated_by, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (workspace) DO UPDATE SET stage = ?2, owner = ?3, next_step = ?4, next_at = ?5,
                   updated_by = ?6, updated_at = ?7",
            )
            .bind(&[
                workspace.as_str().into(),
                a.stage.as_str().into(),
                crate::optional(owner.as_deref()),
                crate::optional(next_step.as_deref()),
                crate::optional(next_at.as_deref()),
                a.by.as_str().into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        let account = self.account_of(&workspace).await?;
        let was = before.map_or_else(|| "none".to_owned(), |b| b.stage);
        let detail = format!(
            "{workspace}: stage {was} → {}{}{}",
            a.stage,
            owner.as_deref().map(|o| format!(", owner {o}")).unwrap_or_default(),
            next_step.as_deref().map(|s| format!(", next: {s}")).unwrap_or_default(),
        );
        self.audit(&account.id, "sales", &detail, &a.by).await?;
        Ok(Outcome::Ok(self.admin_sales(AdminSalesArgs { workspace }).await?))
    }

    pub(crate) async fn admin_add_note(&self, a: AdminAddNoteArgs) -> Result<Outcome<SalesRecord>> {
        let workspace = a.workspace.trim().to_lowercase();
        let text = a.text.trim();
        if workspace.is_empty() || text.is_empty() || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "A note needs a workspace, some words, and who wrote it."));
        }
        if text.chars().count() > 4000 {
            return Ok(Outcome::fail(FailureCode::Invalid, "Keep a note under 4,000 characters."));
        }
        let now = now_ms();
        self.db
            .prepare("INSERT INTO sales_notes (id, workspace, text, by, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(&[new_id("note", now).into(), workspace.as_str().into(), text.into(), a.by.as_str().into(), rfc3339(now).into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(self.admin_sales(AdminSalesArgs { workspace }).await?))
    }

    /// Every workspace worth reaching out to, most urgent first.
    pub(crate) async fn admin_signals(&self, _: AdminSignalsArgs) -> Result<Vec<Signal>> {
        let now = rfc3339(now_ms());
        let month = &now[..7];
        let last = previous_month(month);
        #[derive(Deserialize)]
        struct Active {
            workspace: String,
            this_month: Option<i64>,
            last_month: Option<i64>,
            first_paid: Option<String>,
        }
        let active = self
            .db
            .prepare(
                "SELECT workspace,
                        -SUM(CASE WHEN kind = 'usage' AND created_at >= ?1 THEN amount_micros END) AS this_month,
                        -SUM(CASE WHEN kind = 'usage' AND created_at >= ?2 AND created_at < ?1 THEN amount_micros END) AS last_month,
                        MIN(CASE WHEN kind = 'top_up' AND amount_micros > 0 AND reference NOT LIKE 'crd%' THEN created_at END) AS first_paid
                 FROM ledger GROUP BY workspace
                 HAVING MAX(created_at) >= ?2
                 LIMIT 500",
            )
            .bind(&[format!("{month}-01").into(), format!("{last}-01").into()])?
            .all()
            .await?
            .results::<Active>()?;
        let day: u32 = now[8..10].parse().unwrap_or(1);
        let fortnight_ago = rfc3339(now_ms() - 14 * 24 * 60 * 60 * 1000);
        let mut signals = vec![];
        for row in active {
            let limit = self.limit_of(&row.workspace).await?;
            if limit.trust == Trust::Internal {
                continue;
            }
            let this_month = row.this_month.unwrap_or(0).max(0);
            let last_month = row.last_month.unwrap_or(0).max(0);
            let record = self.record_row(&row.workspace).await?;
            let (stage, owner, next_step, next_at) =
                record.map_or((None, None, None, None), |r| (Some(r.stage), r.owner, r.next_step, r.next_at));
            let mut push = |kind: SignalKind, detail: String, value: i64| {
                signals.push(Signal {
                    workspace: row.workspace.clone(),
                    kind,
                    detail,
                    value_micros: value,
                    stage: stage.clone(),
                    owner: owner.clone(),
                    next_step: next_step.clone(),
                    next_at: next_at.clone(),
                });
            };
            let declined = limit.message.as_deref().is_some_and(|m| m.contains("could not be charged"));
            if declined {
                push(SignalKind::Declined, limit.message.clone().unwrap_or_default(), limit.exposure_micros);
            } else if limit.state == LimitState::Stopped {
                push(SignalKind::AtLimit, limit.message.clone().unwrap_or_default(), limit.exposure_micros.max(limit.spent_micros));
            } else if let Some(available) = limit.available_micros.filter(|a| *a > 0)
                && limit.exposure_micros * 5 >= available * 4 {
                    push(
                        SignalKind::NearCeiling,
                        format!(
                            "{} unpaid of the {} g1t allows it ({:?}); a call could raise it before it stops.",
                            dollars(limit.exposure_micros),
                            dollars(available),
                            limit.trust
                        ),
                        limit.exposure_micros,
                    );
                }
            if last_month >= HIGH_SPEND_MICROS {
                let terms = self.terms_of(&row.workspace).await?;
                if terms.kind == TermsKind::Standard && !limit.account.starts_with("ent_") {
                    push(
                        SignalKind::HighSpend,
                        format!("Spent {} last month on standard terms: worth offering custom terms or an enterprise.", dollars(last_month)),
                        last_month,
                    );
                }
            }
            if growing(this_month, last_month, day, days_in(month)) {
                push(
                    SignalKind::Growing,
                    format!(
                        "{} so far this month, on pace for about {}, against {} last month.",
                        dollars(this_month),
                        dollars((this_month as f64 * f64::from(days_in(month)) / f64::from(day.max(1))) as i64),
                        dollars(last_month)
                    ),
                    this_month,
                );
            }
            if limit.trust == Trust::Established {
                push(
                    SignalKind::Established,
                    format!(
                        "A steady customer: its limit now follows its spend ({} available).",
                        limit.available_micros.map(dollars).unwrap_or_default()
                    ),
                    last_month,
                );
            }
            if row.first_paid.as_deref().is_some_and(|at| at >= fortnight_ago.as_str()) {
                push(SignalKind::FirstPayment, "Paid g1t for the first time in the last two weeks: say hello.".to_owned(), this_month);
            }
        }
        // Workspaces costing g1t more than they pay (margin.rs), for a look
        // before they cost more: a pricing gap, or abuse.
        for (workspace, detail, value) in self.costing_more_than_they_pay().await? {
            let record = self.record_row(&workspace).await?;
            let (stage, owner, next_step, next_at) =
                record.map_or((None, None, None, None), |r| (Some(r.stage), r.owner, r.next_step, r.next_at));
            signals.push(Signal { workspace, kind: SignalKind::CostOverRevenue, detail, value_micros: value, stage, owner, next_step, next_at });
        }
        signals.sort_by(|a, b| urgency(a.kind).cmp(&urgency(b.kind)).then(b.value_micros.cmp(&a.value_micros)));
        Ok(signals)
    }

    /// Every invoice g1t has sent, workspaces' and enterprises'.
    pub(crate) async fn admin_invoices(&self, a: g1t_contracts::billing::AdminInvoicesArgs) -> Result<Vec<g1t_contracts::billing::InvoiceSummary>> {
        #[derive(Deserialize)]
        struct Row {
            invoice_id: String,
            kind: String,
            account: String,
            name: String,
            reason: String,
            period: String,
            amount_micros: i64,
            status: String,
            hosted_url: Option<String>,
            created_at: String,
            paid_at: Option<String>,
        }
        let status = a.status.filter(|s| ["paid", "open", "failed", "overdue", "void"].contains(&s.as_str()));
        let month = a.month.filter(|m| m.len() == 7 && m.chars().all(|c| c.is_ascii_digit() || c == '-'));
        let rows = self
            .db
            .prepare(
                "SELECT * FROM (
                   SELECT invoice_id, 'workspace' AS kind, workspace AS account, workspace AS name, reason, period,
                          amount_micros, status, hosted_url, created_at, paid_at
                   FROM workspace_invoices
                   UNION ALL
                   SELECT i.invoice_id, 'enterprise', i.account_id, COALESCE(b.name, i.account_id), 'enterprise', i.period,
                          i.amount_micros, i.status, i.hosted_url, i.created_at, i.paid_at
                   FROM enterprise_invoices i LEFT JOIN billing_accounts b ON b.id = i.account_id
                 )
                 WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR substr(created_at, 1, 7) = ?2)
                 ORDER BY created_at DESC LIMIT 200",
            )
            .bind(&[crate::optional(status.as_deref()), crate::optional(month.as_deref())])?
            .all()
            .await?
            .results::<Row>()?;
        Ok(rows
            .into_iter()
            .map(|r| g1t_contracts::billing::InvoiceSummary {
                invoice_id: r.invoice_id,
                kind: r.kind,
                account: r.account,
                name: r.name,
                reason: r.reason,
                period: r.period,
                amount_micros: r.amount_micros,
                status: r.status,
                hosted_url: r.hosted_url,
                created_at: r.created_at,
                paid_at: r.paid_at,
            })
            .collect())
    }

    /// Every change made in sudo and by Stripe, newest first.
    pub(crate) async fn admin_audit(&self, a: g1t_contracts::billing::AdminAuditArgs) -> Result<Vec<g1t_contracts::billing::AdminAction>> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
            account: String,
            action: String,
            detail: String,
            by: String,
            created_at: String,
        }
        let rows = self
            .db
            .prepare(
                "SELECT id, account, action, detail, by, created_at FROM admin_actions
                 WHERE (?1 IS NULL OR by = ?1) AND (?2 IS NULL OR action = ?2) AND (?3 IS NULL OR created_at < ?3)
                 ORDER BY created_at DESC LIMIT 100",
            )
            .bind(&[
                crate::optional(a.by.as_deref().map(str::trim).filter(|s| !s.is_empty())),
                crate::optional(a.action.as_deref().map(str::trim).filter(|s| !s.is_empty())),
                crate::optional(a.before.as_deref()),
            ])?
            .all()
            .await?
            .results::<Row>()?;
        Ok(rows
            .into_iter()
            .map(|r| g1t_contracts::billing::AdminAction {
                id: r.id,
                account: r.account,
                action: r.action,
                detail: r.detail,
                by: r.by,
                created_at: r.created_at,
            })
            .collect())
    }

    /// The business at a glance.
    pub(crate) async fn admin_overview(&self, _: AdminOverviewArgs) -> Result<Overview> {
        let now = rfc3339(now_ms());
        let month = now[..7].to_owned();
        let months = self.months_for(&[], 6).await?;
        #[derive(Deserialize)]
        struct KindRow {
            kind: Option<String>,
            charged: Option<i64>,
            cost: Option<i64>,
        }
        let by_kind = self
            .db
            .prepare(
                "SELECT CASE
                          WHEN task = 'sandbox' THEN 'Sandbox time'
                          WHEN task = 'self_hosted' THEN 'Self-hosted runner time'
                          WHEN task = 'deployments' THEN 'Deployments'
                          WHEN task = 'security' THEN 'Security scans'
                          WHEN task = 'context' THEN 'Search embeddings'
                          WHEN task = 'storage' THEN 'Private storage'
                          WHEN task = 'git' THEN 'Git operations'
                          WHEN billed_to = 'workspace' THEN 'Own-provider runs'
                          ELSE 'Models' END AS kind,
                        -SUM(amount_micros) AS charged,
                        SUM(CASE WHEN COALESCE(billed_to, 'g1t') = 'g1t' THEN cost_micros ELSE 0 END) AS cost
                 FROM ledger WHERE kind = 'usage' AND created_at >= ? GROUP BY 1 ORDER BY charged DESC",
            )
            .bind(&[format!("{month}-01").into()])?
            .all()
            .await?
            .results::<KindRow>()?
            .into_iter()
            .map(|r| KindFigures {
                kind: r.kind.unwrap_or_else(|| "Other".to_owned()),
                charged_micros: r.charged.unwrap_or(0),
                cost_micros: r.cost.unwrap_or(0),
            })
            .collect();
        #[derive(Deserialize)]
        struct Count {
            n: Option<i64>,
        }
        let count = |sql: &'static str, args: Vec<JsValue>| {
            let db = &self.db;
            async move {
                Ok::<i64, worker::Error>(db.prepare(sql).bind(&args)?.first::<Count>(None).await?.and_then(|c| c.n).unwrap_or(0))
            }
        };
        let paying = count(
            "SELECT COUNT(DISTINCT workspace) AS n FROM ledger
             WHERE kind = 'top_up' AND amount_micros > 0 AND reference NOT LIKE 'crd%' AND created_at >= ?",
            vec![rfc3339(now_ms() - 60 * 24 * 60 * 60 * 1000).into()],
        )
        .await?;
        let open_invoices = count(
            "SELECT (SELECT COALESCE(SUM(amount_micros), 0) FROM workspace_invoices WHERE status IN ('open', 'failed'))
                  + (SELECT COALESCE(SUM(amount_micros), 0) FROM enterprise_invoices WHERE status IN ('open', 'overdue')) AS n",
            vec![],
        )
        .await?;
        let follow_ups = count(
            "SELECT COUNT(*) AS n FROM sales_records WHERE next_at IS NOT NULL AND next_at <= ? AND stage NOT IN ('won', 'lost')",
            vec![now[..10].into()],
        )
        .await?;
        let signals = self.admin_signals(AdminSignalsArgs {}).await?;
        let tally = |kind: SignalKind| signals.iter().filter(|s| s.kind == kind).count() as u32;
        let this = months.last().cloned().unwrap_or_default();
        let active_plans = count(
            "SELECT COUNT(*) AS n FROM subscriptions WHERE feature = 'plan' AND status IN ('active', 'canceling')",
            vec![],
        )
        .await?;
        let open_requests = count("SELECT COUNT(*) AS n FROM limit_requests WHERE status = 'open'", vec![]).await?;
        let open_spikes = count("SELECT COUNT(*) AS n FROM spikes WHERE status = 'open'", vec![]).await?;
        let overages = self.admin_overages(AdminOveragesArgs {}).await?.len() as u32;
        Ok(Overview {
            revenue_micros: this.charged_micros + this.plans_micros,
            active_plans: active_plans as u32,
            plan_mrr_micros: active_plans * i64::from(self.plans.plan_monthly_cents) * 10_000,
            given: self.given_this_month(&month).await?,
            internal: self.internal_use(&month).await?,
            open_requests: open_requests as u32,
            open_spikes: open_spikes as u32,
            overages,
            month,
            months,
            by_kind,
            paying_workspaces: paying as u32,
            stopped: tally(SignalKind::AtLimit),
            near_ceiling: tally(SignalKind::NearCeiling),
            declined: tally(SignalKind::Declined),
            open_invoices_micros: open_invoices,
            follow_ups_due: follow_ups as u32,
            pools: Some(self.pools().await?),
        })
    }

    /// What g1t gave in `month`, by source, at price and at cost.
    async fn given_this_month(&self, month: &str) -> Result<Vec<GivenFigures>> {
        #[derive(Deserialize)]
        struct Row {
            internal_cost: Option<i64>,
            trial: Option<i64>,
            oss: Option<i64>,
            covered: Option<i64>,
            goodwill: Option<i64>,
        }
        let row = self
            .db
            .prepare(format!(
                "SELECT
                   SUM(CASE WHEN kind = 'usage' AND COALESCE(billed_to, 'g1t') = 'g1t' AND workspace IN ({INTERNAL_SQL})
                            THEN cost_micros END) AS internal_cost,
                   SUM(CASE WHEN kind = 'usage' THEN trial_micros END) AS trial,
                   SUM(CASE WHEN kind = 'usage' THEN oss_micros END) AS oss,
                   SUM(CASE WHEN kind = 'usage' THEN given_micros END) AS covered,
                   SUM(CASE WHEN kind = 'top_up' AND credit_kind IN ('promotional', 'goodwill') THEN amount_micros END) AS goodwill
                 FROM ledger WHERE created_at >= ?",
            ))
            .bind(&[format!("{month}-01").into()])?
            .first::<Row>(None)
            .await?;
        let Some(row) = row else { return Ok(vec![]) };
        let at_cost = |price: i64| price * 100 / i64::from(100 + self.margin_percent);
        let internal_cost = row.internal_cost.unwrap_or(0);
        Ok([
            ("internal", "g1t's and Flagon's own use", crate::credits::with_margin(internal_cost, self.margin_percent), internal_cost),
            ("trial", "Trials", row.trial.unwrap_or(0), at_cost(row.trial.unwrap_or(0))),
            ("oss_pool", "Open-source pool", row.oss.unwrap_or(0), at_cost(row.oss.unwrap_or(0))),
            ("covered", "Covered past a trial's end", row.covered.unwrap_or(0), at_cost(row.covered.unwrap_or(0))),
            ("goodwill", "Credits from g1t, promotional and goodwill", row.goodwill.unwrap_or(0), row.goodwill.unwrap_or(0)),
        ]
        .into_iter()
        .map(|(source, label, micros, cost)| GivenFigures { source: source.to_owned(), label: label.to_owned(), micros, cost_micros: cost })
        .collect())
    }

    /// g1t's own workspaces' use in `month`, with why each is not charged.
    async fn internal_use(&self, month: &str) -> Result<Vec<InternalUse>> {
        #[derive(Deserialize)]
        struct Row {
            workspace: String,
            cost: Option<i64>,
            entries: Option<u32>,
        }
        let rows = self
            .db
            .prepare(format!(
                "SELECT workspace, SUM(cost_micros) AS cost, COUNT(*) AS entries FROM ledger
                 WHERE kind = 'usage' AND COALESCE(billed_to, 'g1t') = 'g1t' AND created_at >= ? AND workspace IN ({INTERNAL_SQL})
                 GROUP BY workspace ORDER BY cost DESC"
            ))
            .bind(&[format!("{month}-01").into()])?
            .all()
            .await?
            .results::<Row>()?;
        let mut list = vec![];
        for row in rows {
            let terms = self.terms_of(&row.workspace).await?;
            list.push(InternalUse {
                reason: if terms.note.is_empty() { "100% discount".to_owned() } else { terms.note },
                cost_micros: row.cost.unwrap_or(0),
                entries: row.entries.unwrap_or(0),
                workspace: row.workspace,
            });
        }
        Ok(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(kind: &str, billed_to: &str, amount: i64, cost: i64) -> LedgerGroup {
        LedgerGroup {
            month: "2026-10".into(),
            kind: kind.into(),
            billed_to: Some(billed_to.into()),
            amount: Some(amount),
            cost: Some(cost),
            ..LedgerGroup::default()
        }
    }

    #[test]
    fn a_workspaces_own_provider_is_never_g1ts_cost() {
        let groups = [
            // Runs on g1t's models: charged $12, cost g1t $10.
            group("usage", "g1t", -12_000_000, 10_000_000),
            // A run on the workspace's own provider: it paid that $0.21 itself.
            group("usage", "workspace", -100_000, 209_700),
        ];
        let month = fold_month("2026-10", &groups, 0, 20);
        assert_eq!(month.cost_micros, 10_000_000);
        assert_eq!(month.charged_micros, 12_100_000);
    }

    #[test]
    fn plan_revenue_counts_and_what_g1t_gives_is_kept_apart() {
        let groups = [
            group("usage", "g1t", -12_000_000, 10_000_000),
            // Paid for by the trial and the open-source pool: $3 at price.
            LedgerGroup { pools: Some(3_000_000), ..group("usage", "g1t", 0, 2_500_000) },
            // g1t's own workspace: nothing charged, $5 of cost.
            LedgerGroup { internal: 1, ..group("usage", "g1t", 0, 5_000_000) },
            // A payment, a goodwill credit, and another credit from g1t.
            group("top_up", "g1t", 40_000_000, 0),
            LedgerGroup { credit: 1, goodwill: 1, ..group("top_up", "g1t", 15_000_000, 0) },
            LedgerGroup { credit: 1, ..group("top_up", "g1t", 2_000_000, 0) },
            // Another month is not this one.
            LedgerGroup { month: "2026-09".into(), ..group("usage", "g1t", -1, 1) },
        ];
        let month = fold_month("2026-10", &groups, 20_000_000, 20);
        assert_eq!(month.plans_micros, 20_000_000);
        assert_eq!(month.paid_micros, 40_000_000);
        assert_eq!(month.charged_micros, 12_000_000);
        assert_eq!(month.cost_micros, 17_500_000);
        // $6 of internal use at price, $3 of pools, $15 of goodwill.
        assert_eq!(month.given_micros, 6_000_000 + 3_000_000 + 15_000_000);
    }

    #[test]
    fn six_months_end_with_this_one() {
        assert_eq!(last_months("2026-02", 3), vec!["2025-12", "2026-01", "2026-02"]);
    }

    #[test]
    fn growth_is_judged_on_pace_not_on_the_month_so_far() {
        // Ten days in, $20 on a 30-day month is a $60 pace against $30.
        assert!(growing(20_000_000, 30_000_000, 10, 30));
        assert!(!growing(10_000_000, 30_000_000, 10, 30));
        // Too small last month to say.
        assert!(!growing(9_000_000, 1_000_000, 10, 30));
    }

    #[test]
    fn the_most_urgent_comes_first() {
        assert!(urgency(SignalKind::AtLimit) < urgency(SignalKind::NearCeiling));
        assert!(urgency(SignalKind::Declined) < urgency(SignalKind::Growing));
    }

    #[test]
    fn february_knows_its_leap_years() {
        assert_eq!(days_in("2028-02"), 29);
        assert_eq!(days_in("2026-02"), 28);
        assert_eq!(days_in("2026-10"), 31);
    }
}
