//! Workspaces moved off Stripe's test mode: `admin_detach_test_stripe`.
//!
//! Before billing takes a live Stripe key, every id and amount Stripe's test
//! mode left behind has to stop counting: a plan still "active" until its
//! period ends, a cached 4242 card, a test customer id (the first live month
//! close would charge test-era balances to whatever card it then finds),
//! open invoices, and test payments that count as paid. A testing reset
//! (`reset.rs`) wipes all of that and the history with it; this keeps the
//! history and makes it inert:
//!
//! - plans canceled; the customer id, cached card and tax-address flag
//!   cleared; card checks and open checkouts removed (the trial grant stays,
//!   so there is no second trial); AI auto-reload off; a declined autopay
//!   cleared; open and failed invoices void;
//! - every past month from the workspace's first ledger line marked closed
//!   (`skipped`), so the first live close charges none of them;
//! - AI and purchased credit closed (hosted agents are gone, so it can buy
//!   nothing), test payments reversed on the ledger and plan payments by a
//!   reversing row each, so none of it counts as paid (nor as having had
//!   the plan that month, `storage::PLAN_EVIDENCE`); and what that leaves
//!   owed written off as goodwill credit (a `crd…` grant, never a payment,
//!   and no email to the owners);
//! - usage metered to be charged at a month's end: every month before this
//!   one marked charged (`never: test mode …`), and this month's figure so
//!   far kept as its baseline (`pending_baselines`), which everything that
//!   values or charges it takes off, since reporters keep replacing the row
//!   with the month's whole total;
//! - this month's draws on the plan's included usage deleted, so a live
//!   plan taken this month has all of it (the trial grant and g1t's
//!   open-source pool are left: the trial is once ever, and the pool's
//!   draws were g1t's own money spent);
//! - what lost test-mode disputes left owed cleared, and open ones closed
//!   (`detached`), so no test dispute holds the workspace's work.
//!
//! All of it but the goodwill grant is one D1 batch per workspace; the
//! grant goes through `grant_credit` after it. Running it again changes
//! nothing: every step reads what is left to do. Never with a live key.
//! Every workspace at once skips comped and enterprise workspaces and an
//! exclusion list (`syntaqx` and `flagon-io` by default); one workspace can
//! be any but an enterprise's.

use std::collections::{BTreeMap, BTreeSet};

use g1t_contracts::billing::{
    AdminDetachTestStripeArgs, CreditKind, DetachSkipped, TestStripeDetach, WorkspaceDetach,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Billing;
use crate::accounts::own_account;
use crate::features::cents;

/// Left alone by a detach of every workspace unless named.
pub(crate) const DEFAULT_EXCLUDED: [&str; 2] = ["syntaqx", "flagon-io"];
/// What staff type to detach every workspace.
pub(crate) const CONFIRM_ALL: &str = "detach";
/// Workspaces one call detaches; the rest are `remaining`.
pub(crate) const PER_CALL: usize = 25;
/// The goodwill grant's note.
pub(crate) const WRITE_OFF_NOTE: &str = "Usage while payments were in test mode, written off";
/// A skipped month's `error`, which is where `month_closes` keeps why.
pub(crate) const MONTH_NOTE: &str = "test-mode period, written off";
/// The suffix of a plan payment's reversing row (12 characters).
#[cfg(test)]
const PLAN_REVERSAL: &str = "_test_detach";

/// Every workspace holding a billing row, with what test mode left on it.
/// `?1` one workspace, or NULL for all; `?2` this month (`YYYY-MM`).
/// `{internal}` is `sales::INTERNAL_SQL`.
pub(crate) const FOUND: &str = "WITH candidates(workspace) AS (
    SELECT workspace FROM accounts
    UNION SELECT workspace FROM subscriptions
    UNION SELECT workspace FROM card_checks
    UNION SELECT workspace FROM checkouts WHERE status = 'open'
    UNION SELECT workspace FROM workspace_invoices
    UNION SELECT workspace FROM credit_grants
    UNION SELECT workspace FROM plan_payments
    UNION SELECT workspace FROM ai_reload
    UNION SELECT workspace FROM limits WHERE autopay_failed_at IS NOT NULL OR autopay_error IS NOT NULL OR dispute_owed_micros <> 0
    UNION SELECT workspace FROM pending_usage WHERE charged_at IS NULL
    UNION SELECT scope FROM allowance_use WHERE kind = 'plan_credit' AND month = ?2
    UNION SELECT workspace FROM disputes WHERE status = 'open'
  )
  SELECT c.workspace AS workspace,
    CASE WHEN c.workspace IN ({internal}) THEN 1 ELSE 0 END AS comped,
    (SELECT COUNT(*) FROM account_members m WHERE m.workspace = c.workspace) AS enterprise,
    CASE WHEN a.customer_id IS NOT NULL THEN 1 ELSE 0 END AS customer,
    a.card_brand AS card_brand,
    a.card_last4 AS card_last4,
    CASE WHEN a.card_brand IS NOT NULL OR a.card_last4 IS NOT NULL OR a.card_exp_month IS NOT NULL
           OR a.card_exp_year IS NOT NULL OR a.card_synced_at IS NOT NULL OR a.tax_address_needed_at IS NOT NULL
         THEN 1 ELSE 0 END AS card_cached,
    COALESCE(a.balance_micros, 0) AS balance,
    (SELECT COUNT(*) FROM subscriptions s WHERE s.workspace = c.workspace AND s.status <> 'canceled') AS subscriptions,
    (SELECT COUNT(*) FROM card_checks k WHERE k.workspace = c.workspace) AS card_checks,
    (SELECT COUNT(*) FROM checkouts o WHERE o.workspace = c.workspace AND o.status = 'open') AS checkouts,
    (SELECT COUNT(*) FROM ai_reload r WHERE r.workspace = c.workspace AND r.enabled <> 0) AS ai_reload,
    (SELECT COUNT(*) FROM limits l WHERE l.workspace = c.workspace
       AND (l.autopay_failed_at IS NOT NULL OR l.autopay_error IS NOT NULL)) AS autopay_failed,
    (SELECT COUNT(*) FROM workspace_invoices i WHERE i.workspace = c.workspace AND i.status IN ('open', 'failed')) AS invoices,
    (SELECT COUNT(*) FROM credit_grants g WHERE g.workspace = c.workspace AND g.closed_at IS NULL
       AND (g.kind = 'purchased' OR g.scope = 'models' OR g.source = 'purchase')) AS ai_grants,
    (SELECT COALESCE(SUM(e.amount_micros), 0) FROM ledger e
       WHERE e.workspace = c.workspace AND e.kind = 'top_up' AND e.reference NOT LIKE 'crd%') AS paid,
    (SELECT COALESCE(SUM(p.amount_micros), 0) FROM plan_payments p
       WHERE p.workspace = c.workspace AND p.amount_micros > 0 AND substr(p.invoice_id, -12) <> '_test_detach'
         AND NOT EXISTS (SELECT 1 FROM plan_payments q WHERE q.invoice_id = p.invoice_id || '_test_detach')) AS plan_unreversed,
    (SELECT MIN(e.created_at) FROM ledger e WHERE e.workspace = c.workspace) AS first_entry,
    (SELECT COUNT(*) FROM pending_usage u WHERE u.workspace = c.workspace AND u.month < ?2 AND u.charged_at IS NULL) AS pending_past,
    (SELECT COALESCE(SUM(u.charge_micros), 0) FROM pending_usage u
       WHERE u.workspace = c.workspace AND u.month < ?2 AND u.charged_at IS NULL) AS pending_past_micros,
    (SELECT COUNT(*) FROM pending_usage u LEFT JOIN pending_baselines b
       ON b.workspace = u.workspace AND b.source = u.source AND b.month = u.month
       WHERE u.workspace = c.workspace AND u.month = ?2 AND u.charged_at IS NULL
         AND (u.cost_micros > COALESCE(b.cost_micros, 0) OR u.charge_micros > COALESCE(b.charge_micros, 0))) AS pending_now,
    (SELECT COALESCE(SUM(MAX(0, u.charge_micros - COALESCE(b.charge_micros, 0))), 0) FROM pending_usage u LEFT JOIN pending_baselines b
       ON b.workspace = u.workspace AND b.source = u.source AND b.month = u.month
       WHERE u.workspace = c.workspace AND u.month = ?2 AND u.charged_at IS NULL) AS pending_now_micros,
    (SELECT COALESCE(SUM(w.used), 0) FROM allowance_use w WHERE w.kind = 'plan_credit' AND w.scope = c.workspace AND w.month = ?2) AS plan_credit,
    (SELECT COALESCE(SUM(l.dispute_owed_micros), 0) FROM limits l WHERE l.workspace = c.workspace) AS dispute_owed,
    (SELECT COUNT(*) FROM disputes d WHERE d.workspace = c.workspace AND d.status = 'open') AS open_disputes
  FROM candidates c LEFT JOIN accounts a ON a.workspace = c.workspace
  WHERE ?1 IS NULL OR c.workspace = ?1
  ORDER BY c.workspace";

