//! A workspace's statement: a month of its ledger, grouped so it can be
//! read at a glance (by day or by project, a line per kind of charge),
//! with each line's entries a page at a time.

use g1t_contracts::billing::{
    Covered, LedgerEntry, MeterUsage, Statement, StatementArgs, StatementEntriesArgs, StatementGroup, StatementLine, StatementTotals,
    UsageMetersArgs,
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
    WHEN kind = 'top_up' AND credit_kind = 'purchased' THEN 'AI credit'
    WHEN kind = 'top_up' AND reference LIKE 'crd%' THEN 'Credits from g1t'
    WHEN kind = 'top_up' AND amount_micros < 0 THEN 'Refunds'
    WHEN kind = 'top_up' THEN 'Payments'
    WHEN task = 'sandbox' THEN 'Sandbox time'
    WHEN task = 'self_hosted' THEN 'Self-hosted runner time'
    WHEN task = 'deployments' THEN 'Deployments'
    WHEN task = 'security' THEN 'Security scans'
    WHEN task = 'context' THEN 'Search embeddings'
    WHEN task = 'storage' THEN 'Private storage'
    WHEN task = 'cache' THEN 'Actions cache storage'
    WHEN task = 'git' THEN 'Git operations'
    WHEN billed_to = 'workspace' THEN 'Runs on your own model provider'
    WHEN reference LIKE '%/agent%' THEN 'Agent rate'
    WHEN task = 'gateway' THEN 'AI Gateway'
    WHEN task = 'domains' THEN 'Custom domains'
    WHEN task = 'package_storage' THEN 'Package storage'
    ELSE 'Agent runs' END";

/// A usage line at its price, in SQL: what was charged, what paid for it
/// first (the plan's included usage, the trial, a pool, g1t), and what a
/// discount took off. `line_price`, for a whole column. The one measure of
/// usage every page shows.
pub(crate) const PRICE_SQL: &str = "(-amount_micros + COALESCE(credit_micros, 0) + COALESCE(trial_micros, 0) + COALESCE(oss_micros, 0)
      + COALESCE(given_micros, 0) + COALESCE(discount_micros, 0))";

/// Whether a usage line is an agent run's own line (`run_…`), not its
/// agent rate, a correction or anything else: what counts as one run.
pub(crate) const RUN_SQL: &str = "(reference LIKE 'run%' AND instr(reference, '/') = 0)";

/// The order lines appear in within a group.
pub(crate) fn kind_order(kind: &str) -> u8 {
    match kind {
        "Agent runs" => 0,
        "Agent rate" => 0,
        "AI Gateway" => 1,
        "Runs on your own model provider" => 1,
        "Sandbox time" => 2,
        "Self-hosted runner time" => 2,
        "Deployments" => 3,
        "Private storage" => 4,
        "Actions cache storage" => 4,
        "Git operations" => 5,
        "Search embeddings" => 6,
        "Security scans" => 7,
        "Custom domains" => 3,
        "Package storage" => 4,
        "Payments" => 8,
        "AI credit" => 8,
        "Credits from g1t" => 9,
        "Refunds" => 10,
        "Tax" => 8,
        "Card processing fees" => 8,
        _ => 11,
    }
}

/// Payments, credits and refunds: money in, which has no price.
pub(crate) fn is_money_in(kind: &str) -> bool {
    matches!(kind, "Payments" | "AI credit" | "Credits from g1t" | "Refunds" | "Tax" | "Card processing fees")
}

/// A usage line at its price: what was charged, what paid for it first,
/// and what the account's discount took off.
pub(crate) fn line_price(charged: i64, covered: i64, discount: i64) -> i64 {
    charged + covered + discount
}

/// The Billing page's meters, in order: key and label.
pub(crate) const METERS: [(&str, &str); 6] = [
    ("agents", "Agents & sandboxes"),
    ("builds", "Builds"),
    ("requests", "Requests & CPU"),
    ("domains", "Custom domains"),
    ("git_storage", "Git operations & storage"),
    ("search_scans", "Search & security scans"),
];

