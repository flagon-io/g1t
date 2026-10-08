//! Owners asking g1t for more: a higher limit ("Raise my limit"), or help
//! with usage past what they meant ("Spent more than you meant to?").
//!
//! A request goes to sudo with the workspace's history beside it: spend by
//! month, payments cleared, disputes and declines, how long it has been
//! here, and its recent pace. Staff approve it (at the amount asked, or
//! another) or decline it in one click; the owner is told in the app and by
//! email. g1t answers within one business day.
//!
//! An approved limit is a granted ceiling (see `limits`): a floor under the
//! ceiling trust gives, and the owners' spend limit moves up to it.

use g1t_contracts::billing::{
    AdminDecideLimitRequestArgs, AdminLimitRequestsArgs, AdminRecordPaymentArgs, EntryKind, LedgerEntry, LimitRequest,
    LimitRequestReview, LimitRequestsArgs, RequestLimitArgs, WorkspaceHistory, MICROS_PER_DOLLAR,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::features::dollars;
use crate::{Billing, LedgerRow, members_only};

/// The most a request may ask for: past it, the conversation is about
/// custom terms, which staff set in sudo.
const MAX_REQUEST_MICROS: i64 = 1_000_000 * MICROS_PER_DOLLAR;

#[derive(Deserialize)]
struct RequestRow {
    id: String,
    workspace: String,
    kind: String,
    amount_micros: i64,
    reason: String,
    expected_monthly_micros: i64,
    status: String,
    decided_micros: Option<i64>,
    decided_by: Option<String>,
    answer: Option<String>,
    created_by: String,
    created_at: String,
    decided_at: Option<String>,
}

impl From<RequestRow> for LimitRequest {
    fn from(row: RequestRow) -> Self {
        LimitRequest {
            id: row.id,
            workspace: row.workspace,
            kind: row.kind,
            amount_micros: row.amount_micros,
            reason: row.reason,
            expected_monthly_micros: row.expected_monthly_micros,
            status: row.status,
            decided_micros: row.decided_micros,
            decided_by: row.decided_by,
            answer: row.answer,
            created_by: row.created_by,
            created_at: row.created_at,
            decided_at: row.decided_at,
        }
    }
}

/// Checks a request before it is saved. `Err` says what to fix.
pub(crate) fn validate(kind: &str, amount: i64, reason: &str, current: Option<i64>) -> std::result::Result<(), String> {
    if kind != "limit" && kind != "overage" {
        return Err("A request is for a higher limit, or about usage past what was meant.".to_owned());
    }
    let reason = reason.trim();
    if reason.chars().count() < 10 {
        return Err("Say in a sentence what it is for, so g1t can answer.".to_owned());
    }
    if reason.chars().count() > 2000 {
        return Err("Keep it under 2,000 characters.".to_owned());
    }
    if kind == "limit" {
        if amount <= 0 || amount > MAX_REQUEST_MICROS {
            return Err("Ask for a monthly limit between $1 and $1,000,000.".to_owned());
        }
        if current.is_some_and(|current| amount <= current) {
            return Err(format!(
                "That is within what you can set yourself ({}). Set it under Spend limit; no request is needed.",
                dollars(current.unwrap_or_default())
            ));
        }
    }
    Ok(())
}

/// What the owner is told about a decision.
pub(crate) fn answer(kind: &str, approved: Option<i64>, asked: i64, note: &str) -> String {
    let note = note.trim();
    let mut text = match (kind, approved) {
        ("overage", Some(_)) => "g1t looked at this month's usage and has answered below.".to_owned(),
        ("overage", None) => "g1t looked at this month's usage.".to_owned(),
        (_, Some(amount)) if amount >= asked => format!("Approved: the limit is now {}.", dollars(amount)),
        (_, Some(amount)) => format!("Approved at {}, rather than the {} asked for.", dollars(amount), dollars(asked)),
        (_, None) => "Not approved this time.".to_owned(),
    };
    if !note.is_empty() {
        text.push(' ');
        text.push_str(note);
    }
    text
}

impl Billing {
    /// `request_limit`: an owner asks.
    pub(crate) async fn request_limit(&self, a: RequestLimitArgs) -> Result<Outcome<LimitRequest>> {
        let workspace = a.workspace.to_lowercase();
        if !a.actor.manages_billing(&workspace) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner or a billing manager can ask g1t about the workspace's limit."));
        }
        let limit = self.limit_of(&workspace).await?;
        let current = limit.available_micros.max(limit.raise_once_micros);
        if let Err(why) = validate(&a.kind, a.amount_micros, &a.reason, if a.kind == "limit" { current } else { None }) {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        // One open request of each kind at a time: a second replaces nothing.
        let open = self
            .db
            .prepare("SELECT id FROM limit_requests WHERE workspace = ? AND kind = ? AND status = 'open'")
            .bind(&[workspace.as_str().into(), a.kind.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if open.is_some() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "There is already a request waiting for g1t. It is answered within one business day.",
            ));
        }
        let now = now_ms();
        let id = new_id("lrq", now);
        self.db
            .prepare(
                "INSERT INTO limit_requests (id, workspace, kind, amount_micros, reason, expected_monthly_micros, status, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                workspace.as_str().into(),
                a.kind.as_str().into(),
                (a.amount_micros.max(0) as f64).into(),
                a.reason.trim().into(),
                (a.expected_monthly_micros.max(0) as f64).into(),
                a.actor.username.as_str().into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
        let account = self.account_of(&workspace).await?;
        let what = if a.kind == "limit" {
            format!("asked for a {} limit", dollars(a.amount_micros))
        } else {
            "asked about usage past what was meant".to_owned()
        };
        self.audit(&account.id, "request", &format!("{workspace}: {what}: {}", a.reason.trim()), &a.actor.username).await?;
        Ok(match self.request(&id).await? {
            Some(request) => Outcome::Ok(request),
            None => Outcome::fail(FailureCode::NotFound, "The request was not saved."),
        })
    }

    async fn request(&self, id: &str) -> Result<Option<LimitRequest>> {
        Ok(self
            .db
            .prepare("SELECT * FROM limit_requests WHERE id = ?")
            .bind(&[id.into()])?
            .first::<RequestRow>(None)
            .await?
            .map(LimitRequest::from))
    }

    /// `limit_requests`: a workspace's requests and their answers.
    pub(crate) async fn limit_requests(&self, a: LimitRequestsArgs) -> Result<Outcome<Vec<LimitRequest>>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        Ok(Outcome::Ok(self.requests_of(&workspace).await?))
    }

    pub(crate) async fn requests_of(&self, workspace: &str) -> Result<Vec<LimitRequest>> {
        Ok(self
            .db
            .prepare("SELECT * FROM limit_requests WHERE workspace = ? ORDER BY created_at DESC LIMIT 20")
            .bind(&[workspace.into()])?
            .all()
            .await?
            .results::<RequestRow>()?
            .into_iter()
            .map(LimitRequest::from)
            .collect())
    }

    /// A workspace's history with g1t, for staff deciding about it.
    pub(crate) async fn history(&self, workspace: &str) -> Result<WorkspaceHistory> {
        let limit = self.limit_of(workspace).await?;
        let months = self.months_for(&[workspace.to_owned()], 6).await?;
        #[derive(Deserialize)]
        struct Row {
            paid: Option<i64>,
            payments: Option<u32>,
            disputes: Option<u32>,
            first_seen: Option<String>,
        }
        let settled = rfc3339(now_ms() - crate::limits::SETTLE_DAYS * 24 * 60 * 60 * 1000);
        let row = self
            .db
            .prepare(
                "SELECT
                   SUM(CASE WHEN kind = 'top_up' AND amount_micros > 0 AND reference NOT LIKE 'crd%' AND disputed = 0
                             AND created_at <= ?2 THEN amount_micros END) AS paid,
                   SUM(CASE WHEN kind = 'top_up' AND amount_micros > 0 AND reference NOT LIKE 'crd%' THEN 1 ELSE 0 END) AS payments,
                   SUM(CASE WHEN disputed = 1 THEN 1 ELSE 0 END) AS disputes,
                   MIN(created_at) AS first_seen
                 FROM ledger WHERE workspace = ?1",
            )
            .bind(&[workspace.into(), settled.into()])?
            .first::<Row>(None)
            .await?;
        #[derive(Deserialize)]
        struct Count {
            n: Option<u32>,
        }
        let declines = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM workspace_invoices WHERE workspace = ? AND status = 'failed'")
            .bind(&[workspace.into()])?
            .first::<Count>(None)
            .await?
            .and_then(|c| c.n)
            .unwrap_or(0);
        let pace = self.pace(workspace).await?;
        let row = row.unwrap_or(Row { paid: None, payments: None, disputes: None, first_seen: None });
        Ok(WorkspaceHistory {
            plan: Some(self.plan_kind(workspace).await?),
            months,
            paid_cleared_micros: row.paid.unwrap_or(0),
            payments: row.payments.unwrap_or(0),
            disputes: row.disputes.unwrap_or(0),
            declines,
            first_seen: row.first_seen,
            ceiling_micros: limit.ceiling_micros,
            max_ceiling_micros: limit.max_ceiling_micros,
            spend_limit_micros: limit.spend_limit_micros,
            last_hour_micros: pace.last_hour,
            average_hour_micros: pace.usual_hour,
            last_day_micros: pace.last_day,
        })
    }

    /// `admin_limit_requests`: requests for staff, oldest open first.
    pub(crate) async fn admin_limit_requests(&self, a: AdminLimitRequestsArgs) -> Result<Vec<LimitRequestReview>> {
        let status = a.status.unwrap_or_else(|| "open".to_owned());
        let rows = self
            .db
            .prepare(
                "SELECT * FROM limit_requests WHERE (?1 = 'all' OR status = ?1)
                 ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, CASE WHEN status = 'open' THEN created_at END ASC,
                          created_at DESC
                 LIMIT 100",
            )
            .bind(&[status.as_str().into()])?
            .all()
            .await?
            .results::<RequestRow>()?;
        let mut reviews = vec![];
        for row in rows {
            let request = LimitRequest::from(row);
            let history = self.history(&request.workspace).await?;
            reviews.push(LimitRequestReview { request, history });
        }
        Ok(reviews)
    }

    /// `admin_decide_limit_request`: approve or decline, and tell the owner.
    pub(crate) async fn admin_decide_limit_request(&self, a: AdminDecideLimitRequestArgs) -> Result<Outcome<LimitRequest>> {
        if a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say who is deciding."));
        }
        let approve = match a.decision.as_str() {
            "approve" => true,
            "decline" => false,
            _ => return Ok(Outcome::fail(FailureCode::Invalid, "Approve or decline.")),
        };
        let Some(request) = self.request(&a.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such request."));
        };
        if request.status != "open" {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("That request was {} already.", request.status)));
        }
        let amount = if approve && request.kind == "limit" { Some(a.amount_micros.unwrap_or(request.amount_micros)) } else { None };
        if amount.is_some_and(|m| m <= 0 || m > MAX_REQUEST_MICROS) {
            return Ok(Outcome::fail(FailureCode::Invalid, "Approve between $1 and $1,000,000."));
        }
        if !approve && a.note.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why, for the owner, when declining."));
        }
        let text = answer(&request.kind, amount.or(approve.then_some(0)), request.amount_micros, &a.note);
        let now = rfc3339(now_ms());
        let claimed = self
            .db
            .prepare(
                "UPDATE limit_requests SET status = ?1, decided_micros = ?2, decided_by = ?3, answer = ?4, decided_at = ?5
                 WHERE id = ?6 AND status = 'open' RETURNING id",
            )
            .bind(&[
                (if approve { "approved" } else { "declined" }).into(),
                amount.map_or(worker::wasm_bindgen::JsValue::NULL, |m| (m as f64).into()),
                a.by.trim().into(),
                text.as_str().into(),
                now.as_str().into(),
                a.id.as_str().into(),
            ])?
            .first::<serde_json::Value>(None)
            .await?;
        if claimed.is_none() {
            return Ok(Outcome::fail(FailureCode::Conflict, "Someone decided it meanwhile."));
        }
        let workspace = request.workspace.clone();
        if let Some(amount) = amount {
            // The ceiling rises to it, and so does the owners' spend limit.
            self.db
                .prepare(
                    "INSERT INTO limits (workspace, granted_ceiling_micros, spend_limit_micros, updated_at) VALUES (?1, ?2, ?2, ?3)
                     ON CONFLICT (workspace) DO UPDATE SET
                       granted_ceiling_micros = MAX(COALESCE(granted_ceiling_micros, 0), ?2),
                       spend_limit_micros = CASE WHEN spend_limit_full = 1 THEN spend_limit_micros
                                                 ELSE MAX(COALESCE(spend_limit_micros, 0), ?2) END,
                       updated_at = ?3",
                )
                .bind(&[workspace.as_str().into(), (amount as f64).into(), now.as_str().into()])?
                .run()
                .await?;
        }
        let account = self.account_of(&workspace).await?;
        self.audit(
            &account.id,
            "request",
            &format!("{workspace}: {} request {}: {text}", request.kind, if approve { "approved" } else { "declined" }),
            a.by.trim(),
        )
        .await?;
        if let Some(identity) = &self.identity {
            let subject = match (request.kind.as_str(), approve) {
                ("limit", true) => format!("g1t: {workspace}'s limit was raised"),
                ("limit", false) => format!("g1t: about {workspace}'s limit"),
                _ => format!("g1t: about {workspace}'s usage this month"),
            };
            crate::limits::notify(identity, &workspace, &subject, &text, "Open billing", &format!("https://g1t.sh/{workspace}/-/billing"))
                .await;
        }
        Ok(match self.request(&a.id).await? {
            Some(request) => Outcome::Ok(request),
            None => Outcome::fail(FailureCode::NotFound, "No such request."),
        })
    }

    /// `admin_record_payment`: money that reached g1t outside the card
    /// pages, such as a bank transfer, entered as a payment.
    pub(crate) async fn admin_record_payment(&self, a: AdminRecordPaymentArgs) -> Result<Outcome<LedgerEntry>> {
        let workspace = a.workspace.trim().to_lowercase();
        let reference = a.reference.trim();
        if workspace.is_empty() || reference.is_empty() || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "A payment needs a workspace, the transfer's reference, and who recorded it."));
        }
        if a.amount_micros <= 0 || a.amount_micros > 100_000 * MICROS_PER_DOLLAR {
            return Ok(Outcome::fail(FailureCode::Invalid, "A payment is more than $0 and at most $100,000."));
        }
        let key = format!("bank/{reference}");
        let seen = self
            .db
            .prepare("SELECT id FROM ledger WHERE reference = ?")
            .bind(&[key.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if seen.is_some() {
            return Ok(Outcome::fail(FailureCode::Conflict, "That transfer is recorded already."));
        }
        let note = a.note.trim();
        let description = if note.is_empty() { "Paid by bank transfer".to_owned() } else { format!("Paid by bank transfer: {note}") };
        self.enter(&workspace, EntryKind::TopUp, a.amount_micros, &description, &key, None, None, Some(a.by.trim()), None)
            .await?;
        let account = self.account_of(&workspace).await?;
        self.audit(
            &account.id,
            "payment",
            &format!("{} to {workspace} by bank transfer, reference {reference}{}", dollars(a.amount_micros), if note.is_empty() { String::new() } else { format!(": {note}") }),
            a.by.trim(),
        )
        .await?;
        let row = self
            .db
            .prepare("SELECT * FROM ledger WHERE reference = ?")
            .bind(&[key.as_str().into()])?
            .first::<LedgerRow>(None)
            .await?;
        Ok(match row {
            Some(row) => Outcome::Ok(LedgerEntry::from(row)),
            None => Outcome::fail(FailureCode::NotFound, "The payment was not saved."),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_says_what_it_is_for() {
        assert!(validate("limit", 500_000_000, "We are moving our CI to g1t this month.", Some(200_000_000)).is_ok());
        assert!(validate("limit", 500_000_000, "more", Some(200_000_000)).unwrap_err().contains("in a sentence"));
        assert!(validate("other", 1, "We are moving our CI to g1t.", None).is_err());
        // Within what the owners can set themselves: no request needed.
        assert!(validate("limit", 150_000_000, "We are moving our CI to g1t.", Some(200_000_000)).unwrap_err().contains("yourself"));
        assert!(validate("limit", 0, "We are moving our CI to g1t.", None).is_err());
        // An overage needs no amount.
        assert!(validate("overage", 0, "An agent looped overnight on #12.", None).is_ok());
    }

    #[test]
    fn the_owner_is_told_plainly() {
        assert_eq!(answer("limit", Some(500_000_000), 500_000_000, ""), "Approved: the limit is now $500.00.");
        assert_eq!(
            answer("limit", Some(300_000_000), 500_000_000, "We can go higher after a month of payments."),
            "Approved at $300.00, rather than the $500.00 asked for. We can go higher after a month of payments."
        );
        assert_eq!(answer("limit", None, 500_000_000, "Your card was declined twice."), "Not approved this time. Your card was declined twice.");
    }
}
