//! The cache of `actions/cache`: which entries each repository has, kept
//! here, while the API keeps their bytes in R2 (the ACTIONS_CACHE bucket).
//!
//! - Entries are scoped by ref, as on GitHub (`scopes`): an entry belongs
//!   to the ref whose run saved it, and a run restores from its own ref,
//!   then its pull request's base branch, then the default branch. A pull
//!   request from outside the repository saves under `untrusted:<ref>`,
//!   which no other ref reads, so it can never plant an entry the default
//!   branch restores. g1t's own `actions/cache` and the toolkit's protocols
//!   follow the same rule (`Actions::cache_scope`).
//! - An entry's version is the hash of its paths and compression, which
//!   the toolkit's client and g1t's runner both send: the same key saved
//!   for other paths is another entry.
//! - A key is written once in its scope and version. In each scope in
//!   turn, a restore finds its key exactly, else the newest entry whose key
//!   starts with its key, else with each of its restore keys in order
//!   (`prefixes`), as GitHub's cache does. An upload holds its key while
//!   its job runs, for at most `PENDING_MS`: a job that ends lets go of
//!   what it did not finish (`release_cache`), and the next job to save
//!   the key takes it over (`RESERVE`).
//! - An entry is at most `CACHE_MAX_ENTRY_BYTES`. A repository's entries
//!   hold at most `CACHE_REPO_QUOTA_BYTES` together: saving past it evicts
//!   the entries restored longest ago.
//! - An entry not restored for `CACHE_UNUSED_DAYS`, or saved more than
//!   `CACHE_MAX_AGE_DAYS` ago, is deleted by the hourly sweep, which also
//!   writes down what each workspace holds, its artifacts included (they
//!   are in the same bucket), and reports this month's storage to billing
//!   (`note_pending`, source `cache`) at R2's price.
//!
//! - People list a repository's entries and what they hold together
//!   (`caches`, `cache_usage`), and delete them (`delete_caches`), through
//!   the API's `/repos/{owner}/{repo}/actions/caches`, as on GitHub.
//!
//! The API calls these with the job's token, or its runtime token for the
//! toolkit's protocols (runtime.rs), which is checked here. An entry the
//! toolkit saves has the toolkit's version, and is found only by the same
//! version; g1t's own `actions/cache` saves and finds entries without one.

use g1t_contracts::FailureCode;
use g1t_contracts::Outcome;
use g1t_contracts::access::Capability;
use g1t_contracts::actions::{
    CACHE_MAX_AGE_DAYS, CACHE_MAX_ENTRY_BYTES, CACHE_MICROS_PER_GB_MONTH, CACHE_REPO_QUOTA_BYTES, CACHE_UNUSED_DAYS,
    CacheAbortArgs, CacheCommitArgs, CacheCommitted, CacheEntry, CacheHit, CacheList, CacheLookupArgs, CacheReservation,
    CacheReserveArgs, CacheUploadArgs, CacheUsage, CacheUsageArgs, CachesArgs, DeleteCachesArgs,
};
use g1t_contracts::billing::NotePendingArgs;
use g1t_contracts::new_id;
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Actions, check, fail};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// An upload not finished after this long is given up, whether or not its
/// job is still running.
const PENDING_MS: u64 = 6 * 60 * 60 * 1000;
/// When an entry was last restored is written down at most this often: a
/// tool that restores an entry per compiled file (sccache) would otherwise
/// write a row on every read, for an order that eviction needs only
/// roughly.
const TOUCH_MS: u64 = 60 * 60 * 1000;
/// Rows deleted or marked by id in one statement: D1 binds at most 100
/// values to one.
const IDS_PER_STATEMENT: usize = 50;
/// A GB, as storage is billed.
const GB: f64 = 1_000_000_000.0;

#[derive(Debug, Deserialize)]
struct EntryRow {
    id: String,
    key: String,
    object: String,
    size: f64,
    created_at: String,
    last_used_at: String,
}

/// Reserves a key in its scope and version for a job (`?10`). A key is
/// written once there, never into another ref's scope: a reservation takes
/// the row of an earlier one only when that one expired, was left
/// unfinished before `?11`, or was made by a job that is no longer running
/// (it finished, failed or was cancelled before it saved). Gives the
/// entry's number, or nothing when the key is taken.
pub(crate) const RESERVE: &str = "INSERT INTO cache_entries (id, repo_id, namespace, key, object, size, status, created_at, last_used_at, version, scope, job_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7, ?8, ?9, ?10)
     ON CONFLICT (repo_id, scope, key, version) DO UPDATE SET
       id = ?1, object = ?5, size = ?6, status = 'pending', created_at = ?7, last_used_at = ?7, version = ?8, upload = NULL, job_id = ?10
     WHERE cache_entries.status = 'expired'
        OR (cache_entries.status = 'pending' AND (
              cache_entries.created_at < ?11
              OR (cache_entries.job_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = cache_entries.job_id AND jobs.status = 'in_progress'))))
     RETURNING rowid AS number";

/// A job's uploads it never finished, once it has ended: their keys are
/// free for the next job at once, and the sweep deletes whatever bytes
/// they had sent.
pub(crate) const RELEASE: &str = "UPDATE cache_entries SET status = 'expired' WHERE job_id = ? AND status = 'pending'";

/// The least text after every key that starts with `prefix`: its last
/// character, one higher. Keys compare byte by byte, and UTF-8 keeps the
/// order of characters, so `key >= prefix AND key < end` is exactly the
/// keys that start with `prefix`, whatever they hold (`%`, `_` and `/`
/// included), and the index on keys finds them. None when there is no such
/// text (a prefix of only the highest character).
pub(crate) fn prefix_end(prefix: &str) -> Option<String> {
    let mut chars: Vec<char> = prefix.chars().collect();
    while let Some(last) = chars.pop() {
        // Surrogates are not characters: the one after U+D7FF is U+E000.
        let next = if last == '\u{D7FF}' { Some('\u{E000}') } else { char::from_u32(u32::from(last) + 1) };
        if let Some(next) = next {
            chars.push(next);
            return Some(chars.into_iter().collect());
        }
    }
    None
}

/// The condition that a key starts with `prefix`, and the values it binds:
/// a range the index serves (`prefix_end`), or, without an end, by its
/// first characters.
pub(crate) fn key_prefix(prefix: &str) -> (&'static str, [String; 2]) {
    match prefix_end(prefix) {
        Some(end) => ("key >= ? AND key < ?", [prefix.to_owned(), end]),
        None => ("substr(key, 1, length(?)) = ?", [prefix.to_owned(), prefix.to_owned()]),
    }
}