/// The meter a ledger row's usage is on. One SQL expression, as `KIND_SQL`.
pub(crate) const METER_SQL: &str = "CASE
    WHEN task = 'deployments' AND reference LIKE 'deploy/%' THEN 'builds'
    WHEN task = 'deployments' THEN 'requests'
    WHEN task IN ('storage', 'git', 'cache') THEN 'git_storage'
    WHEN task IN ('security', 'context') THEN 'search_scans'
    ELSE 'agents' END";

/// The meter usage noted through the month (`pending_usage.source`) is on.
pub(crate) fn meter_of_source(source: &str) -> &'static str {
    match source {
        "deployments" => "requests",
        "domains" => "domains",
        "storage" | "git" | "cache" => "git_storage",
        _ => "search_scans",
    }
}

/// `41 build minutes`, from seconds, rounded up.
pub(crate) fn build_minutes(seconds: i64) -> Option<String> {
    let minutes = (seconds.max(0) + 59) / 60;
    (seconds > 0).then(|| format!("{} build minute{}", crate::features::thousands(minutes as u64), if minutes == 1 { "" } else { "s" }))
}

/// `12 runs`.
pub(crate) fn runs(count: u32) -> Option<String> {
    (count > 0).then(|| format!("{} run{}", crate::features::thousands(count.into()), if count == 1 { "" } else { "s" }))
}

