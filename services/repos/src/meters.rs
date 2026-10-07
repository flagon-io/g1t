//! Raw meters of everything g1t asks of the git store, and how it answered.
//!
//! Cloudflare bills Artifacts per "operation" from 2026-10-14 without
//! having said exactly which calls are operations, so every interaction is
//! counted by kind, per day, git store namespace, repository and workspace
//! (`artifacts_meters`): git over HTTPS from people and tools, the same by
//! g1t itself, and every call on the binding, with the bytes each moved
//! where known. Which meters are operations, for g1t's own bill and for
//! what workspaces are charged, is data (`operation_mapping`), read here
//! and changed without a deploy. What a workspace is counted for goes to
//! `git_operations` by the hour, as before, which billing reads.
//!
//! Sandboxes (agents, checks, builds, workflow jobs) use git like anyone
//! else: through g1t's git endpoints with a run credential, so their
//! clones, fetches and pushes are metered here as `git.*`, whoever runs
//! them in the sandbox, the agent included. Only a nightly backup's clone
//! goes to the store directly (backups.rs), and its sandbox reports it.
//! What is asked of a pull request's working copy (`pulls--<pull id>`,
//! where agents clone and push) is counted for the workspace of the
//! repository it came from, looked up when the counts are written
//! (`Pending::attributed`); before 2026-10-07 it was counted for a
//! workspace called `pulls`, which nobody is charged as.
//!
//! The same place keeps how the store answered, by the minute
//! (`store_health`), for the status page's "Git storage" part.
//!
//! Nothing here is on the request path. Each isolate adds up what it saw in
//! memory, and writes it all in one batch once the answer has gone back
//! (`flush`, from `ctx.wait_until`), every few seconds at most. A request
//! that counts something before the next write is due plans that write in
//! its own `wait_until`, which waits until it is (`plan_flush`,
//! `flush_after`): what was counted is never left for a later request on
//! the same isolate, which may never come. Before 2026-10-07 it was, and a
//! clone's last request (its fetch, the one that is an operation) was the
//! one most often lost when the isolate then went idle or a deploy
//! replaced it. A failed write puts the counts back for the next one. What
//! an isolate holds when it dies outright is lost: a few seconds' worth at
//! most.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, Result};

/// How an answer from the store went, for its health.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    /// Failed, after any retries.
    Failed,
    /// Refused for the store's rate limit.
    RateLimited,
    /// Not asked: the namespace's breaker was open (resilience.rs).
    Rejected,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    pub count: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Health {
    pub calls: u64,
    pub errors: u64,
    pub rate_limited: u64,
    pub rejected: u64,
    pub ms_total: u64,
}

/// One meter's place: the hour (`YYYY-MM-DDTHH`), the git store namespace,
/// the repository's name there, its workspace, and the meter.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Place {
    pub hour: String,
    pub store: String,
    pub repo: String,
    pub workspace: String,
    pub meter: String,
}

/// What an isolate has counted and not yet written.
#[derive(Default, Debug)]
pub struct Pending {
    pub usage: HashMap<Place, Tally>,
    /// By namespace and minute (`YYYY-MM-DDTHH:MM`).
    pub health: HashMap<(String, String), Health>,
}

impl Pending {
    pub fn is_empty(&self) -> bool {
        self.usage.is_empty() && self.health.is_empty()
    }

    pub fn meter(&mut self, place: Place, bytes_in: u64, bytes_out: u64) {
        self.add(place, 1, bytes_in, bytes_out);
    }

    pub fn add(&mut self, place: Place, count: u64, bytes_in: u64, bytes_out: u64) {
        let tally = self.usage.entry(place).or_default();
        tally.count += count;
        tally.bytes_in += bytes_in;
        tally.bytes_out += bytes_out;
    }

    pub fn health(&mut self, store: &str, minute: &str, outcome: Outcome, ms: u64) {
        let health = self.health.entry((store.to_owned(), minute.to_owned())).or_default();
        match outcome {
            Outcome::Rejected => health.rejected += 1,
            _ => {
                health.calls += 1;
                health.ms_total += ms;
                match outcome {
                    Outcome::Failed => health.errors += 1,
                    Outcome::RateLimited => {
                        health.errors += 1;
                        health.rate_limited += 1;
                    }
                    _ => {}
                }
            }
        }
    }

