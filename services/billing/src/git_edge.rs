//! The git edge as sudo shows it (`admin_git_edge`): how many edges run
//! now against `max_instances`, and what they used and cost over the last
//! 24 hours and the month so far. See the repos service's git_edge.rs and
//! the runner's gitedge.ts for what an edge is.
//!
//! Read from Cloudflare with the costs reconciliation's token (keeper.rs),
//! so sudo needs no Cloudflare secret of its own: the edges running from
//! the Containers API (`/containers/applications`, which needs Containers
//! Read on the token), what they used from GraphQL Analytics
//! (`containersUsageAdaptiveGroups`, filtered to the edge's application).
//! Each part that Cloudflare does not answer comes back empty with why,
//! and the rest still shows. The off switch is the `git_edge` level of the
//! platform pause (platform.rs), whose state comes along.

use g1t_contracts::billing::{GitEdgeReport, GitEdgeUsage, PauseLevel};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde_json::{Value, json};
use worker::Result;

use crate::Billing;
use crate::keeper::{GIB, Keeper, LIST_DISK_GB_SECOND, LIST_MEMORY_GIB_SECOND, LIST_VCPU_SECOND};

/// The edge's Containers application: the runner Worker's `GitEdge` class.
pub(crate) const APPLICATION: &str = "g1t-runner-gitedge";
/// One edge's instance (standard-1 in services/runner/wrangler.jsonc).
/// Edge-hours before 2026-10-23 were on standard-2 (6 GiB), so they read
/// half again as many as they were; their cost is what was billed.
const EDGE_GIB: f64 = 4.0;
const EDGE_DISK_GB: f64 = 8.0;
/// `max_instances` in services/runner/wrangler.jsonc, for when Cloudflare
/// does not say.
const EDGE_MAX_INSTANCES: u32 = 10;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// The edge's application in a `/containers/applications` answer: its id,
/// the edges running now (`health.instances.active`) and the most that
/// may run.
pub(crate) fn application(body: &Value) -> std::result::Result<(String, u32, u32), String> {
    let Some(apps) = body["result"].as_array() else {
        return Err(format!("Cloudflare answered without applications: {}", truncated(body)));
    };
    let Some(app) = apps.iter().find(|app| app["name"].as_str() == Some(APPLICATION)) else {
        return Err(format!("no Containers application named {APPLICATION} on the account"));
    };
    let id = app["id"].as_str().unwrap_or_default().to_owned();
    let count = |value: &Value| value.as_u64().map(|n| n as u32);
    let running = count(&app["health"]["instances"]["active"]).unwrap_or(0);
    let max = count(&app["max_instances"]).or_else(|| count(&app["instances"])).unwrap_or(EDGE_MAX_INSTANCES);
    Ok((id, running, max))
}

fn truncated(body: &Value) -> String {
    body.to_string().chars().take(300).collect()
}

/// `2026-10-08T13:17:00Z`, as GraphQL's `Time` takes it.
fn time_label(ms: u64) -> String {
    format!("{}Z", &rfc3339(ms)[..19])
}

/// The windows read: the last 24 hours (`Time`) and the month so far
/// (`Date`, today included).
pub(crate) fn windows(now: u64) -> [(&'static str, String, String); 2] {
    let today = rfc3339(now)[..10].to_owned();
    [("Time", time_label(now.saturating_sub(DAY_MS)), time_label(now)), ("Date", format!("{}-01", &today[..7]), today)]
}

/// The GraphQL request for what the application `app` used over a window.
pub(crate) fn usage_body(account: &str, app: &str, (kind, since, until): &(&str, String, String)) -> Value {
    let filter = if *kind == "Time" { "datetime_geq: $since, datetime_lt: $until" } else { "date_geq: $since, date_leq: $until" };
    let text = format!(
        "query ($account: String!, $app: String!, $since: {kind}!, $until: {kind}!) {{
  viewer {{ accounts(filter: {{ accountTag: $account }}) {{
    rows: containersUsageAdaptiveGroups(limit: 10000, filter: {{ applicationId: $app, {filter} }}) {{
      sum {{ allocatedMemory cpuTimeSec }}
    }}
  }} }}
}}"
    );
    json!({ "query": text, "variables": { "account": account, "app": app, "since": since, "until": until } })
}

