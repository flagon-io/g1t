//! A workspace's statement: a month of its ledger, grouped so it can be
//! read at a glance (by day or by project, a line per kind of charge),
//! with each line's entries a page at a time.

use g1t_contracts::billing::{
    Covered, LedgerEntry, Statement, StatementArgs, StatementEntriesArgs, StatementGroup, StatementLine, StatementTotals,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::Outcome;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Billing, LedgerRow, members_only};

/// Entries in one page of a line.
const PAGE: u32 = 50;

/// The kind of charge a ledger row is, as the statement names it. One SQL
/// expression, so grouping and filtering agree.
/// `Runs on your own model provider` is only on older months: those runs
/// carried a flat fee then, and pay only their sandbox time now.
pub(crate) const KIND_SQL: &str = "CASE
    WHEN kind = 'top_up' AND reference LIKE 'crd%' THEN 'Credits from g1t'
    WHEN kind = 'top_up' AND amount_micros < 0 THEN 'Refunds'
    WHEN kind = 'top_up' THEN 'Payments'
    WHEN task = 'sandbox' THEN 'Sandbox time'
    WHEN task = 'deployments' THEN 'Deployments'
    WHEN task = 'security' THEN 'Security scans'
    WHEN task = 'context' THEN 'Search embeddings'
    WHEN task = 'storage' THEN 'Private storage'
    WHEN billed_to = 'workspace' THEN 'Runs on your own model provider'
    ELSE 'Agent runs' END";

/// The order lines appear in within a group.
pub(crate) fn kind_order(kind: &str) -> u8 {
    match kind {
        "Agent runs" => 0,
        "Runs on your own model provider" => 1,
        "Sandbox time" => 2,
        "Deployments" => 3,
        "Private storage" => 4,
        "Search embeddings" => 5,
        "Security scans" => 6,
        "Payments" => 7,
        "Credits from g1t" => 8,
        "Refunds" => 9,
        _ => 10,
    }
}

/// What paid for usage before it was charged, as the statement names it,
/// with the ledger column that holds it.
pub(crate) const COVERED: [(&str, &str, &str); 3] = [
    ("team_credit", "credit_micros", "Paid by your Team plan's credit"),
    ("trial", "trial_micros", "Paid by your trial credit"),
    ("oss_pool", "oss_micros", "Paid by g1t's open-source pool"),
];

/// The statement's lines for what paid: each source with anything to show.
pub(crate) fn covered_lines(sums: [i64; 3]) -> Vec<Covered> {
    COVERED
        .iter()
        .zip(sums)
        .filter(|(_, micros)| *micros > 0)
        .map(|((source, _, label), micros)| Covered { source: (*source).to_owned(), label: (*label).to_owned(), micros })
        .collect()
}

/// `2026-10` and the first instant of the next month, for a range.
pub(crate) fn month_range(month: &str) -> Option<(String, String)> {
    let year: i32 = month.get(..4)?.parse().ok()?;
    let number: u32 = month.get(5..7)?.parse().ok()?;
    if month.len() != 7 || !(1..=12).contains(&number) {
        return None;
    }
    let next = if number == 12 { format!("{}-01", year + 1) } else { format!("{year}-{:02}", number + 1) };
    Some((format!("{month}-01"), format!("{next}-01")))
}

#[derive(Deserialize)]
struct Row {
    group_key: Option<String>,
    kind: String,
    count: u32,
    amount: Option<i64>,
    cost: Option<i64>,
    credit: Option<i64>,
    trial: Option<i64>,
    oss: Option<i64>,
}

#[derive(Deserialize)]
struct Month {
    month: String,
}

