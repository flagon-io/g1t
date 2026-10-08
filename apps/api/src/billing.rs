//! Billing: a workspace's usage, budget, AI credit and invoices. The
//! billing service keeps them and answers in camelCase; this is their
//! public shape, in snake_case, with money as whole millionths of a dollar
//! (`_micros`) or, for invoices, cents (`_cents`).
//!
//! Reading is for the workspace's members, a workspace's own token
//! included. Changing the budget and buying AI credit are for its owners,
//! as people: signed in or with a personal access token. A workspace's
//! token and g1t's agents never change billing, whatever their scopes say.

use std::collections::BTreeMap;

use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User, Viewer};
use serde_json::{Map, Value, json};
use worker::Result;

use crate::operations::{Op, Services};

/// The product families usage is grouped into, in order.
pub(crate) const PRODUCTS: [&str; 8] =
    ["agent", "sandboxes", "gateway", "deployments", "git_storage", "packages", "security", "search"];

/// Where a budget's alerts can be, in percent of its limit.
pub(crate) const ALERT_LEVELS: [u32; 4] = [50, 75, 90, 100];

/// How usage can be added up over its range.
pub(crate) const GROUPS: [&str; 3] = ["product", "project", "day"];

fn failed(code: FailureCode, message: &str) -> Result<Outcome<Value>> {
    Ok(Outcome::fail(code, message))
}

