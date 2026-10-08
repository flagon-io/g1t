//! Model tokens, counted per run for usage views.
//!
//! The model proxy reports what each answer used (`record_tokens`), and the
//! day's row for that run adds it up: one row per day, workspace, person,
//! session and model. `token_usage` reads a window of those back, for the
//! whole workspace or for one person, with what the window's runs were
//! charged. Billing still prices runs from AI Gateway, never from these.

use futures_util::future::try_join;
use g1t_contracts::billing::{DayTokens, RecordTokensArgs, TokenUsage, TokenUsageArgs};
use g1t_contracts::identity::AGENT_NAME;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::Result;

use crate::{Billing, members_only};

/// The window `token_usage` shows when asked for none, and the longest.
pub(crate) const DEFAULT_DAYS: u32 = 42;
pub(crate) const MAX_DAYS: u32 = 366;
const DAY_MS: u64 = 86_400_000;

/// One answer's tokens, ready to add to its day's row.
#[derive(Debug, PartialEq)]
pub(crate) struct TokenRow {
    pub day: String,
    pub workspace: String,
    pub person: String,
    pub session: String,
    pub model: String,
    pub tier: Option<String>,
    pub counts: [u64; 4],
}

/// Whether `tier` is one g1t routes to: `small`, `large` or `frontier`.
pub(crate) fn is_tier(tier: &str) -> bool {
    matches!(tier, "small" | "large" | "frontier")
}

/// The UTC day of a time, `YYYY-MM-DD`.
fn day_of(ms: u64) -> String {
    rfc3339(ms)[..10].to_owned()
}

/// Who a run's tokens count for: a username, lowercased, or empty for
/// nobody. The agent is not a person.
pub(crate) fn person_of(username: Option<&str>) -> String {
    let name = username.unwrap_or_default().trim().to_lowercase();
    if name == AGENT_NAME { String::new() } else { name }
}

/// What to add for one report, or None when there is nothing to count or
/// nothing to count it under.
pub(crate) fn token_row(a: &RecordTokensArgs, now: u64) -> Option<TokenRow> {
    let counts = [a.input, a.output, a.cache_read, a.cache_write];
    let workspace = a.workspace.trim().to_lowercase();
    let session = a.session.trim();
    if counts.iter().all(|n| *n == 0) || workspace.is_empty() || session.is_empty() {
        return None;
    }
    let model = a.model.trim();
    Some(TokenRow {
        day: day_of(now),
        workspace,
        person: person_of(a.person.as_deref()),
        session: session.chars().take(64).collect(),
        model: if model.is_empty() { "unknown".to_owned() } else { model.chars().take(200).collect() },
        tier: a.tier.as_deref().filter(|tier| is_tier(tier)).map(str::to_owned),
        counts,
    })
}

/// The days of a window that ends today, oldest first, and how many.
pub(crate) fn window(now: u64, days: Option<u32>) -> Vec<String> {
    let days = days.unwrap_or(DEFAULT_DAYS).clamp(1, MAX_DAYS);
    (0..u64::from(days)).rev().map(|back| day_of(now.saturating_sub(back * DAY_MS))).collect()
}

/// Every day of the window with its tokens, zeros included.
pub(crate) fn fill(days: &[String], counted: &[(String, u64)]) -> Vec<DayTokens> {
    days.iter()
        .map(|day| DayTokens {
            day: day.clone(),
            tokens: counted.iter().filter(|(d, _)| d == day).map(|(_, n)| n).sum(),
        })
        .collect()
}

/// D1 takes numbers as doubles; a count of tokens fits exactly.
fn number(n: u64) -> JsValue {
    JsValue::from_f64(n as f64)
}

