//! What a workspace is charged in a month: one definition, used by the
//! spend limit (`limits::limit_with`, the `spent_micros` every signed-in
//! page shows), the Usage page and the Billing page's plan card
//! (`report::usage_report`), and so by Spend's "Charged" tile and the top
//! bar, which read the limit.
//!
//! **Charged** is usage at price, less the account's discount, less what
//! the plan's included usage, the trial, the open-source pool or g1t paid,
//! less what credit paid; never below zero. Every ledger line carries each
//! part (`statement::PRICE_SQL` reads the price back from them), and usage
//! metered through the month and charged when it closes (`pending_usage`:
//! storage, git operations, scans, embeddings, domains, app traffic) counts
//! now on the same terms it will be entered on: at cost plus the margin,
//! with the discount off, and nothing for a source g1t covers on a free
//! workspace. So a workspace with a 100% discount is charged exactly
//! nothing, however much is pending.

use g1t_contracts::billing::UsageTotals;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Billing;
use crate::credits::with_margin;

/// What is left to pay: usage at price less the discount, included usage
/// and credit. The one arithmetic for "charged".
pub(crate) fn charged(totals: &UsageTotals) -> i64 {
    (totals.price_micros - totals.discount_micros - totals.included_micros - totals.credits_micros).max(0)
}

/// A month-end source's usage so far this month, metered and not charged
/// yet (`pending_usage`).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct PendingLine {
    /// Whose it is: the plan's included usage is each workspace's own.
    #[serde(default)]
    pub workspace: String,
    pub source: String,
    /// What it cost g1t so far.
    #[serde(default)]
    pub cost_micros: Option<f64>,
    /// What it will be charged before the account's terms: at cost plus
    /// the margin, or nothing for a source g1t covers on a free workspace
    /// (`storage::set_pending`).
    #[serde(default)]
    pub charge_micros: Option<f64>,
}

impl PendingLine {
    pub fn cost(&self) -> i64 {
        self.cost_micros.unwrap_or(0.0).round().max(0.0) as i64
    }

    pub fn charge(&self) -> i64 {
        self.charge_micros.unwrap_or(0.0).round().max(0.0) as i64
    }
}

/// A pending line's parts, as the month's close will enter them: its
/// price, what g1t covers of it, and what the discount takes off the rest.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PendingSplit {
    pub price: i64,
    pub covered: i64,
    pub discount: i64,
}

impl PendingSplit {
    /// What the workspace will be charged for it when the month closes.
    pub fn charged(&self) -> i64 {
        self.price - self.covered - self.discount
    }
}

/// Splits a pending line: `cost` at cost plus `margin_percent` is its
/// price; `charge` (what it will be charged before terms) below that is
/// covered by g1t; `percent_off` comes off what is charged.
pub(crate) fn pending_split(cost: i64, charge: i64, margin_percent: u32, percent_off: u32) -> PendingSplit {
    let price = with_margin(cost.max(0), margin_percent);
    let base = charge.clamp(0, price);
    PendingSplit { price, covered: price - base, discount: base * i64::from(percent_off.min(100)) / 100 }
}

/// Pays pending lines from the plan's included usage still `left` this
/// month, in order, as the close will (`draw` pays from it first): what it
/// pays is included, not charged. Returns what it paid of each.
pub(crate) fn cover_with_included(splits: &mut [PendingSplit], left: i64) -> Vec<i64> {
    let mut left = left.max(0);
    splits
        .iter_mut()
        .map(|split| {
            let pay = split.charged().clamp(0, left);
            split.covered += pay;
            left -= pay;
            pay
        })
        .collect()
}

/// Counts a pending line into the totals: at price (and as pending), with
/// what g1t covers as included, the discount as discount, and what is
/// left as what the close will charge.
pub(crate) fn add_pending(totals: &mut UsageTotals, split: &PendingSplit) {
    totals.price_micros += split.price;
    totals.pending_micros += split.price;
    totals.pending_charged_micros += split.charged();
    totals.included_micros += split.covered;
    totals.discount_micros += split.discount;
}

