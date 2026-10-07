//! Git operations, counted per workspace.
//!
//! Cloudflare Artifacts charges g1t per operation from 2026-10-14 ($0.15
//! per 1,000) without having said exactly which calls are operations. So
//! every interaction with the store is metered by kind (meters.rs), and
//! which meters a workspace is counted for, and how much each is worth, is
//! data (`operation_mapping`). By default: each clone or fetch (an
//! upload-pack request that fetches objects, not `ls-refs` and never an
//! answer g1t served from its own cache), each push (receive-pack), and
//! making, forking and deleting a repository. The counts go to
//! `git_operations` by the hour, after answers have gone back. Billing
//! reads the month's count each day and charges workspaces on the plan for
//! what is past the amount that is free for everyone (50,000 a month), at
//! cost plus 20%. A workspace on the plan is never slowed or refused for
//! git operations or for storage: it pays for them as usage, up to its
//! spend limit.
//!
//! A free workspace is never charged for git operations. Past
//! `GIT_OPERATIONS_FREE_CAP` in a month (50,000, billing's
//! `GIT_OPERATIONS_INCLUDED`), it is slowed down instead: at most
//! `GIT_OPERATIONS_FREE_HOURLY` (60) an hour, answered 429 with when to try
//! again. Whether it is past its cap is decided from counts this isolate
//! read a moment ago and has added to since, never by asking the database
//! on the way (63 to 98 ms a request, measured).
//!
//! Agents' sandboxes, checks, builds and workflow jobs clone, fetch and
//! push through g1t's git endpoints (`https://g1t.sh/<path>.git`, with a
//! run credential), never the store directly, so they are counted here
//! like anyone's; so is git an agent runs itself in its sandbox. A pull
//! request's working copy counts for the workspace of the repository it
//! came from (meters.rs). The one sandbox that reads the store directly,
//! a nightly backup, reports its clone, which is g1t's cost and never a
//! workspace's (backups.rs). The limits here go by the path asked for, so
//! a free workspace's requests to a working copy (`pulls/<pull id>`) are
//! counted for it but never slowed down.

use std::cell::RefCell;
use std::collections::HashMap;

use g1t_contracts::repos::{GitService, WorkspaceGitOperations};
use serde::Deserialize;
use worker::{D1Database, Env, Fetcher, Response, Result};

/// What a request to g1t's git endpoints asks the store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitCall {
    /// `GET info/refs`: the refs, for a fetch or a push.
    RefAdvertisement,
    /// A protocol v2 `ls-refs`.
    LsRefs,
    /// An upload-pack request that fetches objects: a clone or fetch.
    Fetch,
    /// A push.
    ReceivePack,
}

impl GitCall {
    /// Its meter (meters.rs).
    pub fn meter(self) -> &'static str {
        match self {
            GitCall::RefAdvertisement => "git.info_refs",
            GitCall::LsRefs => "git.ls_refs",
            GitCall::Fetch => "git.fetch",
            GitCall::ReceivePack => "git.receive_pack",
        }
    }

    /// The meter for an answer g1t served from its own cache, which never
    /// reaches the store and is never an operation.
    pub fn cached_meter(self) -> &'static str {
        match self {
            GitCall::RefAdvertisement => "cache.info_refs",
            GitCall::LsRefs => "cache.ls_refs",
            GitCall::Fetch => "cache.fetch",
            GitCall::ReceivePack => "cache.receive_pack",
        }
    }
}

/// What a git request is. `body` is an upload-pack POST's, read already.
pub fn classify(service: GitService, endpoint: &str, get: bool, body: Option<&[u8]>) -> GitCall {
    if get || endpoint == "info/refs" {
        return GitCall::RefAdvertisement;
    }
    if service == GitService::ReceivePack {
        return GitCall::ReceivePack;
    }
    let ls_refs = body.is_some_and(|body| {
        let (lines, _) = crate::land::read_pkt_lines(body);
        lines.first().is_some_and(|line| line.strip_suffix(b"\n").unwrap_or(line) == b"command=ls-refs")
    });
    if ls_refs { GitCall::LsRefs } else { GitCall::Fetch }
}

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

