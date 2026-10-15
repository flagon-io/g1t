//! The Usage page: a workspace's usage over a range of days, at price, by
//! product family, meter, project and day, with what paid for it.
//!
//! Every figure comes from the ledger's own lines, measured as the
//! statement measures them (`statement::PRICE_SQL`: what was charged, plus
//! what included usage, the trial, a pool or g1t paid, plus what a discount
//! took off), so the Usage page and Billing show the same numbers. Usage metered through the month and charged
//! when it closes (storage, git operations, scans, embeddings, domains,
//! app traffic) is added from `pending_usage`, at cost plus the margin, and
//! said to be pending.
//!
//! Lines from before g1t stopped running agents and selling model access
//! (agent runs, the agent rate, AI Gateway requests), and any line on a
//! task this page does not know, are kept on one meter, Other, in a
//! product of their own: nothing charged is ever left out.

use std::collections::{BTreeMap, BTreeSet};

use futures_util::future::{try_join, try_join3};
use g1t_contracts::billing::{
    Allowance, MeterLine, PlanKind, ProductUsage, ProjectUsage, UsageDay, UsageReport, UsageReportArgs, UsageTotals, PRODUCTS,
};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::charged::{charged, cover_with_included, pending_split};
use crate::statement::PRICE_SQL;
use crate::{Billing, members_only};

/// The longest range the page reads at once.
pub(crate) const MAX_DAYS: u64 = 400;
const DAY_MS: u64 = 86_400_000;

/// Which meter a ledger line is on. One SQL expression, so every query
/// agrees with `meters()`. Runner minutes are by machine (`runner_2-core`,
/// one meter for each machine in the catalogue); sandbox lines from before
/// minutes have no machine and stay sandbox time, in seconds.
pub(crate) const METER_KEY_SQL: &str = "CASE
    WHEN task = 'sandbox' AND machine IS NOT NULL THEN 'runner_' || machine
    WHEN task = 'sandbox' THEN 'sandbox'
    WHEN task = 'self_hosted' THEN 'self_hosted'
    WHEN task = 'deployments' AND reference LIKE 'deploy/%' THEN 'builds'
    WHEN task = 'deployments' THEN 'requests'
    WHEN task = 'domains' THEN 'domains'
    WHEN task = 'git' THEN 'git'
    WHEN task = 'storage' THEN 'storage'
    WHEN task = 'cache' THEN 'cache'
    WHEN task = 'package_storage' THEN 'packages'
    WHEN task = 'security' THEN 'security'
    WHEN task = 'context' THEN 'context'
    WHEN task = 'telemetry' THEN 'telemetry'
    ELSE 'other' END";

/// A meter: key, name, product family and the unit of its quantity.
pub(crate) type Meter = (String, String, &'static str, &'static str);

/// The runner-minutes meter of a machine (`runner_2-core`).
pub(crate) fn runner_meter(machine: &str) -> String {
    format!("runner_{machine}")
}

/// Every meter: runner minutes for each machine in the catalogue, then
/// `METERS`.
pub(crate) fn meters() -> Vec<Meter> {
    g1t_contracts::actions::machines()
        .into_iter()
        .map(|m| (runner_meter(m.machine), format!("Runner minutes, {} ({})", m.machine, m.size()), "sandboxes", "minutes"))
        .chain(METERS.iter().map(|(key, label, product, unit)| ((*key).to_owned(), (*label).to_owned(), *product, *unit)))
        .collect()
}

