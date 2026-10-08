//! Credit g1t staff give a workspace from sudo: promotional, goodwill, or a
//! refund.
//!
//! A grant goes on the ledger as a `crd…` top-up, so it is never a payment,
//! with `credit_kind` set, and in `credit_grants` with its note, who gave
//! it, and an optional expiry. It raises the balance at once.
//!
//! **Spending.** Credit is spent before anything paid in advance, the
//! soonest-expiring grant first (never-expiring last, then oldest). Given
//! while the workspace owes, it pays what is owed first: the most recent
//! usage not yet paid for. What each grant paid for is never stored: it is
//! worked out from the ledger in order (`replay`), so it is always what the
//! ledger says, and the many places that charge usage need not know about
//! credit at all.
//!
//! **Expiry and revoking.** Unused credit past its expiry stops counting:
//! the daily run enters what is left as a negative `crd…_expired` line.
//! Staff can revoke what is left of a grant, with why (`crd…_revoked`).
//! Neither ever takes the balance below what was paid in: at most the
//! balance, if a refund of a payment brought it lower than the credit left.
//!
//! **Margin.** Usage paid for with promotional or goodwill credit is given
//! away, never money in (`margin::usage_rows`). A refund gives back money
//! already paid: it comes off money in on the day it refunds (at most 30
//! days back, the days the reconciliation still recomputes), and what it
//! pays for later is paid for. Refunds never expire.

use std::collections::BTreeMap;

use g1t_contracts::billing::{
    AdminCreditArgs, AdminCredits, AdminCreditsArgs, AdminRevokeCreditArgs, CreditGrant, CreditKind, CreditMonth, Credits, EntryKind,
    LedgerEntry, MICROS_PER_DOLLAR,
};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::features::cents;
use crate::{Billing, LedgerRow, optional};

/// The most one credit can be, against a slipped finger.
pub(crate) const MAX_CREDIT_MICROS: i64 = 10_000 * MICROS_PER_DOLLAR;
/// The furthest an expiry can be: five years.
const MAX_EXPIRY_DAYS: u64 = 5 * 366;
/// How far back a refund can take money off: the days the daily
/// reconciliation recomputes. An older day's refund lands on the oldest.
pub(crate) const REFUND_DAYS_BACK: u64 = 30;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// The arithmetic, apart from the database so it can be tested.
// ---------------------------------------------------------------------

/// A grant, as the replay needs it.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Grant {
    pub id: String,
    pub kind: CreditKind,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub closed_at: Option<String>,
    /// Pays only for model usage (agent runs), not everything.
    pub models_only: bool,
}

/// The tasks that are not a model's work: sandbox and runner time,
/// deployments, and the month-end meters.
const NOT_MODELS: [&str; 8] = ["sandbox", "self_hosted", "deployments", "security", "context", "storage", "git", "cache"];

/// Whether a usage line is model usage (an agent run's model cost), which
/// credit scoped to models can pay for.
pub(crate) fn is_model_usage(task: Option<&str>) -> bool {
    task.is_some_and(|task| !NOT_MODELS.contains(&task))
}

/// A ledger line, oldest first.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub(crate) struct Line {
    pub reference: String,
    pub kind: String,
    pub amount_micros: i64,
    pub created_at: String,
    #[serde(default)]
    pub task: Option<String>,
}

/// What a grant paid of one usage line: less than nothing when a charge
/// came down and gave some back.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Draw {
    pub grant: String,
    pub kind: CreditKind,
    /// The usage line it paid for, or the grant itself for what was owed
    /// from before the lines read.
    pub reference: String,
    pub task: Option<String>,
    /// When the line it paid for was entered.
    pub at: String,
    pub micros: i64,
}

/// What the ledger says each grant paid for.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Replay {
    pub draws: Vec<Draw>,
    /// Each grant's left, at the end; absent for a grant not on the ledger.
    pub left: BTreeMap<String, i64>,
}

impl Replay {
    pub fn used(&self, grant: &str) -> i64 {
        self.draws.iter().filter(|d| d.grant == grant).map(|d| d.micros).sum()
    }
}

/// Whether a grant can pay for something entered at `at`: on the ledger,
/// not closed, not expired.
fn open_at(grant: &Grant, at: &str) -> bool {
    grant.closed_at.as_deref().is_none_or(|closed| closed > at) && grant.expires_at.as_deref().is_none_or(|expires| expires > at)
}