/// Where a workspace stands this month and hour, as this isolate knows it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Standing {
    /// `YYYY-MM-DDTHH` the counts are for.
    hour_key: String,
    month: f64,
    hour: f64,
    /// When the database was last read for it.
    read_at: u64,
}

impl Standing {
    /// The month's and the hour's counts at `hour_key`, if read recently
    /// enough to go by: an hour that has turned starts at nothing, a month
    /// that has turned likewise.
    pub fn at(&self, hour_key: &str, now: u64) -> Option<(u64, u64)> {
        if now.saturating_sub(self.read_at) > STANDING_TTL_MS {
            return None;
        }
        let month = if self.hour_key.get(..7) == hour_key.get(..7) { self.month } else { 0.0 };
        let hour = if self.hour_key == hour_key { self.hour } else { 0.0 };
        Some((month as u64, hour as u64))
    }

    /// Adds operations counted here, not yet written.
    pub fn add(&mut self, hour_key: &str, operations: f64) {
        if self.hour_key != hour_key {
            if self.hour_key.get(..7) != hour_key.get(..7) {
                self.month = 0.0;
            }
            self.hour = 0.0;
            self.hour_key = hour_key.to_owned();
        }
        self.month += operations;
        self.hour += operations;
    }
}

/// How long counts read from the database are gone by. Every write of the
/// meters reads them again (meters.rs), so a busy workspace's are seconds old.
const STANDING_TTL_MS: u64 = 10 * 60 * 1000;
/// How long billing's answer about a workspace's plan is kept.
const PLAN_TTL_MS: u64 = 5 * 60 * 1000;

thread_local! {
    static STANDING: RefCell<HashMap<String, Standing>> = RefCell::new(HashMap::new());
    static FREE: RefCell<HashMap<String, (bool, u64)>> = RefCell::new(HashMap::new());
}

/// Adds operations this isolate counted for `namespace` (meters.rs).
pub fn note_local(namespace: &str, hour_key: &str, operations: f64) {
    STANDING.with(|standing| {
        if let Some(kept) = standing.borrow_mut().get_mut(namespace) {
            kept.add(hour_key, operations);
        }
    });
}

/// The month's and the hour's counts for `namespace`, as last read and
/// added to here; `None` when not read lately, which never slows anyone.
pub fn standing(namespace: &str, hour_key: &str, now: u64) -> Option<(u64, u64)> {
    STANDING.with(|standing| standing.borrow().get(namespace).and_then(|kept| kept.at(hour_key, now)))
}

/// Reads `namespace`'s counts again, after the meters were written.
pub async fn refresh(db: &D1Database, namespace: &str) -> Result<()> {
    let now = g1t_kit::now_ms();
    let hour = hour_key(&g1t_contracts::time::rfc3339(now));
    let counts = db
        .prepare(
            "SELECT SUM(operations) AS month, SUM(CASE WHEN hour = ?2 THEN operations END) AS hour
             FROM git_operations WHERE namespace = ?1 AND substr(hour, 1, 7) = ?3",
        )
        .bind(&[namespace.into(), hour.as_str().into(), hour[..7].into()])?
        .first::<Counts>(None)
        .await?;
    let (month, hour_count) = counts.map_or((0.0, 0.0), |c| (c.month.unwrap_or(0.0), c.hour.unwrap_or(0.0)));
    STANDING.with(|standing| {
        standing.borrow_mut().insert(namespace.to_owned(), Standing { hour_key: hour, month, hour: hour_count, read_at: now });
    });
    Ok(())
}

/// The hours of `month` (`YYYY-MM`) from `since` on, as the range
/// `[from, until)` of hour keys; `None` for a month that is not one.
/// A range on `hour` is what the table's key can find; `substr` is not.
pub fn month_hours(month: &str, since: Option<&str>) -> Option<(String, String)> {
    let year: u32 = month.get(..4)?.parse().ok()?;
    let number: u32 = month.get(5..7)?.parse().ok()?;
    if month.len() != 7 || &month[4..5] != "-" || !(1..=12).contains(&number) {
        return None;
    }
    let until = if number == 12 { format!("{}-01-01", year + 1) } else { format!("{year}-{:02}-01", number + 1) };
    let start = format!("{month}-01");
    let from = match since {
        Some(since) if since > start.as_str() => since.to_owned(),
        _ => start,
    };
    Some((from, until))
}