/// What a usage answer adds up to, priced at Containers' list prices:
/// memory (allocated, byte-seconds) and disk for every second an edge is
/// awake, CPU as used.
pub(crate) fn usage(body: &Value, since: &str, until: &str) -> std::result::Result<GitEdgeUsage, String> {
    if let Some(errors) = body["errors"].as_array().filter(|e| !e.is_empty()) {
        let messages: Vec<&str> = errors.iter().filter_map(|e| e["message"].as_str()).collect();
        return Err(format!("containersUsageAdaptiveGroups: {}", messages.join("; ")));
    }
    let Some(groups) = body["data"]["viewer"]["accounts"][0]["rows"].as_array() else {
        return Err("containersUsageAdaptiveGroups: no rows in the answer".to_owned());
    };
    let sum = |field: &str| groups.iter().map(|g| g["sum"][field].as_f64().unwrap_or(0.0)).sum::<f64>();
    let memory_gib_seconds = sum("allocatedMemory") / GIB;
    let cpu_seconds = sum("cpuTimeSec");
    let edge_seconds = memory_gib_seconds / EDGE_GIB;
    let cost_dollars =
        memory_gib_seconds * LIST_MEMORY_GIB_SECOND + cpu_seconds * LIST_VCPU_SECOND + edge_seconds * EDGE_DISK_GB * LIST_DISK_GB_SECOND;
    Ok(GitEdgeUsage {
        since: since.to_owned(),
        until: until.to_owned(),
        edge_hours: edge_seconds / 3600.0,
        memory_gib_seconds,
        cpu_seconds,
        cost_dollars,
    })
}

