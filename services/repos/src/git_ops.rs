//! Git operations through g1t's git endpoints, counted per workspace.
//!
//! Cloudflare Artifacts charges g1t for every operation from 2026-10-14
//! ($0.15 per 1,000): each clone, fetch and push. Every upload-pack (clone
//! or fetch) and receive-pack (push) request through here is one, counted
//! by the hour. Billing reads the month's count each day (`git_operations`)
//! and charges workspaces on the plan for what is past the included amount.
//!
//! A free workspace is never charged for git operations. Past
//! `GIT_OPERATIONS_FREE_CAP` in a month (50,000, five times what is
//! included), it is slowed down instead: at most
//! `GIT_OPERATIONS_FREE_HOURLY` (60) an hour, answered 429 with when to try
//! again. Pushes from agents' sandboxes go to the store directly and are
//! not counted.

use g1t_contracts::repos::WorkspaceGitOperations;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, Env, Fetcher, Response, Result};

/// The hour an operation is counted in: `YYYY-MM-DDTHH` of an RFC 3339 time.
pub fn hour_key(timestamp: &str) -> String {
    timestamp[..13].to_owned()
}

/// Whether a free workspace's operation should wait: past the month's cap,
/// and past the hour's share.
pub fn slow_down(month_ops: u64, hour_ops: u64, free_cap: u64, hourly: u64) -> bool {
    month_ops > free_cap && hour_ops > hourly
}

/// The limits, from the repos service's variables.
pub struct Limits {
    pub free_cap: u64,
    pub hourly: u64,
}

impl Limits {
    pub fn from_env(env: &Env) -> Self {
        let number = |name: &str, default: u64| env.var(name).ok().and_then(|v| v.to_string().parse().ok()).unwrap_or(default);
        Limits { free_cap: number("GIT_OPERATIONS_FREE_CAP", 50_000), hourly: number("GIT_OPERATIONS_FREE_HOURLY", 60) }
    }
}

#[derive(Deserialize)]
struct Counts {
    month: Option<f64>,
    hour: Option<f64>,
}

/// Counts one operation for `namespace` now; returns the month's and the
/// hour's counts with it.
pub async fn count(db: &D1Database, namespace: &str, now: &str) -> Result<(u64, u64)> {
    let hour = hour_key(now);
    let month = &now[..7];
    let results = db
        .batch(vec![
            db.prepare(
                "INSERT INTO git_operations (namespace, hour, operations) VALUES (?1, ?2, 1)
                 ON CONFLICT (namespace, hour) DO UPDATE SET operations = operations + 1",
            )
            .bind(&[namespace.into(), hour.as_str().into()])?,
            db.prepare(
                "SELECT SUM(operations) AS month, SUM(CASE WHEN hour = ?2 THEN operations END) AS hour
                 FROM git_operations WHERE namespace = ?1 AND substr(hour, 1, 7) = ?3",
            )
            .bind(&[namespace.into(), hour.as_str().into(), month.into()])?,
        ])
        .await?;
    let counts = results.get(1).map(|r| r.results::<Counts>()).transpose()?.and_then(|rows| rows.into_iter().next());
    Ok(counts.map_or((1, 1), |c| (c.month.unwrap_or(1.0) as u64, c.hour.unwrap_or(1.0) as u64)))
}

/// Each workspace's operations in `month`, from `since` (an hour) on.
pub async fn totals(db: &D1Database, month: &str, since: Option<&str>, namespace: Option<&str>) -> Result<Vec<WorkspaceGitOperations>> {
    #[derive(Deserialize)]
    struct Row {
        namespace: String,
        operations: Option<f64>,
    }
    Ok(db
        .prepare(
            "SELECT namespace, SUM(operations) AS operations FROM git_operations
             WHERE substr(hour, 1, 7) = ?1 AND hour >= COALESCE(?2, '') AND (?3 IS NULL OR namespace = ?3)
             GROUP BY namespace",
        )
        .bind(&[month.into(), since.map_or(JsValue::NULL, JsValue::from), namespace.map_or(JsValue::NULL, JsValue::from)])?
        .all()
        .await?
        .results::<Row>()?
        .into_iter()
        .map(|row| WorkspaceGitOperations { namespace: row.namespace, operations: row.operations.unwrap_or(0.0) as u64 })
        .collect())
}

/// Whether billing says the workspace is free. Unknown (billing not bound
/// or not answering) counts as not free: nothing is slowed down on a guess.
pub async fn is_free(billing: Option<&Fetcher>, namespace: &str) -> bool {
    let Some(billing) = billing else { return false };
    let args = g1t_contracts::billing::EntitlementsArgs { workspace: namespace.to_owned() };
    match g1t_kit::call::<_, serde_json::Value>(billing, "entitlements", &args).await {
        Ok(found) => found["plan"].as_str() == Some("free"),
        Err(error) => {
            worker::console_error!("could not ask billing about {namespace}: {error}");
            false
        }
    }
}

/// The private storage a free workspace may push to: 1 GB unless set.
pub fn free_private_bytes(env: &worker::Env) -> i64 {
    env.var("FREE_PRIVATE_STORAGE_BYTES")
        .ok()
        .and_then(|value| value.to_string().parse().ok())
        .unwrap_or(1_000_000_000)
}

/// Whether a push to a private repository should be refused: a free
/// workspace whose private repositories already hold its free amount. Free
/// workspaces are never charged for storage; past it, pushes stop instead.
pub fn storage_full(private_bytes: i64, free_bytes: i64) -> bool {
    private_bytes >= free_bytes
}

/// The answer to a push a free workspace has no room for. Plain text on
/// the push's first request, which git shows as the reason.
pub fn storage_full_response(namespace: &str, private_bytes: i64, free_bytes: i64) -> Result<Response> {
    let gb = |bytes: i64| bytes as f64 / 1_000_000_000.0;
    let message = format!(
        "{namespace}'s private repositories hold {:.2} GB, and a free workspace has {:.0} GB. Free workspaces are never charged for storage, so pushes to private repositories stop here. Make the repository public, delete what you no longer need, or start the g1t plan (10 GB): https://g1t.sh/{namespace}/-/billing
",
        gb(private_bytes),
        gb(free_bytes)
    );
    Response::error(message, 403)
}

/// The answer to a free workspace past its share: try again next hour.
pub fn too_many(namespace: &str, free_cap: u64, hourly: u64) -> Result<Response> {
    let message = format!(
        "{namespace} has made more than {free_cap} git operations this month, so g1t allows {hourly} an hour until the month turns. Free workspaces are never charged for git operations; the g1t plan has no hourly limit: https://g1t.sh/{namespace}/-/billing\n"
    );
    let response = Response::error(message, 429)?;
    response.headers().set("retry-after", "3600")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operations_are_counted_by_the_hour() {
        assert_eq!(hour_key("2026-10-14T09:59:59.000Z"), "2026-10-14T09");
    }

    #[test]
    fn a_free_workspace_pushes_until_its_private_storage_is_full() {
        assert!(!storage_full(999_999_999, 1_000_000_000));
        assert!(storage_full(1_000_000_000, 1_000_000_000));
        assert!(storage_full(3_000_000_000, 1_000_000_000));
    }

    #[test]
    fn a_free_workspace_is_slowed_only_past_its_monthly_cap() {
        // Under the cap: never slowed, however busy the hour.
        assert!(!slow_down(49_999, 5_000, 50_000, 60));
        // Past it: 60 an hour, then wait.
        assert!(!slow_down(50_001, 60, 50_000, 60));
        assert!(slow_down(50_001, 61, 50_000, 60));
    }
}