/// Works out what each grant paid for, from the ledger in order: every
/// charge from the open grants, the soonest-expiring first; a grant given
/// while the balance was below zero pays what was owed, the most recent
/// usage first; a charge that came down gives back to the grants that paid
/// last. `opening` is the balance before the first line.
pub(crate) fn replay(opening: i64, lines: &[Line], grants: &[Grant]) -> Replay {
    let mut out = Replay::default();
    let mut balance = opening;
    // Usage lines with what is still unpaid by credit, for a grant that
    // pays what was owed.
    let mut usage: Vec<(usize, i64)> = vec![];
    for (index, line) in lines.iter().enumerate() {
        let grant = grants.iter().find(|g| g.id == line.reference);
        if let Some(grant) = grant.filter(|_| line.amount_micros > 0) {
            let mut left = line.amount_micros;
            let mut owed = (-balance).max(0).min(left);
            for (i, unpaid) in usage.iter_mut().rev() {
                if owed == 0 {
                    break;
                }
                let take = (*unpaid).min(owed);
                if take > 0 {
                    let paid = &lines[*i];
                    out.draws.push(Draw {
                        grant: grant.id.clone(),
                        kind: grant.kind,
                        reference: paid.reference.clone(),
                        task: paid.task.clone(),
                        at: paid.created_at.clone(),
                        micros: take,
                    });
                    *unpaid -= take;
                    owed -= take;
                    left -= take;
                }
            }
            if owed > 0 {
                // Owed from before the lines read: on the grant's own day.
                out.draws.push(Draw {
                    grant: grant.id.clone(),
                    kind: grant.kind,
                    reference: grant.id.clone(),
                    task: None,
                    at: line.created_at.clone(),
                    micros: owed,
                });
                left -= owed;
            }
            out.left.insert(grant.id.clone(), left);
        } else if line.kind == "usage" && line.amount_micros < 0 {
            let charge = -line.amount_micros;
            let mut open: Vec<&Grant> = grants
                .iter()
                .filter(|g| out.left.get(&g.id).is_some_and(|left| *left > 0) && open_at(g, &line.created_at))
                .filter(|g| !g.models_only || is_model_usage(line.task.as_deref()))
                .collect();
            open.sort_by(|a, b| spend_order(a, b));
            let mut due = charge;
            for grant in open {
                if due == 0 {
                    break;
                }
                let left = out.left.get_mut(&grant.id).expect("an open grant has a left");
                let take = (*left).min(due);
                *left -= take;
                due -= take;
                out.draws.push(Draw {
                    grant: grant.id.clone(),
                    kind: grant.kind,
                    reference: line.reference.clone(),
                    task: line.task.clone(),
                    at: line.created_at.clone(),
                    micros: take,
                });
            }
            usage.push((index, due));
        } else if line.kind == "usage" && line.amount_micros > 0 {
            // A charge that came down: back to the grants that paid last,
            // while they can still be spent.
            let mut back = line.amount_micros;
            let mut returned: Vec<Draw> = vec![];
            for draw in out.draws.iter().rev() {
                if back == 0 {
                    break;
                }
                let Some(grant) = grants.iter().find(|g| g.id == draw.grant) else { continue };
                let paid: i64 = out.draws.iter().chain(returned.iter()).filter(|d| d.grant == grant.id).map(|d| d.micros).sum();
                if draw.micros <= 0 || paid <= 0 || !open_at(grant, &line.created_at) {
                    continue;
                }
                let give = draw.micros.min(paid).min(back);
                back -= give;
                returned.push(Draw {
                    grant: grant.id.clone(),
                    kind: grant.kind,
                    reference: line.reference.clone(),
                    task: line.task.clone(),
                    at: line.created_at.clone(),
                    micros: -give,
                });
            }
            for draw in returned {
                *out.left.entry(draw.grant.clone()).or_insert(0) -= draw.micros;
                out.draws.push(draw);
            }
        } else if let Some(id) = closed_grant(&line.reference) {
            // What expired or was revoked: nothing more to spend.
            if let Some(left) = out.left.get_mut(id) {
                *left = 0;
            }
        }
        balance += line.amount_micros;
    }
    // Closed or expired by now: nothing left to spend, whatever the ledger
    // has not caught up with yet.
    out
}

/// Credit scoped to models before credit for everything; then the
/// soonest-expiring first, never-expiring last; then the oldest.
fn spend_order(a: &Grant, b: &Grant) -> std::cmp::Ordering {
    b.models_only
        .cmp(&a.models_only)
        .then_with(|| match (&a.expires_at, &b.expires_at) {
            (Some(x), Some(y)) => x.cmp(y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        })
        .then_with(|| a.created_at.cmp(&b.created_at))
}

/// The grant a `<grant>_expired` or `<grant>_revoked` line closes.
pub(crate) fn closed_grant(reference: &str) -> Option<&str> {
    reference.strip_suffix("_expired").or_else(|| reference.strip_suffix("_revoked"))
}

/// What expiring or revoking takes off the balance: what is left of the
/// grant, and never the balance below zero (a refunded payment can leave
/// less there than the credit).
pub(crate) fn take_back(left: i64, balance: i64) -> i64 {
    left.max(0).min(balance.max(0))
}

/// `open`, `used`, `expired` or `revoked`, and what can still be spent.
pub(crate) fn state(left: i64, expires_at: Option<&str>, closed_reason: Option<&str>, now: &str) -> (&'static str, i64) {
    match closed_reason {
        Some("revoked") => ("revoked", 0),
        Some(_) => ("expired", 0),
        None if expires_at.is_some_and(|at| at <= now) => ("expired", 0),
        None if left <= 0 => ("used", 0),
        None => ("open", left),
    }
}

/// The key a usage line is reconciled under, as `margin::usage_rows` reads
/// it: builds apart from a deployment's requests.
pub(crate) fn usage_key(task: Option<&str>, reference: &str) -> String {
    match task {
        Some("deployments") if reference.starts_with("deploy/") => "builds".to_owned(),
        Some(task) => task.to_owned(),
        None => "other".to_owned(),
    }
}

/// The day a refund takes money off: the day it refunds, but no further
/// back than the reconciliation recomputes from the day it was given.
pub(crate) fn refund_cash_day(refund_day: Option<&str>, granted_at: &str) -> String {
    let granted = &granted_at[..10];
    let oldest = rfc3339(parse_rfc3339(&format!("{granted}T00:00:00Z")).unwrap_or(0).saturating_sub(REFUND_DAYS_BACK * DAY_MS))[..10].to_owned();
    match refund_day {
        Some(day) if day.len() == 10 && day <= granted => day.max(oldest.as_str()).to_owned(),
        _ => granted.to_owned(),
    }
}

/// A `YYYY-MM-DD` that is a real day.
fn is_day(day: &str) -> bool {
    day.len() == 10 && parse_rfc3339(&format!("{day}T00:00:00Z")).is_some_and(|ms| rfc3339(ms).starts_with(day))
}

/// What is wrong with a credit as asked for, if anything.
pub(crate) fn invalid(a: &AdminCreditArgs, now_ms: u64) -> Option<&'static str> {
    if a.workspace.trim().is_empty() || a.note.trim().is_empty() || a.by.trim().is_empty() {
        return Some("A credit needs a workspace, a note and who gave it.");
    }
    if a.note.trim().chars().count() > 500 {
        return Some("Keep the note under 500 characters.");
    }
    if a.kind == CreditKind::Purchased {
        return Some("Staff give promotional, goodwill or refund credit; purchased credit is bought by the workspace.");
    }
    if a.amount_micros <= 0 || a.amount_micros > MAX_CREDIT_MICROS {
        return Some("A credit is more than $0 and at most $10,000.");
    }
    if let Some(expires) = &a.expires_at {
        if a.kind == CreditKind::Refund {
            return Some("A refund never expires: it is money the workspace already paid.");
        }
        match parse_rfc3339(expires) {
            Some(at) if at > now_ms && at <= now_ms + MAX_EXPIRY_DAYS * DAY_MS => {}
            Some(at) if at <= now_ms => return Some("The expiry has to be in the future."),
            _ => return Some("The expiry is a date within five years."),
        }
    }
    if a.kind == CreditKind::Refund {
        if a.refund_for.as_deref().is_none_or(|f| f.trim().is_empty()) {
            return Some("Say what the refund is for, such as the failed runs on Oct 2.");
        }
        if a.refund_for.as_deref().is_some_and(|f| f.trim().chars().count() > 200) {
            return Some("Keep what the refund is for under 200 characters.");
        }
        if let Some(day) = &a.refund_day
            && (!is_day(day) || day.as_str() > &rfc3339(now_ms)[..10])
        {
            return Some("The day refunded is a date, today or before.");
        }
    }
    None
}

