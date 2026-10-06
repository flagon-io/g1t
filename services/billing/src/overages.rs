//! Accidental overages: protecting g1t without punishing customers.
//!
//! Spikes pause new compute before a runaway gets far (see `compute`).
//! When a month still goes well past a workspace's usual, or hits a spike,
//! it shows in sudo's Overages queue with its typical month, this month,
//! what it cost g1t, the margin, and the runs that caused it.
//!
//! **Goodwill credit.** One click, once per workspace in 12 months: a
//! credit for the overage above its typical month. It always includes g1t's
//! margin on that overage; of what the overage cost g1t, it covers at most
//! `OVERAGE_FORGIVE_COST_MICROS` ($50), so one forgiveness never costs g1t
//! more than that. More than that, or a second within 12 months, needs a
//! typed reason, and sudo shows what g1t absorbs in real cost. Every credit
//! is in `admin_actions` with who and why, and on the customer's statement
//! as "Credit from g1t: accidental usage on <date>".

use g1t_contracts::billing::{
    AdminGoodwillArgs, AdminOveragesArgs, AdminVelocityArgs, EntryKind, Goodwill, LedgerEntry, Overage, PlanKind, Velocity,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::features::dollars;
use crate::limits::previous_month;
use crate::{Billing, LedgerRow};

/// A month counts as an overage at twice the typical month, and at least
/// this much above it.
const OVERAGE_MIN_MICROS: i64 = 10_000_000;
/// How long one goodwill credit lasts before another is one click again.
const GOODWILL_DAYS: u64 = 365;
/// Reference prefix of goodwill credits. Starts `crd`, so like every
/// credit from g1t it never counts as a payment.
pub(crate) const GOODWILL_PREFIX: &str = "crd_goodwill_";

/// The median of the months given; 0 with none.
pub(crate) fn typical(months: &[i64]) -> i64 {
    let mut sorted: Vec<i64> = months.iter().map(|m| (*m).max(0)).collect();
    if sorted.is_empty() {
        return 0;
    }
    sorted.sort_unstable();
    let middle = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) { (sorted[middle - 1] + sorted[middle]) / 2 } else { sorted[middle] }
}

/// Whether this month is well past the typical one.
pub(crate) fn is_overage(this_month: i64, typical: i64) -> bool {
    this_month - typical >= OVERAGE_MIN_MICROS && this_month >= typical * 2
}

/// The one-click goodwill credit for a month: the overage above the
/// typical month, split into g1t's margin and what g1t paid for it. The
/// credit is the margin, always, plus the cost up to `cap`.
pub(crate) fn goodwill(this_month: i64, typical: i64, margin_percent: u32, cap: i64) -> Goodwill {
    let overage = (this_month - typical).max(0);
    // What g1t paid of it: the charge less the margin, rounded so the
    // margin is never overstated.
    let cost = (overage * 100 + i64::from(100 + margin_percent) - 1) / i64::from(100 + margin_percent);
    let cost = cost.min(overage);
    let margin = overage - cost;
    let absorbed = cost.min(cap.max(0));
    Goodwill { overage_micros: overage, margin_micros: margin, cost_micros: cost, credit_micros: margin + absorbed, absorbed_micros: absorbed }
}

/// What a credit of `amount` costs g1t in real money, given the overage's
/// margin: whatever of it is not margin.
pub(crate) fn absorbed_by(amount: i64, quote: &Goodwill) -> i64 {
    (amount - quote.margin_micros).max(0)
}

/// Whether a goodwill credit of `amount` needs a typed reason: past the
/// one-click credit, or a second within 12 months.
pub(crate) fn needs_reason(amount: i64, quote: &Goodwill, given_within_year: bool) -> bool {
    amount > quote.credit_micros || given_within_year
}

