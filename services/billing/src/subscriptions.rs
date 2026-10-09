//! Cloudflare's subscriptions: what g1t pays each month whatever it uses
//! (Workers Paid, add-ons), read from Cloudflare each day.
//!
//! They are not on the billable-usage bill, so the costs statement and
//! g1t's own spend add them as a fixed cost. Read with the bill's token
//! (`CLOUDFLARE_BILLING_TOKEN`, Account: Billing Read) and kept in
//! `cf_subscriptions`; until a read has worked, `CLOUDFLARE_FIXED_MONTHLY_MICROS`
//! stands in as an estimate.
//!
//! The same read says when the billing cycle starts (`current_period_start`):
//! the day of the month every cycle starts on (`cycle`), which is when the
//! usage bill's included amounts start again. Until it is read,
//! `CLOUDFLARE_BILLING_DAY` says.

use g1t_contracts::billing::FixedCost;
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::Result;

use crate::Billing;

/// The states of a subscription that is paid for (or will be).
const PAID: [&str; 4] = ["Paid", "Provisioned", "AwaitingPayment", "Trial"];

/// Each subscription that costs money, at what it comes to a month.
pub(crate) fn monthly(body: &Value) -> Vec<FixedCost> {
    let mut out = Vec::new();
    for s in body["result"].as_array().into_iter().flatten() {
        let state = s["state"].as_str().unwrap_or("Paid");
        if !PAID.contains(&state) {
            continue;
        }
        let price = s["price"].as_f64().unwrap_or(0.0);
        let months = match s["frequency"].as_str().unwrap_or("monthly") {
            "weekly" => 12.0 / 52.0,
            "quarterly" => 3.0,
            "yearly" => 12.0,
            _ => 1.0,
        };
        let monthly_micros = (price / months * 1_000_000.0).round() as i64;
        if monthly_micros <= 0 {
            continue;
        }
        let name = s["rate_plan"]["public_name"]
            .as_str()
            .or_else(|| s["product"]["name"].as_str())
            .or_else(|| s["rate_plan"]["id"].as_str())
            .unwrap_or("Subscription")
            .to_owned();
        out.push(FixedCost { name, monthly_micros });
    }
    out
}

/// When the current billing cycle started, from the first paid monthly
/// subscription that says (`current_period_start`), as YYYY-MM-DD.
pub(crate) fn period_start(body: &Value) -> Option<String> {
    body["result"]
        .as_array()?
        .iter()
        .filter(|s| PAID.contains(&s["state"].as_str().unwrap_or("Paid")))
        .filter(|s| s["frequency"].as_str().unwrap_or("monthly") == "monthly")
        .find_map(|s| s["current_period_start"].as_str().filter(|d| crate::cycle::anchor_of(d).is_some()))
        .map(|d| d[..10].to_owned())
}

/// What the fixed cost is, and where the figure came from.
pub(crate) struct Fixed {
    pub monthly_micros: i64,
    /// `cloudflare` (read from Cloudflare) or `estimate` (the variable).
    pub source: &'static str,
    pub read_at: Option<String>,
    pub items: Vec<FixedCost>,
}

impl Billing {
    /// Reads the subscriptions and keeps them; an error is returned for the
    /// run to log, and the last read (or the estimate) stays.
    pub(crate) async fn read_subscriptions(&self, keeper: &crate::keeper::Keeper) -> Result<usize> {
        let body = keeper.subscriptions_body().await?;
        let items = monthly(&body);
        let total: i64 = items.iter().map(|i| i.monthly_micros).sum();
        let cycle_start = period_start(&body);
        self.db
            .prepare(
                "INSERT INTO cf_subscriptions (id, monthly_micros, detail, read_at, cycle_start) VALUES ('current', ?1, ?2, ?3, ?4)
                 ON CONFLICT (id) DO UPDATE SET monthly_micros = excluded.monthly_micros, detail = excluded.detail, read_at = excluded.read_at,
                   cycle_start = COALESCE(excluded.cycle_start, cf_subscriptions.cycle_start)",
            )
            .bind(&[
                (total as f64).into(),
                serde_json::to_string(&items)?.into(),
                rfc3339(now_ms()).into(),
                cycle_start.map_or(worker::wasm_bindgen::JsValue::NULL, |d| d.into()),
            ])?
            .run()
            .await?;
        Ok(items.len())
    }