/// The line on the statement: `Credit from g1t (promotional): Welcome to g1t`.
pub(crate) fn describe_grant(kind: CreditKind, note: &str, refund_for: Option<&str>, expires_at: Option<&str>) -> String {
    let what = match (kind, refund_for) {
        (CreditKind::Refund, Some(what)) => format!("refund for {}", what.trim()),
        (kind, _) => kind.as_str().to_owned(),
    };
    let until = expires_at.map(|at| format!(", until {}", &at[..at.len().min(10)])).unwrap_or_default();
    format!("Credit from g1t ({what}{until}): {}", note.trim())
}

/// A month's credits by kind, from the grants (given, taken back) and what
/// they paid for.
pub(crate) fn fold_months(grants: &[GrantRow], draws: &[Draw]) -> Vec<CreditMonth> {
    fn at<'a>(months: &'a mut BTreeMap<(String, CreditKind), CreditMonth>, month: &str, kind: CreditKind) -> &'a mut CreditMonth {
        months.entry((month.to_owned(), kind)).or_insert_with(|| CreditMonth { month: month.to_owned(), kind, ..CreditMonth::default() })
    }
    let mut months: BTreeMap<(String, CreditKind), CreditMonth> = BTreeMap::new();
    for grant in grants {
        let kind = grant.kind();
        let m = at(&mut months, &grant.created_at[..7], kind);
        m.given_micros += grant.amount_micros;
        m.grants += 1;
        if let Some(closed) = &grant.closed_at {
            let m = at(&mut months, &closed[..7], kind);
            if grant.closed_reason.as_deref() == Some("revoked") {
                m.revoked_micros += grant.closed_micros;
            } else {
                m.expired_micros += grant.closed_micros;
            }
        }
    }
    for draw in draws {
        at(&mut months, &draw.at[..7], draw.kind).used_micros += draw.micros;
    }
    let mut out: Vec<CreditMonth> = months.into_values().collect();
    out.sort_by(|a, b| b.month.cmp(&a.month).then(a.kind.cmp(&b.kind)));
    out
}

// ---------------------------------------------------------------------
// The database.
// ---------------------------------------------------------------------

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct GrantRow {
    pub id: String,
    pub workspace: String,
    pub kind: String,
    pub amount_micros: i64,
    pub note: String,
    pub refund_for: Option<String>,
    pub refund_day: Option<String>,
    pub expires_at: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub closed_reason: Option<String>,
    pub closed_note: Option<String>,
    pub closed_by: Option<String>,
    #[serde(default)]
    pub closed_micros: i64,
    /// `all` or `models`.
    #[serde(default)]
    pub scope: Option<String>,
    /// `staff`, `purchase` or `promo_code`.
    #[serde(default)]
    pub source: Option<String>,
}

impl GrantRow {
    pub fn kind(&self) -> CreditKind {
        CreditKind::parse(&self.kind).unwrap_or_default()
    }

    fn facts(&self) -> Grant {
        Grant {
            id: self.id.clone(),
            kind: self.kind(),
            expires_at: self.expires_at.clone(),
            created_at: self.created_at.clone(),
            closed_at: self.closed_at.clone(),
            models_only: self.scope.as_deref() == Some("models"),
        }
    }

    fn view(&self, replay: &Replay, now: &str) -> CreditGrant {
        let used = replay.used(&self.id);
        let left = replay.left.get(&self.id).copied().unwrap_or(0);
        let (state, left) = state(left, self.expires_at.as_deref(), self.closed_reason.as_deref(), now);
        CreditGrant {
            id: self.id.clone(),
            workspace: self.workspace.clone(),
            kind: self.kind(),
            amount_micros: self.amount_micros,
            used_micros: used,
            left_micros: left,
            note: self.note.clone(),
            refund_for: self.refund_for.clone(),
            refund_day: self.refund_day.clone(),
            expires_at: self.expires_at.clone(),
            created_by: self.created_by.clone(),
            created_at: self.created_at.clone(),
            state: state.to_owned(),
            closed_at: self.closed_at.clone(),
            closed_note: self.closed_note.clone(),
            closed_by: self.closed_by.clone(),
            closed_micros: self.closed_micros,
            scope: self.scope.clone().unwrap_or_else(|| "all".to_owned()),
            source: self.source.clone().unwrap_or_else(|| "staff".to_owned()),
        }
    }
}

/// A refund's money given back, on the day it comes off.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Refunded {
    pub workspace: String,
    pub day: String,
    pub micros: i64,
}

impl Billing {
    async fn grants_of(&self, workspace: &str) -> Result<Vec<GrantRow>> {
        self.db
            .prepare("SELECT * FROM credit_grants WHERE workspace = ? ORDER BY created_at DESC")
            .bind(&[workspace.into()])?
            .all()
            .await?
            .results::<GrantRow>()
    }