impl Billing {
    /// A workspace's charges this month, and its last three months'.
    async fn months_charged(&self, workspace: &str) -> Result<(i64, Vec<i64>)> {
        let now = rfc3339(now_ms());
        let this = now[..7].to_owned();
        let mut earlier = vec![];
        let mut month = previous_month(&this);
        for _ in 0..3 {
            earlier.push(month.clone());
            month = previous_month(&month);
        }
        #[derive(Deserialize)]
        struct Row {
            month: String,
            charged: Option<i64>,
        }
        let rows = self
            .db
            .prepare(
                "SELECT substr(created_at, 1, 7) AS month, -SUM(amount_micros) AS charged FROM ledger
                 WHERE workspace = ? AND kind = 'usage' AND created_at >= ? GROUP BY 1",
            )
            .bind(&[workspace.into(), format!("{}-01", earlier[2]).into()])?
            .all()
            .await?
            .results::<Row>()?;
        let get = |m: &str| rows.iter().find(|r| r.month == m).and_then(|r| r.charged).unwrap_or(0).max(0);
        // Months before the workspace's first are not "typical" zeros.
        let first = rows.iter().map(|r| r.month.clone()).min();
        let history: Vec<i64> = earlier
            .iter()
            .filter(|m| first.as_deref().is_some_and(|first| m.as_str() >= first))
            .map(|m| get(m))
            .collect();
        Ok((get(&this), history))
    }