    /// Puts back what a failed write took.
    pub fn merge(&mut self, other: Pending) {
        for (place, tally) in other.usage {
            let kept = self.usage.entry(place).or_default();
            kept.count += tally.count;
            kept.bytes_in += tally.bytes_in;
            kept.bytes_out += tally.bytes_out;
        }
        for (key, health) in other.health {
            let kept = self.health.entry(key).or_default();
            kept.calls += health.calls;
            kept.errors += health.errors;
            kept.rate_limited += health.rate_limited;
            kept.rejected += health.rejected;
            kept.ms_total += health.ms_total;
        }
    }

    /// The pull requests whose working copies (`pulls--<pull id>`) are
    /// counted for nobody's workspace yet: see [`Pending::attributed`].
    pub fn unattributed_pulls(&self) -> Vec<String> {
        let mut pulls: Vec<String> = self
            .usage
            .keys()
            .filter(|place| place.workspace == crate::PULLS_NAMESPACE)
            .filter_map(|place| working_copy(&place.repo).map(str::to_owned))
            .collect();
        pulls.sort();
        pulls.dedup();
        pulls
    }

    /// The same counts with each pull request's working copy counted for
    /// the workspace of the repository it came from, as `owners` (pull id
    /// to workspace) says. A working copy's path is `pulls/<pull id>`, so
    /// what is asked of it (an agent's clone of it and its pushes to it, a
    /// merge check, catching up, making and removing it) would otherwise be
    /// counted for a workspace called `pulls`, which nobody is charged as.
    /// One `owners` does not name stays as it was.
    pub fn attributed(&self, owners: &HashMap<String, String>) -> Pending {
        let mut out = Pending { usage: HashMap::with_capacity(self.usage.len()), health: self.health.clone() };
        for (place, tally) in &self.usage {
            let mut place = place.clone();
            if place.workspace == crate::PULLS_NAMESPACE
                && let Some(owner) = working_copy(&place.repo).and_then(|pull| owners.get(pull))
            {
                place.workspace = owner.clone();
            }
            out.add(place, tally.count, tally.bytes_in, tally.bytes_out);
        }
        out
    }

    /// What each workspace is counted for, by the hour, under `mapping`.
    pub fn billable(&self, mapping: &Mapping) -> HashMap<(String, String), f64> {
        let mut out: HashMap<(String, String), f64> = HashMap::new();
        for (place, tally) in &self.usage {
            let weight = mapping.billable(&place.meter);
            if weight > 0.0 && !place.workspace.is_empty() {
                *out.entry((place.workspace.clone(), place.hour.clone())).or_default() += weight * tally.count as f64;
            }
        }
        out
    }
}

/// Which meters are operations, and how many each is worth.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MappingRow {
    pub meter: String,
    pub cost_operations: f64,
    pub billable_operations: f64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Clone, Debug, Default)]
pub struct Mapping {
    rows: HashMap<String, (f64, f64)>,
}

impl Mapping {
    pub fn from_rows(rows: &[MappingRow]) -> Self {
        Mapping {
            rows: rows.iter().map(|row| (row.meter.clone(), (row.cost_operations, row.billable_operations))).collect(),
        }
    }

    /// Used until the table can be read: the same as its defaults.
    pub fn defaults() -> Self {
        let rows = DEFAULT_OPERATIONS
            .iter()
            .map(|meter| MappingRow { meter: (*meter).to_owned(), cost_operations: 1.0, billable_operations: 1.0, ..MappingRow::default() })
            .chain(COST_ONLY_OPERATIONS.iter().map(|meter| MappingRow {
                meter: (*meter).to_owned(),
                cost_operations: 1.0,
                ..MappingRow::default()
            }))
            .collect::<Vec<_>>();
        Mapping::from_rows(&rows)
    }

    pub fn billable(&self, meter: &str) -> f64 {
        self.rows.get(meter).map_or(0.0, |(_, billable)| *billable)
    }

    #[cfg(test)]
    pub fn cost(&self, meter: &str) -> f64 {
        self.rows.get(meter).map_or(0.0, |(cost, _)| *cost)
    }
}

/// The meters `operation_mapping` starts with as one operation each
/// (migrations/0011): what Cloudflare most plausibly bills.
pub const DEFAULT_OPERATIONS: [&str; 7] = [
    "git.fetch",
    "git.receive_pack",
    "internal.git.fetch",
    "internal.git.receive_pack",
    "binding.create",
    "binding.fork",
    "binding.delete",
];

/// Meters that are an operation on g1t's own bill and on no workspace's:
/// a nightly backup's clone (backups.rs, migrations/0013).
pub const COST_ONLY_OPERATIONS: [&str; 1] = [crate::backups::FETCH_METER];