/// The months already closed. `?1` one workspace, or NULL for all.
pub(crate) const CLOSED: &str = "SELECT workspace, month FROM month_closes WHERE ?1 IS NULL OR workspace = ?1";

/// A workspace's AI and purchased credit still open: what a detach closes.
pub(crate) const AI_GRANTS: &str =
    "SELECT id FROM credit_grants WHERE workspace = ?1 AND closed_at IS NULL AND (kind = 'purchased' OR scope = 'models' OR source = 'purchase')";

/// The plans whose subscriptions a detach may cancel at Stripe.
pub(crate) const OPEN_PLANS: &str = "SELECT subscription_id FROM subscriptions WHERE workspace = ?1 AND status <> 'canceled'";

/// What a pending row of a month before the detach is marked charged with
/// (`charged_at`), followed by when: never charged.
#[cfg(test)]
const PENDING_MARK: &str = "never: test mode, detached ";

/// The batch's fixed statements. `?1` the workspace, `?2` now, `?3` who,
/// `?4` this month (`YYYY-MM`). Each changes a row only when there is
/// something to change, so a second run counts nothing.
pub(crate) const STATEMENTS: &[&str] = &[
    "UPDATE subscriptions SET status = 'canceled', updated_at = ?2 WHERE workspace = ?1 AND status <> 'canceled'",
    "UPDATE accounts SET customer_id = NULL, card_brand = NULL, card_last4 = NULL, card_exp_month = NULL, card_exp_year = NULL,
       card_synced_at = NULL, tax_address_needed_at = NULL
     WHERE workspace = ?1 AND (customer_id IS NOT NULL OR card_brand IS NOT NULL OR card_last4 IS NOT NULL OR card_exp_month IS NOT NULL
       OR card_exp_year IS NOT NULL OR card_synced_at IS NOT NULL OR tax_address_needed_at IS NOT NULL)",
    "DELETE FROM card_checks WHERE workspace = ?1",
    "DELETE FROM checkouts WHERE workspace = ?1 AND status = 'open'",
    "UPDATE ai_reload SET enabled = 0, updated_by = ?3, updated_at = ?2 WHERE workspace = ?1 AND enabled <> 0",
    "UPDATE limits SET autopay_failed_at = NULL, autopay_error = NULL WHERE workspace = ?1 AND (autopay_failed_at IS NOT NULL OR autopay_error IS NOT NULL)",
    "UPDATE workspace_invoices SET status = 'void' WHERE workspace = ?1 AND status IN ('open', 'failed')",
    "INSERT OR IGNORE INTO plan_payments (invoice_id, workspace, amount_micros, paid_at)
     SELECT invoice_id || '_test_detach', workspace, -amount_micros, paid_at FROM plan_payments
     WHERE workspace = ?1 AND amount_micros > 0 AND substr(invoice_id, -12) <> '_test_detach'",
    // Months before this one: their metered usage is never charged.
    "UPDATE pending_usage SET charged_at = 'never: test mode, detached ' || ?2
     WHERE workspace = ?1 AND month < ?4 AND charged_at IS NULL",
    // This month's so far: kept as the baseline later reports are charged
    // past (raised, never lowered, by a run after more test-mode usage).
    "INSERT INTO pending_baselines (workspace, source, month, cost_micros, charge_micros, created_at)
     SELECT workspace, source, month, cost_micros, charge_micros, ?2 FROM pending_usage
     WHERE workspace = ?1 AND month = ?4 AND charged_at IS NULL AND (cost_micros > 0 OR charge_micros > 0)
     ON CONFLICT (workspace, source, month) DO UPDATE SET
       cost_micros = MAX(pending_baselines.cost_micros, excluded.cost_micros),
       charge_micros = MAX(pending_baselines.charge_micros, excluded.charge_micros),
       created_at = excluded.created_at
     WHERE excluded.cost_micros > pending_baselines.cost_micros OR excluded.charge_micros > pending_baselines.charge_micros",
    // This month's draws on the plan's included usage: a live plan this
    // month starts with all of it. The trial and the pools are left.
    "DELETE FROM allowance_use WHERE kind = 'plan_credit' AND scope = ?1 AND month = ?4",
    // Test-mode disputes: nothing owed for them, none left open.
    "UPDATE limits SET dispute_owed_micros = 0 WHERE workspace = ?1 AND dispute_owed_micros <> 0",
    "UPDATE disputes SET status = 'detached', updated_at = ?2 WHERE workspace = ?1 AND status = 'open'",
];