    /// When the workspace last had a goodwill credit, if in the last year.
    async fn last_goodwill(&self, workspace: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            at: Option<String>,
        }
        let since = rfc3339(now_ms() - GOODWILL_DAYS * 24 * 60 * 60 * 1000);
        Ok(self
            .db
            .prepare("SELECT MAX(created_at) AS at FROM ledger WHERE workspace = ? AND reference LIKE ? AND created_at >= ?")
            .bind(&[workspace.into(), format!("{GOODWILL_PREFIX}%").into(), since.into()])?
            .first::<Row>(None)
            .await?
            .and_then(|r| r.at))
    }

    async fn overage_of(&self, workspace: &str, force: bool) -> Result<Option<Overage>> {
        let plan = self.plan_kind(workspace).await?;
        if plan == PlanKind::Internal {
            return Ok(None);
        }
        let (this_month, history) = self.months_charged(workspace).await?;
        let usual = typical(&history);
        let month_start = format!("{}-01", &rfc3339(now_ms())[..7]);
        let spike = self.latest_spike(workspace).await?.filter(|s| s.detected_at.as_str() >= month_start.as_str());
        let open_request = self.requests_of(workspace).await?.into_iter().find(|r| r.kind == "overage" && r.status == "open");
        if !force && !is_overage(this_month, usual) && spike.is_none() && open_request.is_none() {
            return Ok(None);
        }
        #[derive(Deserialize)]
        struct Cost {
            cost: Option<i64>,
        }
        let cost = self
            .db
            .prepare(
                "SELECT SUM(cost_micros) AS cost FROM ledger
                 WHERE workspace = ? AND kind = 'usage' AND COALESCE(billed_to, 'g1t') = 'g1t' AND created_at >= ?",
            )
            .bind(&[workspace.into(), month_start.as_str().into()])?
            .first::<Cost>(None)
            .await?
            .and_then(|c| c.cost)
            .unwrap_or(0);
        let top_entries = self
            .db
            .prepare(
                "SELECT * FROM ledger WHERE workspace = ? AND kind = 'usage' AND created_at >= ?
                 ORDER BY (-amount_micros + credit_micros + trial_micros + oss_micros + given_micros) DESC LIMIT 10",
            )
            .bind(&[workspace.into(), month_start.as_str().into()])?
            .all()
            .await?
            .results::<LedgerRow>()?
            .into_iter()
            .map(LedgerEntry::from)
            .collect();
        let last = self.last_goodwill(workspace).await?;
        Ok(Some(Overage {
            workspace: workspace.to_owned(),
            plan,
            typical_month_micros: usual,
            this_month_micros: this_month,
            cost_micros: cost,
            margin_micros: this_month - cost.min(this_month),
            spike,
            top_entries,
            goodwill: goodwill(this_month, usual, self.margin_percent, self.plans.forgive_cost_micros),
            goodwill_available: last.is_none(),
            last_goodwill_at: last,
            request: open_request,
        }))
    }

    /// `admin_overages`: the Overages queue, biggest overage first.
    pub(crate) async fn admin_overages(&self, _: AdminOveragesArgs) -> Result<Vec<Overage>> {
        #[derive(Deserialize)]
        struct Active {
            workspace: String,
        }
        let month_start = format!("{}-01", &rfc3339(now_ms())[..7]);
        let active = self
            .db
            .prepare(
                "SELECT DISTINCT workspace FROM ledger WHERE kind = 'usage' AND created_at >= ?1
                 UNION SELECT workspace FROM spikes WHERE detected_at >= ?1
                 UNION SELECT workspace FROM limit_requests WHERE kind = 'overage' AND status = 'open'
                 LIMIT 500",
            )
            .bind(&[month_start.into()])?
            .all()
            .await?
            .results::<Active>()?;
        let mut queue = vec![];
        for Active { workspace } in active {
            if let Some(overage) = self.overage_of(&workspace, false).await? {
                queue.push(overage);
            }
        }
        queue.sort_by_key(|a| std::cmp::Reverse(a.goodwill.overage_micros));
        Ok(queue)
    }

    /// `admin_goodwill`: a credit for accidental usage.
    pub(crate) async fn admin_goodwill(&self, a: AdminGoodwillArgs) -> Result<Outcome<LedgerEntry>> {
        let workspace = a.workspace.trim().to_lowercase();
        if workspace.is_empty() || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace, and who is giving the credit."));
        }
        let Some(overage) = self.overage_of(&workspace, true).await? else {
            return Ok(Outcome::fail(FailureCode::Conflict, "g1t's own workspaces are not charged, so there is nothing to credit."));
        };
        let quote = overage.goodwill;
        let amount = a.amount_micros.unwrap_or(quote.credit_micros);
        if amount <= 0 {
            return Ok(Outcome::fail(FailureCode::Invalid, "This month is not above the workspace's typical month, so the one-click credit is $0. Give an amount, with a reason."));
        }
        if amount > 10_000 * g1t_contracts::billing::MICROS_PER_DOLLAR {
            return Ok(Outcome::fail(FailureCode::Invalid, "A goodwill credit is at most $10,000."));
        }
        let reason = a.reason.trim();
        if needs_reason(amount, &quote, overage.last_goodwill_at.is_some()) && reason.chars().count() < 10 {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                if overage.last_goodwill_at.is_some() {
                    "This workspace had a goodwill credit in the last 12 months: say why another, in a sentence."
                } else {
                    "This is more than the one-click credit: say why, in a sentence."
                },
            ));
        }
        let day = a
            .day
            .as_deref()
            .filter(|d| d.len() == 10 && d.chars().all(|c| c.is_ascii_digit() || c == '-'))
            .map(str::to_owned)
            .or_else(|| overage.spike.as_ref().map(|s| s.detected_at[..10].to_owned()))
            .unwrap_or_else(|| rfc3339(now_ms())[..10].to_owned());
        let reference = format!("{GOODWILL_PREFIX}{}", new_id("gw", now_ms()));
        let description = format!("Credit from g1t: accidental usage on {day}");
        self.enter(&workspace, EntryKind::TopUp, amount, &description, &reference, None, None, Some(a.by.trim()), None)
            .await?;
        let absorbed = absorbed_by(amount, &quote);
        let account = self.account_of(&workspace).await?;
        self.audit(
            &account.id,
            "goodwill",
            &format!(
                "{} to {workspace} for accidental usage on {day} (typical month {}, this month {}); g1t absorbs {} of real cost{}",
                dollars(amount),
                dollars(overage.typical_month_micros),
                dollars(overage.this_month_micros),
                dollars(absorbed),
                if reason.is_empty() { String::new() } else { format!(": {reason}") }
            ),
            a.by.trim(),
        )
        .await?;
        // An open overage request is answered by the credit.
        if let Some(request) = &overage.request {
            self.db
                .prepare(
                    "UPDATE limit_requests SET status = 'approved', decided_by = ?1, decided_at = ?2, answer = ?3
                     WHERE id = ?4 AND status = 'open'",
                )
                .bind(&[
                    a.by.trim().into(),
                    rfc3339(now_ms()).into(),
                    format!("g1t credited {} for accidental usage on {day}. It is on this month's statement.", dollars(amount)).into(),
                    request.id.as_str().into(),
                ])?
                .run()
                .await?;
        }
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

    /// `admin_velocity`: workspaces spending in the last day, fastest first.
    pub(crate) async fn admin_velocity(&self, _: AdminVelocityArgs) -> Result<Vec<Velocity>> {
        #[derive(Deserialize)]
        struct Active {
            workspace: String,
            first_seen: Option<String>,
        }
        let day_ago = rfc3339(now_ms() - 24 * 60 * 60 * 1000);
        let active = self
            .db
            .prepare(
                "SELECT workspace, (SELECT MIN(created_at) FROM ledger l WHERE l.workspace = ledger.workspace) AS first_seen
                 FROM ledger WHERE kind = 'usage' AND created_at >= ? GROUP BY workspace LIMIT 200",
            )
            .bind(&[day_ago.into()])?
            .all()
            .await?
            .results::<Active>()?;
        let mut list = vec![];
        for Active { workspace, first_seen } in active {
            let pace = self.pace(&workspace).await?;
            let (this_month, _) = self.months_charged(&workspace).await?;
            let month_start = format!("{}-01", &rfc3339(now_ms())[..7]);
            list.push(Velocity {
                plan: self.plan_kind(&workspace).await?,
                last_hour_micros: pace.last_hour,
                average_hour_micros: pace.usual_hour,
                last_day_micros: pace.last_day,
                this_month_micros: this_month,
                ratio: if pace.usual_hour > 0 { pace.last_hour as f64 / pace.usual_hour as f64 } else { 0.0 },
                spike: self.latest_spike(&workspace).await?.filter(|s| s.detected_at.as_str() >= month_start.as_str()),
                first_seen,
                workspace,
            });
        }
        list.sort_by(|a, b| b.last_hour_micros.cmp(&a.last_hour_micros).then(b.last_day_micros.cmp(&a.last_day_micros)));
        Ok(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typical_month_is_the_median() {
        assert_eq!(typical(&[]), 0);
        assert_eq!(typical(&[30_000_000]), 30_000_000);
        assert_eq!(typical(&[30_000_000, 400_000_000, 20_000_000]), 30_000_000);
        assert_eq!(typical(&[20_000_000, 40_000_000]), 30_000_000);
    }

    #[test]
    fn an_overage_is_twice_the_usual_and_ten_dollars_over() {
        assert!(is_overage(70_000_000, 30_000_000));
        assert!(!is_overage(50_000_000, 30_000_000));
        // A new workspace with no history: $10 is enough to look at.
        assert!(is_overage(10_000_000, 0));
        assert!(!is_overage(9_000_000, 0));
    }

    #[test]
    fn goodwill_always_returns_the_margin_and_caps_the_cost() {
        // $120 over a $30 typical month: $90 over, of which $75 cost g1t and
        // $15 is margin. Under the $50 cap: the margin plus $50.
        let quote = goodwill(120_000_000, 30_000_000, 20, 50_000_000);
        assert_eq!(quote.overage_micros, 90_000_000);
        assert_eq!(quote.cost_micros, 75_000_000);
        assert_eq!(quote.margin_micros, 15_000_000);
        assert_eq!(quote.absorbed_micros, 50_000_000);
        assert_eq!(quote.credit_micros, 65_000_000);
        // A small overage is credited in full: margin and cost.
        let small = goodwill(42_000_000, 30_000_000, 20, 50_000_000);
        assert_eq!(small.overage_micros, 12_000_000);
        assert_eq!(small.credit_micros, 12_000_000);
        assert_eq!(small.absorbed_micros, 10_000_000);
        // A huge one never costs g1t more than the cap.
        let huge = goodwill(10_030_000_000, 30_000_000, 20, 50_000_000);
        assert_eq!(huge.absorbed_micros, 50_000_000);
        assert_eq!(huge.credit_micros, huge.margin_micros + 50_000_000);
        assert!(huge.credit_micros < huge.overage_micros);
        // Nothing over the typical month: nothing to credit.
        assert_eq!(goodwill(20_000_000, 30_000_000, 20, 50_000_000), Goodwill::default());
        // The split never loses a millionth.
        let odd = goodwill(1_000_001, 0, 20, 50_000_000);
        assert_eq!(odd.cost_micros + odd.margin_micros, odd.overage_micros);
    }

    #[test]
    fn more_than_one_click_needs_a_reason_and_says_what_g1t_absorbs() {
        let quote = goodwill(120_000_000, 30_000_000, 20, 50_000_000);
        assert!(!needs_reason(quote.credit_micros, &quote, false));
        assert!(needs_reason(quote.credit_micros + 1, &quote, false));
        // A second within 12 months, even the same amount.
        assert!(needs_reason(quote.credit_micros, &quote, true));
        // Crediting the whole $90 overage: g1t absorbs the whole $75 cost.
        assert_eq!(absorbed_by(90_000_000, &quote), 75_000_000);
        assert_eq!(absorbed_by(quote.credit_micros, &quote), 50_000_000);
        assert_eq!(absorbed_by(10_000_000, &quote), 0);
    }
}