/// Every meter but the runners': key, name, product family and the unit
/// of its quantity.
pub(crate) const METERS: [(&str, &str, &str, &str); 13] = [
    // Sandbox lines from before runner minutes, by the second.
    ("sandbox", "Sandbox time", "sandboxes", "seconds"),
    ("self_hosted", "Self-hosted runner time", "sandboxes", "seconds"),
    ("builds", "Builds", "deployments", "entries"),
    ("requests", "Requests & CPU", "deployments", "entries"),
    ("domains", "Custom domains", "deployments", "entries"),
    ("git", "Git operations", "git_storage", "operations"),
    ("storage", "Private storage", "git_storage", "bytes"),
    ("cache", "Actions cache", "git_storage", "entries"),
    ("packages", "Package storage", "packages", "entries"),
    ("security", "Security scans", "security", "entries"),
    ("context", "Search embeddings", "search", "entries"),
    ("telemetry", "Observability data", "observability", "entries"),
    // Kept apart so nothing is ever lost: a line whose meter is unknown,
    // and agents' and models' usage from before they were retired.
    ("other", "Other", OTHER, "entries"),
];

/// The product of the Other meter: not one of `PRODUCTS`, listed last and
/// only when it has something.
pub(crate) const OTHER: &str = "other";

/// The meter month-end usage noted so far (`pending_usage.source`) is on.
pub(crate) fn meter_of_pending(source: &str) -> &'static str {
    match source {
        "deployments" => "requests",
        "domains" => "domains",
        "storage" => "storage",
        "git" => "git",
        "cache" => "cache",
        "package_storage" => "packages",
        "security" => "security",
        "context" => "context",
        "telemetry" => "telemetry",
        _ => "other",
    }
}

/// Every day from `from` to `until`, both included, or why not.
pub(crate) fn days_between(from: &str, until: &str) -> std::result::Result<Vec<String>, &'static str> {
    let (Some(start), Some(end)) = (parse_rfc3339(&format!("{from}T00:00:00Z")), parse_rfc3339(&format!("{until}T00:00:00Z"))) else {
        return Err("Give the range as days, YYYY-MM-DD.");
    };
    if end < start {
        return Err("The range ends before it starts.");
    }
    if (end - start) / DAY_MS + 1 > MAX_DAYS {
        return Err("Ask for at most 400 days at a time.");
    }
    Ok((0..=(end - start) / DAY_MS).map(|n| rfc3339(start + n * DAY_MS)[..10].to_owned()).collect())
}

/// One group of ledger lines: a day, a meter and a project.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct Cell {
    pub day: String,
    pub meter: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub quantity: Option<f64>,
    #[serde(default)]
    pub entries: Option<f64>,
    #[serde(default)]
    pub discount: Option<f64>,
    #[serde(default)]
    pub covered: Option<f64>,
    #[serde(default)]
    pub cost: Option<f64>,
}

/// What is metered this month and charged when it closes, by meter: at
/// price, with what g1t covers of it and what the discount takes off, as
/// the close will enter it (`charged::pending_split`).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Pending {
    pub meter: &'static str,
    pub micros: i64,
    pub covered: i64,
    pub discount: i64,
}

/// Whether a range of days reaches into the current month, so the month's
/// usage not yet closed (`pending_usage`, which has no day of its own) is
/// counted in it. `today` is billing's own UTC day, so the top bar, Spend,
/// Home and Usage, which all ask for the first of the month to today, get
/// the same answer whatever `until` they send: a range need not reach
/// month end to include what the month has metered so far.
pub(crate) fn reaches_this_month(from: &str, until: &str, today: &str) -> bool {
    from <= today && until >= &format!("{}-01", &today[..7])[..]
}