/// Each workspace's operations in `month`, from `since` (an hour) on.
pub async fn totals(db: &D1Database, month: &str, since: Option<&str>, namespace: Option<&str>) -> Result<Vec<WorkspaceGitOperations>> {
    #[derive(Deserialize)]
    struct Row {
        namespace: String,
        operations: Option<f64>,
    }
    let Some((from, until)) = month_hours(month, since) else { return Ok(vec![]) };
    // One workspace's is read by the table's key, namespace first; every
    // workspace's (billing's daily measure) reads the month's hours.
    let statement = match namespace {
        Some(namespace) => db
            .prepare(
                "SELECT namespace, SUM(operations) AS operations FROM git_operations
                 WHERE namespace = ?1 AND hour >= ?2 AND hour < ?3
                 GROUP BY namespace",
            )
            .bind(&[namespace.into(), from.as_str().into(), until.as_str().into()])?,
        None => db
            .prepare(
                "SELECT namespace, SUM(operations) AS operations FROM git_operations
                 WHERE hour >= ?1 AND hour < ?2
                 GROUP BY namespace",
            )
            .bind(&[from.as_str().into(), until.as_str().into()])?,
    };
    Ok(statement
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

/// [`is_free`], kept for a few minutes: asked only of a workspace past its
/// cap, on each of its requests.
pub async fn is_free_kept(billing: Option<&Fetcher>, namespace: &str) -> bool {
    let now = g1t_kit::now_ms();
    let kept = FREE.with(|free| {
        free.borrow().get(namespace).filter(|(_, at)| now.saturating_sub(*at) < PLAN_TTL_MS).map(|(free, _)| *free)
    });
    if let Some(free) = kept {
        return free;
    }
    let free = is_free(billing, namespace).await;
    FREE.with(|kept| kept.borrow_mut().insert(namespace.to_owned(), (free, now)));
    free
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
/// Only ever asked for a free workspace: one on the plan pays for storage
/// past the free amount and is never refused.
pub fn storage_full(private_bytes: i64, free_bytes: i64) -> bool {
    private_bytes >= free_bytes
}

/// The answer to a push a free workspace has no room for. Plain text on
/// the push's first request, which git shows as the reason.
pub fn storage_full_response(namespace: &str, private_bytes: i64, free_bytes: i64) -> Result<Response> {
    let gb = |bytes: i64| bytes as f64 / 1_000_000_000.0;
    let message = format!(
        "{namespace}'s private repositories hold {:.2} GB, and a free workspace has {:.0} GB. Free workspaces are never charged for storage, so pushes to private repositories stop here. Make the repository public, delete what you no longer need, or start the g1t plan, where storage past it is usage at cost plus 20% and pushes never stop: https://g1t.sh/{namespace}/-/billing
",
        gb(private_bytes),
        gb(free_bytes)
    );
    Response::error(message, 403)
}

/// The answer to a free workspace past its share: try again next hour.
pub fn too_many(namespace: &str, free_cap: u64, hourly: u64) -> Result<Response> {
    let message = format!(
        "{namespace} has made more than {free_cap} git operations this month, so g1t allows {hourly} an hour until the month turns. Free workspaces are never charged for git operations. On the g1t plan they are never slowed: past {free_cap} a month they are usage at cost plus 20%: https://g1t.sh/{namespace}/-/billing\n"
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
    fn a_months_hours_are_a_range_on_the_key() {
        let range = |month: &str, since: Option<&str>| month_hours(month, since);
        assert_eq!(range("2026-10", None), Some(("2026-10-01".to_owned(), "2026-11-01".to_owned())));
        assert_eq!(range("2026-12", None), Some(("2026-12-01".to_owned(), "2027-01-01".to_owned())));
        // `since` narrows the start, never widens it past the month.
        assert_eq!(range("2026-10", Some("2026-10-14T00")).map(|r| r.0), Some("2026-10-14T00".to_owned()));
        assert_eq!(range("2026-10", Some("2026-09-30T23")).map(|r| r.0), Some("2026-10-01".to_owned()));
        assert_eq!(range("2026-10", Some("")).map(|r| r.0), Some("2026-10-01".to_owned()));
        // Every hour of the month is in it, and none of the next or last,
        // as `substr(hour, 1, 7) = month` had it.
        let (from, until) = range("2026-10", None).unwrap();
        let inside = |hour: &str| hour >= from.as_str() && hour < until.as_str();
        assert!(inside("2026-10-01T00") && inside("2026-10-31T23"));
        assert!(!inside("2026-09-30T23") && !inside("2026-11-01T00"));
        assert_eq!(range("2026-13", None), None);
        assert_eq!(range("2026-1", None), None);
        assert_eq!(range("", None), None);
    }

    fn pkt(payload: &str) -> Vec<u8> {
        format!("{:04x}{payload}", payload.len() + 4).into_bytes()
    }

    #[test]
    fn each_git_request_is_metered_by_what_it_asks() {
        use GitService::{ReceivePack, UploadPack};
        assert_eq!(classify(UploadPack, "info/refs", true, None), GitCall::RefAdvertisement);
        assert_eq!(classify(ReceivePack, "info/refs", true, None), GitCall::RefAdvertisement);
        let ls_refs = [pkt("command=ls-refs\n"), b"0001".to_vec(), pkt("peel\n"), b"0000".to_vec()].concat();
        assert_eq!(classify(UploadPack, "git-upload-pack", false, Some(&ls_refs)), GitCall::LsRefs);
        let fetch = [pkt("command=fetch\n"), b"0001".to_vec(), pkt("want 1111111111111111111111111111111111111111\n"), pkt("done\n"), b"0000".to_vec()].concat();
        assert_eq!(classify(UploadPack, "git-upload-pack", false, Some(&fetch)), GitCall::Fetch);
        let v0 = [pkt("want 1111111111111111111111111111111111111111 side-band-64k\n"), b"0000".to_vec(), pkt("done\n")].concat();
        assert_eq!(classify(UploadPack, "git-upload-pack", false, Some(&v0)), GitCall::Fetch);
        assert_eq!(classify(ReceivePack, "git-receive-pack", false, None), GitCall::ReceivePack);
        // By default only fetches and pushes are operations; listing refs,
        // and anything g1t answered from its cache, never are.
        let mapping = crate::meters::Mapping::defaults();
        assert_eq!(mapping.billable(GitCall::Fetch.meter()), 1.0);
        assert_eq!(mapping.billable(GitCall::ReceivePack.meter()), 1.0);
        assert_eq!(mapping.billable(GitCall::LsRefs.meter()), 0.0);
        assert_eq!(mapping.billable(GitCall::RefAdvertisement.meter()), 0.0);
        for call in [GitCall::RefAdvertisement, GitCall::LsRefs, GitCall::Fetch, GitCall::ReceivePack] {
            assert_eq!(mapping.billable(call.cached_meter()), 0.0);
            assert_eq!(mapping.cost(call.cached_meter()), 0.0);
        }
    }

    #[test]
    fn the_standing_kept_here_moves_with_local_counts_and_turns_with_the_hour() {
        let mut standing = Standing { hour_key: "2026-10-14T09".into(), month: 50_000.0, hour: 59.0, read_at: 1_000 };
        assert_eq!(standing.at("2026-10-14T09", 1_000), Some((50_000, 59)));
        standing.add("2026-10-14T09", 2.0);
        assert_eq!(standing.at("2026-10-14T09", 2_000), Some((50_002, 61)));
        // A new hour starts at nothing; the month goes on.
        assert_eq!(standing.at("2026-10-14T10", 2_000), Some((50_002, 0)));
        standing.add("2026-10-14T10", 1.0);
        assert_eq!(standing.at("2026-10-14T10", 2_000), Some((50_003, 1)));
        // A new month too.
        assert_eq!(standing.at("2026-11-01T00", 2_000), Some((0, 0)));
        // Read too long ago: not gone by, so nobody is slowed on old news.
        assert_eq!(standing.at("2026-10-14T10", 1_000 + STANDING_TTL_MS + 1), None);
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