/// `12,345 git operations, 0.42 GB private`.
pub(crate) fn git_and_storage(operations: u64, private_bytes: i64) -> Option<String> {
    let mut parts = vec![];
    if operations > 0 {
        parts.push(format!("{} git operation{}", crate::features::thousands(operations), if operations == 1 { "" } else { "s" }));
    }
    if private_bytes > 0 {
        parts.push(format!("{:.2} GB private", private_bytes as f64 / 1e9));
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// What paid for usage before it was charged, as the statement names it,
/// with the ledger column that holds it.
pub(crate) const COVERED: [(&str, &str, &str); 4] = [
    ("included", "credit_micros", "Paid by your plan's included usage"),
    ("trial", "trial_micros", "Paid by your trial credit"),
    ("oss_pool", "oss_micros", "Paid by g1t's open-source pool"),
    ("given", "given_micros", "Covered by g1t"),
];

/// The statement's lines for what paid: each source with anything to show.
pub(crate) fn covered_lines(sums: [i64; 4]) -> Vec<Covered> {
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
    given: Option<i64>,
    discount: Option<i64>,
}

#[derive(Deserialize)]
struct Month {
    month: String,
}

#[derive(Deserialize)]
struct ExtraRow {
    group_key: Option<String>,
    kind: String,
    count: u32,
    amount: Option<i64>,
}

/// How the statement names a `tax_and_fees` kind.
pub(crate) fn extra_kind(kind: &str) -> &'static str {
    if kind == "tax" { "Tax" } else { "Card processing fees" }
}

/// Puts a line in its group, starting the group if it is new.
fn add_line(groups: &mut Vec<StatementGroup>, key: String, line: StatementLine) {
    match groups.iter_mut().find(|g| g.key == key) {
        Some(group) => group.lines.push(line),
        None => groups.push(StatementGroup {
            label: if key.is_empty() { "Not one project".to_owned() } else { key.clone() },
            key,
            lines: vec![line],
            charged_micros: 0,
            price_micros: 0,
            discount_micros: 0,
        }),
    }
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
                        SUM(credit_micros) AS credit, SUM(trial_micros) AS trial, SUM(oss_micros) AS oss,
                        SUM(given_micros) AS given, SUM(discount_micros) AS discount
                 FROM ledger WHERE workspace = ?1 AND created_at >= ?2 AND created_at < ?3
                 GROUP BY 1, 2"
            ))
            .bind(&[workspace.as_str().into(), from.as_str().into(), until.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;

        let mut groups: Vec<StatementGroup> = vec![];
        let mut covered = [0i64; 4];
        for row in rows {
            let key = row.group_key.unwrap_or_default();
            let amount = row.amount.unwrap_or(0);
            let paid_for = [row.credit.unwrap_or(0), row.trial.unwrap_or(0), row.oss.unwrap_or(0), row.given.unwrap_or(0)];
            for (total, micros) in covered.iter_mut().zip(paid_for) {
                *total += micros;
            }
            let discount = row.discount.unwrap_or(0);
            let line = StatementLine {
                // Charges positive, money in negative, as a statement reads.
                charged_micros: -amount,
                cost_micros: row.cost.unwrap_or(0),
                covered_micros: paid_for.iter().sum(),
                price_micros: if is_money_in(&row.kind) { 0 } else { line_price(-amount, paid_for.iter().sum(), discount) },
                discount_micros: discount,
                kind: row.kind,
                count: row.count,
                passed_micros: 0,
            };
            add_line(&mut groups, key, line);
        }
        // Tax and card fees paid with the month's payments: their own
        // lines, beside the payment, never in what was charged or paid.
        let extras = self
            .db
            .prepare(format!(
                "SELECT {} AS group_key, kind, COUNT(*) AS count, SUM(amount_micros) AS amount
                 FROM tax_and_fees WHERE workspace = ?1 AND created_at >= ?2 AND created_at < ?3 GROUP BY 1, 2",
                if by_project { "''" } else { "substr(created_at, 1, 10)" }
            ))
            .bind(&[workspace.as_str().into(), from.as_str().into(), until.as_str().into()])?
            .all()
            .await?
            .results::<ExtraRow>()?;
        let (mut tax_micros, mut card_fee_micros) = (0, 0);
        for extra in extras {
            let amount = extra.amount.unwrap_or(0);
            if extra.kind == "tax" {
                tax_micros += amount;
            } else {
                card_fee_micros += amount;
            }
            let line = StatementLine {
                kind: extra_kind(&extra.kind).to_owned(),
                count: extra.count,
                charged_micros: 0,
                cost_micros: 0,
                covered_micros: 0,
                price_micros: 0,
                discount_micros: 0,
                passed_micros: amount,
            };
            add_line(&mut groups, extra.group_key.unwrap_or_default(), line);
        }
        for group in &mut groups {
            group.lines.sort_by_key(|line| kind_order(&line.kind));
            group.charged_micros = group.lines.iter().filter(|l| l.charged_micros > 0).map(|l| l.charged_micros).sum();
            group.price_micros = group.lines.iter().map(|l| l.price_micros).sum();
            group.discount_micros = group.lines.iter().map(|l| l.discount_micros).sum();
        }
        if by_project {
            groups.sort_by_key(|a| std::cmp::Reverse(a.charged_micros));
        } else {
            groups.sort_by(|a, b| b.key.cmp(&a.key));
        }
        let lines = groups.iter().flat_map(|g| g.lines.iter());
        let totals = StatementTotals {
            charged_micros: lines.clone().filter(|l| l.charged_micros > 0).map(|l| l.charged_micros).sum(),
            paid_micros: lines.clone().filter(|l| l.charged_micros < 0).map(|l| -l.charged_micros).sum(),
            cost_micros: lines.clone().map(|l| l.cost_micros).sum(),
            price_micros: lines.clone().map(|l| l.price_micros).sum(),
            discount_micros: lines.clone().map(|l| l.discount_micros).sum(),
            discount_percent: Some(self.terms_of(&workspace).await?.percent_off()).filter(|p| *p > 0),
            entries: lines.map(|l| l.count).sum(),
            covered: covered_lines(covered),
            carried_micros: self.carried(&workspace, &month).await?,
            tax_micros,
            card_fee_micros,
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

    /// `usage_meters`: this month's usage by meter, at cost plus the margin
    /// (with a custom discount, if the account has one) before the plan's
    /// included usage or a pool paid for any of it. Comped workspaces see
    /// what it would cost. Usage charged through the month is on the
    /// ledger; usage charged when the month closes (app traffic, custom
    /// domains, storage, git operations, search and scans) is what has been
    /// noted so far.
    pub(crate) async fn usage_meters(&self, a: UsageMetersArgs) -> Result<Outcome<Vec<MeterUsage>>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let now = rfc3339(now_ms());
        let month = now[..7].to_owned();
        let (from, until) = month_range(&month).expect("a valid month");
        #[derive(Deserialize)]
        struct Used {
            meter: String,
            count: u32,
            price: Option<f64>,
        }
        // A month's close for deployments is charged in the next month;
        // it is last month's, so it is left out here.
        let ledger = self
            .db
            .prepare(format!(
                "SELECT {METER_SQL} AS meter, SUM(CASE WHEN {RUN_SQL} THEN 1 ELSE 0 END) AS count, SUM({PRICE_SQL}) AS price
                 FROM ledger WHERE workspace = ?1 AND kind = 'usage' AND created_at >= ?2 AND created_at < ?3
                   AND COALESCE(reference, '') NOT LIKE 'deployments/%'
                   -- Runs on the workspace's own model provider are its provider's to bill, never g1t's.
                   AND COALESCE(billed_to, 'g1t') = 'g1t'
                 GROUP BY 1"
            ))
            .bind(&[workspace.as_str().into(), from.as_str().into(), until.as_str().into()])?
            .all()
            .await?
            .results::<Used>()?;
        #[derive(Deserialize)]
        struct Pending {
            source: String,
            cost_micros: Option<f64>,
            detail: Option<String>,
        }
        let pending = self
            .db
            .prepare("SELECT source, cost_micros, detail FROM pending_usage WHERE workspace = ? AND month = ? AND charged_at IS NULL")
            .bind(&[workspace.as_str().into(), month.as_str().into()])?
            .all()
            .await?
            .results::<Pending>()?;
        // At price, before any discount, as every page shows usage: the
        // ledger's lines as they were charged, and what is metered so far
        // at cost plus the margin.
        let price = |cost: i64| crate::credits::with_margin(cost, self.margin_percent);
        let mut meters: Vec<MeterUsage> = METERS
            .iter()
            .map(|(key, label)| MeterUsage { key: (*key).to_owned(), label: (*label).to_owned(), micros: 0, quantity: None })
            .collect();
        let mut agent_runs = 0;
        for used in ledger {
            if let Some(meter) = meters.iter_mut().find(|m| m.key == used.meter) {
                meter.micros += used.price.unwrap_or(0.0).round() as i64;
            }
            if used.meter == "agents" {
                agent_runs = used.count;
            }
        }
        for row in &pending {
            let key = meter_of_source(&row.source);
            if let Some(meter) = meters.iter_mut().find(|m| m.key == key) {
                meter.micros += price(row.cost_micros.unwrap_or(0.0).round() as i64);
                if matches!(key, "requests" | "domains") {
                    meter.quantity = row.detail.clone().filter(|d| !d.is_empty());
                }
            }
        }
        let build_seconds = self.allowance_used("build_seconds", &workspace, &month).await?;
        let operations = self.git_operations_this_month(&workspace).await?;
        let stored = self.private_storage(&workspace).await?;
        for meter in &mut meters {
            match meter.key.as_str() {
                "agents" => meter.quantity = runs(agent_runs),
                "builds" => meter.quantity = build_minutes(build_seconds),
                "git_storage" => meter.quantity = git_and_storage(operations, stored),
                _ => {}
            }
        }
        Ok(Outcome::Ok(meters))
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
    fn tax_and_card_fees_are_their_own_lines_beside_payments_never_charges() {
        assert_eq!(extra_kind("tax"), "Tax");
        assert_eq!(extra_kind("card_fee"), "Card processing fees");
        for kind in ["Tax", "Card processing fees"] {
            // Money that came in with a payment: no price, no usage.
            assert!(is_money_in(kind));
            assert_eq!(kind_order(kind), kind_order("Payments"));
        }
        let mut groups = vec![];
        let line = |kind: &str, passed: i64| StatementLine {
            kind: kind.to_owned(),
            count: 1,
            charged_micros: 0,
            cost_micros: 0,
            covered_micros: 0,
            price_micros: 0,
            discount_micros: 0,
            passed_micros: passed,
        };
        add_line(&mut groups, "2026-10-08".into(), line("Tax", 1_640_000));
        add_line(&mut groups, "2026-10-08".into(), line("Card processing fees", 920_000));
        assert_eq!(groups.len(), 1);
        assert!(groups[0].lines.iter().all(|l| l.charged_micros == 0));
    }

    #[test]
    fn a_month_runs_to_the_first_of_the_next() {
        assert_eq!(month_range("2026-10"), Some(("2026-10-01".into(), "2026-11-01".into())));
        assert_eq!(month_range("2026-12"), Some(("2026-12-01".into(), "2027-01-01".into())));
        assert_eq!(month_range("2026-13"), None);
        assert_eq!(month_range("oops"), None);
    }

    #[test]
    fn a_discounted_line_shows_its_price_and_the_discount() {
        // $1.20 of usage on a 100% discount: charged nothing, all of it off.
        assert_eq!(line_price(0, 0, 1_200_000), 1_200_000);
        // 30% off, $0.20 of it paid by included usage first.
        assert_eq!(line_price(700_000, 140_000, 360_000), 1_200_000);
        assert!(is_money_in("Payments") && is_money_in("Credits from g1t") && is_money_in("Refunds"));
        assert!(!is_money_in("Agent runs"));
    }

    #[test]
    fn usage_lines_come_before_money_in() {
        assert!(kind_order("Agent runs") < kind_order("Sandbox time"));
        assert!(kind_order("Deployments") < kind_order("Payments"));
        assert!(kind_order("Security scans") < kind_order("Payments"));
    }

    #[test]
    fn usage_falls_on_the_meters_the_billing_page_shows() {
        let keys: Vec<_> = METERS.iter().map(|(key, _)| *key).collect();
        assert_eq!(keys, ["agents", "builds", "requests", "domains", "git_storage", "search_scans"]);
        assert_eq!(meter_of_source("deployments"), "requests");
        assert_eq!(meter_of_source("domains"), "domains");
        assert_eq!(meter_of_source("git"), "git_storage");
        assert_eq!(meter_of_source("storage"), "git_storage");
        assert_eq!(meter_of_source("context"), "search_scans");
        assert_eq!(meter_of_source("security"), "search_scans");
        for key in ["builds", "requests", "git_storage", "search_scans", "agents"] {
            assert!(METER_SQL.contains(&format!("'{key}'")));
        }
    }

    #[test]
    fn quantities_read_plainly() {
        assert_eq!(build_minutes(0), None);
        assert_eq!(build_minutes(1).as_deref(), Some("1 build minute"));
        assert_eq!(build_minutes(2_461).as_deref(), Some("42 build minutes"));
        assert_eq!(runs(1).as_deref(), Some("1 run"));
        assert_eq!(runs(1_200).as_deref(), Some("1,200 runs"));
        assert_eq!(git_and_storage(0, 0), None);
        assert_eq!(git_and_storage(12_345, 420_000_000).as_deref(), Some("12,345 git operations, 0.42 GB private"));
        assert_eq!(git_and_storage(1, 0).as_deref(), Some("1 git operation"));
    }

    #[test]
    fn the_statement_says_what_paid_before_the_workspace_did() {
        let lines = covered_lines([0, 250_000, 120_000, 0]);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].label, "Paid by your trial credit");
        assert_eq!(lines[1], Covered { source: "oss_pool".into(), label: "Paid by g1t's open-source pool".into(), micros: 120_000 });
        assert!(covered_lines([0, 0, 0, 0]).is_empty());
        let lines = covered_lines([4_000_000, 0, 0, 30_000]);
        assert_eq!(lines[0].label, "Paid by your plan's included usage");
        assert_eq!(lines[1].label, "Covered by g1t");
    }
}