/// Shapes the groups into the page: products in order, each with its
/// meters, each meter with every day of the range and its projects. Only
/// the products and projects asked for (all, when none are).
pub(crate) fn shape(
    days: &[String],
    cells: &[Cell],
    pending: &[Pending],
    products: &[String],
    projects: &[String],
) -> (Vec<ProductUsage>, Vec<UsageDay>, UsageTotals, Vec<String>) {
    let wanted_product = |product: &str| products.is_empty() || products.iter().any(|p| p == product);
    let wanted_project = |project: &str| projects.is_empty() || projects.iter().any(|p| p == project);
    let index: BTreeMap<&str, usize> = days.iter().enumerate().map(|(i, d)| (d.as_str(), i)).collect();
    let all_meters = meters();
    let product_of = |meter: &str| all_meters.iter().find(|m| m.0 == meter).map_or(OTHER, |m| m.2);
    let mut all_projects = BTreeSet::new();
    let mut lines: Vec<MeterLine> = all_meters
        .iter()
        .map(|(key, label, product, unit)| MeterLine {
            key: key.clone(),
            label: label.clone(),
            product: (*product).to_owned(),
            unit: (*unit).to_owned(),
            quantity: 0.0,
            micros: 0,
            pending_micros: 0,
            daily: vec![0; days.len()],
            allowance: None,
            by_project: vec![],
            note: None,
        })
        .collect();
    let mut by_day: BTreeMap<(String, String), i64> = BTreeMap::new();
    let mut totals = UsageTotals::default();
    let mut projects_of: BTreeMap<(String, String), (i64, f64)> = BTreeMap::new();
    for cell in cells {
        if !cell.project.is_empty() {
            all_projects.insert(cell.project.clone());
        }
        let product = product_of(&cell.meter);
        if !wanted_product(product) || !wanted_project(&cell.project) {
            continue;
        }
        // A meter this page does not know is Other's: never dropped.
        let meter = if all_meters.iter().any(|m| m.0 == cell.meter) { cell.meter.as_str() } else { "other" };
        let Some(line) = lines.iter_mut().find(|l| l.key == meter) else { continue };
        let price = cell.price.unwrap_or(0.0).round() as i64;
        line.micros += price;
        line.quantity += if line.unit == "entries" { cell.entries.unwrap_or(0.0) } else { cell.quantity.unwrap_or(0.0) };
        if let Some(i) = index.get(cell.day.as_str()) {
            line.daily[*i] += price;
        }
        *by_day.entry((cell.day.clone(), product.to_owned())).or_default() += price;
        let part = projects_of.entry((meter.to_owned(), cell.project.clone())).or_default();
        part.0 += price;
        part.1 += if line.unit == "entries" { cell.entries.unwrap_or(0.0) } else { cell.quantity.unwrap_or(0.0) };
        totals.price_micros += price;
        totals.discount_micros += cell.discount.unwrap_or(0.0).round() as i64;
        totals.included_micros += cell.covered.unwrap_or(0.0).round() as i64;
        totals.cost_micros += cell.cost.unwrap_or(0.0).round() as i64;
    }
    // Pending usage is no one project's: only when all projects are shown.
    if projects.is_empty() {
        for p in pending {
            let product = product_of(p.meter);
            if !wanted_product(product) {
                continue;
            }
            if let Some(line) = lines.iter_mut().find(|l| l.key == p.meter) {
                line.micros += p.micros;
                line.pending_micros += p.micros;
            }
            totals.price_micros += p.micros;
            totals.pending_micros += p.micros;
            totals.pending_charged_micros += p.micros - p.covered - p.discount;
            totals.included_micros += p.covered;
            totals.discount_micros += p.discount;
        }
    }
    for ((meter, project), (micros, quantity)) in projects_of {
        if let Some(line) = lines.iter_mut().find(|l| l.key == meter) {
            line.by_project.push(ProjectUsage { project, micros, quantity });
        }
    }
    for line in &mut lines {
        line.by_project.sort_by(|a, b| b.micros.cmp(&a.micros).then(a.project.cmp(&b.project)));
    }
    // The products that still have meters, in order, then Other when it
    // has something.
    let other_used = lines.iter().any(|l| l.product == OTHER && (l.micros != 0 || l.quantity != 0.0));
    let products_out = PRODUCTS
        .iter()
        .copied()
        .filter(|(key, _)| all_meters.iter().any(|m| m.2 == *key))
        .chain(other_used.then_some((OTHER, "Other")))
        .filter(|(key, _)| wanted_product(key))
        .map(|(key, label)| {
            let meters: Vec<MeterLine> = lines.iter().filter(|l| l.product == key).cloned().collect();
            ProductUsage {
                key: key.to_owned(),
                label: label.to_owned(),
                micros: meters.iter().map(|m| m.micros).sum(),
                meters,
            }
        })
        .collect();
    let days_out = by_day.into_iter().filter(|(_, micros)| *micros != 0).map(|((day, product), micros)| UsageDay { day, product, micros }).collect();
    (products_out, days_out, totals, all_projects.into_iter().collect())
}