/// A past month marked closed. `?1` workspace, `?2` month, `?3` why, `?4` now.
pub(crate) const SKIP_MONTH: &str = "INSERT OR IGNORE INTO month_closes (workspace, month, status, amount_micros, payment_id, error, closed_at)
     VALUES (?1, ?2, 'skipped', 0, NULL, ?3, ?4)";

/// An AI credit grant closed. `?1` now, `?2` why, `?3` who, `?4` what was
/// left, `?5` the grant.
pub(crate) const CLOSE_GRANT: &str = "UPDATE credit_grants SET closed_at = ?1, closed_reason = 'revoked', closed_note = ?2, closed_by = ?3, closed_micros = ?4
     WHERE id = ?5 AND closed_at IS NULL";

/// A ledger line of the batch, as `Billing::enter` writes one. `?1` id,
/// `?2` workspace, `?3` amount, `?4` description, `?5` reference, `?6` who,
/// `?7` now, `?8` the credit's kind or NULL.
pub(crate) const LEDGER: &str = "INSERT INTO ledger (id, workspace, kind, amount_micros, description, reference, created_by, created_at, billed_to, credit_kind)
     VALUES (?1, ?2, 'top_up', ?3, ?4, ?5, ?6, ?7, 'g1t', ?8)";

/// The balance moved with it. `?1` workspace, `?2` amount, `?3` now.
pub(crate) const BALANCE: &str = "INSERT INTO accounts (workspace, balance_micros, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (workspace) DO UPDATE SET balance_micros = balance_micros + ?2";

/// Every table a detach reads or writes, with the columns it names: each
/// is checked against the migrations.
#[cfg(test)]
pub(crate) const USES: &[(&str, &[&str])] = &[
    ("accounts", &[
        "workspace", "balance_micros", "customer_id", "card_brand", "card_last4", "card_exp_month", "card_exp_year", "card_synced_at",
        "tax_address_needed_at", "created_at",
    ]),
    ("subscriptions", &["workspace", "subscription_id", "status", "updated_at"]),
    ("card_checks", &["workspace"]),
    ("checkouts", &["workspace", "status"]),
    ("ai_reload", &["workspace", "enabled", "updated_by", "updated_at"]),
    ("limits", &["workspace", "autopay_failed_at", "autopay_error", "dispute_owed_micros"]),
    ("pending_usage", &["workspace", "source", "month", "cost_micros", "charge_micros", "charged_at"]),
    ("pending_baselines", &["workspace", "source", "month", "cost_micros", "charge_micros", "created_at"]),
    ("allowance_use", &["kind", "scope", "month", "used"]),
    ("disputes", &["workspace", "status", "updated_at"]),
    ("workspace_invoices", &["workspace", "status"]),
    ("credit_grants", &[
        "id", "workspace", "kind", "scope", "source", "closed_at", "closed_reason", "closed_note", "closed_by", "closed_micros",
    ]),
    ("plan_payments", &["invoice_id", "workspace", "amount_micros", "paid_at"]),
    ("ledger", &[
        "id", "workspace", "kind", "amount_micros", "description", "reference", "created_by", "created_at", "billed_to", "credit_kind",
    ]),
    ("month_closes", &["workspace", "month", "status", "amount_micros", "payment_id", "error", "closed_at"]),
    ("account_members", &["workspace"]),
    ("admin_actions", &["id", "account", "action", "detail", "by", "created_at"]),
];

/// One workspace, as `FOUND` reads it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct Found {
    pub workspace: String,
    pub comped: i64,
    pub enterprise: i64,
    pub customer: i64,
    pub card_brand: Option<String>,
    pub card_last4: Option<String>,
    pub card_cached: i64,
    pub balance: i64,
    pub subscriptions: i64,
    pub card_checks: i64,
    pub checkouts: i64,
    pub ai_reload: i64,
    pub autopay_failed: i64,
    pub invoices: i64,
    pub ai_grants: i64,
    pub paid: i64,
    pub plan_unreversed: i64,
    pub first_entry: Option<String>,
    pub pending_past: i64,
    pub pending_past_micros: i64,
    pub pending_now: i64,
    pub pending_now_micros: i64,
    pub plan_credit: i64,
    pub dispute_owed: i64,
    pub open_disputes: i64,
}

/// An AI or purchased credit grant still open, with what is left of it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OpenGrant {
    pub id: String,
    pub kind: CreditKind,
    pub left: i64,
}

impl OpenGrant {
    /// A grant given by g1t (`crd…`) is credit; anything else was a payment.
    fn was_paid(&self) -> bool {
        !self.id.starts_with("crd")
    }
}

/// Why the call is refused before anything is read, if it is.
pub(crate) fn refusal(live: bool, has_key: bool, a: &AdminDetachTestStripeArgs) -> Option<(FailureCode, String)> {
    if live {
        return Some((FailureCode::Forbidden, "Billing takes real cards: test-mode data is detached before the live key, never after.".into()));
    }
    if a.by.trim().is_empty() {
        return Some((FailureCode::Invalid, "Say who is detaching.".into()));
    }
    if a.cancel_at_stripe && !has_key {
        return Some((FailureCode::Invalid, "Billing has no Stripe key, so nothing can be canceled at Stripe.".into()));
    }
    if a.dry_run {
        return None;
    }
    match a.workspace.as_deref().map(|w| w.trim().to_lowercase()) {
        Some(slug) if a.confirm.trim() != slug => {
            Some((FailureCode::Invalid, format!("Type the workspace's slug, {slug}, exactly, to detach it.")))
        }
        None if a.confirm.trim() != CONFIRM_ALL => Some((FailureCode::Invalid, format!("Type {CONFIRM_ALL} to detach every workspace."))),
        _ => None,
    }
}

