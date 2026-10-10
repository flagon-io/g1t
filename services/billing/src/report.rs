//! The Usage page: a workspace's usage over a range of days, at price, by
//! product family, meter, project and day, with what paid for it.
//!
//! Every figure comes from the ledger's own lines, measured as the
//! statement measures them (`statement::PRICE_SQL`: what was charged, plus
//! what included usage, the trial, a pool or g1t paid, plus what a discount
//! took off), so the Usage page, Billing, mission control and the agent
//! fleet show the same numbers. Usage metered through the month and charged
//! when it closes (storage, git operations, scans, embeddings, domains,
//! app traffic) is added from `pending_usage`, at cost plus the margin, and
//! said to be pending.

use std::collections::{BTreeMap, BTreeSet};

use futures_util::future::{try_join, try_join5};
use g1t_contracts::billing::{
    Allowance, FeatureUsage, MeterLine, ModelTokens, PlanKind, ProductUsage, ProjectUsage, UsageDay, UsageReport, UsageReportArgs, UsageShare,
    UsageTotals, PRODUCTS,
};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::charged::{charged, pending_split};
use crate::statement::{PRICE_SQL, RUN_SQL};
use crate::{Billing, members_only};

/// The meters that make up the agent product, as `METER_KEY_SQL` names
/// them: what agents cost, attributed to the agent and the person asking.
pub(crate) const AGENT_METERS_SQL: &str = "('agent_models', 'agent_rate', 'agent_rate_own', 'agent_sandbox')";

/// The longest range the page reads at once.
pub(crate) const MAX_DAYS: u64 = 400;
const DAY_MS: u64 = 86_400_000;

/// Which meter a ledger line is on. One SQL expression, so every query
/// agrees with `METERS`.
pub(crate) const METER_KEY_SQL: &str = "CASE
    WHEN task = 'sandbox' AND compute = 'agent' THEN 'agent_sandbox'
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
    WHEN task = 'gateway' THEN 'gateway'
    WHEN reference LIKE '%/agent-own%' THEN 'agent_rate_own'
    WHEN reference LIKE '%/agent%' THEN 'agent_rate'
    ELSE 'agent_models' END";

/// Every meter: key, name, product family and the unit of its quantity.
pub(crate) const METERS: [(&str, &str, &str, &str); 17] = [
    ("agent_models", "Model tokens", "agent", "tokens"),
    ("agent_rate", "Agent rate", "agent", "tokens"),
    ("agent_rate_own", "Agent rate, your own model key", "agent", "tokens"),
    ("agent_sandbox", "Agent sandbox time", "agent", "seconds"),
    ("sandbox", "Sandbox time", "sandboxes", "seconds"),
    ("self_hosted", "Self-hosted runner time", "sandboxes", "seconds"),
    ("gateway", "AI Gateway models", "gateway", "requests"),
    ("builds", "Builds", "deployments", "entries"),
    ("requests", "Requests & CPU", "deployments", "entries"),
    ("domains", "Custom domains", "deployments", "entries"),
    ("git", "Git operations", "git_storage", "operations"),
    ("storage", "Private storage", "git_storage", "bytes"),
    ("cache", "Actions cache", "git_storage", "entries"),
    ("packages", "Package storage", "packages", "entries"),
    ("security", "Security scans", "security", "entries"),
    ("context", "Search embeddings", "search", "entries"),
    // Kept apart so nothing is ever lost: a line whose meter is unknown.
    ("other", "Other", "agent", "entries"),
];

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
        _ => "other",
    }
}