/// A restore's lookup of the newest entry whose key starts with a prefix,
/// around its condition on keys (`key_prefix`): the repository, scope,
/// prefix, version and the oldest an entry may be saved, bound in order.
const PREFIX_LOOKUP_START: &str = "SELECT id, key, object, size, created_at, last_used_at FROM cache_entries
     WHERE repo_id = ? AND scope = ? AND ";
const PREFIX_LOOKUP_END: &str = " AND version = ? AND +status = 'ready' AND +created_at > ?
     ORDER BY created_at DESC LIMIT 1";

/// Whether an entry last restored at `last_used_at` is written down as
/// restored again at `now`: not when it was within `TOUCH_MS`.
pub(crate) fn touch_due(last_used_at: &str, now: u64) -> bool {
    last_used_at < rfc3339(now.saturating_sub(TOUCH_MS)).as_str()
}

/// `{statement} (?, ?, …)` for each run of at most `IDS_PER_STATEMENT` ids:
/// the statements and the ids each binds.
pub(crate) fn by_ids<'a>(statement: &str, ids: &'a [String]) -> Vec<(String, &'a [String])> {
    ids.chunks(IDS_PER_STATEMENT).map(|chunk| (format!("{statement} ({})", vec!["?"; chunk.len()].join(", ")), chunk)).collect()
}

/// The longest key: GitHub's limit.
const MAX_KEY_CHARS: usize = 512;

/// Whether a key can be kept: 1 to 512 characters, no commas (GitHub's rule).
pub(crate) fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.chars().count() <= MAX_KEY_CHARS && !key.contains(',')
}

/// Which of `entries` (id, size, newest use first) to evict so that the
/// repository holds at most `quota` with `keep` (just saved) among them.
/// The entry just saved is never evicted.
pub(crate) fn to_evict(entries: &[(String, u64)], keep: &str, quota: u64) -> Vec<String> {
    let mut total: u64 = entries.iter().map(|(_, size)| size).sum();
    let mut out = Vec::new();
    for (id, size) in entries.iter().rev() {
        if total <= quota {
            break;
        }
        if id == keep {
            continue;
        }
        total = total.saturating_sub(*size);
        out.push(id.clone());
    }
    out
}

/// Whether a repository holding `total` bytes must evict to stay within
/// `quota`: what `to_evict` would take something from.
pub(crate) fn over_quota(total: u64, quota: u64) -> bool {
    total > quota
}

/// A month's GB-months from the bytes held each day so far: each day's
/// bytes over 30 days.
pub(crate) fn gb_months(days: &[u64]) -> f64 {
    days.iter().map(|bytes| *bytes as f64).sum::<f64>() / GB / 30.0
}

/// What `gb_months` of cache cost g1t, in millionths of a dollar.
pub(crate) fn storage_cost(gb_months: f64) -> i64 {
    (gb_months * CACHE_MICROS_PER_GB_MONTH as f64).ceil() as i64
}

/// The prefixes a restore tries in each scope once its key has no exact
/// match, in order: the key itself, then its restore keys. Blank ones and
/// repeats are dropped.
pub(crate) fn prefixes<'a>(key: &'a str, restore: &'a [String]) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for prefix in std::iter::once(key).chain(restore.iter().map(String::as_str)).map(str::trim) {
        if !prefix.is_empty() && !out.contains(&prefix) {
            out.push(prefix);
        }
    }
    out
}

/// The `ORDER BY` of a list of entries, from GitHub's `sort`
/// (`last_accessed_at` by default) and `direction` (`desc` by default);
/// `None` for a name it does not have. Ties go by when each was saved.
pub(crate) fn cache_order(sort: Option<&str>, direction: Option<&str>) -> Option<String> {
    let column = match sort.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("last_accessed_at") {
        "last_accessed_at" => "last_used_at",
        "created_at" => "created_at",
        "size_in_bytes" => "size",
        _ => return None,
    };
    let direction = match direction.map(str::trim).filter(|d| !d.is_empty()).unwrap_or("desc") {
        "asc" => "ASC",
        "desc" => "DESC",
        _ => return None,
    };
    Some(format!("{column} {direction}, rowid {direction}"))
}

/// A saved entry, as `caches` lists it.
#[derive(Debug, Deserialize)]
struct ListedRow {
    id: String,
    number: f64,
    key: String,
    scope: String,
    version: String,
    object: String,
    size: f64,
    created_at: String,
    last_used_at: String,
}

impl ListedRow {
    fn view(&self) -> CacheEntry {
        CacheEntry {
            id: self.number as u64,
            key: self.key.clone(),
            git_ref: self.scope.clone(),
            version: self.version.clone(),
            size_in_bytes: self.size as u64,
            created_at: self.created_at.clone(),
            last_accessed_at: self.last_used_at.clone(),
        }
    }
}

const LISTED: &str = "SELECT id, rowid AS number, key, scope, version, object, size, created_at, last_used_at FROM cache_entries";

/// Where a job's cache entries are found and saved: its repository, and in
/// it the refs it restores from, in order, and the one it saves to.
pub(crate) struct CacheScope {
    pub repo_id: String,
    pub restore: Vec<String>,
    pub save: String,
}

/// The scopes a run's jobs restore from, in order, and the one they save
/// to: its own ref, then its pull request's base branch, then the default
/// branch. A run that is not trusted (a pull request from outside) saves to
/// a scope of its own that no other ref reads.
pub(crate) fn scopes(git_ref: &str, base_ref: Option<&str>, default_branch: &str, trusted: bool) -> (Vec<String>, String) {
    let own = if trusted { git_ref.to_owned() } else { format!("untrusted:{git_ref}") };
    let mut restore = vec![own.clone()];
    let base = base_ref.filter(|base| !base.is_empty()).map(|base| format!("refs/heads/{}", base.trim_start_matches("refs/heads/")));
    for scope in base.into_iter().chain(std::iter::once(format!("refs/heads/{default_branch}"))) {
        if !restore.contains(&scope) {
            restore.push(scope);
        }
    }
    (restore, own)
}

/// Where a job's entries are found and saved (`scopes`), for g1t's own
/// `actions/cache` and the toolkit's protocols alike, from its run.
fn cache_scope(job: &crate::plan::JobRow, run: Option<&crate::plan::RunRow>) -> CacheScope {
    let (restore, save) = match run {
        Some(run) => {
            let info = run.info();
            scopes(&run.git_ref, info.base_ref.as_deref(), &info.default_branch, run.trusted != 0)
        }
        None => (Vec::new(), format!("untrusted:{}", job.run_id)),
    };
    CacheScope { repo_id: job.repo_id.clone(), restore, save }
}