/// The exclusion list: as given, or the default.
pub(crate) fn excluded(exclude: Option<&[String]>) -> BTreeSet<String> {
    match exclude {
        Some(list) => list.iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect(),
        None => DEFAULT_EXCLUDED.iter().map(|s| (*s).to_owned()).collect(),
    }
}

/// Why a workspace is left alone. One workspace chosen by staff is left
/// alone only when an enterprise pays for it.
pub(crate) fn skip_reason(found: &Found, single: bool, exclude: &BTreeSet<String>) -> Option<String> {
    if found.enterprise > 0 {
        return Some("an enterprise pays for it: it is invoiced, never on a test card".into());
    }
    if single {
        return None;
    }
    if exclude.contains(&found.workspace) {
        return Some("excluded".into());
    }
    if found.comped > 0 {
        return Some("comped (g1t's own)".into());
    }
    None
}

fn next_month(month: &str) -> String {
    let year: i32 = month[..4].parse().unwrap_or(1970);
    let number: u32 = month[5..7].parse().unwrap_or(1);
    if number == 12 { format!("{}-01", year + 1) } else { format!("{year}-{:02}", number + 1) }
}

/// Every month from the first ledger line's until before `this_month` not
/// closed yet: what the first live close could otherwise charge.
pub(crate) fn months_to_skip(first_entry: Option<&str>, this_month: &str, closed: &BTreeSet<String>) -> Vec<String> {
    let Some(first) = first_entry.filter(|f| f.len() >= 7) else { return vec![] };
    let mut month = first[..7].to_owned();
    let mut out = vec![];
    while month.as_str() < this_month && out.len() < 600 {
        if !closed.contains(&month) {
            out.push(month.clone());
        }
        month = next_month(&month);
    }
    out
}

/// What a detach does to one workspace: nothing changed yet.
pub(crate) fn plan(found: &Found, grants: &[OpenGrant], months: Vec<String>) -> WorkspaceDetach {
    let closed: i64 = grants.iter().map(|g| g.left.max(0)).sum();
    let closed_paid: i64 = grants.iter().filter(|g| g.was_paid()).map(|g| g.left.max(0)).sum();
    // What test payments still add up to once the AI credit bought with
    // them is closed: reversed, so none of it counts as paid.
    let reversed = (found.paid - closed_paid).max(0);
    let after = found.balance - closed - reversed;
    let written_off = (-after).max(0);
    let card = match (&found.card_brand, &found.card_last4) {
        (Some(brand), Some(last4)) => Some(format!("{brand} {last4}")),
        (None, Some(last4)) => Some(last4.clone()),
        (Some(brand), None) => Some(brand.clone()),
        (None, None) => None,
    };
    WorkspaceDetach {
        workspace: found.workspace.clone(),
        done: false,
        customer: found.customer > 0,
        card,
        card_cached: found.card_cached > 0,
        subscriptions: found.subscriptions as u32,
        card_checks: found.card_checks as u32,
        checkouts: found.checkouts as u32,
        ai_reload: found.ai_reload > 0,
        autopay_cleared: found.autopay_failed > 0,
        invoices_voided: found.invoices as u32,
        months_skipped: months,
        credit_grants_closed: grants.len() as u32,
        credit_closed_micros: closed,
        payments_reversed_micros: reversed,
        plan_payments_reversed_micros: found.plan_unreversed.max(0),
        written_off_micros: written_off,
        balance_before_micros: found.balance,
        balance_after_micros: after + written_off,
        stripe_canceled: 0,
        stripe_errors: vec![],
        pending_months_marked: found.pending_past.max(0) as u32,
        pending_marked_micros: found.pending_past_micros.max(0),
        pending_baselined: found.pending_now.max(0) as u32,
        pending_baselined_micros: found.pending_now_micros.max(0),
        plan_credit_cleared_micros: found.plan_credit.max(0),
        dispute_owed_cleared_micros: found.dispute_owed.max(0),
        disputes_closed: found.open_disputes.max(0) as u32,
    }
}

/// Whether a detach would change anything.
pub(crate) fn changes(d: &WorkspaceDetach) -> bool {
    d.customer
        || d.card_cached
        || d.subscriptions > 0
        || d.card_checks > 0
        || d.checkouts > 0
        || d.ai_reload
        || d.autopay_cleared
        || d.invoices_voided > 0
        || !d.months_skipped.is_empty()
        || d.credit_grants_closed > 0
        || d.payments_reversed_micros > 0
        || d.plan_payments_reversed_micros > 0
        || d.written_off_micros > 0
        || d.pending_months_marked > 0
        || d.pending_baselined > 0
        || d.plan_credit_cleared_micros > 0
        || d.dispute_owed_cleared_micros > 0
        || d.disputes_closed > 0
}

/// A value to bind, apart from JavaScript so the batch can be tested.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Bind {
    Text(String),
    Number(i64),
    Null,
}

impl Bind {
    fn js(&self) -> JsValue {
        match self {
            Bind::Text(text) => text.as_str().into(),
            Bind::Number(n) => (*n as f64).into(),
            Bind::Null => JsValue::NULL,
        }
    }
}

fn text(s: &str) -> Bind {
    Bind::Text(s.to_owned())
}