impl Billing {
    pub(crate) async fn record_tokens(&self, a: RecordTokensArgs) -> Result<Outcome<bool>> {
        let Some(row) = token_row(&a, now_ms()) else {
            return Ok(Outcome::Ok(false));
        };
        let [input, output, cache_read, cache_write] = row.counts;
        self.db
            .prepare(
                "INSERT INTO token_usage (day, workspace, person, session, model, tier, input, output, cache_read, cache_write, requests)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                 ON CONFLICT (day, workspace, person, session, model) DO UPDATE SET
                   input = input + excluded.input,
                   output = output + excluded.output,
                   cache_read = cache_read + excluded.cache_read,
                   cache_write = cache_write + excluded.cache_write,
                   requests = requests + 1,
                   tier = COALESCE(excluded.tier, tier)",
            )
            .bind(&[
                row.day.into(),
                row.workspace.into(),
                row.person.into(),
                row.session.into(),
                row.model.into(),
                row.tier.map_or(JsValue::NULL, JsValue::from),
                number(input),
                number(output),
                number(cache_read),
                number(cache_write),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }

    pub(crate) async fn token_usage(&self, a: TokenUsageArgs) -> Result<Outcome<TokenUsage>> {
        let workspace = a.workspace.to_lowercase();
        let Some(viewer) = a.viewer.filter(|viewer| viewer.is_member(&workspace)) else {
            return Ok(members_only());
        };
        let person = a.person.as_deref().map(|name| person_of(Some(name))).filter(|name| !name.is_empty());
        if let Some(person) = &person
            && *person != viewer.username.to_lowercase()
            && !viewer.manages_billing(&workspace)
        {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only owners and billing managers can see another person's usage.",
            ));
        }
        let days = window(now_ms(), a.days);
        let since = days[0].clone();
        let mut binds: Vec<JsValue> = vec![workspace.as_str().into(), since.as_str().into()];
        if let Some(person) = &person {
            binds.push(person.as_str().into());
        }
        let for_person = if person.is_some() { " AND person = ?3" } else { "" };

        #[derive(Deserialize)]
        struct DayRow {
            day: String,
            input: Option<f64>,
            output: Option<f64>,
            cache_read: Option<f64>,
            cache_write: Option<f64>,
        }
        #[derive(Deserialize)]
        struct Charged {
            micros: Option<f64>,
        }
        let by_day = async {
            self.db
                .prepare(format!(
                    "SELECT day, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write
                     FROM token_usage WHERE workspace = ?1 AND day >= ?2{for_person} GROUP BY day"
                ))
                .bind(&binds)?
                .all()
                .await?
                .results::<DayRow>()
        };
        // What the window's runs cost, whoever paid: at g1t's price, what was
        // left to pay plus what included usage, credit, the trial, the
        // open-source pool or a comp covered; a run charged nothing at all
        // (comped, or while g1t charges nothing) at the provider's cost.
        // For one person, the runs whose sessions counted their tokens.
        let measure = if self.free {
            "COALESCE(l.cost_micros, 0)"
        } else {
            "CASE WHEN (-l.amount_micros + l.credit_micros + l.trial_micros + l.oss_micros + l.given_micros) > 0
                  THEN (-l.amount_micros + l.credit_micros + l.trial_micros + l.oss_micros + l.given_micros)
                  ELSE COALESCE(l.cost_micros, 0) END"
        };
        let sessions = if person.is_some() {
            " AND r.session_id IN (SELECT session FROM token_usage WHERE workspace = ?1 AND person = ?3 AND day >= ?2)"
        } else {
            ""
        };
        let charged = async {
            self.db
                .prepare(format!(
                    "SELECT SUM({measure}) AS micros FROM ledger l JOIN runs r ON r.id = l.reference
                     WHERE l.workspace = ?1 AND l.kind = 'usage' AND l.created_at >= ?2{sessions}"
                ))
                .bind(&binds)?
                .first::<Charged>(None)
                .await
        };
        // Both read independently, so they go to D1 at once.
        let (rows, charged) = try_join(by_day, charged).await?;

        let count = |n: Option<f64>| n.unwrap_or_default().max(0.0) as u64;
        let mut totals = [0u64; 4];
        let mut counted = Vec::with_capacity(rows.len());
        for row in &rows {
            let row_counts = [count(row.input), count(row.output), count(row.cache_read), count(row.cache_write)];
            for (total, n) in totals.iter_mut().zip(row_counts) {
                *total += n;
            }
            counted.push((row.day.clone(), row_counts.iter().sum::<u64>()));
        }
        let by_day = fill(&days, &counted);
        Ok(Outcome::Ok(TokenUsage {
            since,
            days: days.len() as u32,
            person,
            total_tokens: totals.iter().sum(),
            input_tokens: totals[0],
            output_tokens: totals[1],
            cache_read_tokens: totals[2],
            cache_write_tokens: totals[3],
            cost_micros: charged.and_then(|c| c.micros).unwrap_or_default().round() as i64,
            active_days: by_day.iter().filter(|day| day.tokens > 0).count() as u32,
            by_day,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-10-06T12:00:00Z.
    const NOW: u64 = 1_791_288_000_000;

    fn args() -> RecordTokensArgs {
        RecordTokensArgs {
            workspace: " Acme ".into(),
            session: "ms_abc".into(),
            person: Some("Ada".into()),
            model: "claude-opus".into(),
            tier: Some("large".into()),
            input: 10,
            output: 5,
            cache_read: 0,
            cache_write: 0,
        }
    }

    #[test]
    fn a_report_is_added_to_today_under_its_person() {
        let row = token_row(&args(), NOW).unwrap();
        assert_eq!(row.day, "2026-10-06");
        assert_eq!(row.workspace, "acme");
        assert_eq!(row.person, "ada");
        assert_eq!(row.tier.as_deref(), Some("large"));
        assert_eq!(row.counts, [10, 5, 0, 0]);
    }

    #[test]
    fn nothing_used_or_nowhere_to_put_it_is_not_counted() {
        assert!(token_row(&RecordTokensArgs { input: 0, output: 0, ..args() }, NOW).is_none());
        assert!(token_row(&RecordTokensArgs { session: " ".into(), ..args() }, NOW).is_none());
        assert!(token_row(&RecordTokensArgs { workspace: String::new(), ..args() }, NOW).is_none());
    }

    #[test]
    fn the_agent_is_nobody_and_odd_tiers_and_models_are_tidied() {
        let row = token_row(
            &RecordTokensArgs { person: Some("g1t".into()), tier: Some("huge".into()), model: " ".into(), ..args() },
            NOW,
        )
        .unwrap();
        assert_eq!(row.person, "");
        assert_eq!(row.tier, None);
        assert_eq!(row.model, "unknown");
        assert_eq!(person_of(None), "");
        // The most capable tier is a tier too.
        let frontier = token_row(&RecordTokensArgs { tier: Some("frontier".into()), ..args() }, NOW).unwrap();
        assert_eq!(frontier.tier.as_deref(), Some("frontier"));
    }

    #[test]
    fn the_window_ends_today_oldest_first_and_is_bounded() {
        let days = window(NOW, Some(3));
        assert_eq!(days, vec!["2026-10-04", "2026-10-05", "2026-10-06"]);
        assert_eq!(window(NOW, None).len(), DEFAULT_DAYS as usize);
        assert_eq!(window(NOW, Some(0)).len(), 1);
        assert_eq!(window(NOW, Some(5000)).len(), MAX_DAYS as usize);
        // Across a month's end.
        assert_eq!(window(NOW, Some(7))[0], "2026-09-30");
    }

    #[test]
    fn every_day_is_filled_with_zeros_where_nothing_ran() {
        let days = window(NOW, Some(3));
        let filled = fill(&days, &[("2026-10-05".into(), 40), ("2026-09-01".into(), 9)]);
        let tokens: Vec<u64> = filled.iter().map(|d| d.tokens).collect();
        assert_eq!(tokens, vec![0, 40, 0]);
        assert_eq!(filled[2].day, "2026-10-06");
    }
}