/// What the agent was doing, by a run's task.
pub(crate) fn feature_of(task: &str) -> (&'static str, &'static str) {
    match task {
        "review" => ("reviews", "Reviews"),
        "plan" => ("plans", "Plans"),
        "update" => ("catch_ups", "Catch-ups"),
        "check" | "mergecheck" | "queue" => ("checks", "Checks"),
        _ => ("runs", "Runs"),
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

/// Tokens a day's runs used, by project.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct TokenCell {
    pub day: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub tokens: Option<f64>,
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

/// One agent's and one asker's agent-product lines over the range.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct Attributed {
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub person: String,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub entries: Option<f64>,
}

/// The agent product by agent and by person, most first, from its lines:
/// each group's price under the agent's handle and the asker's username,
/// and lines attributed to no one under an empty key. Both sum to the
/// agent product's total.
pub(crate) fn attribution(rows: &[Attributed]) -> (Vec<UsageShare>, Vec<UsageShare>) {
    fn fold(rows: &[Attributed], key_of: impl Fn(&Attributed) -> &str, label_of: impl Fn(&str) -> String) -> Vec<UsageShare> {
        let mut by: BTreeMap<&str, UsageShare> = BTreeMap::new();
        for row in rows {
            let key = key_of(row);
            let slice = by.entry(key).or_insert_with(|| UsageShare { key: key.to_owned(), label: label_of(key), ..UsageShare::default() });
            slice.micros += row.price.unwrap_or(0.0).round() as i64;
            slice.count += row.entries.unwrap_or(0.0).max(0.0) as u32;
        }
        let mut out: Vec<UsageShare> = by.into_values().filter(|s| s.micros != 0 || s.count > 0).collect();
        out.sort_by(|a, b| b.micros.cmp(&a.micros).then(a.key.cmp(&b.key)));
        out
    }
    let agents = fold(rows, |r| r.agent.as_str(), |k| if k.is_empty() { "Not attributed to an agent".to_owned() } else { format!("@{k}") });
    let people = fold(rows, |r| r.person.as_str(), |k| if k.is_empty() { "No one asked".to_owned() } else { format!("@{k}") });
    (agents, people)
}

/// Shapes the groups into the page: products in order, each with its
/// meters, each meter with every day of the range and its projects. Only
/// the products and projects asked for (all, when none are).
pub(crate) fn shape(
    days: &[String],
    cells: &[Cell],
    tokens: &[TokenCell],
    pending: &[Pending],
    products: &[String],
    projects: &[String],
) -> (Vec<ProductUsage>, Vec<UsageDay>, UsageTotals, Vec<String>) {
    let wanted_product = |product: &str| products.is_empty() || products.iter().any(|p| p == product);
    let wanted_project = |project: &str| projects.is_empty() || projects.iter().any(|p| p == project);
    let index: BTreeMap<&str, usize> = days.iter().enumerate().map(|(i, d)| (d.as_str(), i)).collect();
    let product_of = |meter: &str| METERS.iter().find(|m| m.0 == meter).map_or("agent", |m| m.2);
    let mut all_projects = BTreeSet::new();
    let mut lines: Vec<MeterLine> = METERS
        .iter()
        .map(|(key, label, product, unit)| MeterLine {
            key: (*key).to_owned(),
            label: (*label).to_owned(),
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
        let Some(line) = lines.iter_mut().find(|l| l.key == cell.meter) else { continue };
        let price = cell.price.unwrap_or(0.0).round() as i64;
        line.micros += price;
        // Tokens for the model meter come from the token counts below.
        if line.key != "agent_models" {
            line.quantity += if line.unit == "entries" { cell.entries.unwrap_or(0.0) } else { cell.quantity.unwrap_or(0.0) };
        }
        if let Some(i) = index.get(cell.day.as_str()) {
            line.daily[*i] += price;
        }
        *by_day.entry((cell.day.clone(), product.to_owned())).or_default() += price;
        let part = projects_of.entry((cell.meter.clone(), cell.project.clone())).or_default();
        part.0 += price;
        part.1 += if line.unit == "entries" { cell.entries.unwrap_or(0.0) } else { cell.quantity.unwrap_or(0.0) };
        totals.price_micros += price;
        totals.discount_micros += cell.discount.unwrap_or(0.0).round() as i64;
        totals.included_micros += cell.covered.unwrap_or(0.0).round() as i64;
        totals.cost_micros += cell.cost.unwrap_or(0.0).round() as i64;
    }
    if wanted_product("agent") {
        for cell in tokens {
            if !wanted_project(&cell.project) {
                continue;
            }
            let tokens = cell.tokens.unwrap_or(0.0);
            if let Some(line) = lines.iter_mut().find(|l| l.key == "agent_models") {
                line.quantity += tokens;
            }
            projects_of.entry(("agent_models".to_owned(), cell.project.clone())).or_default().1 += tokens;
        }
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
    let products_out = PRODUCTS
        .iter()
        .filter(|(key, _)| wanted_product(key))
        .map(|(key, label)| {
            let meters: Vec<MeterLine> = lines.iter().filter(|l| l.product == *key && (l.key != "other" || l.micros != 0)).cloned().collect();
            ProductUsage {
                key: (*key).to_owned(),
                label: (*label).to_owned(),
                micros: meters.iter().map(|m| m.micros).sum(),
                meters,
                features: vec![],
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
        let this_month = from.as_str() <= now.as_str() && until.as_str() >= &format!("{month}-01")[..];

        let cells = async {
            self.db
                .prepare(format!(
                    "SELECT substr(created_at, 1, 10) AS day, {meter} AS meter, COALESCE(repo, '') AS project,
                            SUM({measure}) AS price, SUM(COALESCE(quantity, 0)) AS quantity, COUNT(*) AS entries,
                            SUM(COALESCE(discount_micros, 0)) AS discount,
                            SUM(COALESCE(credit_micros, 0) + COALESCE(trial_micros, 0) + COALESCE(oss_micros, 0) + COALESCE(given_micros, 0)) AS covered,
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
        let tokens = async {
            self.db
                .prepare(
                    "SELECT t.day AS day, COALESCE(r.repo, '') AS project,
                            SUM(t.input + t.output + t.cache_read + t.cache_write) AS tokens
                     FROM token_usage t LEFT JOIN runs r ON r.session_id = t.session
                     WHERE t.workspace = ?1 AND t.day >= ?2 AND t.day <= ?3
                     GROUP BY 1, 2 LIMIT 20000",
                )
                .bind(&[workspace.as_str().into(), from.as_str().into(), until.as_str().into()])?
                .all()
                .await?
                .results::<TokenCell>()
        };
        #[derive(Deserialize)]
        struct Feature {
            task: Option<String>,
            price: Option<f64>,
            runs: Option<f64>,
        }
        let features = async {
            self.db
                .prepare(format!(
                    "SELECT COALESCE(task, 'implement') AS task, SUM({measure}) AS price, SUM(CASE WHEN {RUN_SQL} THEN 1 ELSE 0 END) AS runs
                     FROM ledger WHERE workspace = ?1 AND kind = 'usage' AND created_at >= ?2 AND created_at < ?3
                       AND ({meter}) IN ('agent_models', 'agent_rate', 'agent_rate_own', 'agent_sandbox')
                     GROUP BY 1",
                    meter = METER_KEY_SQL
                ))
                .bind(&[workspace.as_str().into(), from.as_str().into(), end.as_str().into()])?
                .all()
                .await?
                .results::<Feature>()
        };
        let pending = async {
            if !this_month {
                return Ok(vec![]);
            }
            self.pending_this_month(&[workspace.as_str().into()], &month).await
        };
        // The agent product by the agent that did the work and by who
        // asked, from the same lines: only when the agent product is shown.
        let agents_wanted = a.products.is_empty() || a.products.iter().any(|p| p == "agent");
        let attributed = async {
            if !agents_wanted {
                return Ok(vec![]);
            }
            let mut binds: Vec<worker::wasm_bindgen::JsValue> = vec![workspace.as_str().into(), from.as_str().into(), end.as_str().into()];
            let projects = if a.projects.is_empty() {
                String::new()
            } else {
                binds.extend(a.projects.iter().map(|p| worker::wasm_bindgen::JsValue::from(p.as_str())));
                format!(" AND COALESCE(repo, '') IN ({})", vec!["?"; a.projects.len()].join(", "))
            };
            self.db
                .prepare(format!(
                    "SELECT COALESCE(agent, '') AS agent, COALESCE(asked_by, '') AS person, SUM({measure}) AS price, COUNT(*) AS entries
                     FROM ledger WHERE workspace = ?1 AND kind = 'usage' AND created_at >= ?2 AND created_at < ?3
                       AND ({meter}) IN {AGENT_METERS_SQL}{projects}
                     GROUP BY 1, 2 LIMIT 5000",
                    meter = METER_KEY_SQL
                ))
                .bind(&binds)?
                .all()
                .await?
                .results::<Attributed>()
        };
        let credits = self.credit_paid_between(&workspace, &from, &end);
        let ((cells, tokens, features, pending, (credits_paid, credits)), (attributed, account)) =
            try_join(try_join5(cells, tokens, features, pending, credits), try_join(attributed, self.account_of(&workspace))).await?;
        let percent = account.terms.percent_off();
        // What is metered so far is entered on the account's terms when the
        // month closes: its discount, and what g1t covers, come off it now.
        let pending: Vec<Pending> = pending
            .into_iter()
            .map(|p| {
                let split = pending_split(p.cost(), p.charge(), self.margin_percent, percent);
                Pending { meter: meter_of_pending(&p.source), micros: split.price, covered: split.covered, discount: split.discount }
            })
            .filter(|p| p.micros > 0)
            .collect();
        let (mut products, days_out, mut totals, all_projects) = shape(&days, &cells, &tokens, &pending, &a.products, &a.projects);
        let (by_agent, by_person) = attribution(&attributed);
        let filtered = !a.products.is_empty() || !a.projects.is_empty();
        // Credit is the workspace's, not a product's or a project's: only
        // without a filter is it taken off.
        totals.credits_micros = if filtered { 0 } else { credits_paid.max(0) };
        totals.charged_micros = charged(&totals);
        if let Some(agent) = products.iter_mut().find(|p| p.key == "agent") {
            let mut grouped: BTreeMap<&str, FeatureUsage> = BTreeMap::new();
            for f in &features {
                let (key, label) = feature_of(f.task.as_deref().unwrap_or("implement"));
                let entry = grouped.entry(key).or_insert_with(|| FeatureUsage { key: key.to_owned(), label: label.to_owned(), micros: 0, count: 0 });
                entry.micros += f.price.unwrap_or(0.0).round() as i64;
                entry.count += f.runs.unwrap_or(0.0) as u32;
            }
            agent.features = grouped.into_values().filter(|f| f.micros != 0 || f.count > 0).collect();
            agent.features.sort_by_key(|f| std::cmp::Reverse(f.micros));
        }
        let plan = self.plan_kind_for(&workspace, &account).await?;
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
        // The agent rate's tokens are weighted by kind: say how.
        let weights = self.token_weights().await?;
        for product in &mut products {
            for meter in &mut product.meters {
                if meter.key == "agent_rate" || meter.key == "agent_rate_own" {
                    meter.note = Some(agent_rate_note(&weights));
                }
            }
        }
        let ai: i64 = credits.grants.iter().filter(|g| g.scope == "models").map(|g| g.left_micros).sum();
        let models = self.tokens_by_model(&workspace, &from, &until).await?;
        Ok(Outcome::Ok(UsageReport {
            from,
            until,
            totals,
            days: days_out,
            products,
            projects: all_projects,
            models,
            by_agent,
            by_person,
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

/// What the agent rate's meters say of their tokens.
pub(crate) fn agent_rate_note(weights: &crate::ai::TokenWeights) -> String {
    if weights.is_flat() {
        "Weighted tokens: every token counts once (input ×1, output ×1, cache reads ×1, cache writes ×1)".to_owned()
    } else {
        format!("Weighted tokens: {}", weights.describe())
    }
}

impl Billing {
    /// Agent tokens by model over the days `from` to `until`, most first:
    /// what the model proxy counted, on g1t's models and the workspace's
    /// own provider alike.
    async fn tokens_by_model(&self, workspace: &str, from: &str, until: &str) -> Result<Vec<ModelTokens>> {
        #[derive(Deserialize)]
        struct Row {
            model: String,
            input: Option<f64>,
            output: Option<f64>,
            cache_read: Option<f64>,
            cache_write: Option<f64>,
        }
        let rows = self
            .db
            .prepare(
                "SELECT model, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write
                 FROM token_usage WHERE workspace = ?1 AND day >= ?2 AND day <= ?3
                 GROUP BY model ORDER BY SUM(input + output + cache_read + cache_write) DESC LIMIT 20",
            )
            .bind(&[workspace.into(), from.into(), until.into()])?
            .all()
            .await?
            .results::<Row>()?;
        let n = |v: Option<f64>| v.unwrap_or(0.0).max(0.0) as u64;
        Ok(rows
            .into_iter()
            .map(|r| ModelTokens { model: r.model, input: n(r.input), output: n(r.output), cache_read: n(r.cache_read), cache_write: n(r.cache_write) })
            .collect())
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
            cell("2026-10-01", "agent_models", "acme/web", 2_000_000.0),
            cell("2026-10-01", "agent_rate", "acme/web", 500_000.0),
            cell("2026-10-03", "agent_models", "acme/api", 1_000_000.0),
            sandbox,
            Cell { covered: Some(1_000_000.0), discount: Some(0.0), ..cell("2026-10-03", "storage", "", 30_000.0) },
        ];
        let tokens = vec![TokenCell { day: "2026-10-01".into(), project: "acme/web".into(), tokens: Some(2_000_000.0) }];
        let pending = vec![Pending { meter: "git", micros: 40_000, ..Pending::default() }];
        let (products, by_day, totals, projects) = shape(&days, &cells, &tokens, &pending, &[], &[]);
        // Every product family, in order.
        assert_eq!(products.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), ["agent", "sandboxes", "gateway", "deployments", "git_storage", "packages", "security", "search"]);
        let agent = &products[0];
        assert_eq!(agent.micros, 3_500_000);
        let models = agent.meters.iter().find(|m| m.key == "agent_models").unwrap();
        assert_eq!(models.daily, [2_000_000, 0, 1_000_000]);
        assert_eq!(models.quantity, 2_000_000.0);
        assert_eq!(models.by_project[0].project, "acme/web");
        let sandbox = products[1].meters.iter().find(|m| m.key == "sandbox").unwrap();
        assert_eq!((sandbox.micros, sandbox.quantity), (120_000, 600.0));
        // Pending usage counts in the totals and its meter, not on a day.
        let git = products[4].meters.iter().find(|m| m.key == "git").unwrap();
        assert_eq!((git.micros, git.pending_micros), (40_000, 40_000));
        assert_eq!(totals.price_micros, 3_500_000 + 120_000 + 30_000 + 40_000);
        assert_eq!(totals.pending_micros, 40_000);
        assert_eq!(totals.included_micros, 1_000_000);
        assert_eq!(by_day.iter().filter(|d| d.product == "agent").map(|d| d.micros).sum::<i64>(), 3_500_000);
        assert_eq!(projects, ["acme/api", "acme/web"]);
    }

    #[test]
    fn filters_keep_only_the_products_and_projects_asked_for() {
        let days = days_between("2026-10-01", "2026-10-01").unwrap();
        let cells = vec![cell("2026-10-01", "agent_models", "acme/web", 100.0), cell("2026-10-01", "agent_models", "acme/api", 50.0), cell("2026-10-01", "sandbox", "acme/web", 10.0)];
        let pending = vec![Pending { meter: "git", micros: 7, ..Pending::default() }];
        let (products, _, totals, projects) = shape(&days, &cells, &[], &pending, &["agent".into()], &["acme/web".into()]);
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
        let (_, _, totals, _) = shape(&days, &[], &[], &pending, &[], &[]);
        assert_eq!(totals.price_micros, 11_400);
        assert_eq!(totals.pending_micros, 11_400);
        assert_eq!(totals.included_micros, 2_400);
        assert_eq!(totals.discount_micros, 9_000);
        assert_eq!(charged(&totals), 0);
        // With a project chosen, pending usage (no project's) is left out.
        let (_, _, filtered, _) = shape(&days, &[], &[], &pending, &[], &["acme/api".to_owned()]);
        assert_eq!(filtered.pending_micros, 0);
    }

    fn attributed(agent: &str, person: &str, price: f64, entries: f64) -> Attributed {
        Attributed { agent: agent.into(), person: person.into(), price: Some(price), entries: Some(entries) }
    }

    #[test]
    fn the_agent_product_is_attributed_to_agents_and_to_who_asked() {
        let rows = [
            attributed("g1t", "chase", 2_000_000.0, 3.0),
            attributed("mike", "chase", 20_000.0, 2.0),
            attributed("mike", "", 5_000.0, 1.0),
            attributed("", "", 500_000.0, 4.0),
        ];
        let (agents, people) = attribution(&rows);
        assert_eq!(agents.iter().map(|s| (s.key.as_str(), s.micros, s.count)).collect::<Vec<_>>(), [("g1t", 2_000_000, 3), ("", 500_000, 4), ("mike", 25_000, 3)]);
        assert_eq!(agents[0].label, "@g1t");
        assert_eq!(agents[1].label, "Not attributed to an agent");
        assert_eq!(people.iter().map(|s| (s.key.as_str(), s.micros)).collect::<Vec<_>>(), [("chase", 2_020_000), ("", 505_000)]);
        assert_eq!(people[1].label, "No one asked");
        // Both views are the same money.
        let total: i64 = rows.iter().map(|r| r.price.unwrap() as i64).sum();
        assert_eq!(agents.iter().map(|s| s.micros).sum::<i64>(), total);
        assert_eq!(people.iter().map(|s| s.micros).sum::<i64>(), total);
    }

    /// The figures every page shows come from one ledger: Home's and
    /// Spend's "Spent" are the products' sum at price, the top bar's and
    /// Spend's "Agents" are the agent product, agents by handle sum to it,
    /// and a full discount is charged nothing.
    #[test]
    fn home_spend_and_the_top_bar_reconcile_on_the_ledger() {
        let days = days_between("2026-10-01", "2026-10-10").unwrap();
        // The same lines, grouped two ways: by day, meter and project for
        // the products; by agent and asker for the attribution.
        let lines: [(&str, &str, &str, &str, &str, f64); 7] = [
            ("2026-10-02", "agent_models", "flagon-io/g1t", "g1t", "chase", 1_900_000.0),
            ("2026-10-02", "agent_rate", "flagon-io/g1t", "g1t", "chase", 400_000.0),
            ("2026-10-03", "agent_sandbox", "flagon-io/g1t", "g1t", "chase", 220_000.0),
            ("2026-10-04", "agent_models", "flagon-io/@mike", "mike", "chase", 20_000.0),
            ("2026-10-05", "agent_models", "flagon-io/@margo", "margo", "", 4_000.0),
            ("2026-10-03", "sandbox", "flagon-io/g1t", "", "", 3_360_000.0),
            ("2026-10-06", "requests", "flagon-io/site", "", "", 4_480_000.0),
        ];
        let cells: Vec<Cell> = lines
            .iter()
            .map(|(day, meter, project, _, _, price)| Cell { discount: Some(*price), ..cell(day, meter, project, *price) })
            .collect();
        let rows: Vec<Attributed> = lines
            .iter()
            .filter(|(_, meter, ..)| meter.starts_with("agent"))
            .map(|(_, _, _, agent, person, price)| attributed(agent, person, *price, 1.0))
            .collect();
        let (products, by_day, totals, _) = shape(&days, &cells, &[], &[], &[], &[]);
        let (agents, people) = attribution(&rows);
        // Spent, on Home and Spend: every product at price.
        let spent: i64 = lines.iter().map(|l| l.5 as i64).sum();
        assert_eq!(totals.price_micros, spent);
        assert_eq!(products.iter().map(|p| p.micros).sum::<i64>(), spent);
        assert_eq!(by_day.iter().map(|d| d.micros).sum::<i64>(), spent);
        // Agents, in the top bar and on Spend: the agent product, which is
        // what the agents by handle add up to, g1t's own runs included.
        let agent_product = products.iter().find(|p| p.key == "agent").unwrap().micros;
        assert_eq!(agent_product, 1_900_000 + 400_000 + 220_000 + 20_000 + 4_000);
        assert_eq!(agents.iter().map(|s| s.micros).sum::<i64>(), agent_product);
        assert_eq!(people.iter().map(|s| s.micros).sum::<i64>(), agent_product);
        assert!(agents.iter().all(|s| s.micros <= agent_product));
        assert_eq!(agents[0].key, "g1t");
        // Charged, on Billing, Spend and in the top bar: nothing, on a 100% discount.
        assert_eq!(totals.discount_micros, spent);
        assert_eq!(charged(&totals), 0);
    }

    #[test]
    fn the_agent_is_counted_by_what_it_was_doing() {
        assert_eq!(feature_of("review").0, "reviews");
        assert_eq!(feature_of("plan").0, "plans");
        assert_eq!(feature_of("implement").0, "runs");
        assert_eq!(meter_of_pending("package_storage"), "packages");
        assert_eq!(meter_of_pending("nonsense"), "other");
    }
}