/// How long a read of `operation_mapping` is used for.
const MAPPING_TTL_MS: u64 = 5 * 60 * 1000;

thread_local! {
    static PENDING: RefCell<Pending> = RefCell::new(Pending::default());
    static MAPPING: RefCell<Option<(Mapping, u64)>> = const { RefCell::new(None) };
    /// The workspace each store key belongs to, as rows were read
    /// (registry.rs `store_key`).
    static OWNERS: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

/// Notes that the repository stored under `key` is in `workspace`.
pub fn note_owner(key: &str, workspace: &str) {
    OWNERS.with(|owners| {
        let mut owners = owners.borrow_mut();
        if owners.get(key).map(String::as_str) != Some(workspace) {
            owners.insert(key.to_owned(), workspace.to_owned());
        }
    });
}

/// The workspace a key belongs to: as its row said, else what its name says
/// (`acme--rocket`), else nothing.
fn workspace_of(key: &str, name: &str) -> String {
    OWNERS
        .with(|owners| owners.borrow().get(key).cloned())
        .unwrap_or_else(|| name.split_once("--").map(|(workspace, _)| workspace.to_owned()).unwrap_or_default())
}

/// The pull id of a working copy's name in the store (`pulls--pul_7`).
fn working_copy(name: &str) -> Option<&str> {
    name.strip_prefix(crate::PULLS_NAMESPACE)?.strip_prefix("--").filter(|pull| !pull.is_empty())
}

/// How long the workspace a working copy is counted for is kept before it
/// is read again (a workspace can be renamed).
const PULL_OWNER_TTL_MS: u64 = 10 * 60 * 1000;

thread_local! {
    /// The workspace each pull request's working copy is counted for, by
    /// pull id, as last read, and when.
    static PULL_OWNERS: RefCell<HashMap<String, (String, u64)>> = RefCell::new(HashMap::new());
}

/// The workspace of the repository each of `pulls`' working copies came
/// from: as kept for a while, else read in one query. Off the request
/// path (from `flush`).
async fn pull_owners(db: &D1Database, pulls: &[String]) -> Result<HashMap<String, String>> {
    let now = g1t_kit::now_ms();
    let mut owners = HashMap::new();
    let mut missing = Vec::new();
    PULL_OWNERS.with(|kept| {
        let kept = kept.borrow();
        for pull in pulls {
            match kept.get(pull).filter(|(_, at)| now.saturating_sub(*at) < PULL_OWNER_TTL_MS) {
                Some((owner, _)) => {
                    owners.insert(pull.clone(), owner.clone());
                }
                None => missing.push(pull.clone()),
            }
        }
    });
    if missing.is_empty() {
        return Ok(owners);
    }
    #[derive(Deserialize)]
    struct Row {
        pull: String,
        workspace: String,
    }
    let rows = db
        .prepare(
            "SELECT f.name AS pull, s.namespace AS workspace FROM repos f JOIN repos s ON s.id = f.fork_of
             WHERE f.namespace = ?1 AND f.name IN (SELECT value FROM json_each(?2))",
        )
        .bind(&[crate::PULLS_NAMESPACE.into(), serde_json::to_string(&missing)?.into()])?
        .all()
        .await?
        .results::<Row>()?;
    PULL_OWNERS.with(|kept| {
        let mut kept = kept.borrow_mut();
        for row in &rows {
            kept.insert(row.pull.clone(), (row.workspace.clone(), now));
        }
    });
    owners.extend(rows.into_iter().map(|row| (row.pull, row.workspace)));
    Ok(owners)
}

/// Counts one `meter` for the repository stored under `key`, with the
/// bytes it sent and received.
pub fn record(meter: &str, key: &str, bytes_in: u64, bytes_out: u64) {
    let place = place(meter, key);
    // A workspace's local count moves now, for its free limits (git_ops.rs).
    let weight = mapping_now().billable(meter);
    if weight > 0.0 && !place.workspace.is_empty() {
        crate::git_ops::note_local(&place.workspace, &place.hour, weight);
    }
    PENDING.with(|pending| pending.borrow_mut().meter(place, bytes_in, bytes_out));
}

/// Adds bytes to a `meter` already counted for `key`.
pub fn record_bytes(meter: &str, key: &str, bytes_in: u64, bytes_out: u64) {
    let place = place(meter, key);
    PENDING.with(|pending| pending.borrow_mut().add(place, 0, bytes_in, bytes_out));
}

/// Counts one `meter` for the repository behind a git `remote`.
pub fn record_remote(meter: &str, remote: &str, bytes_in: u64, bytes_out: u64) {
    if let Some(key) = crate::store::key_from_remote(remote) {
        record(meter, &key, bytes_in, bytes_out);
    }
}

fn place(meter: &str, key: &str) -> Place {
    place_at(meter, key, hour_now())
}

fn place_at(meter: &str, key: &str, hour: String) -> Place {
    let (store, name) = crate::store::locate(key);
    let workspace = workspace_of(key, &name);
    Place { hour, store, repo: name, workspace, meter: meter.to_owned() }
}

/// Records how one call to the store in namespace `store` went.
pub fn record_health(store: &str, outcome: Outcome, ms: u64) {
    let minute = g1t_contracts::time::rfc3339(g1t_kit::now_ms())[..16].to_owned();
    PENDING.with(|pending| pending.borrow_mut().health(store, &minute, outcome, ms));
}

fn hour_now() -> String {
    g1t_contracts::time::rfc3339(g1t_kit::now_ms())[..13].to_owned()
}

/// How often an isolate writes what it counted, at most, unless a lot
/// has piled up. Each write is one D1 batch; a page view or clone does
/// not each need one.
const FLUSH_EVERY_MS: u64 = 5_000;
const FLUSH_AT_PLACES: usize = 200;
/// A planned write not begun after this long is taken as never coming (its
/// request's `wait_until` was cut short), so another is planned.
const PLAN_STALE_MS: u64 = 30_000;

thread_local! {
    static LAST_FLUSH: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    /// When the write now waiting in some request's `wait_until` was planned.
    static PLANNED: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// How long the write a request should plan waits, in milliseconds, or
/// `None` when it should plan none: nothing waits, or a write is planned
/// already and has not gone stale. A pile-up is written at once, planned
/// write or not.
pub fn plan(waiting: usize, last: u64, planned: Option<u64>, now: u64) -> Option<u64> {
    if waiting == 0 {
        return None;
    }
    if waiting >= FLUSH_AT_PLACES {
        return Some(0);
    }
    if planned.is_some_and(|at| now.saturating_sub(at) < PLAN_STALE_MS) {
        return None;
    }
    Some(FLUSH_EVERY_MS.saturating_sub(now.saturating_sub(last)))
}

/// The write this request should plan, if any, as how long it waits (see
/// [`plan`]); taken as planned. Never waits itself.
pub fn plan_flush() -> Option<u64> {
    let now = g1t_kit::now_ms();
    let waiting = PENDING.with(|pending| {
        let pending = pending.borrow();
        pending.usage.len() + pending.health.len()
    });
    let wait = plan(waiting, LAST_FLUSH.with(std::cell::Cell::get), PLANNED.with(std::cell::Cell::get), now)?;
    if wait > 0 {
        PLANNED.with(|planned| planned.set(Some(now)));
    }
    Some(wait)
}

/// A planned write: waits `wait_ms`, then writes everything counted by
/// then. For `ctx.wait_until`, after the answer has gone back.
pub async fn flush_after(db: &D1Database, wait_ms: u64) {
    if wait_ms > 0 {
        worker::Delay::from(std::time::Duration::from_millis(wait_ms)).await;
        PLANNED.with(|planned| planned.set(None));
    }
    LAST_FLUSH.with(|last| last.set(g1t_kit::now_ms()));
    flush(db).await;
}

/// The mapping as this isolate last read it, else the defaults. Never
/// waits: for deciding on the request path.
pub fn mapping_now() -> Mapping {
    MAPPING.with(|kept| kept.borrow().as_ref().map(|(mapping, _)| mapping.clone())).unwrap_or_else(Mapping::defaults)
}

/// The mapping, read at most every few minutes; the defaults if it cannot be.
pub async fn mapping(db: &D1Database) -> Mapping {
    let now = g1t_kit::now_ms();
    if let Some(mapping) = MAPPING.with(|kept| {
        kept.borrow().as_ref().filter(|(_, at)| now.saturating_sub(*at) < MAPPING_TTL_MS).map(|(m, _)| m.clone())
    }) {
        return mapping;
    }
    match read_mapping(db).await {
        Ok(rows) => {
            let mapping = Mapping::from_rows(&rows);
            MAPPING.with(|kept| *kept.borrow_mut() = Some((mapping.clone(), now)));
            mapping
        }
        Err(error) => {
            worker::console_error!("operation_mapping not read: {error}");
            Mapping::defaults()
        }
    }
}

pub async fn read_mapping(db: &D1Database) -> Result<Vec<MappingRow>> {
    db.prepare("SELECT meter, cost_operations, billable_operations, note, updated_at FROM operation_mapping ORDER BY meter")
        .all()
        .await?
        .results::<MappingRow>()
}

/// Sets how many operations a meter is worth, from now on.
pub async fn set_mapping(db: &D1Database, row: &MappingRow, now: &str) -> Result<()> {
    db.prepare(
        "INSERT INTO operation_mapping (meter, cost_operations, billable_operations, note, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (meter) DO UPDATE SET cost_operations = ?2, billable_operations = ?3, note = ?4, updated_at = ?5",
    )
    .bind(&[
        row.meter.as_str().into(),
        row.cost_operations.into(),
        row.billable_operations.into(),
        row.note.as_deref().map_or(JsValue::NULL, JsValue::from),
        now.into(),
    ])?
    .run()
    .await?;
    MAPPING.with(|kept| *kept.borrow_mut() = None);
    Ok(())
}

/// D1 runs at most this many statements in one batch, here.
const BATCH: usize = 50;

/// Writes everything counted so far; see the module docs.
pub async fn flush(db: &D1Database) {
    let taken = PENDING.with(|pending| std::mem::take(&mut *pending.borrow_mut()));
    if taken.is_empty() {
        return;
    }
    let mapping = mapping(db).await;
    // Pull requests' working copies count for their repositories' workspaces.
    let pulls = taken.unattributed_pulls();
    let attributed = if pulls.is_empty() {
        None
    } else {
        match pull_owners(db, &pulls).await {
            Ok(owners) => Some(taken.attributed(&owners)),
            Err(error) => {
                worker::console_error!("working copies' workspaces not read, counted as they are: {error}");
                None
            }
        }
    };
    if let Err(error) = write(db, attributed.as_ref().unwrap_or(&taken), &mapping).await {
        worker::console_error!("git store meters not written, kept for the next try: {error}");
        PENDING.with(|pending| pending.borrow_mut().merge(taken));
    }
}

async fn write(db: &D1Database, pending: &Pending, mapping: &Mapping) -> Result<()> {
    let mut statements = Vec::new();
    // By day in the table; by the hour in memory.
    let mut days: HashMap<(String, String, String, String, String), Tally> = HashMap::new();
    for (place, tally) in &pending.usage {
        let day = days
            .entry((place.hour[..10].to_owned(), place.store.clone(), place.repo.clone(), place.workspace.clone(), place.meter.clone()))
            .or_default();
        day.count += tally.count;
        day.bytes_in += tally.bytes_in;
        day.bytes_out += tally.bytes_out;
    }
    for ((day, store, repo, workspace, meter), tally) in days {
        statements.push(
            db.prepare(
                "INSERT INTO artifacts_meters (day, store, repo, workspace, meter, count, bytes_in, bytes_out)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (day, store, repo, meter) DO UPDATE SET
                   count = count + ?6, bytes_in = bytes_in + ?7, bytes_out = bytes_out + ?8,
                   workspace = CASE WHEN ?4 = '' THEN workspace ELSE ?4 END",
            )
            .bind(&[
                day.into(),
                store.into(),
                repo.into(),
                workspace.into(),
                meter.into(),
                (tally.count as f64).into(),
                (tally.bytes_in as f64).into(),
                (tally.bytes_out as f64).into(),
            ])?,
        );
    }
    for ((store, minute), health) in &pending.health {
        statements.push(
            db.prepare(
                "INSERT INTO store_health (store, minute, calls, errors, rate_limited, rejected, ms_total)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (store, minute) DO UPDATE SET
                   calls = calls + ?3, errors = errors + ?4, rate_limited = rate_limited + ?5,
                   rejected = rejected + ?6, ms_total = ms_total + ?7",
            )
            .bind(&[
                store.as_str().into(),
                minute.as_str().into(),
                (health.calls as f64).into(),
                (health.errors as f64).into(),
                (health.rate_limited as f64).into(),
                (health.rejected as f64).into(),
                (health.ms_total as f64).into(),
            ])?,
        );
    }
    let billable = pending.billable(mapping);
    for ((workspace, hour), operations) in &billable {
        // Whole operations only; a fraction left over is dropped.
        let operations = operations.round();
        if operations < 1.0 {
            continue;
        }
        statements.push(
            db.prepare(
                "INSERT INTO git_operations (namespace, hour, operations) VALUES (?1, ?2, ?3)
                 ON CONFLICT (namespace, hour) DO UPDATE SET operations = operations + ?3",
            )
            .bind(&[workspace.as_str().into(), hour.as_str().into(), operations.into()])?,
        );
    }
    // Health and meters are kept for a while only.
    if pending.health.keys().any(|(_, minute)| minute.ends_with(":00")) {
        let cutoff = g1t_contracts::time::rfc3339(g1t_kit::now_ms().saturating_sub(24 * 3600 * 1000))[..16].to_owned();
        statements.push(db.prepare("DELETE FROM store_health WHERE minute < ?1").bind(&[cutoff.into()])?);
    }
    while !statements.is_empty() {
        let rest = statements.split_off(statements.len().min(BATCH));
        db.batch(statements).await?;
        statements = rest;
    }
    // What each workspace now stands at, for its free limits (git_ops.rs).
    let workspaces: Vec<String> = billable.keys().map(|(workspace, _)| workspace.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    for workspace in workspaces {
        if let Err(error) = crate::git_ops::refresh(db, &workspace).await {
            worker::console_error!("git operations of {workspace} not read back: {error}");
        }
    }
    Ok(())
}

/// One meter's total, as `artifacts_usage` answers.
#[derive(Debug, Serialize, Deserialize)]
pub struct UsageRow {
    pub day: String,
    pub store: String,
    #[serde(default)]
    pub repo: Option<String>,
    pub workspace: String,
    pub meter: String,
    pub count: f64,
    pub bytes_in: f64,
    pub bytes_out: f64,
}

/// `artifacts_usage`: the raw meters from `from` to `to` (days, inclusive).
#[derive(Debug, Deserialize)]
pub struct UsageArgs {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub workspace: Option<String>,
    /// One row per repository; otherwise per workspace.
    #[serde(default)]
    pub by_repo: bool,
}

#[derive(Debug, Serialize)]
pub struct Usage {
    pub rows: Vec<UsageRow>,
    /// Which meters count, and for how much, now.
    pub mapping: Vec<MappingRow>,
    /// Whether rows were left out (more than `MAX_USAGE_ROWS`).
    pub truncated: bool,
}

const MAX_USAGE_ROWS: usize = 10_000;

pub async fn usage(db: &D1Database, a: &UsageArgs) -> Result<Usage> {
    let (repo, group) = if a.by_repo { ("repo", "day, store, repo, workspace, meter") } else { ("NULL AS repo", "day, store, workspace, meter") };
    let sql = format!(
        "SELECT day, store, {repo}, workspace, meter, SUM(count) AS count, SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out
         FROM artifacts_meters WHERE day >= ?1 AND day <= ?2 AND (?3 IS NULL OR workspace = ?3)
         GROUP BY {group} ORDER BY day, store, workspace, meter LIMIT {}",
        MAX_USAGE_ROWS + 1
    );
    let mut rows = db
        .prepare(sql)
        .bind(&[a.from.as_str().into(), a.to.as_str().into(), a.workspace.as_deref().map_or(JsValue::NULL, JsValue::from)])?
        .all()
        .await?
        .results::<UsageRow>()?;
    let truncated = rows.len() > MAX_USAGE_ROWS;
    rows.truncate(MAX_USAGE_ROWS);
    Ok(Usage { rows, mapping: read_mapping(db).await?, truncated })
}

/// How the store has answered over the last minutes, per namespace, for
/// the status page.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct StoreHealth {
    pub store: String,
    pub calls: f64,
    pub errors: f64,
    pub rate_limited: f64,
    pub rejected: f64,
    pub ms_total: f64,
}

#[derive(Debug, Serialize)]
pub struct HealthReport {
    pub minutes: u32,
    pub stores: Vec<StoreHealth>,
}

#[derive(Debug, Deserialize)]
pub struct HealthArgs {
    #[serde(default)]
    pub minutes: Option<u32>,
}

pub async fn health(db: &D1Database, a: &HealthArgs) -> Result<HealthReport> {
    let minutes = a.minutes.unwrap_or(5).clamp(1, 60);
    let since = g1t_contracts::time::rfc3339(g1t_kit::now_ms().saturating_sub(u64::from(minutes) * 60_000))[..16].to_owned();
    let stores = db
        .prepare(
            "SELECT store, SUM(calls) AS calls, SUM(errors) AS errors, SUM(rate_limited) AS rate_limited,
                    SUM(rejected) AS rejected, SUM(ms_total) AS ms_total
             FROM store_health WHERE minute >= ?1 GROUP BY store ORDER BY store",
        )
        .bind(&[since.into()])?
        .all()
        .await?
        .results::<StoreHealth>()?;
    Ok(HealthReport { minutes, stores })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(hour: &str, workspace: &str, meter: &str) -> Place {
        Place { hour: hour.into(), store: "g1t".into(), repo: format!("{workspace}--rocket"), workspace: workspace.into(), meter: meter.into() }
    }

    #[test]
    fn counts_are_written_now_and_then_not_on_every_request() {
        // At once only when the last write was a while ago or much has
        // piled up; otherwise once it is due.
        assert_eq!(plan(1, 0, None, 100_000), Some(0));
        assert_eq!(plan(3, 100_000, None, 100_000 + FLUSH_EVERY_MS - 1), Some(1));
        assert_eq!(plan(3, 100_000, None, 100_000 + FLUSH_EVERY_MS), Some(0));
        assert_eq!(plan(FLUSH_AT_PLACES, 100_000, None, 100_001), Some(0));
    }

    #[test]
    fn what_a_request_counts_is_written_even_if_no_request_follows() {
        // Nothing waiting: nothing planned.
        assert_eq!(plan(0, 0, None, 100_000), None);
        // Due: written at once.
        assert_eq!(plan(1, 0, None, 100_000), Some(0));
        // Counted a second after the last write: the write is planned for
        // when it is due, not left for the next request.
        assert_eq!(plan(3, 100_000, None, 101_000), Some(FLUSH_EVERY_MS - 1_000));
        // One planned already: the requests after it plan none...
        assert_eq!(plan(3, 100_000, Some(101_000), 102_000), None);
        // ...unless much has piled up, which is written at once,
        assert_eq!(plan(FLUSH_AT_PLACES, 100_000, Some(101_000), 102_000), Some(0));
        // or the planned one never began (its request was cut short).
        assert_eq!(plan(3, 100_000, Some(101_000), 101_000 + PLAN_STALE_MS), Some(0));
        // Never planned further off than the interval.
        assert!(plan(1, 100_000, None, 100_000).is_some_and(|wait| wait <= FLUSH_EVERY_MS));
    }

    #[test]
    fn meters_add_up_by_place() {
        let mut pending = Pending::default();
        pending.meter(place("2026-10-14T09", "acme", "git.fetch"), 300, 5_000);
        pending.meter(place("2026-10-14T09", "acme", "git.fetch"), 200, 1_000);
        pending.meter(place("2026-10-14T09", "acme", "git.ls_refs"), 100, 50);
        assert_eq!(pending.usage[&place("2026-10-14T09", "acme", "git.fetch")], Tally { count: 2, bytes_in: 500, bytes_out: 6_000 });
        assert_eq!(pending.usage.len(), 2);
    }

    #[test]
    fn what_a_workspace_is_counted_for_follows_the_mapping() {
        let mut pending = Pending::default();
        for _ in 0..3 {
            pending.meter(place("2026-10-14T09", "acme", "git.fetch"), 0, 0);
        }
        pending.meter(place("2026-10-14T09", "acme", "git.ls_refs"), 0, 0);
        pending.meter(place("2026-10-14T09", "acme", "binding.read_tree"), 0, 0);
        pending.meter(place("2026-10-14T10", "acme", "git.receive_pack"), 0, 0);
        // Unknown workspace: metered, never billed.
        pending.meter(place("2026-10-14T10", "", "git.fetch"), 0, 0);
        let defaults = pending.billable(&Mapping::defaults());
        assert_eq!(defaults[&("acme".to_owned(), "2026-10-14T09".to_owned())], 3.0);
        assert_eq!(defaults[&("acme".to_owned(), "2026-10-14T10".to_owned())], 1.0);
        assert_eq!(defaults.len(), 2);
        // The day Cloudflare says listing refs counts too: data, not code.
        let mut rows: Vec<MappingRow> = DEFAULT_OPERATIONS
            .iter()
            .map(|meter| MappingRow { meter: (*meter).into(), cost_operations: 1.0, billable_operations: 1.0, ..MappingRow::default() })
            .collect();
        rows.push(MappingRow { meter: "git.ls_refs".into(), cost_operations: 1.0, billable_operations: 0.5, ..MappingRow::default() });
        let changed = pending.billable(&Mapping::from_rows(&rows));
        assert_eq!(changed[&("acme".to_owned(), "2026-10-14T09".to_owned())], 3.5);
        assert_eq!(Mapping::from_rows(&rows).cost("git.ls_refs"), 1.0);
        assert_eq!(Mapping::defaults().billable("binding.read_blob"), 0.0);
    }

    #[test]
    fn a_working_copy_is_counted_for_its_repositorys_workspace() {
        let copy = |meter: &str, pull: &str| Place {
            hour: "2026-10-14T09".into(),
            store: "g1t".into(),
            repo: format!("pulls--{pull}"),
            workspace: "pulls".into(),
            meter: meter.into(),
        };
        let mut pending = Pending::default();
        // A pull request's working copy is made, an agent's sandbox clones
        // it and pushes to it, and checks clone it again; another pull
        // request's repository is not found.
        pending.meter(copy("binding.fork", "pul_7"), 0, 0);
        pending.meter(copy("git.fetch", "pul_7"), 100, 9_000);
        pending.meter(copy("git.receive_pack", "pul_7"), 4_000, 50);
        pending.meter(copy("git.fetch", "pul_7"), 100, 9_000);
        pending.meter(copy("git.fetch", "pul_8"), 0, 0);
        pending.meter(place("2026-10-14T09", "acme", "git.fetch"), 0, 0);
        pending.health("g1t", "2026-10-14T09:01", Outcome::Ok, 5);
        assert_eq!(pending.unattributed_pulls(), ["pul_7", "pul_8"]);
        // As they are: counted for a workspace called `pulls`.
        let before = pending.billable(&Mapping::defaults());
        assert_eq!(before[&("pulls".to_owned(), "2026-10-14T09".to_owned())], 5.0);

        let owners = HashMap::from([("pul_7".to_owned(), "acme".to_owned())]);
        let attributed = pending.attributed(&owners);
        let billable = attributed.billable(&Mapping::defaults());
        assert_eq!(billable[&("acme".to_owned(), "2026-10-14T09".to_owned())], 5.0);
        assert_eq!(billable[&("pulls".to_owned(), "2026-10-14T09".to_owned())], 1.0);
        // The meters keep the working copy's own name, with its workspace.
        let mut counted = copy("git.fetch", "pul_7");
        counted.workspace = "acme".into();
        assert_eq!(attributed.usage[&counted], Tally { count: 2, bytes_in: 200, bytes_out: 18_000 });
        assert_eq!(attributed.health.len(), 1);
        assert_eq!(attributed.unattributed_pulls(), ["pul_8"]);
        // Nothing else is a working copy.
        assert_eq!(working_copy("pulls--pul_7"), Some("pul_7"));
        assert_eq!(working_copy("pulls--"), None);
        assert_eq!(working_copy("pullsx--pul_7"), None);
        assert_eq!(working_copy("acme--pulls"), None);
    }

    #[test]
    fn health_counts_failures_and_rejections_apart() {
        let mut pending = Pending::default();
        pending.health("g1t", "2026-10-14T09:01", Outcome::Ok, 40);
        pending.health("g1t", "2026-10-14T09:01", Outcome::Failed, 900);
        pending.health("g1t", "2026-10-14T09:01", Outcome::RateLimited, 10);
        pending.health("g1t", "2026-10-14T09:01", Outcome::Rejected, 0);
        let health = pending.health[&("g1t".to_owned(), "2026-10-14T09:01".to_owned())];
        assert_eq!(health, Health { calls: 3, errors: 2, rate_limited: 1, rejected: 1, ms_total: 950 });
    }

    #[test]
    fn a_failed_write_is_put_back() {
        let mut kept = Pending::default();
        kept.meter(place("2026-10-14T09", "acme", "git.fetch"), 1, 2);
        let mut taken = Pending::default();
        taken.meter(place("2026-10-14T09", "acme", "git.fetch"), 10, 20);
        taken.health("g1t", "2026-10-14T09:01", Outcome::Ok, 5);
        kept.merge(taken);
        assert_eq!(kept.usage[&place("2026-10-14T09", "acme", "git.fetch")], Tally { count: 2, bytes_in: 11, bytes_out: 22 });
        assert_eq!(kept.health.len(), 1);
    }

    #[test]
    fn a_key_is_counted_for_its_workspace() {
        assert_eq!(super::place_at("git.fetch", "g1t-us-1/acme--rocket", String::new()).store, "g1t-us-1");
        assert_eq!(super::place_at("git.fetch", "g1t-us-1/acme--rocket", String::new()).workspace, "acme");
        assert_eq!(super::place_at("git.fetch", "acme--rocket", String::new()).store, "g1t");
        assert_eq!(workspace_of("zz--unknown", "zz--unknown"), "zz");
        note_owner("rep_9", "acme");
        assert_eq!(workspace_of("rep_9", "rep_9"), "acme");
        assert_eq!(workspace_of("rep_8", "rep_8"), "");
    }
}