impl Billing {
    pub(crate) async fn statement(&self, a: StatementArgs) -> Result<Outcome<Statement>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let current = rfc3339(now_ms())[..7].to_owned();
        let month = a.month.filter(|m| month_range(m).is_some()).unwrap_or(current);
        let (from, until) = month_range(&month).expect("a valid month");
        let by_project = a.group.as_deref() == Some("project");
        let group_sql = if by_project { "COALESCE(repo, '')" } else { "substr(created_at, 1, 10)" };
        let rows = self
            .db
            .prepare(format!(
                "SELECT {group_sql} AS group_key, {KIND_SQL} AS kind, COUNT(*) AS count,
                        SUM(amount_micros) AS amount, SUM(cost_micros) AS cost,
                        SUM(credit_micros) AS credit, SUM(trial_micros) AS trial, SUM(oss_micros) AS oss
                 FROM ledger WHERE workspace = ?1 AND created_at >= ?2 AND created_at < ?3
                 GROUP BY 1, 2"
            ))
            .bind(&[workspace.as_str().into(), from.as_str().into(), until.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;

        let mut groups: Vec<StatementGroup> = vec![];
        let mut covered = [0i64; 3];
        for row in rows {
            let key = row.group_key.unwrap_or_default();
            let amount = row.amount.unwrap_or(0);
            let paid_for = [row.credit.unwrap_or(0), row.trial.unwrap_or(0), row.oss.unwrap_or(0)];
            for (total, micros) in covered.iter_mut().zip(paid_for) {
                *total += micros;
            }
            let line = StatementLine {
                kind: row.kind.clone(),
                count: row.count,
                // Charges positive, money in negative, as a statement reads.
                charged_micros: -amount,
                cost_micros: row.cost.unwrap_or(0),
                covered_micros: paid_for.iter().sum(),
            };
            match groups.iter_mut().find(|g| g.key == key) {
                Some(group) => group.lines.push(line),
                None => groups.push(StatementGroup {
                    label: if key.is_empty() { "Not one project".to_owned() } else { key.clone() },
                    key,
                    lines: vec![line],
                    charged_micros: 0,
                }),
            }
        }
        for group in &mut groups {
            group.lines.sort_by_key(|line| kind_order(&line.kind));
            group.charged_micros = group.lines.iter().filter(|l| l.charged_micros > 0).map(|l| l.charged_micros).sum();
        }
        if by_project {
            groups.sort_by(|a, b| b.charged_micros.cmp(&a.charged_micros));
        } else {
            groups.sort_by(|a, b| b.key.cmp(&a.key));
        }
        let lines = groups.iter().flat_map(|g| g.lines.iter());
        let totals = StatementTotals {
            charged_micros: lines.clone().filter(|l| l.charged_micros > 0).map(|l| l.charged_micros).sum(),
            paid_micros: lines.clone().filter(|l| l.charged_micros < 0).map(|l| -l.charged_micros).sum(),
            cost_micros: lines.clone().map(|l| l.cost_micros).sum(),
            entries: lines.map(|l| l.count).sum(),
            covered: covered_lines(covered),
            carried_micros: self.carried(&workspace, &month).await?,
        };
        let months = self
            .db
            .prepare("SELECT DISTINCT substr(created_at, 1, 7) AS month FROM ledger WHERE workspace = ? ORDER BY 1 DESC LIMIT 36")
            .bind(&[workspace.as_str().into()])?
            .all()
            .await?
            .results::<Month>()?
            .into_iter()
            .map(|m| m.month)
            .collect();
        Ok(Outcome::Ok(Statement { month, months, groups, totals }))
    }

    /// What was owed when `month` closed but was under the minimum charge,
    /// and so carried over to the next invoice.
    async fn carried(&self, workspace: &str, month: &str) -> Result<i64> {
        #[derive(Deserialize)]
        struct Row {
            amount_micros: i64,
        }
        Ok(self
            .db
            .prepare("SELECT amount_micros FROM month_closes WHERE workspace = ? AND month = ? AND status = 'carried'")
            .bind(&[workspace.into(), month.into()])?
            .first::<Row>(None)
            .await?
            .map_or(0, |row| row.amount_micros))
    }

    /// One line's entries, newest first, a page at a time.
    pub(crate) async fn statement_entries(&self, a: StatementEntriesArgs) -> Result<Outcome<Vec<LedgerEntry>>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let Some((from, until)) = month_range(&a.month) else {
            return Ok(Outcome::Ok(vec![]));
        };
        let mut filters = vec![format!("({KIND_SQL}) = ?4")];
        let mut values: Vec<JsValue> = vec![
            workspace.as_str().into(),
            from.as_str().into(),
            until.as_str().into(),
            a.kind.as_str().into(),
        ];
        if let Some(day) = a.day.as_deref().filter(|d| d.len() == 10) {
            values.push(day.into());
            filters.push(format!("substr(created_at, 1, 10) = ?{}", values.len()));
        }
        if let Some(project) = &a.project {
            values.push(project.as_str().into());
            filters.push(format!("COALESCE(repo, '') = ?{}", values.len()));
        }
        if let Some(before) = &a.before {
            values.push(before.as_str().into());
            filters.push(format!("id < ?{}", values.len()));
        }
        let rows = self
            .db
            .prepare(format!(
                "SELECT * FROM ledger WHERE workspace = ?1 AND created_at >= ?2 AND created_at < ?3 AND {}
                 ORDER BY id DESC LIMIT {PAGE}",
                filters.join(" AND ")
            ))
            .bind(&values)?
            .all()
            .await?
            .results::<LedgerRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(LedgerEntry::from).collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_month_runs_to_the_first_of_the_next() {
        assert_eq!(month_range("2026-10"), Some(("2026-10-01".into(), "2026-11-01".into())));
        assert_eq!(month_range("2026-12"), Some(("2026-12-01".into(), "2027-01-01".into())));
        assert_eq!(month_range("2026-13"), None);
        assert_eq!(month_range("oops"), None);
    }

    #[test]
    fn usage_lines_come_before_money_in() {
        assert!(kind_order("Agent runs") < kind_order("Sandbox time"));
        assert!(kind_order("Deployments") < kind_order("Payments"));
        assert!(kind_order("Security scans") < kind_order("Payments"));
    }

    #[test]
    fn the_statement_says_what_paid_before_the_workspace_did() {
        let lines = covered_lines([0, 250_000, 120_000]);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].label, "Paid by your trial credit");
        assert_eq!(lines[1], Covered { source: "oss_pool".into(), label: "Paid by g1t's open-source pool".into(), micros: 120_000 });
        assert!(covered_lines([0, 0, 0]).is_empty());
    }
}