impl Billing {
    /// `admin_git_edge`: the edges running, what they cost, and the pause.
    pub(crate) async fn git_edge(&self, keeper: &Keeper) -> Result<GitEdgeReport> {
        let guard_levels = self.pause_states().await?;
        let pause = guard_levels.into_iter().find(|s| s.level == PauseLevel::GitEdge.as_str()).unwrap_or_default();
        let mut report =
            GitEdgeReport { application: APPLICATION.to_owned(), pause, can_read: keeper.can_read_bill(), ..GitEdgeReport::default() };
        if !report.can_read {
            let why = "billing has no Cloudflare token (CLOUDFLARE_BILLING_TOKEN or CLOUDFLARE_USAGE_TOKEN) and account".to_owned();
            report.instances_error = Some(why.clone());
            report.usage_error = Some(why);
            return Ok(report);
        }
        let found = match keeper.container_applications().await {
            Ok(body) => application(&body),
            Err(error) => Err(format!("{error} (the token needs Containers Read)")),
        };
        let id = match found {
            Ok((id, running, max)) => {
                report.running = Some(running);
                report.max_instances = Some(max);
                id
            }
            Err(error) => {
                report.instances_error = Some(error);
                report.usage_error = Some("not read: the edge's application id comes from the Containers API".to_owned());
                return Ok(report);
            }
        };
        report.application_id = Some(id.clone());
        let [day, month] = windows(now_ms());
        let read = async |window: &(&str, String, String)| match keeper.graphql(usage_body(keeper.account(), &id, window)).await {
            Ok(body) => usage(&body, &window.1, &window.2),
            Err(error) => Err(error.to_string()),
        };
        let (day_usage, month_usage) = futures_util::future::join(read(&day), read(&month)).await;
        let mut errors = vec![];
        match day_usage {
            Ok(u) => report.last_day = Some(u),
            Err(e) => errors.push(e),
        }
        match month_usage {
            Ok(u) => report.month_to_date = Some(u),
            Err(e) => errors.push(e),
        }
        errors.dedup();
        if !errors.is_empty() {
            worker::console_error!("git edge usage not read: {}", errors.join("; "));
            report.usage_error = Some(errors.join("; "));
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_edges_application_says_how_many_run_and_the_most_that_may() {
        let body = json!({ "success": true, "result": [
            { "id": "a0329680", "name": "g1t-runner-sandbox", "max_instances": 30, "health": { "instances": { "active": 7 } } },
            { "id": "a038498b", "name": "g1t-runner-gitedge", "instances": 10, "health": { "instances": { "active": 3, "healthy": 3 } } },
        ] });
        assert_eq!(application(&body), Ok(("a038498b".to_owned(), 3, 10)));
        let with_max = json!({ "result": [{ "id": "x", "name": APPLICATION, "max_instances": 12 }] });
        // Nothing running says so with no health at all.
        assert_eq!(application(&with_max), Ok(("x".to_owned(), 0, 12)));
        assert!(application(&json!({ "result": [] })).unwrap_err().contains("no Containers application named g1t-runner-gitedge"));
        assert!(
            application(&json!({ "success": false, "errors": [{ "message": "Authentication error" }] }))
                .unwrap_err()
                .contains("Authentication error")
        );
    }

    #[test]
    fn usage_is_read_for_the_last_day_and_the_month_so_far() {
        // 2026-10-08 13:17:00 UTC.
        let now = 1_791_465_420_000;
        let [day, month] = windows(now);
        assert_eq!(day, ("Time", "2026-10-07T13:17:00Z".to_owned(), "2026-10-08T13:17:00Z".to_owned()));
        assert_eq!(month, ("Date", "2026-10-01".to_owned(), "2026-10-08".to_owned()));
        let body = usage_body("acct", "a038498b", &day);
        let text = body["query"].as_str().unwrap();
        assert!(text.contains("rows: containersUsageAdaptiveGroups(limit: 10000, filter: { applicationId: $app, datetime_geq: $since, datetime_lt: $until })"), "{text}");
        assert!(text.contains("$since: Time!") && text.contains("sum { allocatedMemory cpuTimeSec }"));
        assert_eq!(body["variables"]["app"], "a038498b");
        let text = usage_body("acct", "a038498b", &month)["query"].as_str().unwrap().to_owned();
        assert!(text.contains("date_geq: $since, date_leq: $until") && text.contains("$since: Date!"), "{text}");
    }

    #[test]
    fn an_edge_hour_is_its_memory_disk_and_cpu_at_list_price() {
        // Two edges awake for an hour each (4 GiB each), using 1,800 CPU-seconds.
        let gib_seconds = 2.0 * 4.0 * 3600.0;
        let body = json!({ "data": { "viewer": { "accounts": [{ "rows": [
            { "sum": { "allocatedMemory": gib_seconds * GIB / 2.0, "cpuTimeSec": 900.0 } },
            { "sum": { "allocatedMemory": gib_seconds * GIB / 2.0, "cpuTimeSec": 900.0 } },
        ] }] } } });
        let used = usage(&body, "a", "b").unwrap();
        assert!((used.edge_hours - 2.0).abs() < 1e-9);
        assert_eq!(used.cpu_seconds, 1800.0);
        // Memory 28,800 GiB-s at $0.0000025, CPU 1,800 s at $0.00002, disk
        // 7,200 edge-seconds × 8 GB at $0.00000007.
        let expected = 28_800.0 * 0.000_002_5 + 1_800.0 * 0.000_02 + 7_200.0 * 8.0 * 0.000_000_07;
        assert!((used.cost_dollars - expected).abs() < 1e-9, "{}", used.cost_dollars);
        assert!((expected - 0.112_032).abs() < 1e-9);
        let refused = usage(&json!({ "data": null, "errors": [{ "message": "unknown field applicationId" }] }), "a", "b");
        assert!(refused.unwrap_err().contains("unknown field applicationId"));
        // No rows: nothing used, not an error.
        let none = usage(&json!({ "data": { "viewer": { "accounts": [{ "rows": [] }] } } }), "a", "b").unwrap();
        assert_eq!((none.edge_hours, none.cost_dollars), (0.0, 0.0));
    }
}