/// The month's totals from its ledger lines and pending usage, and what
/// credit paid, with `charged_micros` worked out.
pub(crate) fn month_totals(price: i64, discount: i64, covered: i64, credits: i64, pending: &[PendingSplit]) -> UsageTotals {
    let mut totals = UsageTotals {
        price_micros: price,
        discount_micros: discount,
        included_micros: covered,
        credits_micros: credits.max(0),
        ..UsageTotals::default()
    };
    for split in pending {
        add_pending(&mut totals, split);
    }
    totals.charged_micros = charged(&totals);
    totals
}

/// The pending lines of the workspaces bound at `marks` (then the month),
/// net of what was metered before a test-mode detach.
pub(crate) fn pending_sql(marks: &str) -> String {
    format!(
        "SELECT workspace, source, {} AS cost_micros, {} AS charge_micros FROM pending_usage
         WHERE workspace IN ({marks}) AND month = ? AND charged_at IS NULL",
        crate::storage::NET_COST,
        crate::storage::NET_CHARGE
    )
}

impl Billing {
    /// What the workspaces have metered this month (`YYYY-MM`) that is
    /// charged when it closes, not charged yet: less what was metered
    /// before a test-mode detach (`pending_baselines`), which is never
    /// charged, so the limit and the Usage page do not count it either.
    pub(crate) async fn pending_this_month(&self, members: &[JsValue], month: &str) -> Result<Vec<PendingLine>> {
        let marks = vec!["?"; members.len().max(1)].join(", ");
        let mut args = members.to_vec();
        args.push(month.into());
        self.db.prepare(pending_sql(&marks)).bind(&args)?.all().await?.results::<PendingLine>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_usage_is_valued_less_what_was_metered_before_a_detach() {
        let sql = pending_sql("?");
        for column in ["cost_micros", "charge_micros"] {
            assert!(
                sql.contains(&format!("MAX(0, COALESCE(pending_usage.{column}, 0) - COALESCE((SELECT b.{column} FROM pending_baselines b")),
                "{column}: {sql}"
            );
        }
        // Matched on the row's own workspace, source and month, so the
        // FROM must stay unaliased.
        assert!(sql.contains("FROM pending_usage\n"));
        assert!(
            crate::storage::NET_COST.contains("b.month = pending_usage.month")
                && crate::storage::NET_COST.contains("b.source = pending_usage.source")
        );
    }

    const MARGIN: u32 = 20;

    #[test]
    fn a_full_discount_is_charged_exactly_nothing_pending_usage_included() {
        // flagon-io, October 2026: $10.29 of usage at price on the ledger,
        // every line discounted in full; and $0.0075 of storage metered so
        // far, which the limit used to count at its charge, $0.009.
        let pending = [pending_split(7_500, with_margin(7_500, MARGIN), MARGIN, 100)];
        assert_eq!(pending[0], PendingSplit { price: 9_000, covered: 0, discount: 9_000 });
        let totals = month_totals(10_290_000, 10_290_000, 0, 0, &pending);
        assert_eq!((totals.pending_micros, totals.pending_charged_micros), (9_000, 0));
        assert_eq!(totals.price_micros, 10_299_000);
        assert_eq!(totals.discount_micros, 10_299_000);
        assert_eq!(totals.charged_micros, 0);
        assert_eq!(charged(&totals), 0);
    }

    #[test]
    fn included_usage_pays_first_and_only_the_rest_is_charged() {
        // The plan: $10 included. $12.50 of runs at price, $10 of it drawn
        // from the included usage on the lines themselves; $0.60 of storage
        // pending, which the close will charge in full (the included usage
        // is spent).
        let pending = [pending_split(500_000, with_margin(500_000, MARGIN), MARGIN, 0)];
        assert_eq!(pending[0], PendingSplit { price: 600_000, covered: 0, discount: 0 });
        let totals = month_totals(12_500_000, 0, 10_000_000, 0, &pending);
        assert_eq!(totals.included_micros, 10_000_000);
        assert_eq!(totals.charged_micros, 2_500_000 + 600_000);
        // Credit from g1t pays after that.
        let with_credit = month_totals(12_500_000, 0, 10_000_000, 1_000_000, &pending);
        assert_eq!(with_credit.charged_micros, 2_100_000);
        // Never below zero: more credit than usage charges nothing.
        assert_eq!(month_totals(1_000_000, 0, 0, 5_000_000, &[]).charged_micros, 0);
        // Spent: nothing left to pay pending usage, which stays charged.
        let mut spent = pending.to_vec();
        assert_eq!(cover_with_included(&mut spent, 0), vec![0]);
        assert_eq!(spent, pending.to_vec());
    }

    #[test]
    fn pending_usage_is_paid_from_the_included_usage_still_left() {
        // The plan, $10 included, $9.80 of it drawn on the ledger: $0.20
        // left. $0.60 of storage pending is paid $0.20 by it at the close,
        // so only $0.40 counts against the spend limit now, not $0.60.
        let mut pending = vec![pending_split(500_000, with_margin(500_000, MARGIN), MARGIN, 0)];
        assert_eq!(cover_with_included(&mut pending, 200_000), vec![200_000]);
        assert_eq!(pending[0], PendingSplit { price: 600_000, covered: 200_000, discount: 0 });
        let totals = month_totals(9_800_000, 0, 9_800_000, 0, &pending);
        assert_eq!(totals.charged_micros, 400_000);
        assert_eq!(totals.included_micros, 10_000_000);
        // Untouched included usage pays it all, in order, never past a line.
        let mut two = vec![pending_split(500_000, 600_000, MARGIN, 0), pending_split(250, 300, MARGIN, 0)];
        assert_eq!(cover_with_included(&mut two, 10_000_000), vec![600_000, 300]);
        assert_eq!(month_totals(0, 0, 0, 0, &two).charged_micros, 0);
        // It pays after the discount, as the close draws: 50% off $0.60
        // leaves $0.30 for it to pay.
        let mut half = vec![pending_split(500_000, 600_000, MARGIN, 50)];
        assert_eq!(cover_with_included(&mut half, 10_000_000), vec![300_000]);
        assert_eq!(half[0].charged(), 0);
        // Nothing negative is ever paid or left.
        assert_eq!(cover_with_included(&mut [pending_split(0, 0, MARGIN, 0)], -5), vec![0]);
    }

    #[test]
    fn pay_as_you_go_is_charged_at_price() {
        // No discount, nothing included, no credit: price is what is
        // charged, pending usage counted at its price too.
        let pending = [pending_split(1_000_000, with_margin(1_000_000, MARGIN), MARGIN, 0), pending_split(250, 300, MARGIN, 0)];
        let totals = month_totals(4_000_000, 0, 0, 0, &pending);
        assert_eq!(totals.pending_micros, 1_200_000 + 300);
        assert_eq!(totals.charged_micros, 4_000_000 + 1_200_000 + 300);
    }

    #[test]
    fn a_partial_discount_comes_off_pending_usage_as_the_close_will_take_it() {
        // 30% off: $0.009 of pending storage is charged $0.0063.
        let split = pending_split(7_500, 9_000, MARGIN, 30);
        assert_eq!(split, PendingSplit { price: 9_000, covered: 0, discount: 2_700 });
        assert_eq!(split.charged(), 6_300);
    }

    #[test]
    fn what_g1t_covers_on_a_free_workspace_is_included_not_charged() {
        // Security scans on a free workspace: metered at cost, charged
        // nothing (`set_pending` writes a charge of 0), shown at price.
        let split = pending_split(2_000, 0, MARGIN, 0);
        assert_eq!(split, PendingSplit { price: 2_400, covered: 2_400, discount: 0 });
        assert_eq!(split.charged(), 0);
        let totals = month_totals(0, 0, 0, 0, &[split]);
        assert_eq!(totals.price_micros, 2_400);
        assert_eq!(totals.included_micros, 2_400);
        assert_eq!(totals.charged_micros, 0);
        // A charge above the price (an older margin) is held to the price.
        assert_eq!(pending_split(1_000, 5_000, MARGIN, 0).covered, 0);
    }

    #[test]
    fn a_pending_row_reads_whole_micros_and_never_less_than_nothing() {
        let line =
            PendingLine { source: "storage".into(), cost_micros: Some(7_499.6), charge_micros: Some(-1.0), ..PendingLine::default() };
        assert_eq!(line.cost(), 7_500);
        assert_eq!(line.charge(), 0);
        assert_eq!(PendingLine::default().cost(), 0);
    }
}