/// `camelCase` as `snake_case`.
fn snake_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            if !out.is_empty() {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// A service's answer with every object key in `snake_case`, all the way
/// down. Billing's answers have no keys that are data, so all of them are
/// names.
pub(crate) fn snake(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            Value::Object(fields.iter().map(|(key, value)| (snake_key(key), snake(value))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(snake).collect()),
        other => other.clone(),
    }
}

/// Strings given as an array, or as one string separated by commas (a
/// query string's way).
fn list(input: &Value, key: &str) -> Vec<String> {
    let items: Vec<String> = match &input[key] {
        Value::Array(items) => items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
        Value::String(text) => text.split(',').map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    items.into_iter().map(|item| item.trim().to_owned()).filter(|item| !item.is_empty()).collect()
}

fn workspace(input: &Value) -> Option<String> {
    input["workspace"].as_str().map(str::trim).filter(|slug| !slug.is_empty()).map(str::to_lowercase)
}

/// `YYYY-MM-DD`.
fn is_day(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(at, byte)| if at == 4 || at == 7 { *byte == b'-' } else { byte.is_ascii_digit() })
}

/// The UTC day `days` after 1970-01-01, as `(year, month, day)`.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The first day of the current UTC month, and today, at `now_ms`.
pub(crate) fn this_month(now_ms: f64) -> (String, String) {
    let (year, month, day) = civil((now_ms / 86_400_000.0).floor() as i64);
    (format!("{year:04}-{month:02}-01"), format!("{year:04}-{month:02}-{day:02}"))
}

/// The person who may change a workspace's billing: a person, never a
/// workspace's own token or one of g1t's agents. `agent_scoped` is whether
/// the request came with an agent's token.
pub(crate) fn person(viewer: &Viewer, agent_scoped: bool) -> std::result::Result<&User, (FailureCode, &'static str)> {
    match viewer {
        None => Err((FailureCode::Unauthenticated, "This needs a g1t access token.")),
        Some(user) if agent_scoped || user.kind == PrincipalKind::Agent => Err((
            FailureCode::Forbidden,
            "g1t's agents never change billing: a workspace's budget and AI credit are for its owners.",
        )),
        Some(user) if user.kind != PrincipalKind::User => Err((
            FailureCode::Forbidden,
            "Changing billing needs a person: sign in, or use a personal access token. A workspace's own token can read billing, not change it.",
        )),
        Some(user) => Ok(user),
    }
}

/// A usage report (camelCase, as billing answers) in its public shape,
/// with `groups` when `group_by` asks for them.
pub(crate) fn usage_json(report: &Value, group_by: Option<&str>) -> Value {
    let mut out = snake(report);
    if let (Some(by), Some(fields)) = (group_by, out.as_object_mut()) {
        fields.insert("group_by".to_owned(), json!(by));
        fields.insert("groups".to_owned(), groups(report, by));
    }
    out
}

fn micros(value: &Value) -> i64 {
    value.as_i64().or_else(|| value.as_f64().map(|n| n as i64)).unwrap_or(0)
}

/// The report's range added up by product (every family, in order), by
/// project (most first; `key` null for usage that is no one project's) or
/// by day (oldest first).
fn groups(report: &Value, by: &str) -> Value {
    let products = report["products"].as_array().cloned().unwrap_or_default();
    match by {
        "product" => Value::Array(
            products
                .iter()
                .map(|product| json!({ "key": product["key"], "label": product["label"], "micros": micros(&product["micros"]) }))
                .collect(),
        ),
        "project" => {
            let mut sums: BTreeMap<String, i64> = BTreeMap::new();
            for product in &products {
                for meter in product["meters"].as_array().into_iter().flatten() {
                    for part in meter["byProject"].as_array().into_iter().flatten() {
                        *sums.entry(part["project"].as_str().unwrap_or_default().to_owned()).or_default() += micros(&part["micros"]);
                    }
                }
            }
            let mut sums: Vec<(String, i64)> = sums.into_iter().collect();
            sums.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            Value::Array(
                sums.into_iter()
                    .map(|(project, micros)| {
                        let key = if project.is_empty() { Value::Null } else { Value::String(project) };
                        json!({ "key": key, "micros": micros })
                    })
                    .collect(),
            )
        }
        _ => {
            let mut sums: BTreeMap<String, i64> = BTreeMap::new();
            for day in report["days"].as_array().into_iter().flatten() {
                *sums.entry(day["day"].as_str().unwrap_or_default().to_owned()).or_default() += micros(&day["micros"]);
            }
            Value::Array(sums.into_iter().map(|(day, micros)| json!({ "key": day, "micros": micros })).collect())
        }
    }
}

/// A workspace's limit (camelCase, as billing answers) as its budget.
pub(crate) fn budget_json(limit: &Value) -> Value {
    json!({
        "workspace": limit["workspace"],
        "amount_micros": limit["spendLimitMicros"],
        "automatic": limit["defaultSpendLimit"].as_bool().unwrap_or(false),
        "spent_micros": micros(&limit["spentMicros"]),
        "max_amount_micros": limit["availableMicros"],
        "alerts": limit["alertLevels"].as_array().cloned().unwrap_or_default(),
        "pause_at_limit": limit["pauseAtLimit"].as_bool().unwrap_or(true),
        "webhook": limit["budgetWebhook"],
        "state": limit["state"],
        "message": limit["message"],
    })
}

/// What set_budget asks billing for: the fields given, and the rest as
/// they are in `current` (the workspace's limit, camelCase).
#[derive(Debug, PartialEq)]
pub(crate) struct BudgetChange {
    /// No amount was given: billing leaves the limit as it is, whatever
    /// it is by the time it is asked.
    pub keep_limit: bool,
    pub amount_micros: Option<i64>,
    pub alerts: Vec<u32>,
    pub pause_at_limit: bool,
    pub webhook: Option<String>,
}

pub(crate) fn budget_change(input: &Value, current: &Value) -> std::result::Result<BudgetChange, String> {
    let amount_micros = match input.get("amount_micros") {
        None if current["defaultSpendLimit"].as_bool() == Some(true) => None,
        None => current["spendLimitMicros"].as_i64(),
        Some(Value::Null) => None,
        Some(value) => {
            let amount = value.as_i64().or_else(|| value.as_str().and_then(|digits| digits.trim().parse().ok()));
            match amount {
                Some(amount) if amount >= 0 => Some(amount),
                _ => return Err("amount_micros is a whole number of millionths of a dollar, or null for the automatic limit.".to_owned()),
            }
        }
    };
    let alerts = match input.get("alerts") {
        None | Some(Value::Null) => current["alertLevels"]
            .as_array()
            .map(|levels| levels.iter().filter_map(|level| level.as_u64()).filter_map(|level| u32::try_from(level).ok()).collect())
            .unwrap_or_default(),
        Some(Value::Array(levels)) => {
            let mut chosen = Vec::new();
            for level in levels {
                let level = level.as_u64().or_else(|| level.as_str().and_then(|digits| digits.trim().parse().ok()));
                match level.and_then(|level| u32::try_from(level).ok()).filter(|level| ALERT_LEVELS.contains(level)) {
                    Some(level) if !chosen.contains(&level) => chosen.push(level),
                    Some(_) => {}
                    None => return Err("alerts are some of 50, 75, 90 and 100.".to_owned()),
                }
            }
            chosen.sort_unstable();
            chosen
        }
        Some(_) => return Err("alerts is a list: some of 50, 75, 90 and 100.".to_owned()),
    };
    let pause_at_limit = match input.get("pause_at_limit") {
        None | Some(Value::Null) => current["pauseAtLimit"].as_bool().unwrap_or(true),
        Some(Value::Bool(pause)) => *pause,
        Some(Value::String(word)) if word == "true" || word == "false" => word == "true",
        Some(_) => return Err("pause_at_limit is true or false.".to_owned()),
    };
    let webhook = match input.get("webhook") {
        None => current["budgetWebhook"].as_str().map(str::to_owned),
        Some(Value::Null) => None,
        Some(Value::String(url)) if url.trim().is_empty() => None,
        Some(Value::String(url)) if url.trim().starts_with("https://") => Some(url.trim().to_owned()),
        Some(_) => return Err("webhook is an https:// address, or null for none.".to_owned()),
    };
    Ok(BudgetChange { keep_limit: input.get("amount_micros").is_none(), amount_micros, alerts, pause_at_limit, webhook })
}

/// Billing details without the invoices, which list_invoices gives.
pub(crate) fn details_json(details: &Value) -> Value {
    let mut out = snake(details);
    if let Some(fields) = out.as_object_mut() {
        fields.remove("invoices");
        fields.remove("upcoming");
        fields.remove("unavailable");
    }
    out
}

/// Every invoice billed to the workspace, g1t's itemised usage invoices,
/// and what the next one comes to so far.
pub(crate) fn invoices_json(details: &Value, usage: &[Value]) -> Value {
    let usage: Vec<Value> = usage
        .iter()
        .map(|invoice| {
            let mut fields = Map::new();
            fields.insert("id".to_owned(), invoice["invoiceId"].clone());
            if let Value::Object(rest) = snake(invoice) {
                fields.extend(rest.into_iter().filter(|(key, _)| key != "invoice_id"));
            }
            Value::Object(fields)
        })
        .collect();
    json!({
        "invoices": snake(&details["invoices"]).as_array().cloned().unwrap_or_default(),
        "usage_invoices": usage,
        "upcoming": snake(&details["upcoming"]),
        "unavailable": details["unavailable"],
    })
}

/// Runs one of the billing operations.
pub async fn run(op: Op, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    if viewer.is_none() {
        return failed(FailureCode::Unauthenticated, "This needs a g1t access token.");
    }
    let Some(workspace) = workspace(input) else {
        return failed(FailureCode::Invalid, "Give the workspace's slug.");
    };
    let billing = &services.billing;
    let shaped = |outcome: Outcome<Value>, shape: &dyn Fn(&Value) -> Value| -> Result<Outcome<Value>> {
        Ok(match outcome {
            Outcome::Ok(value) => Outcome::Ok(shape(&value)),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    };
    let account = json!({ "workspace": workspace, "viewer": viewer });
    match op {
        Op::GetUsage => {
            let group_by = input["group_by"].as_str().map(str::trim).filter(|by| !by.is_empty()).map(str::to_lowercase);
            if let Some(by) = &group_by
                && !GROUPS.contains(&by.as_str())
            {
                return failed(FailureCode::Invalid, "group_by is product, project or day.");
            }
            let products = list(input, "products");
            if let Some(unknown) = products.iter().find(|product| !PRODUCTS.contains(&product.as_str())) {
                return failed(
                    FailureCode::Invalid,
                    &format!("{unknown} is not a product. Give some of {}.", PRODUCTS.join(", ")),
                );
            }
            let (month_start, today) = this_month(worker::Date::now().as_millis() as f64);
            let day = |key: &str, default: String| -> std::result::Result<String, String> {
                match input[key].as_str().map(str::trim).filter(|day| !day.is_empty()) {
                    None => Ok(default),
                    Some(day) if is_day(day) => Ok(day.to_owned()),
                    Some(day) => Err(format!("{key} is a day, YYYY-MM-DD, not {day}.")),
                }
            };
            let (from, until) = match (day("from", month_start), day("until", today)) {
                (Ok(from), Ok(until)) => (from, until),
                (Err(message), _) | (_, Err(message)) => return failed(FailureCode::Invalid, &message),
            };
            let report: Outcome<Value> = g1t_kit::call(
                billing,
                "usage_report",
                &json!({
                    "workspace": workspace,
                    "viewer": viewer,
                    "from": from,
                    "until": until,
                    "products": products,
                    "projects": list(input, "projects"),
                }),
            )
            .await?;
            shaped(report, &|report| usage_json(report, group_by.as_deref()))
        }
        Op::GetBudget => shaped(g1t_kit::call(billing, "limit", &account).await?, &budget_json),
        Op::SetBudget => {
            let actor = match person(viewer, services.scope.is_some()) {
                Ok(user) => user,
                Err((code, message)) => return failed(code, message),
            };
            let current: Outcome<Value> = g1t_kit::call(billing, "limit", &account).await?;
            let current = match current {
                Outcome::Ok(limit) => limit,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            let change = match budget_change(input, &current) {
                Ok(change) => change,
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            let set: Outcome<Value> = g1t_kit::call(
                billing,
                "set_budget",
                &json!({
                    "actor": actor,
                    "workspace": workspace,
                    "keepLimit": change.keep_limit,
                    "amountMicros": change.amount_micros,
                    "alerts": change.alerts,
                    "pauseAtLimit": change.pause_at_limit,
                    "webhook": change.webhook,
                }),
            )
            .await?;
            shaped(set, &budget_json)
        }
        Op::GetAiCredit => shaped(g1t_kit::call(billing, "ai_credit", &account).await?, &snake),
        Op::BuyAiCredit => {
            let actor = match person(viewer, services.scope.is_some()) {
                Ok(user) => user,
                Err((code, message)) => return failed(code, message),
            };
            let cents = match &input["amount_cents"] {
                Value::Number(number) => number.as_u64(),
                Value::String(digits) => digits.trim().parse().ok(),
                _ => None,
            };
            let Some(cents) = cents.and_then(|cents| u32::try_from(cents).ok()).filter(|cents| *cents > 0) else {
                return failed(FailureCode::Invalid, "Give amount_cents: the credit in cents, in whole dollars, such as 5000 for $50.");
            };
            let return_url = format!("{}/{workspace}/-/billing", services.addresses.site.trim_end_matches('/'));
            let checkout: Outcome<Value> = g1t_kit::call(
                billing,
                "buy_ai_credit",
                &json!({ "actor": actor, "workspace": workspace, "amountCents": cents, "returnUrl": return_url }),
            )
            .await?;
            shaped(checkout, &|checkout| json!({ "url": checkout["url"] }))
        }
        Op::ListInvoices => {
            let details: Outcome<Value> = g1t_kit::call(billing, "billing_details", &account).await?;
            let details = match details {
                Outcome::Ok(details) => details,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            let usage: Outcome<Vec<Value>> = g1t_kit::call(billing, "invoices", &account).await?;
            Ok(match usage {
                Outcome::Ok(usage) => Outcome::Ok(invoices_json(&details, &usage)),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            })
        }
        Op::GetBillingDetails => shaped(g1t_kit::call(billing, "billing_details", &account).await?, &details_json),
        Op::ListGatewayRequests => {
            let limit = match &input["limit"] {
                Value::Null => None,
                Value::Number(number) => number.as_u64(),
                Value::String(digits) => digits.trim().parse().ok(),
                _ => Some(0),
            };
            if limit.is_some_and(|limit| !(1..=200).contains(&limit)) {
                return failed(FailureCode::Invalid, "limit is a number from 1 to 200.");
            }
            let before = input["before"].as_str().map(str::trim).filter(|id| !id.is_empty());
            let page: Outcome<Value> = g1t_kit::call(
                billing,
                "gateway_requests",
                &json!({ "workspace": workspace, "viewer": viewer, "limit": limit, "before": before }),
            )
            .await?;
            shaped(page, &snake)
        }
        _ => failed(FailureCode::Invalid, "Not a billing operation."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_usage_report_is_snake_case_all_the_way_down() {
        let report = json!({
            "from": "2026-10-01", "until": "2026-10-07",
            "totals": { "priceMicros": 12_500_000, "discountMicros": 0, "includedMicros": 2_000_000, "creditsMicros": 500_000,
                        "chargedMicros": 10_000_000, "pendingMicros": 300_000, "costMicros": 9_000_000 },
            "days": [
                { "day": "2026-10-02", "product": "agent", "micros": 4_000_000 },
                { "day": "2026-10-02", "product": "sandboxes", "micros": 500_000 },
                { "day": "2026-10-01", "product": "agent", "micros": 8_000_000 },
            ],
            "products": [
                { "key": "agent", "label": "Agent", "micros": 12_000_000, "features": [{ "key": "runs", "label": "Runs", "micros": 12_000_000, "count": 3 }],
                  "meters": [{ "key": "agent_models", "label": "Models", "product": "agent", "unit": "tokens", "quantity": 1.5e6,
                               "micros": 12_000_000, "pendingMicros": 0, "daily": [8_000_000, 4_000_000], "allowance": null,
                               "byProject": [{ "project": "acme/web", "micros": 9_000_000, "quantity": 1e6 },
                                             { "project": "", "micros": 3_000_000, "quantity": 5e5 }] }] },
                { "key": "sandboxes", "label": "Sandboxes", "micros": 500_000, "features": [],
                  "meters": [{ "key": "sandbox", "label": "Sandbox time", "product": "sandboxes", "unit": "seconds", "quantity": 600.0,
                               "micros": 500_000, "pendingMicros": 0, "daily": [0, 500_000],
                               "allowance": { "used": 600.0, "of": 3600.0, "unit": "seconds" },
                               "byProject": [{ "project": "acme/web", "micros": 500_000, "quantity": 600.0 }] }] },
            ],
            "projects": ["acme/web"], "included": null, "discountPercent": null,
            "aiCreditMicros": 40_000_000, "creditMicros": 0, "trialMicros": null, "plan": "pro", "free": false,
        });
        let usage = usage_json(&report, None);
        assert_eq!(usage["totals"]["charged_micros"], 10_000_000);
        assert_eq!(usage["products"][0]["meters"][0]["by_project"][0]["project"], "acme/web");
        assert_eq!(usage["products"][0]["meters"][0]["pending_micros"], 0);
        assert_eq!(usage["ai_credit_micros"], 40_000_000);
        assert!(usage.get("groups").is_none());
        let text = usage.to_string();
        for camel in ["Micros", "byProject", "discountPercent"] {
            assert!(!text.contains(camel), "{camel} in {text}");
        }

        let by_project = usage_json(&report, Some("project"));
        assert_eq!(by_project["group_by"], "project");
        assert_eq!(
            by_project["groups"],
            json!([{ "key": "acme/web", "micros": 9_500_000 }, { "key": null, "micros": 3_000_000 }])
        );
        let by_day = usage_json(&report, Some("day"));
        assert_eq!(by_day["groups"], json!([{ "key": "2026-10-01", "micros": 8_000_000 }, { "key": "2026-10-02", "micros": 4_500_000 }]));
        let by_product = usage_json(&report, Some("product"));
        assert_eq!(by_product["groups"][1], json!({ "key": "sandboxes", "label": "Sandboxes", "micros": 500_000 }));
    }

    #[test]
    fn ai_credit_is_snake_case() {
        let credit = json!({
            "balanceMicros": 42_000_000, "purchasedMicros": 40_000_000, "givenMicros": 2_000_000,
            "grants": [{ "id": "crd_1", "kind": "purchase", "amountMicros": 40_000_000, "usedMicros": 0, "leftMicros": 40_000_000, "expiresAt": null }],
            "freeViaDiscount": false, "postpaid": false, "blocked": false, "canBuy": true,
            "presetsCents": [2500, 5000], "minCents": 1000, "maxCents": 100_000,
            "cardFee": { "on": true, "percentMicros": 29_000.0, "fixedCents": 30 },
            "reload": { "enabled": false, "thresholdMicros": 0, "targetMicros": 0, "monthlyMaxMicros": 0, "reloadedMicros": 0, "failedAt": null, "error": null },
            "agentRateMicros": 3.6, "modelMarkupPercent": 10, "gatewayMarkupPercent": 5, "upgradeCreditMicros": 0, "expiresDays": 365,
        });
        let out = snake(&credit);
        assert_eq!(out["balance_micros"], 42_000_000);
        assert_eq!(out["grants"][0]["left_micros"], 40_000_000);
        assert_eq!(out["card_fee"]["fixed_cents"], 30);
        assert_eq!(out["reload"]["monthly_max_micros"], 0);
        assert_eq!(out["can_buy"], true);
        assert!(out.get("balanceMicros").is_none());
        assert_eq!(snake_key("line1"), "line1");
        assert_eq!(snake_key("last4"), "last4");
        assert_eq!(snake_key("taxIdType"), "tax_id_type");
    }

    #[test]
    fn agents_and_workspace_tokens_never_change_billing() {
        let person_user = User { username: "ana".into(), ..User::default() };
        assert!(person(&Some(person_user.clone()), false).is_ok());
        // A person's token used by an agent's run is still an agent's.
        assert_eq!(person(&Some(person_user), true).unwrap_err().0, FailureCode::Forbidden);
        let agent = User { username: "g1t".into(), kind: PrincipalKind::Agent, ..User::default() };
        let (code, message) = person(&Some(agent), false).unwrap_err();
        assert_eq!(code, FailureCode::Forbidden);
        assert!(message.contains("agents never change billing"));
        let workspace = User { username: "acme".into(), kind: PrincipalKind::Workspace, ..User::default() };
        let (code, message) = person(&Some(workspace), false).unwrap_err();
        assert_eq!(code, FailureCode::Forbidden);
        assert!(message.contains("personal access token"));
        assert_eq!(person(&None, false).unwrap_err().0, FailureCode::Unauthenticated);
    }

    #[test]
    fn a_budget_change_keeps_what_was_not_given() {
        let current = json!({
            "workspace": "acme", "spendLimitMicros": 300_000_000, "defaultSpendLimit": false, "spentMicros": 12_000_000,
            "availableMicros": 1_000_000_000, "alertLevels": [100, 75, 50], "pauseAtLimit": true,
            "budgetWebhook": "https://acme.dev/hooks/budget", "state": "ok", "message": null,
        });
        let kept = budget_change(&json!({}), &current).unwrap();
        assert_eq!(
            kept,
            BudgetChange { keep_limit: true, amount_micros: Some(300_000_000), alerts: vec![100, 75, 50], pause_at_limit: true, webhook: Some("https://acme.dev/hooks/budget".into()) }
        );
        let changed = budget_change(&json!({ "amount_micros": null, "alerts": [90, 50, 90], "pause_at_limit": false, "webhook": null }), &current).unwrap();
        assert_eq!(changed, BudgetChange { keep_limit: false, amount_micros: None, alerts: vec![50, 90], pause_at_limit: false, webhook: None });
        for bad in [json!({ "alerts": [60] }), json!({ "alerts": "50" }), json!({ "amount_micros": -1 }), json!({ "webhook": "http://x" }), json!({ "pause_at_limit": "yes" })] {
            assert!(budget_change(&bad, &current).is_err(), "{bad}");
        }
        // The automatic limit stays automatic when no amount is given.
        let automatic = json!({ "spendLimitMicros": 200_000_000, "defaultSpendLimit": true });
        assert_eq!(budget_change(&json!({}), &automatic).unwrap().amount_micros, None);
        let budget = budget_json(&current);
        assert_eq!(budget["amount_micros"], 300_000_000);
        assert_eq!(budget["max_amount_micros"], 1_000_000_000);
        assert_eq!(budget["alerts"], json!([100, 75, 50]));
        assert_eq!(budget["automatic"], false);
    }

    #[test]
    fn invoices_put_every_invoice_beside_the_itemised_usage_ones() {
        let details = json!({
            "customer": true, "email": "billing@acme.dev",
            "invoices": [{ "id": "in_1", "number": "ACME-0001", "status": "paid", "totalCents": 2000, "currency": "usd",
                           "createdAt": "2026-10-01T00:00:00Z", "description": null, "hostedUrl": null, "pdfUrl": null }],
            "upcoming": { "closesAt": "2026-11-01T00:00:00Z", "subscriptionsMicros": 20_000_000, "usageMicros": 5_000_000, "totalMicros": 25_000_000 },
            "unavailable": null,
        });
        let usage = [json!({ "invoiceId": "inv_1", "workspace": "acme", "reason": "month", "period": "2026-09", "amountMicros": 5_000_000,
                             "status": "paid", "hostedUrl": null, "pdfUrl": null, "lines": [{ "description": "Agent", "amountMicros": 5_000_000 }],
                             "createdAt": "2026-10-01T00:00:00Z" })];
        let out = invoices_json(&details, &usage);
        assert_eq!(out["invoices"][0]["total_cents"], 2000);
        assert_eq!(out["usage_invoices"][0]["id"], "inv_1");
        assert!(out["usage_invoices"][0].get("invoice_id").is_none());
        assert_eq!(out["usage_invoices"][0]["lines"][0]["amount_micros"], 5_000_000);
        assert_eq!(out["upcoming"]["total_micros"], 25_000_000);
        let shown = details_json(&details);
        assert_eq!(shown["email"], "billing@acme.dev");
        assert!(shown.get("invoices").is_none() && shown.get("upcoming").is_none());
    }

    const OPS: [Op; 8] = [
        Op::GetUsage,
        Op::GetBudget,
        Op::SetBudget,
        Op::GetAiCredit,
        Op::BuyAiCredit,
        Op::ListInvoices,
        Op::GetBillingDetails,
        Op::ListGatewayRequests,
    ];

    /// Billing belongs to a workspace, needs someone signed in, and is one
    /// MCP tool whose writes no preset but full access reaches.
    #[test]
    fn billing_operations_name_a_workspace_and_agents_only_read() {
        use crate::tools::{Gate, Tool};
        use g1t_contracts::scopes::{Preset, TokenAccess, scope_for};
        for op in OPS {
            assert!(!op.needs_repo(), "{}", op.name());
            assert!(op.needs_user(), "{}", op.name());
            assert!(op.required().contains(&"workspace".to_owned()), "{}", op.name());
            assert!(scope_for(op.name()).is_some(), "{}", op.name());
        }
        let tool = Tool::by_name("billing").unwrap();
        let token = |preset: Preset| TokenAccess {
            token_id: "tok_1".into(),
            scopes: preset.scopes().map(|scopes| scopes.iter().map(|scope| scope.as_str().to_owned()).collect()),
            legacy: false,
            name: None,
        };
        for preset in [Preset::ReadOnly, Preset::Agent] {
            let access = token(preset);
            let seen: Vec<&str> = tool.visible(&Gate::Token(&access)).iter().map(|action| action.name).collect();
            assert_eq!(seen, ["usage", "budget", "ai_credit", "invoices", "billing_details", "gateway_requests"], "{}", preset.as_str());
        }
        // The AI Gateway's log needs models:read, and nothing of billing's.
        let models = TokenAccess { scopes: Some(vec!["models:read".into()]), ..token(Preset::Ci) };
        let seen: Vec<&str> = tool.visible(&Gate::Token(&models)).iter().map(|action| action.name).collect();
        assert_eq!(seen, ["gateway_requests"]);
        let full = TokenAccess::full();
        assert_eq!(tool.visible(&Gate::Token(&full)).len(), OPS.len());
    }

    #[test]
    fn the_month_so_far_is_read_from_the_clock() {
        // 2026-10-07T12:00:00Z.
        assert_eq!(this_month(1_791_374_400_000.0), ("2026-10-01".to_owned(), "2026-10-07".to_owned()));
        assert_eq!(this_month(0.0), ("1970-01-01".to_owned(), "1970-01-01".to_owned()));
        // 2024-02-29.
        assert_eq!(this_month(1_709_208_000_000.0), ("2024-02-01".to_owned(), "2024-02-29".to_owned()));
        assert!(is_day("2026-10-07") && !is_day("2026-10-7") && !is_day("20261007xx"));
        assert_eq!(list(&json!({ "products": "agent, sandboxes,," }), "products"), vec!["agent", "sandboxes"]);
        assert_eq!(list(&json!({ "products": ["agent"] }), "products"), vec!["agent"]);
    }
}