    /// The workspace's ledger from the month before its first grant, and
    /// the balance before it, replayed against its grants.
    async fn replay_of(&self, workspace: &str, grants: &[GrantRow]) -> Result<(Replay, i64)> {
        let Some(first) = grants.iter().map(|g| g.created_at.as_str()).min() else {
            return Ok((Replay::default(), 0));
        };
        let since = format!("{}-01", crate::limits::previous_month(&first[..7]));
        let lines = self
            .db
            .prepare(
                "SELECT reference, kind, amount_micros, created_at, task FROM ledger
                 WHERE workspace = ? AND created_at >= ? ORDER BY created_at, id",
            )
            .bind(&[workspace.into(), since.into()])?
            .all()
            .await?
            .results::<Line>()?;
        let balance = self.row(workspace).await?.map_or(0, |row| row.balance_micros);
        let opening = balance - lines.iter().map(|l| l.amount_micros).sum::<i64>();
        let facts: Vec<Grant> = grants.iter().map(GrantRow::facts).collect();
        Ok((replay(opening, &lines, &facts), balance))
    }

    /// `credits`: a workspace's credits from g1t, for its members.
    pub(crate) async fn credits(&self, a: g1t_contracts::billing::AccountArgs) -> Result<Outcome<Credits>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(crate::members_only());
        }
        Ok(Outcome::Ok(self.credits_of(&workspace).await?))
    }

    pub(crate) async fn credits_of(&self, workspace: &str) -> Result<Credits> {
        let grants = self.grants_of(workspace).await?;
        let (replay, _) = self.replay_of(workspace, &grants).await?;
        let now = rfc3339(now_ms());
        let grants: Vec<CreditGrant> = grants.iter().map(|g| g.view(&replay, &now)).collect();
        Ok(Credits { left_micros: grants.iter().map(|g| g.left_micros).sum(), grants })
    }

    /// Enters a grant: the ledger line and its `credit_grants` row. Returns
    /// the grant's reference. `reference` names it, for a grant made
    /// elsewhere (the Overages queue's goodwill).
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn grant_credit(
        &self,
        workspace: &str,
        kind: CreditKind,
        amount: i64,
        note: &str,
        by: &str,
        expires_at: Option<&str>,
        refund_for: Option<&str>,
        refund_day: Option<&str>,
        reference: Option<String>,
        description: Option<String>,
    ) -> Result<String> {
        let now = now_ms();
        let reference = reference.unwrap_or_else(|| new_id("crd", now));
        let description = description.unwrap_or_else(|| describe_grant(kind, note, refund_for, expires_at));
        let refund_day = (kind == CreditKind::Refund).then(|| refund_day.map_or_else(|| rfc3339(now)[..10].to_owned(), str::to_owned));
        self.db
            .prepare(
                "INSERT INTO credit_grants (id, workspace, kind, amount_micros, note, refund_for, refund_day, expires_at, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                reference.as_str().into(),
                workspace.into(),
                kind.as_str().into(),
                (amount as f64).into(),
                note.trim().into(),
                optional(refund_for.map(str::trim)),
                optional(refund_day.as_deref()),
                optional(expires_at),
                by.into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
        self.enter(workspace, EntryKind::TopUp, amount, &description, &reference, None, None, Some(by), None).await?;
        self.mark_credit(&reference, kind).await?;
        Ok(reference)
    }

    async fn mark_credit(&self, reference: &str, kind: CreditKind) -> Result<()> {
        self.db
            .prepare("UPDATE ledger SET credit_kind = ? WHERE reference = ?")
            .bind(&[kind.as_str().into(), reference.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// `admin_credit`: credit for a workspace, from sudo.
    pub(crate) async fn admin_credit(&self, a: AdminCreditArgs) -> Result<Outcome<LedgerEntry>> {
        if let Some(why) = invalid(&a, now_ms()) {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        let workspace = a.workspace.trim().to_lowercase();
        let reference = self
            .grant_credit(
                &workspace,
                a.kind,
                a.amount_micros,
                a.note.trim(),
                a.by.trim(),
                a.expires_at.as_deref(),
                a.refund_for.as_deref(),
                a.refund_day.as_deref(),
                None,
                None,
            )
            .await?;
        let account = self.account_of(&workspace).await?;
        let until = a.expires_at.as_deref().map(|at| format!(", until {}", &at[..10])).unwrap_or_default();
        let refund = a.refund_for.as_deref().filter(|_| a.kind == CreditKind::Refund).map(|f| format!(" for {}", f.trim())).unwrap_or_default();
        self.audit(
            &account.id,
            "credit",
            &format!("{} {} credit to {workspace}{refund}{until}: {}", cents(a.amount_micros), a.kind.as_str(), a.note.trim()),
            a.by.trim(),
        )
        .await?;
        self.tell_owners_of_credit(&workspace, a.kind, a.amount_micros, a.note.trim(), a.refund_for.as_deref(), a.expires_at.as_deref()).await;
        let row = self
            .db
            .prepare("SELECT * FROM ledger WHERE reference = ?")
            .bind(&[reference.as_str().into()])?
            .first::<LedgerRow>(None)
            .await?;
        Ok(match row {
            Some(row) => Outcome::Ok(LedgerEntry::from(row)),
            None => Outcome::fail(FailureCode::NotFound, "The credit was not saved."),
        })
    }

    /// Emails the workspace's owners that credit was given. Never fails the
    /// grant.
    pub(crate) async fn tell_owners_of_credit(
        &self,
        workspace: &str,
        kind: CreditKind,
        amount: i64,
        note: &str,
        refund_for: Option<&str>,
        expires_at: Option<&str>,
    ) {
        let Some(identity) = &self.identity else { return };
        let (subject, intro) = credit_notice(workspace, kind, amount, note, refund_for, expires_at);
        crate::limits::notify_with(
            identity,
            workspace,
            &subject,
            &intro,
            "Open billing",
            &format!("https://g1t.sh/{workspace}/-/billing#credits"),
            "You get this because you own this workspace on g1t. Credits are explained at https://docs.g1t.sh/guides/usage-and-billing/#credits-from-g1t",
        )
        .await;
    }

    /// Takes what is left of a grant off the balance: expired, or revoked
    /// by staff. Returns what it took.
    async fn close_grant(&self, grant: &GrantRow, reason: &str, note: Option<&str>, by: &str) -> Result<i64> {
        let grants = self.grants_of(&grant.workspace).await?;
        let (replay, balance) = self.replay_of(&grant.workspace, &grants).await?;
        let left = replay.left.get(&grant.id).copied().unwrap_or(0);
        let take = take_back(left, balance);
        let now = rfc3339(now_ms());
        // Closed first, so a second close finds it closed and takes nothing.
        let claimed = self
            .db
            .prepare(
                "UPDATE credit_grants SET closed_at = ?1, closed_reason = ?2, closed_note = ?3, closed_by = ?4, closed_micros = ?5
                 WHERE id = ?6 AND closed_at IS NULL RETURNING id",
            )
            .bind(&[now.as_str().into(), reason.into(), optional(note), by.into(), (take as f64).into(), grant.id.as_str().into()])?
            .first::<crate::Touched>(None)
            .await?;
        if claimed.is_none() || take == 0 {
            return Ok(0);
        }
        let reference = format!("{}_{reason}", grant.id);
        let verb = if reason == "revoked" { "withdrawn" } else { "expired" };
        let description = format!(
            "Credit from g1t {verb}: {} unused of the {} given on {}",
            cents(take),
            cents(grant.amount_micros),
            &grant.created_at[..10]
        );
        self.enter(&grant.workspace, EntryKind::TopUp, -take, &description, &reference, None, None, Some(by), None).await?;
        self.mark_credit(&reference, grant.kind()).await?;
        Ok(take)
    }

    async fn grant(&self, id: &str) -> Result<Option<GrantRow>> {
        self.db.prepare("SELECT * FROM credit_grants WHERE id = ?").bind(&[id.into()])?.first::<GrantRow>(None).await
    }

    /// `admin_revoke_credit`: what is left of a grant, taken back.
    pub(crate) async fn admin_revoke_credit(&self, a: AdminRevokeCreditArgs) -> Result<Outcome<CreditGrant>> {
        let note = a.note.trim();
        if note.is_empty() || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why, and who is revoking it."));
        }
        let Some(grant) = self.grant(a.id.trim()).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such credit."));
        };
        if grant.closed_at.is_some() {
            return Ok(Outcome::fail(FailureCode::Conflict, "This credit is closed already."));
        }
        let taken = self.close_grant(&grant, "revoked", Some(note), a.by.trim()).await?;
        let account = self.account_of(&grant.workspace).await?;
        self.audit(
            &account.id,
            "credit_revoked",
            &format!("{} unused of {}'s {} {} credit from {}: {note}", cents(taken), grant.workspace, cents(grant.amount_micros), grant.kind, &grant.created_at[..10]),
            a.by.trim(),
        )
        .await?;
        let credits = self.credits_of(&grant.workspace).await?;
        Ok(match credits.grants.into_iter().find(|g| g.id == grant.id) {
            Some(grant) => Outcome::Ok(grant),
            None => Outcome::fail(FailureCode::NotFound, "The credit was not found again."),
        })
    }

    /// The daily run: grants past their expiry, closed, and what was left
    /// of each taken off the balance.
    pub(crate) async fn expire_credits(&self) -> Result<u32> {
        let now = rfc3339(now_ms());
        let due = self
            .db
            .prepare("SELECT * FROM credit_grants WHERE closed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 200")
            .bind(&[now.as_str().into()])?
            .all()
            .await?
            .results::<GrantRow>()?;
        let mut closed = 0;
        for grant in due {
            let taken = self.close_grant(&grant, "expired", None, "g1t").await?;
            let account = self.account_of(&grant.workspace).await?;
            self.audit(
                &account.id,
                "credit_expired",
                &format!("{} unused of {}'s {} {} credit from {}", cents(taken), grant.workspace, cents(grant.amount_micros), grant.kind, &grant.created_at[..10]),
                "g1t",
            )
            .await?;
            closed += 1;
        }
        Ok(closed)
    }

    /// `admin_credits`: every grant, filtered, with each month's totals.
    pub(crate) async fn admin_credits(&self, a: AdminCreditsArgs) -> Result<AdminCredits> {
        // The last 12 months, and anything older still open.
        let mut first = rfc3339(now_ms())[..7].to_owned();
        for _ in 0..11 {
            first = crate::limits::previous_month(&first);
        }
        #[derive(Deserialize)]
        struct Workspace {
            workspace: String,
        }
        let workspaces = self
            .db
            .prepare("SELECT DISTINCT workspace FROM credit_grants WHERE created_at >= ? OR closed_at >= ? OR closed_at IS NULL")
            .bind(&[format!("{first}-01").into(), format!("{first}-01").into()])?
            .all()
            .await?
            .results::<Workspace>()?;
        let now = rfc3339(now_ms());
        let mut rows: Vec<GrantRow> = vec![];
        let mut views: Vec<CreditGrant> = vec![];
        let mut draws: Vec<Draw> = vec![];
        for Workspace { workspace } in workspaces {
            let grants = self.grants_of(&workspace).await?;
            let (replay, _) = self.replay_of(&workspace, &grants).await?;
            views.extend(grants.iter().map(|g| g.view(&replay, &now)));
            draws.extend(replay.draws);
            rows.extend(grants);
        }
        views.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        let months = fold_months(&rows, &draws).into_iter().filter(|m| m.month >= first).collect();
        let mut staff: Vec<String> = views.iter().map(|g| g.created_by.clone()).collect();
        staff.sort();
        staff.dedup();
        let workspace = a.workspace.as_deref().map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty());
        let grants = views
            .into_iter()
            .filter(|g| workspace.as_deref().is_none_or(|w| g.workspace == w))
            .filter(|g| a.kind.is_none_or(|k| g.kind == k))
            .filter(|g| a.month.as_deref().is_none_or(|m| g.created_at.starts_with(m)))
            .filter(|g| a.by.as_deref().is_none_or(|by| g.created_by == by))
            .take(200)
            .collect();
        Ok(AdminCredits { grants, months, staff })
    }

    /// What credits paid for between two days (`YYYY-MM-DD`), and refunds'
    /// money given back on those days, for the reconciliation.
    pub(crate) async fn credit_effects(&self, since: &str, until: &str) -> Result<(Vec<(String, Draw)>, Vec<Refunded>)> {
        let end = format!("{until}T23:59:59.999Z");
        let grants = self
            .db
            .prepare("SELECT * FROM credit_grants WHERE created_at <= ?1 AND (closed_at IS NULL OR closed_at >= ?2)")
            .bind(&[end.as_str().into(), day_start_before(since).into()])?
            .all()
            .await?
            .results::<GrantRow>()?;
        let mut workspaces: Vec<String> = grants.iter().map(|g| g.workspace.clone()).collect();
        workspaces.sort();
        workspaces.dedup();
        let mut draws = vec![];
        for workspace in workspaces {
            let all = self.grants_of(&workspace).await?;
            let (replay, _) = self.replay_of(&workspace, &all).await?;
            draws.extend(
                replay
                    .draws
                    .into_iter()
                    .filter(|d| d.at.as_str() >= since && d.at.as_str() <= end.as_str())
                    .map(|d| (workspace.clone(), d)),
            );
        }
        let refunds = grants
            .iter()
            .filter(|g| g.kind() == CreditKind::Refund)
            .map(|g| Refunded {
                workspace: g.workspace.clone(),
                day: refund_cash_day(g.refund_day.as_deref(), &g.created_at),
                micros: (g.amount_micros - g.closed_micros).max(0),
            })
            .filter(|r| r.micros > 0 && r.day.as_str() >= since && r.day.as_str() <= until)
            .collect();
        Ok((draws, refunds))
    }
}

/// The instant a reconciliation's first day starts, less the refund window:
/// a grant closed before it paid for nothing in the days and refunds none.
fn day_start_before(since: &str) -> String {
    let ms = parse_rfc3339(&format!("{since}T00:00:00Z")).unwrap_or(0);
    rfc3339(ms.saturating_sub(REFUND_DAYS_BACK * DAY_MS))
}

/// The owners' email: subject and first paragraph.
pub(crate) fn credit_notice(
    workspace: &str,
    kind: CreditKind,
    amount: i64,
    note: &str,
    refund_for: Option<&str>,
    expires_at: Option<&str>,
) -> (String, String) {
    let amount = cents(amount);
    let subject = match kind {
        CreditKind::Refund => format!("g1t: a {amount} refund for {workspace}, as credit"),
        _ => format!("g1t: {amount} of credit for {workspace}"),
    };
    let what = match (kind, refund_for) {
        (CreditKind::Refund, Some(what)) => format!("g1t refunded {amount} to {workspace} as credit, for {}.", what.trim()),
        _ => format!("g1t added {amount} of credit to {workspace}."),
    };
    let until = match expires_at {
        Some(at) => format!(" Unused credit expires on {}.", &at[..at.len().min(10)]),
        None => String::new(),
    };
    let intro = format!(
        "{what} {}{}It pays for usage before anything paid in advance, and you can see what is left on the Billing page.{until}",
        note.trim(),
        if note.trim().ends_with(['.', '!', '?']) { " " } else { ". " },
    );
    (subject, intro)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(id: &str, kind: CreditKind, expires: Option<&str>, created: &str) -> Grant {
        Grant { id: id.into(), kind, expires_at: expires.map(Into::into), created_at: created.into(), closed_at: None, models_only: false }
    }

    fn line(reference: &str, kind: &str, amount: i64, at: &str) -> Line {
        Line { reference: reference.into(), kind: kind.into(), amount_micros: amount, created_at: at.into(), task: Some("implement".into()) }
    }

    #[test]
    fn credit_pays_for_usage_before_anything_paid_in_advance() {
        // $50 paid in advance, then $25 of credit, then $10 of usage: the
        // credit pays for all of it.
        let grants = [grant("crd_a", CreditKind::Promotional, None, "2026-10-02T00:00:00Z")];
        let lines = [
            line("cs_paid", "top_up", 50_000_000, "2026-10-01T00:00:00Z"),
            line("crd_a", "top_up", 25_000_000, "2026-10-02T00:00:00Z"),
            line("run_1", "usage", -10_000_000, "2026-10-03T00:00:00Z"),
        ];
        let r = replay(0, &lines, &grants);
        assert_eq!(r.used("crd_a"), 10_000_000);
        assert_eq!(r.left["crd_a"], 15_000_000);
        assert_eq!(r.draws.len(), 1);
        assert_eq!(r.draws[0].reference, "run_1");
    }

    #[test]
    fn the_soonest_expiring_credit_is_spent_first() {
        let grants = [
            grant("crd_never", CreditKind::Goodwill, None, "2026-10-01T00:00:00Z"),
            grant("crd_late", CreditKind::Promotional, Some("2027-01-01T00:00:00Z"), "2026-10-01T00:00:01Z"),
            grant("crd_soon", CreditKind::Promotional, Some("2026-11-01T00:00:00Z"), "2026-10-01T00:00:02Z"),
        ];
        let lines = [
            line("crd_never", "top_up", 5_000_000, "2026-10-01T00:00:00Z"),
            line("crd_late", "top_up", 5_000_000, "2026-10-01T00:00:01Z"),
            line("crd_soon", "top_up", 5_000_000, "2026-10-01T00:00:02Z"),
            line("run_1", "usage", -7_000_000, "2026-10-05T00:00:00Z"),
            line("run_2", "usage", -6_000_000, "2026-10-06T00:00:00Z"),
        ];
        let r = replay(0, &lines, &grants);
        assert_eq!((r.used("crd_soon"), r.used("crd_late"), r.used("crd_never")), (5_000_000, 5_000_000, 3_000_000));
        assert_eq!(r.left["crd_never"], 2_000_000);
        // Past its expiry, a grant pays for nothing more.
        let lines = [
            line("crd_soon", "top_up", 5_000_000, "2026-10-01T00:00:02Z"),
            line("run_late", "usage", -1_000_000, "2026-11-02T00:00:00Z"),
        ];
        let r = replay(0, &lines, &grants);
        assert_eq!(r.used("crd_soon"), 0);
        assert_eq!(r.left["crd_soon"], 5_000_000);
    }

    #[test]
    fn credit_for_models_pays_only_for_models_and_is_spent_first() {
        let models = Grant { models_only: true, ..grant("pi_ai", CreditKind::Purchased, Some("2027-10-01T00:00:00Z"), "2026-10-01T00:00:01Z") };
        let grants = [grant("crd_all", CreditKind::Promotional, Some("2026-11-01T00:00:00Z"), "2026-10-01T00:00:00Z"), models];
        let mut sandbox = line("run_1/sandbox", "usage", -2_000_000, "2026-10-02T00:00:00Z");
        sandbox.task = Some("sandbox".into());
        let lines = [
            line("crd_all", "top_up", 5_000_000, "2026-10-01T00:00:00Z"),
            line("pi_ai", "top_up", 10_000_000, "2026-10-01T00:00:01Z"),
            line("run_1", "usage", -3_000_000, "2026-10-02T00:00:00Z"),
            sandbox,
        ];
        let r = replay(0, &lines, &grants);
        // The run's model cost from the models credit, though the other
        // expires sooner; the sandbox time only from credit for everything.
        assert_eq!((r.used("pi_ai"), r.used("crd_all")), (3_000_000, 2_000_000));
        assert!(is_model_usage(Some("implement")) && !is_model_usage(Some("sandbox")) && !is_model_usage(None));
    }

    #[test]
    fn credit_given_while_owing_pays_the_most_recent_usage_first() {
        let grants = [grant("crd_a", CreditKind::Goodwill, None, "2026-10-10T00:00:00Z")];
        let lines = [
            line("run_1", "usage", -20_000_000, "2026-10-02T00:00:00Z"),
            line("run_2", "usage", -10_000_000, "2026-10-05T00:00:00Z"),
            line("crd_a", "top_up", 25_000_000, "2026-10-10T00:00:00Z"),
        ];
        let r = replay(0, &lines, &grants);
        let paid: Vec<(&str, i64)> = r.draws.iter().map(|d| (d.reference.as_str(), d.micros)).collect();
        assert_eq!(paid, [("run_2", 10_000_000), ("run_1", 15_000_000)]);
        assert_eq!(r.left["crd_a"], 0);
        // Owed from before the lines read: on the grant's day.
        let r = replay(-4_000_000, &[line("crd_a", "top_up", 25_000_000, "2026-10-10T00:00:00Z")], &grants);
        assert_eq!(r.draws[0].reference, "crd_a");
        assert_eq!(r.draws[0].micros, 4_000_000);
        assert_eq!(r.left["crd_a"], 21_000_000);
    }

    #[test]
    fn a_charge_that_comes_down_gives_back_to_the_credit_that_paid() {
        let grants = [grant("crd_a", CreditKind::Promotional, None, "2026-10-01T00:00:00Z")];
        let lines = [
            line("crd_a", "top_up", 10_000_000, "2026-10-01T00:00:00Z"),
            line("run_1", "usage", -3_000_000, "2026-10-02T00:00:00Z"),
            line("run_1/settled", "usage", 1_000_000, "2026-10-02T01:00:00Z"),
        ];
        let r = replay(0, &lines, &grants);
        assert_eq!(r.used("crd_a"), 2_000_000);
        assert_eq!(r.left["crd_a"], 8_000_000);
        assert_eq!(r.draws.last().unwrap().micros, -1_000_000);
    }

    #[test]
    fn revoked_or_expired_credit_pays_for_nothing_more() {
        let mut revoked = grant("crd_a", CreditKind::Promotional, None, "2026-10-01T00:00:00Z");
        revoked.closed_at = Some("2026-10-03T00:00:00Z".into());
        let lines = [
            line("crd_a", "top_up", 10_000_000, "2026-10-01T00:00:00Z"),
            line("run_1", "usage", -3_000_000, "2026-10-02T00:00:00Z"),
            line("crd_a_revoked", "top_up", -7_000_000, "2026-10-03T00:00:00Z"),
            line("run_2", "usage", -3_000_000, "2026-10-04T00:00:00Z"),
        ];
        let r = replay(0, &lines, &[revoked]);
        assert_eq!(r.used("crd_a"), 3_000_000);
        assert_eq!(r.left["crd_a"], 0);
        assert_eq!(closed_grant("crd_a_revoked"), Some("crd_a"));
        assert_eq!(closed_grant("crd_a_expired"), Some("crd_a"));
        assert_eq!(closed_grant("run_1"), None);
    }

    #[test]
    fn taking_credit_back_never_takes_the_balance_below_zero() {
        assert_eq!(take_back(12_400_000, 50_000_000), 12_400_000);
        // A refunded payment left less on the balance than the credit.
        assert_eq!(take_back(12_400_000, 5_000_000), 5_000_000);
        assert_eq!(take_back(12_400_000, -1), 0);
        assert_eq!(take_back(-5, 10), 0);
    }

    #[test]
    fn a_grant_says_where_it_stands() {
        let now = "2026-10-07T12:00:00Z";
        assert_eq!(state(12_400_000, Some("2027-01-05T23:59:59Z"), None, now), ("open", 12_400_000));
        assert_eq!(state(0, None, None, now), ("used", 0));
        assert_eq!(state(5, Some("2026-10-01T00:00:00Z"), None, now), ("expired", 0));
        assert_eq!(state(5, None, Some("revoked"), now), ("revoked", 0));
        assert_eq!(state(0, Some("2026-10-01T00:00:00Z"), Some("expired"), now), ("expired", 0));
    }

    #[test]
    fn a_credit_needs_a_kind_a_note_and_a_sensible_amount() {
        let now = parse_rfc3339("2026-10-07T12:00:00Z").unwrap();
        let ok = AdminCreditArgs {
            workspace: "acme".into(),
            amount_micros: 25_000_000,
            note: "Welcome to g1t".into(),
            by: "chase@g1t.sh".into(),
            kind: CreditKind::Promotional,
            expires_at: Some("2027-01-05T23:59:59Z".into()),
            refund_for: None,
            refund_day: None,
        };
        assert_eq!(invalid(&ok, now), None);
        assert!(invalid(&AdminCreditArgs { note: " ".into(), ..clone(&ok) }, now).is_some());
        assert!(invalid(&AdminCreditArgs { amount_micros: 0, ..clone(&ok) }, now).is_some());
        assert!(invalid(&AdminCreditArgs { amount_micros: MAX_CREDIT_MICROS + 1, ..clone(&ok) }, now).is_some());
        assert_eq!(invalid(&AdminCreditArgs { amount_micros: MAX_CREDIT_MICROS, ..clone(&ok) }, now), None);
        assert!(invalid(&AdminCreditArgs { expires_at: Some("2026-10-01T00:00:00Z".into()), ..clone(&ok) }, now).unwrap().contains("future"));
        assert!(invalid(&AdminCreditArgs { expires_at: Some("2040-01-01T00:00:00Z".into()), ..clone(&ok) }, now).is_some());
        // A refund says what for, never expires, and refunds a day that was.
        let refund = AdminCreditArgs { kind: CreditKind::Refund, expires_at: None, refund_for: Some("the failed runs on Oct 2".into()), refund_day: Some("2026-10-02".into()), ..clone(&ok) };
        assert_eq!(invalid(&refund, now), None);
        assert!(invalid(&AdminCreditArgs { expires_at: Some("2027-01-05T23:59:59Z".into()), ..clone(&refund) }, now).unwrap().contains("never expires"));
        assert!(invalid(&AdminCreditArgs { refund_for: None, ..clone(&refund) }, now).is_some());
        assert!(invalid(&AdminCreditArgs { refund_day: Some("2026-10-09".into()), ..clone(&refund) }, now).is_some());
        assert!(invalid(&AdminCreditArgs { refund_day: Some("2026-02-30".into()), ..clone(&refund) }, now).is_some());
    }

    fn clone(a: &AdminCreditArgs) -> AdminCreditArgs {
        AdminCreditArgs {
            workspace: a.workspace.clone(),
            amount_micros: a.amount_micros,
            note: a.note.clone(),
            by: a.by.clone(),
            kind: a.kind,
            expires_at: a.expires_at.clone(),
            refund_for: a.refund_for.clone(),
            refund_day: a.refund_day.clone(),
        }
    }

    #[test]
    fn a_refund_takes_money_off_the_day_it_refunds_within_the_window() {
        assert_eq!(refund_cash_day(Some("2026-10-02"), "2026-10-07T12:00:00Z"), "2026-10-02");
        // Further back than the reconciliation recomputes: its oldest day.
        assert_eq!(refund_cash_day(Some("2026-08-01"), "2026-10-07T12:00:00Z"), "2026-09-07");
        // None, or a day after it was given: the day it was given.
        assert_eq!(refund_cash_day(None, "2026-10-07T12:00:00Z"), "2026-10-07");
        assert_eq!(refund_cash_day(Some("2026-10-09"), "2026-10-07T12:00:00Z"), "2026-10-07");
    }

    #[test]
    fn usage_is_keyed_as_the_reconciliation_keys_it() {
        assert_eq!(usage_key(Some("deployments"), "deploy/abc"), "builds");
        assert_eq!(usage_key(Some("deployments"), "requests/2026-10"), "deployments");
        assert_eq!(usage_key(Some("implement"), "run_1"), "implement");
        assert_eq!(usage_key(None, "crd_a"), "other");
    }

    #[test]
    fn the_statement_and_the_email_say_what_the_credit_is() {
        assert_eq!(describe_grant(CreditKind::Promotional, "Welcome to g1t", None, Some("2027-01-05T23:59:59Z")), "Credit from g1t (promotional, until 2027-01-05): Welcome to g1t");
        assert_eq!(
            describe_grant(CreditKind::Refund, "Sorry about that", Some("the failed runs on Oct 2"), None),
            "Credit from g1t (refund for the failed runs on Oct 2): Sorry about that"
        );
        let (subject, intro) = credit_notice("acme", CreditKind::Promotional, 25_000_000, "Welcome to g1t", None, Some("2027-01-05T23:59:59Z"));
        assert_eq!(subject, "g1t: $25.00 of credit for acme");
        assert!(intro.starts_with("g1t added $25.00 of credit to acme. Welcome to g1t. It pays for usage"));
        assert!(intro.ends_with("Unused credit expires on 2027-01-05."));
        let (subject, intro) = credit_notice("acme", CreditKind::Refund, 12_000_000, "Sorry.", Some("the outage on Oct 2"), None);
        assert_eq!(subject, "g1t: a $12.00 refund for acme, as credit");
        assert!(intro.starts_with("g1t refunded $12.00 to acme as credit, for the outage on Oct 2. Sorry. It pays"));
    }

    #[test]
    fn months_add_up_given_used_and_taken_back_by_kind() {
        let promo = GrantRow {
            id: "crd_a".into(),
            workspace: "acme".into(),
            kind: "promotional".into(),
            amount_micros: 25_000_000,
            created_at: "2026-09-20T00:00:00Z".into(),
            closed_at: Some("2026-10-20T00:00:00Z".into()),
            closed_reason: Some("expired".into()),
            closed_micros: 5_000_000,
            ..GrantRow::default()
        };
        let draws = [
            Draw { grant: "crd_a".into(), kind: CreditKind::Promotional, reference: "r1".into(), task: None, at: "2026-09-25T00:00:00Z".into(), micros: 15_000_000 },
            Draw { grant: "crd_a".into(), kind: CreditKind::Promotional, reference: "r2".into(), task: None, at: "2026-10-02T00:00:00Z".into(), micros: 5_000_000 },
        ];
        let months = fold_months(&[promo], &draws);
        assert_eq!(months.len(), 2);
        assert_eq!((months[0].month.as_str(), months[0].used_micros, months[0].expired_micros, months[0].given_micros), ("2026-10", 5_000_000, 5_000_000, 0));
        assert_eq!((months[1].month.as_str(), months[1].used_micros, months[1].given_micros, months[1].grants), ("2026-09", 15_000_000, 25_000_000, 1));
    }
}