impl Actions {
    /// A job by its own token or its runtime token (runtime.rs).
    async fn cache_job(&self, job: &str, token: &str) -> Result<Outcome<crate::plan::JobRow>> {
        self.job_for_credential(job, token).await
    }

    /// A job by its credential, as `cache_job`, and where its entries are.
    /// A runtime token names its run, which is read alongside the job
    /// rather than after it; it is used only once the token is checked and
    /// the job's row names the same run.
    async fn cache_job_scope(&self, job: &str, token: &str) -> Result<Outcome<(crate::plan::JobRow, CacheScope)>> {
        let claimed = crate::runtime::runtime_run(token);
        let claimed_run = async {
            match &claimed {
                Some(run) => self.run_row(run).await,
                None => Ok(None),
            }
        };
        let (checked, claimed_run) = futures_util::future::join(self.cache_job(job, token), claimed_run).await;
        let job = check!(checked?);
        let run = match claimed_run? {
            Some(run) if run.id == job.run_id => Some(run),
            _ => self.run_row(&job.run_id).await?,
        };
        let scope = cache_scope(&job, run.as_ref());
        Ok(Outcome::Ok((job, scope)))
    }

    /// `cache_lookup`.
    pub async fn cache_lookup(&self, a: CacheLookupArgs) -> Result<Outcome<Option<CacheHit>>> {
        let (_, scope) = check!(self.cache_job_scope(&a.job, &a.token).await?);
        let now = now_ms();
        let fresh = rfc3339(now.saturating_sub(CACHE_MAX_AGE_DAYS * DAY_MS));
        // Found only by the same version: runners from before it was sent
        // send none, and find only entries saved without one.
        let version = a.version.clone().unwrap_or_default();
        let mut found = None;
        'scopes: for ref_scope in &scope.restore {
            found = self
                .db
                .prepare(
                    "SELECT id, key, object, size, created_at, last_used_at FROM cache_entries
                     WHERE repo_id = ? AND scope = ? AND key = ? AND version = ? AND status = 'ready' AND created_at > ?",
                )
                .bind(&[
                    scope.repo_id.as_str().into(),
                    ref_scope.as_str().into(),
                    a.key.as_str().into(),
                    version.as_str().into(),
                    fresh.as_str().into(),
                ])?
                .first::<EntryRow>(None)
                .await?;
            if found.is_some() {
                break;
            }
            for prefix in prefixes(&a.key, &a.restore) {
                let (starts, bounds) = key_prefix(prefix);
                // `+` keeps SQLite from reading these through the index by
                // scope and time, which holds every entry of the scope:
                // the range of keys, through the index on keys, is far
                // narrower.
                found = self
                    .db
                    .prepare(format!("{PREFIX_LOOKUP_START}{starts}{PREFIX_LOOKUP_END}"))
                    .bind(&[
                        scope.repo_id.as_str().into(),
                        ref_scope.as_str().into(),
                        bounds[0].as_str().into(),
                        bounds[1].as_str().into(),
                        version.as_str().into(),
                        fresh.as_str().into(),
                    ])?
                    .first::<EntryRow>(None)
                    .await?;
                if found.is_some() {
                    break 'scopes;
                }
            }
        }
        let Some(entry) = found else { return Ok(Outcome::Ok(None)) };
        if touch_due(&entry.last_used_at, now) {
            self.db
                .prepare("UPDATE cache_entries SET last_used_at = ? WHERE id = ?")
                .bind(&[rfc3339(now).into(), entry.id.as_str().into()])?
                .run()
                .await?;
        }
        let blob = a.version.as_ref().and_then(|_| self.download_token("cache", &entry.id, &entry.object, crate::runtime::DOWNLOAD_SECONDS));
        Ok(Outcome::Ok(Some(CacheHit { key: entry.key, object: entry.object, size: entry.size as u64, created_at: entry.created_at, blob })))
    }

    /// `cache_upload`.
    pub async fn cache_upload(&self, a: CacheUploadArgs) -> Result<Outcome<CacheReservation>> {
        #[derive(Deserialize)]
        struct Pending {
            id: String,
            object: String,
            number: f64,
            upload: Option<String>,
        }
        let columns = "SELECT id, object, rowid AS number, upload FROM cache_entries";
        // By number, only the job's repository is needed; by key, its
        // scope too.
        let pending = match (a.number, a.key.as_deref()) {
            (Some(number), _) => {
                let job = check!(self.cache_job(&a.job, &a.token).await?);
                self.db
                    .prepare(format!("{columns} WHERE rowid = ? AND repo_id = ? AND status = 'pending'"))
                    .bind(&[(number as f64).into(), job.repo_id.as_str().into()])?
                    .first::<Pending>(None)
                    .await?
            }
            (None, Some(key)) => {
                let (_, scope) = check!(self.cache_job_scope(&a.job, &a.token).await?);
                self.db
                    .prepare(format!("{columns} WHERE repo_id = ? AND scope = ? AND key = ? AND version = ? AND status = 'pending'"))
                    .bind(&[scope.repo_id.as_str().into(), scope.save.as_str().into(), key.into(), a.version.clone().unwrap_or_default().into()])?
                    .first::<Pending>(None)
                    .await?
            }
            (None, None) => {
                check!(self.cache_job(&a.job, &a.token).await?);
                None
            }
        };
        let Some(pending) = pending else {
            return Ok(fail(FailureCode::NotFound, "No upload of that entry is in progress."));
        };
        let blob = match &pending.upload {
            Some(upload) => match self.upload_token("cache", &pending.id, &pending.object, upload) {
                Some(blob) => Some(blob),
                None => return Ok(fail(FailureCode::Invalid, "The toolkit's storage is not set up here: the actions service has no ACTIONS_KEY.")),
            },
            None => None,
        };
        Ok(Outcome::Ok(CacheReservation { id: pending.id, object: pending.object, number: pending.number as u64, upload: pending.upload, blob }))
    }

    /// `cache_reserve`.
    pub async fn cache_reserve(&self, a: CacheReserveArgs) -> Result<Outcome<CacheReservation>> {
        let (job, scope) = check!(self.cache_job_scope(&a.job, &a.token).await?);
        if !valid_key(&a.key) {
            return Ok(fail(FailureCode::Invalid, format!("A cache key is 1 to {MAX_KEY_CHARS} characters, without commas.")));
        }
        if a.size > CACHE_MAX_ENTRY_BYTES {
            return Ok(fail(
                FailureCode::Invalid,
                format!("It is {} MB; a cache entry is at most {} MB.", a.size / 1_048_576, CACHE_MAX_ENTRY_BYTES / 1_048_576),
            ));
        }
        if let Some(why) = self.storage_refused(&job.namespace, a.size).await? {
            return Ok(fail(FailureCode::Limit, why));
        }
        let now = now_ms();
        let at = rfc3339(now);
        let version = a.version.clone().unwrap_or_default();
        let id = new_id("cache", now);
        let object = format!("c/{}/{id}", scope.repo_id);
        #[derive(Deserialize)]
        struct Inserted {
            number: f64,
        }
        let inserted = self
            .db
            .prepare(RESERVE)
            .bind(&[
                id.as_str().into(),
                scope.repo_id.as_str().into(),
                job.namespace.as_str().into(),
                a.key.as_str().into(),
                object.as_str().into(),
                (a.size as f64).into(),
                at.as_str().into(),
                version.as_str().into(),
                scope.save.as_str().into(),
                job.id.as_str().into(),
                rfc3339(now.saturating_sub(PENDING_MS)).into(),
            ])?
            .first::<Inserted>(None)
            .await?;
        let Some(inserted) = inserted else {
            return Ok(fail(FailureCode::Conflict, "That key is already cached."));
        };
        // A token for its upload, whose R2 upload is not started yet: the
        // API puts an entry sent in one request whole, and starts one only
        // for an entry sent in blocks (runtime.rs `blob_start`).
        let blob = self.upload_token("cache", &id, &object, "");
        Ok(Outcome::Ok(CacheReservation { id, object, number: inserted.number as u64, upload: None, blob }))
    }

    /// `cache_commit`: the entry is ready; entries past the quota are
    /// evicted, restored longest ago first.
    pub async fn cache_commit(&self, a: CacheCommitArgs) -> Result<Outcome<CacheCommitted>> {
        let job = check!(self.cache_job(&a.job, &a.token).await?);
        if a.size > CACHE_MAX_ENTRY_BYTES {
            return Ok(fail(FailureCode::Invalid, "That entry is larger than a cache entry may be."));
        }
        // The entry is ready, and what the repository holds is summed, in
        // one round trip: only past the quota are its entries listed to
        // choose what to evict. A tool that saves an entry per compiled
        // file (sccache) commits thousands of small entries a build, and
        // listing them all on each was quadratic.
        #[derive(Deserialize)]
        struct Total {
            bytes: Option<f64>,
        }
        let mut results = self
            .db
            .batch(vec![
                self.db
                    .prepare("UPDATE cache_entries SET status = 'ready', size = ?, last_used_at = ? WHERE id = ? AND repo_id = ? AND status = 'pending' RETURNING id")
                    .bind(&[(a.size as f64).into(), rfc3339(now_ms()).into(), a.id.as_str().into(), job.repo_id.as_str().into()])?,
                self.db
                    .prepare("SELECT SUM(size) AS bytes FROM cache_entries WHERE repo_id = ? AND status = 'ready'")
                    .bind(&[job.repo_id.as_str().into()])?,
            ])
            .await?
            .into_iter();
        let ready = match results.next() {
            Some(ready) => ready.results::<Value>()?,
            None => Vec::new(),
        };
        if ready.is_empty() {
            return Ok(fail(FailureCode::NotFound, "No upload of that entry is in progress."));
        }
        let total = match results.next() {
            Some(total) => total.results::<Total>()?.into_iter().next().and_then(|t| t.bytes).unwrap_or(0.0),
            None => 0.0,
        };
        if !over_quota(total as u64, CACHE_REPO_QUOTA_BYTES) {
            return Ok(Outcome::Ok(CacheCommitted { evicted: Vec::new() }));
        }
        #[derive(Deserialize)]
        struct Held {
            id: String,
            object: String,
            size: f64,
        }
        let held = self
            .db
            .prepare("SELECT id, object, size FROM cache_entries WHERE repo_id = ? AND status = 'ready' ORDER BY last_used_at DESC")
            .bind(&[job.repo_id.as_str().into()])?
            .all()
            .await?
            .results::<Held>()?;
        let sizes: Vec<(String, u64)> = held.iter().map(|h| (h.id.clone(), h.size as u64)).collect();
        let evict = to_evict(&sizes, &a.id, CACHE_REPO_QUOTA_BYTES);
        self.delete_entries(&evict).await?;
        let evicted = evict.iter().filter_map(|id| held.iter().find(|h| &h.id == id)).map(|entry| entry.object.clone()).collect();
        Ok(Outcome::Ok(CacheCommitted { evicted }))
    }

    /// `cache_abort`.
    pub async fn cache_abort(&self, a: CacheAbortArgs) -> Result<Outcome<bool>> {
        let job = check!(self.cache_job(&a.job, &a.token).await?);
        self.db
            .prepare("DELETE FROM cache_entries WHERE id = ? AND repo_id = ? AND status = 'pending'")
            .bind(&[a.id.as_str().into(), job.repo_id.as_str().into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }

    /// When a job ends: the uploads it reserved and never finished let go
    /// of their keys (`RELEASE`). A failure is logged: a reservation whose
    /// job is no longer running gives way to the next one anyway.
    pub(crate) async fn release_cache(&self, job_id: &str) {
        let released = async { self.db.prepare(RELEASE).bind(&[job_id.into()])?.run().await };
        if let Err(error) = released.await {
            worker::console_error!("actions: the cache uploads of job {job_id} were not released: {error}");
        }
    }

    /// Deletes entries' rows by id, in as few statements as D1 takes and
    /// one round trip.
    async fn delete_entries(&self, ids: &[String]) -> Result<()> {
        self.by_ids("DELETE FROM cache_entries WHERE id IN", ids).await
    }

    /// Runs `statement (?, …)` over `ids`, in one batch.
    async fn by_ids(&self, statement: &str, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut statements = Vec::new();
        for (sql, chunk) in by_ids(statement, ids) {
            let values: Vec<JsValue> = chunk.iter().map(|id| id.as_str().into()).collect();
            statements.push(self.db.prepare(sql).bind(&values)?);
        }
        self.db.batch(statements).await?;
        Ok(())
    }

    /// `caches`.
    pub async fn caches(&self, a: CachesArgs) -> Result<Outcome<CacheList>> {
        let Some(repo) = self.visible_repo(&a.repo, &a.viewer).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        let Some(order) = cache_order(a.sort.as_deref(), a.direction.as_deref()) else {
            return Ok(fail(FailureCode::Invalid, "sort is last_accessed_at, created_at or size_in_bytes, and direction asc or desc."));
        };
        let mut filter = "repo_id = ? AND status = 'ready'".to_owned();
        let mut values: Vec<JsValue> = vec![repo.id.as_str().into()];
        if let Some(key) = a.key.as_deref().filter(|k| !k.is_empty()) {
            let (starts, bounds) = key_prefix(key);
            filter.push_str(" AND ");
            filter.push_str(starts);
            values.extend(bounds.iter().map(|bound| JsValue::from(bound.as_str())));
        }
        if let Some(git_ref) = a.git_ref.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
            filter.push_str(" AND scope = ?");
            values.push(git_ref.into());
        }
        #[derive(Deserialize)]
        struct Count {
            n: f64,
        }
        let total = self
            .db
            .prepare(format!("SELECT COUNT(*) AS n FROM cache_entries WHERE {filter}"))
            .bind(&values)?
            .first::<Count>(None)
            .await?
            .map_or(0, |c| c.n as u64);
        let per_page = a.per_page.unwrap_or(30).clamp(1, 100);
        let page = a.page.unwrap_or(1).max(1);
        let mut paged = values.clone();
        paged.push(f64::from(per_page).into());
        paged.push(((f64::from(page) - 1.0) * f64::from(per_page)).into());
        let rows = self
            .db
            .prepare(format!("{LISTED} WHERE {filter} ORDER BY {order} LIMIT ? OFFSET ?"))
            .bind(&paged)?
            .all()
            .await?
            .results::<ListedRow>()?;
        Ok(Outcome::Ok(CacheList { total_count: total, actions_caches: rows.iter().map(ListedRow::view).collect() }))
    }

    /// `cache_usage`: what the entries `cache_commit` counts against the
    /// quota hold.
    pub async fn cache_usage(&self, a: CacheUsageArgs) -> Result<Outcome<CacheUsage>> {
        let Some(repo) = self.visible_repo(&a.repo, &a.viewer).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        #[derive(Deserialize)]
        struct Held {
            bytes: Option<f64>,
            n: f64,
        }
        let held = self
            .db
            .prepare("SELECT SUM(size) AS bytes, COUNT(*) AS n FROM cache_entries WHERE repo_id = ? AND status = 'ready'")
            .bind(&[repo.id.as_str().into()])?
            .first::<Held>(None)
            .await?;
        let (bytes, count) = held.map_or((0, 0), |h| (h.bytes.unwrap_or(0.0) as u64, h.n as u64));
        Ok(Outcome::Ok(CacheUsage { active_caches_size_in_bytes: bytes, active_caches_count: count, quota_bytes: CACHE_REPO_QUOTA_BYTES }))
    }

    /// `delete_caches`: the entries go from restores at once, and their
    /// bytes with them (or at the next sweep, if the bucket refuses).
    pub async fn delete_caches(&self, a: DeleteCachesArgs) -> Result<Outcome<CacheList>> {
        let repo = check!(self.may(&a.actor, &a.repo, Capability::Run).await?);
        let rows = match (a.id, a.key.as_deref().filter(|k| !k.is_empty())) {
            (Some(id), _) => {
                self.db
                    .prepare(format!("{LISTED} WHERE rowid = ? AND repo_id = ? AND status = 'ready'"))
                    .bind(&[(id as f64).into(), repo.id.as_str().into()])?
                    .all()
                    .await?
                    .results::<ListedRow>()?
            }
            (None, Some(key)) => {
                let mut filter = "key = ? AND repo_id = ? AND status = 'ready'".to_owned();
                let mut values: Vec<JsValue> = vec![key.into(), repo.id.as_str().into()];
                if let Some(git_ref) = a.git_ref.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
                    filter.push_str(" AND scope = ?");
                    values.push(git_ref.into());
                }
                self.db.prepare(format!("{LISTED} WHERE {filter} ORDER BY created_at DESC")).bind(&values)?.all().await?.results::<ListedRow>()?
            }
            (None, None) => return Ok(fail(FailureCode::Invalid, "Name the cache entry by its id, or the entries to delete by their key.")),
        };
        if rows.is_empty() {
            return Ok(fail(FailureCode::NotFound, "No cache entry matches."));
        }
        let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
        self.by_ids("UPDATE cache_entries SET status = 'expired' WHERE id IN", &ids).await?;
        let gone: Vec<(String, String)> = rows.iter().map(|r| (r.id.clone(), r.object.clone())).collect();
        self.forget_cache(&gone).await?;
        Ok(Outcome::Ok(CacheList { total_count: rows.len() as u64, actions_caches: rows.iter().map(ListedRow::view).collect() }))
    }

    /// Deletes expired entries' objects, then their rows: whether it could.
    /// If the bucket refuses, the rows stay expired for the next sweep.
    async fn forget_cache(&self, gone: &[(String, String)]) -> Result<bool> {
        let Some(bucket) = &self.cache else { return Ok(false) };
        for chunk in gone.chunks(100) {
            if let Err(error) = bucket.delete_multiple(chunk.iter().map(|(_, object)| object.as_str()).collect()).await {
                worker::console_error!("actions: cache objects not deleted: {error}");
                return Ok(false);
            }
            let ids: Vec<String> = chunk.iter().map(|(id, _)| id.clone()).collect();
            self.delete_entries(&ids).await?;
        }
        Ok(true)
    }

    /// Hourly: deletes entries unused for a week, saved too long ago, or
    /// left unfinished, and their objects; then what each workspace's
    /// cache holds today, and this month's storage, for billing.
    pub async fn sweep_cache(&self, now: u64) -> Result<()> {
        let at = |ms: u64| rfc3339(now.saturating_sub(ms));
        self.db
            .prepare(
                "UPDATE cache_entries SET status = 'expired'
                 WHERE (status = 'ready' AND (last_used_at < ?1 OR created_at < ?2)) OR (status = 'pending' AND created_at < ?3)",
            )
            .bind(&[at(CACHE_UNUSED_DAYS * DAY_MS).into(), at(CACHE_MAX_AGE_DAYS * DAY_MS).into(), at(PENDING_MS).into()])?
            .run()
            .await?;
        #[derive(Deserialize)]
        struct Gone {
            id: String,
            object: String,
        }
        let gone = self
            .db
            .prepare("SELECT id, object FROM cache_entries WHERE status = 'expired' LIMIT 500")
            .all()
            .await?
            .results::<Gone>()?;
        let gone: Vec<(String, String)> = gone.into_iter().map(|g| (g.id, g.object)).collect();
        if self.cache.is_some() && !self.forget_cache(&gone).await? {
            return Ok(());
        }
        self.measure_cache(now).await
    }

    /// What each workspace's cache holds today, and this month's storage so
    /// far reported to billing, which charges it to workspaces on the plan
    /// once the month is over.
    async fn measure_cache(&self, now: u64) -> Result<()> {
        #[derive(Deserialize)]
        struct Held {
            namespace: String,
            bytes: f64,
        }
        let today = rfc3339(now);
        let (day, month) = (&today[..10], &today[..7]);
        let held = self
            .db
            // Artifacts are kept in the same bucket, at the same price.
            .prepare(
                "SELECT namespace, SUM(size) AS bytes FROM (
                   SELECT namespace, size FROM cache_entries WHERE status = 'ready'
                   UNION ALL SELECT namespace, size FROM artifacts WHERE status = 'ready'
                 ) GROUP BY namespace",
            )
            .all()
            .await?
            .results::<Held>()?;
        for workspace in &held {
            self.db
                .prepare(
                    "INSERT INTO cache_days (namespace, day, bytes) VALUES (?1, ?2, ?3)
                     ON CONFLICT (namespace, day) DO UPDATE SET bytes = max(bytes, ?3)",
                )
                .bind(&[workspace.namespace.as_str().into(), day.into(), workspace.bytes.into()])?
                .run()
                .await?;
        }
        #[derive(Deserialize)]
        struct Day {
            namespace: String,
            bytes: f64,
        }
        let days = self
            .db
            .prepare("SELECT namespace, bytes FROM cache_days WHERE substr(day, 1, 7) = ?")
            .bind(&[month.into()])?
            .all()
            .await?
            .results::<Day>()?;
        let mut by_workspace: std::collections::BTreeMap<String, Vec<u64>> = std::collections::BTreeMap::new();
        for d in days {
            by_workspace.entry(d.namespace).or_default().push(d.bytes as u64);
        }
        for (workspace, days) in by_workspace {
            let months = gb_months(&days);
            let cost = storage_cost(months);
            if cost <= 0 {
                continue;
            }
            let noted: Result<bool> = g1t_kit::call(
                &self.billing,
                "note_pending",
                &NotePendingArgs {
                    workspace: workspace.clone(),
                    source: "cache".to_owned(),
                    cost_micros: cost,
                    detail: Some(format!("{months:.2} GB-months")),
                    // The month these days are in, not the one the report
                    // arrives in.
                    month: Some(month.to_owned()),
                },
            )
            .await;
            if let Err(error) = noted {
                worker::console_error!("actions: cache storage not reported for {workspace}: {error}");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(sizes: &[(&str, u64)]) -> Vec<(String, u64)> {
        sizes.iter().map(|(id, size)| ((*id).to_owned(), *size)).collect()
    }

    #[test]
    fn a_run_restores_from_its_ref_then_its_base_then_the_default_branch() {
        let (restore, save) = scopes("refs/heads/feature", None, "main", true);
        assert_eq!(restore, ["refs/heads/feature", "refs/heads/main"]);
        assert_eq!(save, "refs/heads/feature");
        // A pull request: its own merge ref, the branch it merges into, the default.
        let (restore, save) = scopes("refs/pull/7/merge", Some("release/1.x"), "main", true);
        assert_eq!(restore, ["refs/pull/7/merge", "refs/heads/release/1.x", "refs/heads/main"]);
        assert_eq!(save, "refs/pull/7/merge");
        // The default branch reads only its own.
        let (restore, _) = scopes("refs/heads/main", Some("main"), "main", true);
        assert_eq!(restore, ["refs/heads/main"]);
        // From outside: it saves where nothing else reads.
        let (restore, save) = scopes("refs/pull/9/merge", Some("main"), "main", false);
        assert_eq!(save, "untrusted:refs/pull/9/merge");
        assert_eq!(restore, ["untrusted:refs/pull/9/merge", "refs/heads/main"]);
        for trusted_ref in ["refs/heads/main", "refs/pull/9/merge", "refs/heads/feature"] {
            let (others, _) = scopes(trusted_ref, Some("main"), "main", true);
            assert!(!others.contains(&save), "{trusted_ref} must never read an untrusted entry");
        }
    }

    #[test]
    fn eviction_takes_the_entries_restored_longest_ago() {
        // Newest use first.
        let held = entries(&[("new", 4), ("b", 3), ("c", 3), ("old", 2)]);
        assert_eq!(to_evict(&held, "new", 12), Vec::<String>::new());
        assert_eq!(to_evict(&held, "new", 10), ["old"]);
        assert_eq!(to_evict(&held, "new", 7), ["old", "c"]);
        // The entry just saved stays, even when it alone is past the quota.
        assert_eq!(to_evict(&entries(&[("big", 20), ("a", 1)]), "big", 10), ["a"]);
        // Entries are listed only when the sum is over: at or under the
        // quota, nothing would be evicted.
        for (held, quota) in [(entries(&[("a", 4), ("b", 6)]), 10), (entries(&[("a", 1)]), 12)] {
            let total = held.iter().map(|(_, size)| size).sum();
            assert!(!over_quota(total, quota));
            assert!(to_evict(&held, "a", quota).is_empty());
        }
        assert!(over_quota(11, 10));
    }

    #[test]
    fn a_restore_tries_its_key_as_a_prefix_before_its_restore_keys() {
        let restore = vec!["cargo-Linux-1.99.0-".to_owned(), " ".to_owned(), "cargo-".to_owned(), "cargo-".to_owned()];
        assert_eq!(prefixes("cargo-Linux-1.99.0-abc", &restore), ["cargo-Linux-1.99.0-abc", "cargo-Linux-1.99.0-", "cargo-"]);
        assert_eq!(prefixes("k", &[]), ["k"]);
    }

    #[test]
    fn entries_are_listed_in_github_s_orders() {
        assert_eq!(cache_order(None, None).unwrap(), "last_used_at DESC, rowid DESC");
        assert_eq!(cache_order(Some("created_at"), Some("asc")).unwrap(), "created_at ASC, rowid ASC");
        assert_eq!(cache_order(Some("size_in_bytes"), Some(" ")).unwrap(), "size DESC, rowid DESC");
        // Anything else is refused rather than put into the query.
        assert_eq!(cache_order(Some("size; DROP TABLE cache_entries"), None), None);
        assert_eq!(cache_order(Some("created_at"), Some("sideways")), None);
    }

    #[test]
    fn a_listed_entry_is_shown_as_github_shows_one() {
        let row = ListedRow {
            id: "cache_1".into(),
            number: 42.0,
            key: "cargo-test-Linux-1.99.0-abc".into(),
            scope: "refs/heads/main".into(),
            version: String::new(),
            object: "c/repo_1/cache_1".into(),
            size: 1_687_000_000.0,
            created_at: "2026-10-12T10:00:00.000Z".into(),
            last_used_at: "2026-10-12T11:00:00.000Z".into(),
        };
        let shown = serde_json::to_value(row.view()).unwrap();
        assert_eq!(shown["id"], 42);
        assert_eq!(shown["ref"], "refs/heads/main");
        assert_eq!(shown["size_in_bytes"], 1_687_000_000u64);
        assert_eq!(shown["last_accessed_at"], "2026-10-12T11:00:00.000Z");
        assert!(shown.get("object").is_none(), "where its bytes are is not shown");
    }

    #[test]
    fn keys_are_checked() {
        assert!(valid_key("cargo-Linux-abc123"));
        assert!(!valid_key(""));
        assert!(!valid_key("a,b"));
        assert!(!valid_key(&"k".repeat(513)));
    }

    #[test]
    fn a_prefix_is_a_range_of_keys() {
        let keys = [
            "cargo-Linux-abc",
            "cargo-Linux-abd",
            "cargo-Linux-ab",
            "cargo-Linux-abc/deps",
            "cargo-Linux-abc%",
            "cargo-Linux-ab_c",
            "cargo_Linux-abc",
            "cargo%Linux-abc",
            "cargo-",
            "cargo-\u{D7FF}x",
            "cargo-\u{E000}",
            "cargo-\u{10FFFF}",
            "cargo-\u{10FFFF}\u{10FFFF}z",
            "cargo.",
            "sccache/1/ab/cdef",
            "sccache/1/ab0",
            "sccache/10/ab",
            "",
        ];
        let prefixes = [
            "cargo-Linux-ab",
            "cargo-Linux-abc",
            "cargo-",
            "cargo_",
            "cargo%",
            "cargo-Linux-ab_",
            "cargo-Linux-abc%",
            "cargo-\u{D7FF}",
            "cargo-\u{10FFFF}",
            "sccache/1/",
            "sccache/1/ab/",
            "\u{10FFFF}",
        ];
        for prefix in prefixes {
            for key in keys {
                // `%`, `_` and `/` are only characters: nothing in a key or a
                // prefix is a pattern.
                let in_range = key >= prefix && prefix_end(prefix).is_none_or(|end| key < end.as_str());
                assert_eq!(in_range, key.starts_with(prefix), "{key:?} against {prefix:?}");
            }
        }
        assert_eq!(prefix_end("cargo-").as_deref(), Some("cargo."));
        assert_eq!(prefix_end("a\u{D7FF}").as_deref(), Some("a\u{E000}"));
        assert_eq!(prefix_end("a\u{10FFFF}").as_deref(), Some("b"));
        assert_eq!(prefix_end("\u{10FFFF}"), None);
        assert_eq!(key_prefix("\u{10FFFF}").0, "substr(key, 1, length(?)) = ?");
    }

    #[test]
    fn a_restore_is_written_down_once_an_hour() {
        let now = 1_760_000_000_000;
        assert!(!touch_due(&rfc3339(now - 10 * 60 * 1000), now));
        assert!(touch_due(&rfc3339(now - 2 * 60 * 60 * 1000), now));
    }

    #[test]
    fn rows_are_deleted_by_id_fifty_at_a_time() {
        let ids: Vec<String> = (0..120).map(|n| format!("cache_{n}")).collect();
        let statements = by_ids("DELETE FROM cache_entries WHERE id IN", &ids);
        let sizes: Vec<usize> = statements.iter().map(|(_, chunk)| chunk.len()).collect();
        assert_eq!(sizes, [50, 50, 20]);
        for (sql, chunk) in &statements {
            assert_eq!(sql.matches('?').count(), chunk.len());
        }
        assert_eq!(statements[2].0, format!("DELETE FROM cache_entries WHERE id IN ({})", vec!["?"; 20].join(", ")));
        assert!(by_ids("DELETE FROM cache_entries WHERE id IN", &[]).is_empty());
    }

    #[test]
    fn storage_is_charged_by_the_gb_month_at_r2s_price() {
        // 10 GB held for 30 days is 10 GB-months: $0.15.
        let month = vec![10_000_000_000u64; 30];
        assert!((gb_months(&month) - 10.0).abs() < 1e-9);
        assert_eq!(storage_cost(gb_months(&month)), 150_000);
        // A day of 1 GB: a thirtieth of a GB-month, rounded up.
        assert_eq!(storage_cost(gb_months(&[1_000_000_000])), 500);
        assert_eq!(storage_cost(0.0), 0);
    }
}

#[cfg(test)]
mod database {
    use rusqlite::{Connection, OptionalExtension, params};

    use super::{PREFIX_LOOKUP_END, PREFIX_LOOKUP_START, RELEASE, RESERVE, by_ids, key_prefix};

    const CUTOFF: &str = "2026-10-20T06:00:00.000Z";

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        let mut names: Vec<_> = std::fs::read_dir(format!("{}/migrations", env!("CARGO_MANIFEST_DIR")))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
            .collect();
        names.sort();
        for path in names {
            db.execute_batch(&std::fs::read_to_string(&path).unwrap()).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
        for (job, status) in [("job_1", "in_progress"), ("job_2", "in_progress"), ("job_done", "completed"), ("job_requeued", "queued")] {
            db.execute(
                "INSERT INTO jobs (id, run_id, repo_id, namespace, key, name, status) VALUES (?1, 'run_1', 'repo_1', 'acme', ?1, ?1, ?2)",
                params![job, status],
            )
            .unwrap();
        }
        db
    }

    /// Reserves `key` for `job` at `at`: the entry's number, or None when the
    /// key is taken.
    fn reserve(db: &Connection, id: &str, key: &str, job: &str, at: &str) -> Option<i64> {
        db.query_row(
            RESERVE,
            params![id, "repo_1", "acme", key, format!("c/repo_1/{id}"), 0, at, "v1", "refs/heads/main", job, CUTOFF],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    fn entry(db: &Connection, key: &str) -> (String, String, Option<String>) {
        db.query_row("SELECT id, status, job_id FROM cache_entries WHERE key = ?", [key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap()
    }

    #[test]
    fn a_key_is_reserved_once_while_its_job_runs() {
        let db = database();
        let now = "2026-10-20T10:00:00.000Z";
        let number = reserve(&db, "cache_a", "k", "job_1", now).unwrap();
        // Another job, while the first still runs: taken.
        assert_eq!(reserve(&db, "cache_b", "k", "job_2", now), None);
        assert_eq!(entry(&db, "k").0, "cache_a");
        // Saved, it is never written again.
        db.execute("UPDATE cache_entries SET status = 'ready' WHERE id = 'cache_a'", []).unwrap();
        db.execute("UPDATE jobs SET status = 'completed' WHERE id = 'job_1'", []).unwrap();
        assert_eq!(reserve(&db, "cache_c", "k", "job_2", now), None);
        assert!(number > 0);
    }

    #[test]
    fn a_finished_job_s_reservation_is_taken_over() {
        let db = database();
        let now = "2026-10-20T10:00:00.000Z";
        let number = reserve(&db, "cache_a", "k", "job_1", now).unwrap();
        // Its job ends without saving (it failed, or was cancelled).
        db.execute("UPDATE jobs SET status = 'completed' WHERE id = 'job_1'", []).unwrap();
        assert_eq!(reserve(&db, "cache_b", "k", "job_2", now), Some(number));
        assert_eq!(entry(&db, "k"), ("cache_b".into(), "pending".into(), Some("job_2".into())));
        // A job sent back to the queue is not running either.
        reserve(&db, "cache_c", "q", "job_requeued", now).unwrap();
        assert!(reserve(&db, "cache_d", "q", "job_1", now).is_some());
        // A reservation from before jobs were written down waits out its
        // six hours.
        db.execute(
            "INSERT INTO cache_entries (id, repo_id, namespace, key, object, size, status, created_at, last_used_at, version, scope)
             VALUES ('cache_old', 'repo_1', 'acme', 'old', 'c/repo_1/cache_old', 0, 'pending', ?1, ?1, 'v1', 'refs/heads/main')",
            [now],
        )
        .unwrap();
        assert_eq!(reserve(&db, "cache_e", "old", "job_2", now), None);
        db.execute("UPDATE cache_entries SET created_at = '2026-10-20T05:00:00.000Z' WHERE id = 'cache_old'", []).unwrap();
        assert!(reserve(&db, "cache_e", "old", "job_2", now).is_some());
        // So does one whose job still runs.
        reserve(&db, "cache_f", "slow", "job_1", "2026-10-20T05:00:00.000Z");
        db.execute("UPDATE jobs SET status = 'in_progress' WHERE id = 'job_1'", []).unwrap();
        assert!(reserve(&db, "cache_g", "slow", "job_2", now).is_some());
    }

    #[test]
    fn a_job_that_ends_lets_go_of_what_it_did_not_save() {
        let db = database();
        let now = "2026-10-20T10:00:00.000Z";
        reserve(&db, "cache_a", "a", "job_1", now).unwrap();
        reserve(&db, "cache_b", "b", "job_1", now).unwrap();
        reserve(&db, "cache_c", "c", "job_2", now).unwrap();
        db.execute("UPDATE cache_entries SET status = 'ready' WHERE id = 'cache_b'", []).unwrap();
        db.execute(RELEASE, ["job_1"]).unwrap();
        assert_eq!(entry(&db, "a").1, "expired");
        assert_eq!(entry(&db, "b").1, "ready");
        assert_eq!(entry(&db, "c").1, "pending");
        // The key is free at once, for any job.
        assert!(reserve(&db, "cache_d", "a", "job_2", now).is_some());
    }

    #[test]
    fn a_prefix_is_found_through_the_index() {
        let db = database();
        let now = "2026-10-20T10:00:00.000Z";
        for (id, key) in [("cache_1", "cargo-Linux-abc"), ("cache_2", "cargo_Linux-abc"), ("cache_3", "cargo-Linux-%"), ("cache_4", "sccache/1/ab"), ("cache_5", "cargo-")] {
            reserve(&db, id, key, "job_1", now).unwrap();
        }
        let found = |prefix: &str| -> Vec<String> {
            let (starts, bounds) = key_prefix(prefix);
            let sql = format!("SELECT key FROM cache_entries WHERE repo_id = 'repo_1' AND scope = 'refs/heads/main' AND {starts} ORDER BY key");
            let mut statement = db.prepare(&sql).unwrap();
            statement.query_map(params![bounds[0], bounds[1]], |row| row.get(0)).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(found("cargo-"), ["cargo-", "cargo-Linux-%", "cargo-Linux-abc"]);
        assert_eq!(found("cargo_"), ["cargo_Linux-abc"]);
        assert_eq!(found("cargo-Linux-%"), ["cargo-Linux-%"]);
        assert_eq!(found("sccache/"), ["sccache/1/ab"]);
        // A restore's lookup reads the range through the index on (repo,
        // scope, key, version).
        let (starts, bounds) = key_prefix("cargo-");
        let plan: String = db
            .query_row(
                &format!("EXPLAIN QUERY PLAN {PREFIX_LOOKUP_START}{starts}{PREFIX_LOOKUP_END}"),
                params!["repo_1", "refs/heads/main", bounds[0], bounds[1], "v1", "2026-09-01"],
                |row| row.get(3),
            )
            .unwrap();
        assert!(plan.contains("key>? AND key<?"), "{plan}");
    }

    #[test]
    fn evicted_rows_go_in_a_statement_per_fifty() {
        let db = database();
        let now = "2026-10-20T10:00:00.000Z";
        let ids: Vec<String> = (0..120).map(|n| format!("cache_{n:03}")).collect();
        for id in &ids {
            reserve(&db, id, id, "job_1", now).unwrap();
        }
        for (sql, chunk) in by_ids("DELETE FROM cache_entries WHERE id IN", &ids[..110]) {
            db.execute(&sql, rusqlite::params_from_iter(chunk.iter())).unwrap();
        }
        let left: Vec<String> = db.prepare("SELECT id FROM cache_entries ORDER BY id").unwrap().query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(left, ids[110..]);
    }
}