    /// The day of the month Cloudflare's billing cycle starts on: from the
    /// subscriptions as last read, else `CLOUDFLARE_BILLING_DAY`, else the 1st.
    pub(crate) async fn cycle_anchor(&self) -> Result<u32> {
        #[derive(Deserialize)]
        struct Row {
            cycle_start: Option<String>,
        }
        let read = self
            .db
            .prepare("SELECT cycle_start FROM cf_subscriptions WHERE id = 'current'")
            .first::<Row>(None)
            .await?
            .and_then(|r| r.cycle_start)
            .and_then(|d| crate::cycle::anchor_of(&d));
        let configured = self.env.var("CLOUDFLARE_BILLING_DAY").ok().and_then(|v| v.to_string().trim().parse::<u32>().ok()).filter(|d| (1..=31).contains(d));
        Ok(read.or(configured).unwrap_or(crate::cycle::DEFAULT_ANCHOR))
    }

    /// Cloudflare's subscriptions as last read, else the estimate.
    pub(crate) async fn fixed_monthly(&self, estimate: i64) -> Result<Fixed> {
        #[derive(Deserialize)]
        struct Row {
            monthly_micros: i64,
            detail: String,
            read_at: String,
        }
        let row = self
            .db
            .prepare("SELECT monthly_micros, detail, read_at FROM cf_subscriptions WHERE id = 'current'")
            .first::<Row>(None)
            .await?;
        Ok(match row {
            Some(row) => Fixed {
                monthly_micros: row.monthly_micros,
                source: "cloudflare",
                read_at: Some(row.read_at),
                items: serde_json::from_str(&row.detail).unwrap_or_default(),
            },
            None => Fixed { monthly_micros: estimate, source: "estimate", read_at: None, items: Vec::new() },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paid_subscriptions_come_to_a_month_each() {
        let body = json!({ "result": [
            { "state": "Paid", "price": 5.0, "frequency": "monthly", "rate_plan": { "public_name": "Workers Paid" } },
            { "state": "Paid", "price": 240.0, "frequency": "yearly", "product": { "name": "Zone Pro" } },
            { "state": "Cancelled", "price": 20.0, "frequency": "monthly", "rate_plan": { "public_name": "Old" } },
            { "state": "Paid", "price": 0.0, "frequency": "monthly", "rate_plan": { "public_name": "Free" } },
        ] });
        let items = monthly(&body);
        assert_eq!(
            items,
            vec![
                FixedCost { name: "Workers Paid".into(), monthly_micros: 5_000_000 },
                FixedCost { name: "Zone Pro".into(), monthly_micros: 20_000_000 },
            ]
        );
    }

    #[test]
    fn the_cycle_starts_when_the_monthly_subscription_renews() {
        let body = json!({ "result": [
            { "state": "Cancelled", "price": 5.0, "frequency": "monthly", "current_period_start": "2026-09-01T00:00:00Z" },
            { "state": "Paid", "price": 240.0, "frequency": "yearly", "current_period_start": "2026-03-15T00:00:00Z" },
            { "state": "Paid", "price": 5.0, "frequency": "monthly", "current_period_start": "2026-09-28T07:12:00Z" },
        ] });
        assert_eq!(period_start(&body).as_deref(), Some("2026-09-28"));
        assert_eq!(period_start(&json!({ "result": [{ "state": "Paid", "price": 5.0 }] })), None);
    }

    #[test]
    fn nothing_answered_is_nothing_paid() {
        assert!(monthly(&json!({ "result": [] })).is_empty());
        assert!(monthly(&json!({})).is_empty());
    }
}