/// The batch for one workspace, every statement with its values. `ids`
/// makes each ledger line's id.
pub(crate) fn batch(
    d: &WorkspaceDetach,
    grants: &[OpenGrant],
    at: &str,
    by: &str,
    this_month: &str,
    mut ids: impl FnMut() -> String,
) -> Vec<(&'static str, Vec<Bind>)> {
    let ws = d.workspace.as_str();
    let mut out: Vec<(&'static str, Vec<Bind>)> = vec![];
    let fixed = [text(ws), text(at), text(by), text(this_month)];
    for sql in STATEMENTS {
        out.push((sql, fixed[..crate::rename::parameters(sql)].to_vec()));
    }
    for month in &d.months_skipped {
        out.push((SKIP_MONTH, vec![text(ws), text(month), text(MONTH_NOTE), text(at)]));
    }
    let mut line = |out: &mut Vec<(&'static str, Vec<Bind>)>, amount: i64, description: String, reference: String, kind: Option<CreditKind>| {
        out.push((
            LEDGER,
            vec![
                Bind::Text(ids()),
                text(ws),
                Bind::Number(amount),
                Bind::Text(description),
                Bind::Text(reference),
                text(by),
                text(at),
                kind.map_or(Bind::Null, |k| text(k.as_str())),
            ],
        ));
        out.push((BALANCE, vec![text(ws), Bind::Number(amount), text(at)]));
    };
    for grant in grants {
        let left = grant.left.max(0);
        let why = if grant.was_paid() {
            "Bought while payments were in test mode; closed before live billing"
        } else {
            "AI credit can buy nothing since hosted agents were removed; closed before live billing"
        };
        out.push((CLOSE_GRANT, vec![text(at), text(why), text(by), Bind::Number(left), text(&grant.id)]));
        if left > 0 {
            // `<grant>_revoked`: the replay reads the grant as closed by it.
            line(&mut out, -left, format!("AI credit closed before live billing: {} unused", cents(left)), format!("{}_revoked", grant.id), Some(grant.kind));
        }
    }
    if d.payments_reversed_micros > 0 {
        line(
            &mut out,
            -d.payments_reversed_micros,
            format!("Test-mode payments reversed before live billing: {}", cents(d.payments_reversed_micros)),
            format!("test_detach/{ws}/{at}"),
            None,
        );
    }
    out
}

/// What the audit log says a detach changed.
pub(crate) fn describe(d: &WorkspaceDetach) -> String {
    let mut parts = vec![];
    if d.customer || d.card_cached {
        let card = d.card.as_deref().map(|c| format!(", card {c}")).unwrap_or_default();
        parts.push(format!("customer{card} forgotten"));
    }
    let count = |n: u32, one: &str, many: &str| if n == 1 { format!("1 {one}") } else { format!("{n} {many}") };
    if d.subscriptions > 0 {
        parts.push(format!("{} canceled", count(d.subscriptions, "plan", "plans")));
    }
    if d.card_checks > 0 {
        parts.push(format!("{} removed", count(d.card_checks, "card check", "card checks")));
    }
    if d.checkouts > 0 {
        parts.push(format!("{} removed", count(d.checkouts, "open checkout", "open checkouts")));
    }
    if d.ai_reload {
        parts.push("AI auto-reload off".into());
    }
    if d.autopay_cleared {
        parts.push("declined autopay cleared".into());
    }
    if d.invoices_voided > 0 {
        parts.push(format!("{} void", count(d.invoices_voided, "invoice", "invoices")));
    }
    if !d.months_skipped.is_empty() {
        parts.push(format!("months {} closed as skipped", d.months_skipped.join(", ")));
    }
    if d.credit_grants_closed > 0 {
        parts.push(format!("{} closed ({} unused)", count(d.credit_grants_closed, "AI credit grant", "AI credit grants"), cents(d.credit_closed_micros)));
    }
    if d.payments_reversed_micros > 0 {
        parts.push(format!("{} of test payments reversed", cents(d.payments_reversed_micros)));
    }
    if d.plan_payments_reversed_micros > 0 {
        parts.push(format!("{} of test plan payments reversed", cents(d.plan_payments_reversed_micros)));
    }
    if d.written_off_micros > 0 {
        parts.push(format!("{} owed written off as goodwill", cents(d.written_off_micros)));
    }
    if d.pending_months_marked > 0 {
        parts.push(format!(
            "{} of past months never charged ({})",
            count(d.pending_months_marked, "metered figure", "metered figures"),
            cents(d.pending_marked_micros)
        ));
    }
    if d.pending_baselined > 0 {
        parts.push(format!(
            "this month's {} kept as baseline, never charged ({})",
            count(d.pending_baselined, "metered figure", "metered figures"),
            cents(d.pending_baselined_micros)
        ));
    }
    if d.plan_credit_cleared_micros > 0 {
        parts.push(format!("{} of this month's included usage restored", cents(d.plan_credit_cleared_micros)));
    }
    if d.dispute_owed_cleared_micros > 0 {
        parts.push(format!("{} owed for lost test disputes cleared", cents(d.dispute_owed_cleared_micros)));
    }
    if d.disputes_closed > 0 {
        parts.push(format!("{} closed", count(d.disputes_closed, "open test dispute", "open test disputes")));
    }
    if d.stripe_canceled > 0 {
        parts.push(format!("{} canceled at Stripe", count(d.stripe_canceled, "subscription", "subscriptions")));
    }
    for error in &d.stripe_errors {
        parts.push(format!("Stripe: {error}"));
    }
    format!(
        "test-mode Stripe data detached from {}: {}; balance {} to {}",
        d.workspace,
        parts.join("; "),
        cents(d.balance_before_micros),
        cents(d.balance_after_micros)
    )
}

impl Billing {
    pub(crate) async fn admin_detach_test_stripe(&self, a: AdminDetachTestStripeArgs) -> Result<Outcome<TestStripeDetach>> {
        let live = self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live);
        if let Some((code, why)) = refusal(live, self.stripe.is_some(), &a) {
            return Ok(Outcome::fail(code, why));
        }
        let single = a.workspace.as_deref().map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty());
        if a.workspace.is_some() && single.is_none() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace, or none for every workspace."));
        }
        let exclude = excluded(a.exclude.as_deref());
        let by = a.by.trim().to_owned();
        let target = single.as_deref().map_or(JsValue::NULL, JsValue::from);
        let this_month = rfc3339(now_ms())[..7].to_owned();
        let found = self
            .db
            .prepare(FOUND.replace("{internal}", crate::sales::INTERNAL_SQL))
            .bind(&[target.clone(), this_month.as_str().into()])?
            .all()
            .await?
            .results::<Found>()?;
        #[derive(Deserialize)]
        struct Closed {
            workspace: String,
            month: String,
        }
        let mut closed: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for row in self.db.prepare(CLOSED).bind(&[target])?.all().await?.results::<Closed>()? {
            closed.entry(row.workspace).or_default().insert(row.month);
        }
        let none = BTreeSet::new();

        let mut out = TestStripeDetach { dry_run: a.dry_run, ..TestStripeDetach::default() };
        let mut todo: Vec<(WorkspaceDetach, Vec<OpenGrant>)> = vec![];
        for row in &found {
            let grants = if row.ai_grants > 0 { self.open_ai_grants(&row.workspace).await? } else { vec![] };
            let months = months_to_skip(row.first_entry.as_deref(), &this_month, closed.get(&row.workspace).unwrap_or(&none));
            let detach = plan(row, &grants, months);
            if !changes(&detach) {
                continue;
            }
            if let Some(reason) = skip_reason(row, single.is_some(), &exclude) {
                if single.is_some() {
                    return Ok(Outcome::fail(FailureCode::Forbidden, format!("{}: {reason}.", row.workspace)));
                }
                out.skipped.push(DetachSkipped { workspace: row.workspace.clone(), reason });
                continue;
            }
            todo.push((detach, grants));
        }
        if a.dry_run {
            out.workspaces = todo.into_iter().map(|(d, _)| d).collect();
            return Ok(Outcome::Ok(out));
        }
        out.remaining = todo.len().saturating_sub(PER_CALL) as u32;
        for (mut detach, grants) in todo.into_iter().take(PER_CALL) {
            if a.cancel_at_stripe {
                self.cancel_test_plans(&mut detach).await?;
            }
            let at_ms = now_ms();
            let at = rfc3339(at_ms);
            let statements = batch(&detach, &grants, &at, &by, &this_month, || new_id("led", at_ms));
            let mut prepared = Vec::with_capacity(statements.len());
            for (sql, values) in &statements {
                let values: Vec<JsValue> = values.iter().map(Bind::js).collect();
                prepared.push(self.db.prepare(*sql).bind(&values)?);
            }
            self.db.batch(prepared).await?;
            if detach.written_off_micros > 0 {
                self.grant_credit(&detach.workspace, CreditKind::Goodwill, detach.written_off_micros, WRITE_OFF_NOTE, &by, None, None, None, None, None)
                    .await?;
            }
            detach.done = true;
            self.audit(&own_account(&detach.workspace), "test_detach", &describe(&detach), &by).await?;
            out.workspaces.push(detach);
        }
        Ok(Outcome::Ok(out))
    }

    /// The workspace's open AI and purchased credit, with what is left.
    async fn open_ai_grants(&self, workspace: &str) -> Result<Vec<OpenGrant>> {
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let ids: BTreeSet<String> =
            self.db.prepare(AI_GRANTS).bind(&[workspace.into()])?.all().await?.results::<Id>()?.into_iter().map(|r| r.id).collect();
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let credits = self.credits_of(workspace).await?;
        Ok(credits
            .grants
            .into_iter()
            .filter(|g| ids.contains(&g.id))
            // What the ledger still holds of it, expired or not.
            .map(|g| OpenGrant { left: (g.amount_micros - g.used_micros).max(0), id: g.id, kind: g.kind })
            .collect())
    }

    /// Cancels the workspace's plans at Stripe, on the test key only (the
    /// call is refused on a live one before this).
    async fn cancel_test_plans(&self, detach: &mut WorkspaceDetach) -> Result<()> {
        let Some(stripe) = self.stripe.as_ref().filter(|s| !s.live()) else {
            return Ok(());
        };
        #[derive(Deserialize)]
        struct Plan {
            subscription_id: String,
        }
        let plans = self.db.prepare(OPEN_PLANS).bind(&[detach.workspace.as_str().into()])?.all().await?.results::<Plan>()?;
        for plan in plans {
            match stripe.cancel_now(&plan.subscription_id).await {
                Ok(_) => detach.stripe_canceled += 1,
                // Gone at Stripe already: nothing to cancel.
                Err(error) if crate::stripe::is_missing(&error) => {}
                Err(error) => detach.stripe_errors.push(format!("{}: {}", plan.subscription_id, crate::stripe::friendly(&error))),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(workspace: Option<&str>, confirm: &str, dry_run: bool) -> AdminDetachTestStripeArgs {
        AdminDetachTestStripeArgs {
            workspace: workspace.map(Into::into),
            confirm: confirm.into(),
            dry_run,
            by: "staff@g1t.sh".into(),
            ..Default::default()
        }
    }

    /// Each table the migrations leave, with its columns.
    fn schema() -> BTreeMap<String, BTreeSet<String>> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut files: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
        files.sort();
        let mut tables: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for file in files {
            let sql: String = std::fs::read_to_string(file)
                .unwrap()
                .lines()
                .map(|l| l.split("--").next().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n");
            for statement in sql.split(';') {
                let words: Vec<&str> = statement.split_whitespace().collect();
                let s = words.join(" ");
                let create = s.strip_prefix("CREATE TABLE IF NOT EXISTS ").or_else(|| s.strip_prefix("CREATE TABLE "));
                if let Some(rest) = create {
                    let Some(open) = rest.find('(') else { continue };
                    let name = rest[..open].trim().to_owned();
                    let body = &rest[open + 1..rest.rfind(')').unwrap_or(rest.len())];
                    // Split on commas outside parentheses.
                    let (mut depth, mut part, mut columns) = (0, String::new(), BTreeSet::new());
                    for ch in body.chars().chain(std::iter::once(',')) {
                        match ch {
                            '(' => depth += 1,
                            ')' => depth -= 1,
                            ',' if depth == 0 => {
                                let word = part.split_whitespace().next().unwrap_or("").to_owned();
                                if !word.is_empty() && !["PRIMARY", "UNIQUE", "FOREIGN", "CHECK"].contains(&word.as_str()) {
                                    columns.insert(word);
                                }
                                part.clear();
                                continue;
                            }
                            _ => {}
                        }
                        part.push(ch);
                    }
                    tables.insert(name, columns);
                } else if let Some(rest) = s.strip_prefix("DROP TABLE IF EXISTS ").or_else(|| s.strip_prefix("DROP TABLE ")) {
                    tables.remove(rest.trim());
                } else if let Some(rest) = s.strip_prefix("ALTER TABLE ") {
                    let words: Vec<&str> = rest.split_whitespace().collect();
                    if let [table, "ADD", "COLUMN", column, ..] = words.as_slice() {
                        tables.entry((*table).to_owned()).or_default().insert((*column).to_owned());
                    }
                }
            }
        }
        tables
    }

    fn every_sql() -> Vec<String> {
        let mut all: Vec<String> = STATEMENTS.iter().map(|s| s.to_string()).collect();
        all.extend([FOUND, CLOSED, AI_GRANTS, OPEN_PLANS, SKIP_MONTH, CLOSE_GRANT, LEDGER, BALANCE].map(String::from));
        all
    }

    #[test]
    fn every_table_and_column_is_one_the_migrations_leave() {
        let schema = schema();
        assert!(schema["ledger"].contains("credit_kind") && schema["accounts"].contains("tax_address_needed_at"));
        for (table, columns) in USES {
            let have = schema.get(*table).unwrap_or_else(|| panic!("{table} is not a table after the migrations"));
            for column in *columns {
                assert!(have.contains(*column), "{table}.{column} is not a column after the migrations");
            }
        }
        // Every table the SQL names is in USES, and every column in USES
        // is named somewhere, so the list cannot go stale.
        let all = every_sql().join("\n");
        for table in schema.keys() {
            let named = [" FROM ", " INTO ", "UPDATE "].iter().any(|p| all.contains(&format!("{p}{table} ")) || all.contains(&format!("{p}{table}\n")));
            if named {
                assert!(USES.iter().any(|(t, _)| t == table), "{table} is used but not in USES");
            }
        }
        for (table, columns) in USES {
            for column in *columns {
                assert!(all.contains(column) || *table == "admin_actions", "{table}.{column} is listed but never named");
            }
        }
    }

    #[test]
    fn nothing_is_deleted_but_card_checks_open_checkouts_and_this_months_plan_draws() {
        let all = every_sql().join("\n");
        assert_eq!(all.matches("DELETE FROM").count(), 3);
        assert!(all.contains("DELETE FROM card_checks WHERE workspace = ?1"));
        assert!(all.contains("DELETE FROM checkouts WHERE workspace = ?1 AND status = 'open'"));
        // Only the plan's included usage, only this month: the trial and
        // the open-source pool's draws stay.
        assert!(all.contains("DELETE FROM allowance_use WHERE kind = 'plan_credit' AND scope = ?1 AND month = ?4"));
        // The trial grant stays: no second trial.
        assert!(!all.contains("trial_grants"));
        assert_eq!(PLAN_REVERSAL.len(), 12);
        assert!(all.matches("'_test_detach'").count() >= 3);
    }

    #[test]
    fn refused_on_a_live_key_and_without_confirmation() {
        let one = args(Some("acme"), "acme", false);
        assert_eq!(refusal(true, true, &one).unwrap().0, FailureCode::Forbidden);
        assert_eq!(refusal(true, true, &args(None, "", true)).unwrap().0, FailureCode::Forbidden);
        assert!(refusal(false, true, &one).is_none());
        assert!(refusal(false, false, &one).is_none());
        assert!(refusal(false, true, &args(Some("acme"), "acm", false)).is_some());
        assert!(refusal(false, true, &args(None, "acme", false)).is_some());
        assert!(refusal(false, true, &args(None, CONFIRM_ALL, false)).is_none());
        // A dry run needs no confirmation.
        assert!(refusal(false, true, &args(None, "", true)).is_none());
        // Canceling at Stripe needs a (test) key.
        let cancel = AdminDetachTestStripeArgs { cancel_at_stripe: true, ..args(None, CONFIRM_ALL, false) };
        assert!(refusal(false, false, &cancel).is_some());
        assert!(refusal(false, true, &cancel).is_none());
        let nobody = AdminDetachTestStripeArgs { by: " ".into(), ..one };
        assert!(refusal(false, true, &nobody).is_some());
    }

    #[test]
    fn every_workspace_skips_comped_enterprise_and_excluded() {
        let found = |slug: &str, comped: i64, enterprise: i64| Found { workspace: slug.into(), comped, enterprise, ..Found::default() };
        let defaults = excluded(None);
        assert_eq!(defaults, ["flagon-io", "syntaqx"].iter().map(|s| s.to_string()).collect());
        assert!(skip_reason(&found("syntaqx", 0, 0), false, &defaults).is_some());
        assert!(skip_reason(&found("flagon-io", 1, 0), false, &defaults).is_some());
        assert!(skip_reason(&found("acme", 1, 0), false, &defaults).is_some());
        assert!(skip_reason(&found("acme", 0, 1), false, &defaults).is_some());
        assert!(skip_reason(&found("acme", 0, 0), false, &defaults).is_none());
        // An empty list excludes nothing; a given one replaces the default.
        let given = excluded(Some(&[" Acme ".to_string(), String::new()]));
        assert_eq!(given.len(), 1);
        assert!(skip_reason(&found("syntaqx", 0, 0), false, &given).is_none());
        assert!(skip_reason(&found("acme", 0, 0), false, &given).is_some());
        // One workspace chosen by staff: anything but an enterprise's.
        assert!(skip_reason(&found("syntaqx", 0, 0), true, &defaults).is_none());
        assert!(skip_reason(&found("flagon-io", 1, 0), true, &defaults).is_none());
        assert!(skip_reason(&found("acme", 0, 1), true, &defaults).is_some());
    }

    #[test]
    fn every_past_month_not_closed_is_skipped() {
        let closed: BTreeSet<String> = ["2026-09".to_string()].into();
        assert_eq!(months_to_skip(Some("2026-07-14T10:00:00.000Z"), "2026-10", &closed), ["2026-07", "2026-08"]);
        assert_eq!(months_to_skip(Some("2025-11-30T00:00:00Z"), "2026-02", &BTreeSet::new()), ["2025-11", "2025-12", "2026-01"]);
        assert!(months_to_skip(Some("2026-10-01T00:00:00Z"), "2026-10", &BTreeSet::new()).is_empty());
        assert!(months_to_skip(None, "2026-10", &BTreeSet::new()).is_empty());
    }

    /// A workspace that paid $50 in test mode, bought $20 of AI credit
    /// ($5 used), used $30 of other things, and has a card, a plan and an
    /// open invoice.
    fn tested() -> (Found, Vec<OpenGrant>) {
        let found = Found {
            workspace: "acme".into(),
            customer: 1,
            card_brand: Some("visa".into()),
            card_last4: Some("4242".into()),
            card_cached: 1,
            balance: 35_000_000,
            subscriptions: 1,
            card_checks: 1,
            checkouts: 1,
            invoices: 1,
            ai_grants: 1,
            paid: 70_000_000,
            plan_unreversed: 20_000_000,
            first_entry: Some("2026-09-02T00:00:00Z".into()),
            ..Found::default()
        };
        (found, vec![OpenGrant { id: "cs_test_ai".into(), kind: CreditKind::Purchased, left: 15_000_000 }])
    }

    #[test]
    fn the_balance_comes_to_zero_and_nothing_counts_as_paid() {
        let (found, grants) = tested();
        let d = plan(&found, &grants, vec!["2026-09".into()]);
        assert!(changes(&d));
        assert_eq!(d.card.as_deref(), Some("visa 4242"));
        assert_eq!(d.credit_closed_micros, 15_000_000);
        // 70 paid less the 15 of AI credit closed: 55 reversed.
        assert_eq!(d.payments_reversed_micros, 55_000_000);
        // 35 - 15 - 55 = -35 owed: written off.
        assert_eq!(d.written_off_micros, 35_000_000);
        assert_eq!(d.balance_after_micros, 0);
        assert_eq!(d.plan_payments_reversed_micros, 20_000_000);
        // Paid ledger lines after: 70 - 15 - 55 = 0.
        let statements = batch(&d, &grants, "2026-10-13T00:00:00.000Z", "staff@g1t.sh", "2026-10", || "led_x".into());
        let moved: i64 = statements
            .iter()
            .filter(|(sql, _)| *sql == LEDGER)
            .map(|(_, v)| match v[2] { Bind::Number(n) => n, _ => 0 })
            .sum();
        assert_eq!(found.balance + moved + d.written_off_micros, 0);
        assert!(statements.iter().any(|(sql, v)| *sql == LEDGER && v[4] == text("cs_test_ai_revoked")));
        assert!(statements.iter().any(|(sql, v)| *sql == SKIP_MONTH && v[1] == text("2026-09")));
        // Every statement gets exactly the values it names.
        for (sql, values) in &statements {
            assert_eq!(crate::rename::parameters(sql), values.len(), "{sql}");
        }
        assert!(describe(&d).contains("$35.00 owed written off as goodwill"));
    }

    #[test]
    fn staff_credit_left_is_kept() {
        // $10 promotional with $5 left, $50 paid, $5 used: balance 55.
        let found = Found { workspace: "acme".into(), balance: 55_000_000, paid: 50_000_000, ..Found::default() };
        let d = plan(&found, &[], vec![]);
        assert_eq!(d.payments_reversed_micros, 50_000_000);
        assert_eq!(d.written_off_micros, 0);
        assert_eq!(d.balance_after_micros, 5_000_000);
    }

    #[test]
    fn a_second_run_changes_nothing() {
        // After a detach FOUND reads: no customer or card, plans canceled,
        // no checks or open checkouts, invoices void, AI credit closed,
        // payments netting to nothing, plan payments reversed, and every
        // past month closed.
        let (found, grants) = tested();
        let first = plan(&found, &grants, months_to_skip(found.first_entry.as_deref(), "2026-10", &BTreeSet::new()));
        let closed: BTreeSet<String> = first.months_skipped.iter().cloned().collect();
        let after = Found {
            workspace: "acme".into(),
            balance: first.balance_after_micros,
            paid: found.paid - first.credit_closed_micros - first.payments_reversed_micros,
            first_entry: found.first_entry.clone(),
            ..Found::default()
        };
        let second = plan(&after, &[], months_to_skip(after.first_entry.as_deref(), "2026-10", &closed));
        assert!(!changes(&second), "{second:?}");
        assert!(batch(&second, &[], "t", "b", "2026-10", || "x".into()).iter().all(|(sql, _)| STATEMENTS.contains(sql)));
        // Refunds beyond what was paid are never reversed again.
        let refunded = Found { workspace: "acme".into(), paid: -5_000_000, ..Found::default() };
        assert!(!changes(&plan(&refunded, &[], vec![])));
    }

    #[test]
    fn metered_usage_from_test_mode_is_never_charged_live() {
        // Past months' rows are marked charged, this month's kept as the
        // baseline, both in the batch and only for the workspace.
        let past = STATEMENTS.iter().find(|s| s.starts_with("UPDATE pending_usage")).unwrap();
        assert!(past.contains(&format!("'{PENDING_MARK}' || ?2")) && past.contains("month < ?4") && past.contains("charged_at IS NULL"));
        let base = STATEMENTS.iter().find(|s| s.contains("INTO pending_baselines")).unwrap();
        assert!(base.contains("month = ?4") && base.contains("MAX(pending_baselines.cost_micros, excluded.cost_micros)"));
        // Raised only when there is more: a second run writes nothing.
        assert!(base.contains("WHERE excluded.cost_micros > pending_baselines.cost_micros"));
        assert!(FOUND.contains("AS pending_now") && FOUND.contains("u.cost_micros > COALESCE(b.cost_micros, 0)"));
        let found = Found {
            workspace: "acme".into(),
            pending_past: 2,
            pending_past_micros: 1_200_000,
            pending_now: 1,
            pending_now_micros: 300_000,
            plan_credit: 4_000_000,
            dispute_owed: 46_400_000,
            open_disputes: 1,
            ..Found::default()
        };
        let d = plan(&found, &[], vec![]);
        assert!(changes(&d));
        assert_eq!((d.pending_months_marked, d.pending_baselined, d.disputes_closed), (2, 1, 1));
        assert_eq!((d.plan_credit_cleared_micros, d.dispute_owed_cleared_micros), (4_000_000, 46_400_000));
        let statements = batch(&d, &[], "2026-10-13T00:00:00.000Z", "staff@g1t.sh", "2026-10", || "led_x".into());
        for (sql, values) in &statements {
            assert_eq!(crate::rename::parameters(sql), values.len(), "{sql}");
            if crate::rename::parameters(sql) == 4 {
                assert_eq!(values[3], text("2026-10"), "{sql}");
            }
        }
        let text = describe(&d);
        assert!(text.contains("2 metered figures of past months never charged ($1.20)"), "{text}");
        assert!(text.contains("$4.00 of this month's included usage restored"), "{text}");
        // What a run leaves: nothing more to do.
        assert!(!changes(&plan(&Found { workspace: "acme".into(), ..Found::default() }, &[], vec![])));
    }

    #[test]
    fn test_disputes_owe_nothing_and_hold_nothing() {
        let all = STATEMENTS.join("\n");
        assert!(all.contains("UPDATE limits SET dispute_owed_micros = 0 WHERE workspace = ?1 AND dispute_owed_micros <> 0"));
        assert!(all.contains("UPDATE disputes SET status = 'detached', updated_at = ?2 WHERE workspace = ?1 AND status = 'open'"));
        // A detached dispute is never acted on again.
        assert!(!crate::webhooks::dispute_moves(Some("detached"), "lost"));
        assert!(!crate::webhooks::dispute_moves(Some("detached"), "open"));
        // And it no longer holds the stop a dispute made.
        assert!(crate::CLEAR_STOP.contains("disputes.status = 'open'"));
    }

    #[test]
    fn a_test_plan_payment_is_no_evidence_of_the_plan() {
        let evidence = crate::storage::PLAN_EVIDENCE;
        assert!(evidence.contains("p.amount_micros > 0"));
        assert!(evidence.contains("substr(p.invoice_id, -12) <> '_test_detach'"));
        assert!(evidence.contains("q.invoice_id = p.invoice_id || '_test_detach'"));
        assert!(evidence.contains("), 0) > 0)"));
    }
}