impl Billing {
    /// `usage_report`: members only.
    pub(crate) async fn usage_report(&self, a: UsageReportArgs) -> Result<Outcome<UsageReport>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let days = match days_between(&a.from, &a.until) {
            Ok(days) => days,
            Err(why) => return Ok(Outcome::fail(FailureCode::Invalid, why)),
        };
        let from = days[0].clone();
        let until = days[days.len() - 1].clone();
        // Lines entered on the last day count, whatever the hour.
        let end = rfc3339(parse_rfc3339(&format!("{until}T00:00:00Z")).unwrap_or(0) + DAY_MS);
        let measure = if self.free { "COALESCE(cost_micros, 0)" } else { PRICE_SQL };
        let now = rfc3339(now_ms());
        let month = now[..7].to_owned();
        let this_month = reaches_this_month(&from, &until, &now[..10]);

        let cells = async {
            self.db
                .prepare(format!(
                    "SELECT substr(created_at, 1, 10) AS day, {meter} AS meter, COALESCE(repo, '') AS project,
                            SUM({measure}) AS price, SUM(COALESCE(quantity, 0)) AS quantity, COUNT(*) AS entries,
                            SUM(COALESCE(discount_micros, 0)) AS discount,
                            SUM(COALESCE(credit_micros, 0) + COALESCE(gift_micros, 0) + COALESCE(trial_micros, 0) + COALESCE(oss_micros, 0) + COALESCE(given_micros, 0)) AS covered,
                            SUM(COALESCE(cost_micros, 0)) AS cost
                     FROM ledger WHERE workspace = ?1 AND kind = 'usage' AND created_at >= ?2 AND created_at < ?3
                     GROUP BY 1, 2, 3 LIMIT 20000",
                    meter = METER_KEY_SQL
                ))
                .bind(&[workspace.as_str().into(), from.as_str().into(), end.as_str().into()])?
                .all()
                .await?
                .results::<Cell>()
        };
        let pending = async {
            if !this_month {
                return Ok(vec![]);
            }
            self.pending_this_month(&[workspace.as_str().into()], &month).await
        };
        let credits = self.credit_paid_between(&workspace, &from, &end);
        let ((cells, pending, (credits_paid, credits)), account) =
            try_join(try_join3(cells, pending, credits), self.account_of(&workspace)).await?;
        let percent = account.terms.percent_off();
        let plan = self.plan_kind_for(&workspace, &account).await?;
        // What is metered so far is entered on the account's terms when the
        // month closes: its discount, and what g1t covers, come off it now,
        // and the plan's included usage still left pays first, as the
        // limit counts it (`limits::limit_with`).
        let mut splits: Vec<_> = pending.iter().map(|p| pending_split(p.cost(), p.charge(), self.margin_percent, percent)).collect();
        if this_month && plan != PlanKind::Free && !splits.is_empty() {
            let used = self.allowance_used("plan_credit", &workspace, &month).await?;
            cover_with_included(&mut splits, crate::credits::left(self.plans.plan_included_micros, used));
        }
        let pending: Vec<Pending> = pending
            .into_iter()
            .zip(splits)
            .map(|(p, split)| Pending { meter: meter_of_pending(&p.source), micros: split.price, covered: split.covered, discount: split.discount })
            .filter(|p| p.micros > 0)
            .collect();
        let (mut products, days_out, mut totals, all_projects) = shape(&days, &cells, &pending, &a.products, &a.projects);
        let filtered = !a.products.is_empty() || !a.projects.is_empty();
        // Credit is the workspace's, not a product's or a project's: only
        // without a filter is it taken off.
        totals.credits_micros = if filtered { 0 } else { credits_paid.max(0) };
        totals.charged_micros = charged(&totals);
        // Allowances, for the range that includes this month.
        let mut included = None;
        let mut trial = None;
        if this_month {
            let (used, stored, operations) = futures_util::future::try_join3(
                async {
                    if plan == PlanKind::Paid { self.allowance_used("plan_credit", &workspace, &month).await } else { Ok(0) }
                },
                self.private_storage(&workspace),
                self.git_operations_this_month(&workspace),
            )
            .await?;
            if plan == PlanKind::Paid {
                included = Some(Allowance { used: used as f64, of: self.plans.plan_included_micros as f64, unit: "micros".to_owned() });
            }
            for product in &mut products {
                for meter in &mut product.meters {
                    match meter.key.as_str() {
                        "storage" => {
                            meter.quantity = stored as f64;
                            meter.allowance = Some(Allowance { used: stored as f64, of: self.plans.free_storage_bytes as f64, unit: "bytes".to_owned() });
                        }
                        "git" => {
                            meter.quantity = operations as f64;
                            meter.allowance = Some(Allowance { used: operations as f64, of: self.plans.git_included as f64, unit: "operations".to_owned() });
                        }
                        _ => {}
                    }
                }
            }
            if plan == PlanKind::Free
                && let Some(grant) = self.grant_of(&workspace).await?
            {
                trial = Some(crate::credits::left(grant.granted_micros, grant.used_micros));
            }
        }
        // AI credit bought before g1t stopped selling it: still the
        // workspace's, and kept apart from credit for everything.
        let ai: i64 = credits.grants.iter().filter(|g| g.scope == "models").map(|g| g.left_micros).sum();
        Ok(Outcome::Ok(UsageReport {
            from,
            until,
            totals,
            days: days_out,
            products,
            projects: all_projects,
            included,
            discount_percent: (percent > 0).then_some(percent),
            ai_credit_micros: ai,
            credit_micros: credits.left_micros - ai,
            trial_micros: trial,
            plan,
            free: self.free,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(day: &str, meter: &str, project: &str, price: f64) -> Cell {
        Cell { day: day.into(), meter: meter.into(), project: project.into(), price: Some(price), entries: Some(1.0), ..Cell::default() }
    }

    #[test]
    fn a_range_is_every_day_in_it() {
        let days = days_between("2026-10-01", "2026-10-03").unwrap();
        assert_eq!(days, ["2026-10-01", "2026-10-02", "2026-10-03"]);
        assert_eq!(days_between("2026-10-01", "2026-10-01").unwrap().len(), 1);
        assert!(days_between("2026-10-03", "2026-10-01").is_err());
        assert!(days_between("2025-01-01", "2026-10-01").is_err());
        assert!(days_between("Oct 1", "2026-10-01").is_err());
    }

    #[test]
    fn usage_is_shaped_into_products_meters_days_and_projects() {
        let days = days_between("2026-10-01", "2026-10-03").unwrap();
        let mut sandbox = cell("2026-10-02", "sandbox", "acme/web", 120_000.0);
        sandbox.quantity = Some(600.0);
        let cells = vec![
            cell("2026-10-01", "requests", "acme/web", 2_000_000.0),
            cell("2026-10-03", "requests", "acme/api", 1_000_000.0),
            sandbox,
            Cell { covered: Some(1_000_000.0), discount: Some(0.0), ..cell("2026-10-03", "storage", "", 30_000.0) },
        ];
        let pending = vec![Pending { meter: "git", micros: 40_000, ..Pending::default() }];
        let (products, by_day, totals, projects) = shape(&days, &cells, &pending, &[], &[]);
        // Every product family with meters, in order; no Other without usage on it.
        assert_eq!(products.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), ["sandboxes", "deployments", "git_storage", "packages", "security", "search", "observability"]);
        let deployments = &products[1];
        assert_eq!(deployments.micros, 3_000_000);
        let requests = deployments.meters.iter().find(|m| m.key == "requests").unwrap();
        assert_eq!(requests.daily, [2_000_000, 0, 1_000_000]);
        assert_eq!(requests.by_project[0].project, "acme/web");
        let sandbox = products[0].meters.iter().find(|m| m.key == "sandbox").unwrap();
        assert_eq!((sandbox.micros, sandbox.quantity), (120_000, 600.0));
        // Pending usage counts in the totals and its meter, not on a day.
        let git = products[2].meters.iter().find(|m| m.key == "git").unwrap();
        assert_eq!((git.micros, git.pending_micros), (40_000, 40_000));
        assert_eq!(totals.price_micros, 3_000_000 + 120_000 + 30_000 + 40_000);
        assert_eq!(totals.pending_micros, 40_000);
        assert_eq!(totals.included_micros, 1_000_000);
        assert_eq!(by_day.iter().filter(|d| d.product == "deployments").map(|d| d.micros).sum::<i64>(), 3_000_000);
        assert_eq!(projects, ["acme/api", "acme/web"]);
    }

    #[test]
    fn runner_minutes_are_by_machine_beside_older_sandbox_time() {
        let days = days_between("2026-10-01", "2026-10-01").unwrap();
        let minutes = |meter: &str, quantity: f64, price: f64| Cell { quantity: Some(quantity), ..cell("2026-10-01", meter, "acme/web", price) };
        let cells = vec![
            minutes("runner_2-core", 12.0, 48_000.0),
            minutes("runner_4-core", 3.0, 21_000.0),
            // A line from before minutes: seconds of sandbox time.
            minutes("sandbox", 90.0, 1_000.0),
            // A machine since taken out of the catalogue: kept, under Other.
            minutes("runner_1-core", 5.0, 5_000.0),
        ];
        let (products, _, totals, _) = shape(&days, &cells, &[], &[], &[]);
        let sandboxes = &products[0];
        let line = |key: &str| sandboxes.meters.iter().find(|m| m.key == key).unwrap();
        let two = line("runner_2-core");
        assert_eq!((two.label.as_str(), two.unit.as_str(), two.quantity, two.micros), ("Runner minutes, 2-core (2 vCPU, 8 GiB, 16 GB)", "minutes", 12.0, 48_000));
        assert_eq!((line("runner_4-core").quantity, line("runner_4-core").micros), (3.0, 21_000));
        assert_eq!((line("sandbox").unit.as_str(), line("sandbox").quantity), ("seconds", 90.0));
        assert_eq!(products.last().unwrap().micros, 5_000);
        assert_eq!(totals.price_micros, 75_000);
        assert!(METER_KEY_SQL.contains("'runner_' || machine"));
    }

    #[test]
    fn usage_from_retired_or_unknown_meters_is_other_and_never_lost() {
        let days = days_between("2026-10-01", "2026-10-02").unwrap();
        // Lines from when g1t ran agents, as the ledger still has them, and
        // a meter nothing knows.
        let cells = vec![
            cell("2026-10-01", "other", "acme/web", 2_000_000.0),
            cell("2026-10-01", "agent_rate", "acme/web", 500_000.0),
            cell("2026-10-02", "gateway", "", 70_000.0),
            cell("2026-10-02", "sandbox", "acme/web", 10_000.0),
        ];
        let (products, by_day, totals, _) = shape(&days, &cells, &[], &[], &[]);
        let other = products.last().unwrap();
        assert_eq!((other.key.as_str(), other.label.as_str(), other.micros), ("other", "Other", 2_570_000));
        assert_eq!(other.meters.len(), 1);
        assert_eq!(other.meters[0].daily, [2_500_000, 70_000]);
        // Everything charged is in the totals and on its day.
        assert_eq!(totals.price_micros, 2_580_000);
        assert_eq!(products.iter().map(|p| p.micros).sum::<i64>(), totals.price_micros);
        assert_eq!(by_day.iter().map(|d| d.micros).sum::<i64>(), totals.price_micros);
        // Asked for by name, Other is shown alone.
        let (only, _, totals, _) = shape(&days, &cells, &[], &["other".into()], &[]);
        assert_eq!(only.len(), 1);
        assert_eq!(totals.price_micros, 2_570_000);
    }

    #[test]
    fn filters_keep_only_the_products_and_projects_asked_for() {
        let days = days_between("2026-10-01", "2026-10-01").unwrap();
        let cells = vec![cell("2026-10-01", "sandbox", "acme/web", 100.0), cell("2026-10-01", "sandbox", "acme/api", 50.0), cell("2026-10-01", "requests", "acme/web", 10.0)];
        let pending = vec![Pending { meter: "git", micros: 7, ..Pending::default() }];
        let (products, _, totals, projects) = shape(&days, &cells, &pending, &["sandboxes".into()], &["acme/web".into()]);
        assert_eq!(products.len(), 1);
        assert_eq!(totals.price_micros, 100);
        // Every project stays listed, for the filter itself.
        assert_eq!(projects, ["acme/api", "acme/web"]);
    }

    #[test]
    fn pending_usage_counts_at_price_with_what_is_covered_and_discounted() {
        let days = days_between("2026-10-01", "2026-10-02").unwrap();
        // Storage on a 100% discount, and scans g1t covers on a free workspace.
        let pending = [
            Pending { meter: "storage", micros: 9_000, covered: 0, discount: 9_000 },
            Pending { meter: "security", micros: 2_400, covered: 2_400, discount: 0 },
        ];
        let (_, _, totals, _) = shape(&days, &[], &pending, &[], &[]);
        assert_eq!(totals.price_micros, 11_400);
        assert_eq!(totals.pending_micros, 11_400);
        assert_eq!(totals.pending_charged_micros, 11_400 - totals.included_micros - totals.discount_micros);
        assert_eq!(totals.included_micros, 2_400);
        assert_eq!(totals.discount_micros, 9_000);
        assert_eq!(charged(&totals), 0);
        // With a project chosen, pending usage (no project's) is left out.
        let (_, _, filtered, _) = shape(&days, &[], &pending, &[], &["acme/api".to_owned()]);
        assert_eq!(filtered.pending_micros, 0);
    }

    #[test]
    fn pending_usage_is_on_its_meter() {
        assert_eq!(meter_of_pending("package_storage"), "packages");
        assert_eq!(meter_of_pending("nonsense"), "other");
    }

    #[test]
    fn pending_usage_counts_in_any_range_that_reaches_into_this_month() {
        // The first of the month to today, as every page asks: counted.
        assert!(reaches_this_month("2026-10-01", "2026-10-10", "2026-10-10"));
        // To month end, or only the last week: counted too.
        assert!(reaches_this_month("2026-10-01", "2026-10-31", "2026-10-10"));
        assert!(reaches_this_month("2026-10-04", "2026-10-10", "2026-10-10"));
        // Last month, or a month that has not started: not this month's.
        assert!(!reaches_this_month("2026-09-01", "2026-09-30", "2026-10-10"));
        assert!(!reaches_this_month("2026-11-01", "2026-11-30", "2026-10-10"));
        // The month has turned on billing's clock: September's range no longer has it.
        assert!(!reaches_this_month("2026-09-01", "2026-09-30", "2026-10-01"));
    }
}
