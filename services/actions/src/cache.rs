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
//!   (`prefixes`), as GitHub's cache does.
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
/// An upload not finished after this long is given up.
const PENDING_MS: u64 = 6 * 60 * 60 * 1000;
/// A GB, as storage is billed.
const GB: f64 = 1_000_000_000.0;

#[derive(Debug, Deserialize)]
struct EntryRow {
    id: String,
    key: String,
    object: String,
    size: f64,
    created_at: String,
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

impl Actions {
    /// Where a job's entries are found and saved (`scopes`), for g1t's own
    /// `actions/cache` and the toolkit's protocols alike.
    pub(crate) async fn cache_scope(&self, job: &crate::plan::JobRow) -> Result<CacheScope> {
        let (restore, save) = match self.run_row(&job.run_id).await? {
            Some(run) => {
                let info = run.info();
                scopes(&run.git_ref, info.base_ref.as_deref(), &info.default_branch, run.trusted != 0)
            }
            None => (Vec::new(), format!("untrusted:{}", job.run_id)),
        };
        Ok(CacheScope { repo_id: job.repo_id.clone(), restore, save })
    }

    /// A job by its own token or its runtime token (runtime.rs).
    async fn cache_job(&self, job: &str, token: &str) -> Result<Outcome<crate::plan::JobRow>> {
        self.job_for_credential(job, token).await
    }

    /// `cache_lookup`.
    pub async fn cache_lookup(&self, a: CacheLookupArgs) -> Result<Outcome<Option<CacheHit>>> {
        let job = check!(self.cache_job(&a.job, &a.token).await?);
        let scope = self.cache_scope(&job).await?;
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
                    "SELECT id, key, object, size, created_at FROM cache_entries
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
                found = self
                    .db
                    .prepare(
                        "SELECT id, key, object, size, created_at FROM cache_entries
                         WHERE repo_id = ?1 AND scope = ?5 AND version = ?4 AND status = 'ready' AND created_at > ?3
                           AND substr(key, 1, length(?2)) = ?2
                         ORDER BY created_at DESC LIMIT 1",
                    )
                    .bind(&[
                        scope.repo_id.as_str().into(),
                        prefix.into(),
                        fresh.as_str().into(),
                        version.as_str().into(),
                        ref_scope.as_str().into(),
                    ])?
                    .first::<EntryRow>(None)
                    .await?;
                if found.is_some() {
                    break 'scopes;
                }
            }
        }
        let Some(entry) = found else { return Ok(Outcome::Ok(None)) };
        self.db
            .prepare("UPDATE cache_entries SET last_used_at = ? WHERE id = ?")
            .bind(&[rfc3339(now).into(), entry.id.as_str().into()])?
            .run()
            .await?;
        let blob = a.version.as_ref().and_then(|_| self.download_token("cache", &entry.id, &entry.object, crate::runtime::DOWNLOAD_SECONDS));
        Ok(Outcome::Ok(Some(CacheHit { key: entry.key, object: entry.object, size: entry.size as u64, created_at: entry.created_at, blob })))
    }

    /// `cache_upload`.
    pub async fn cache_upload(&self, a: CacheUploadArgs) -> Result<Outcome<CacheReservation>> {
        let job = check!(self.cache_job(&a.job, &a.token).await?);
        let scope = self.cache_scope(&job).await?;
        #[derive(Deserialize)]
        struct Pending {
            id: String,
            object: String,
            number: f64,
            upload: Option<String>,
        }
        let columns = "SELECT id, object, rowid AS number, upload FROM cache_entries";
        let pending = match (a.number, a.key.as_deref()) {
            (Some(number), _) => {
                self.db
                    .prepare(format!("{columns} WHERE rowid = ? AND repo_id = ? AND status = 'pending'"))
                    .bind(&[(number as f64).into(), scope.repo_id.as_str().into()])?
                    .first::<Pending>(None)
                    .await?
            }
            (None, Some(key)) => {
                self.db
                    .prepare(format!("{columns} WHERE repo_id = ? AND scope = ? AND key = ? AND version = ? AND status = 'pending'"))
                    .bind(&[scope.repo_id.as_str().into(), scope.save.as_str().into(), key.into(), a.version.clone().unwrap_or_default().into()])?
                    .first::<Pending>(None)
                    .await?
            }
            (None, None) => None,
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
        let job = check!(self.cache_job(&a.job, &a.token).await?);
        let scope = self.cache_scope(&job).await?;
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
        // An upload left unfinished long ago no longer holds its key.
        self.db
            .prepare(
                "UPDATE cache_entries SET status = 'expired'
                 WHERE repo_id = ? AND scope = ? AND key = ? AND version = ? AND status = 'pending' AND created_at < ?",
            )
            .bind(&[
                scope.repo_id.as_str().into(),
                scope.save.as_str().into(),
                a.key.as_str().into(),
                version.as_str().into(),
                rfc3339(now.saturating_sub(PENDING_MS)).into(),
            ])?
            .run()
            .await?;
        let id = new_id("cache", now);
        let object = format!("c/{}/{id}", scope.repo_id);
        #[derive(Deserialize)]
        struct Inserted {
            number: f64,
        }
        // A key is written once in its scope and version, never into
        // another ref's scope.
        let inserted = self
            .db
            .prepare(
                "INSERT INTO cache_entries (id, repo_id, namespace, key, object, size, status, created_at, last_used_at, version, scope)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7, ?8, ?9)
                 ON CONFLICT (repo_id, scope, key, version) DO UPDATE SET
                   id = ?1, object = ?5, size = ?6, status = 'pending', created_at = ?7, last_used_at = ?7, version = ?8, upload = NULL
                 WHERE cache_entries.status = 'expired'
                 RETURNING rowid AS number",
            )
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
            ])?
            .first::<Inserted>(None)
            .await?;
        let Some(inserted) = inserted else {
            return Ok(fail(FailureCode::Conflict, "That key is already cached."));
        };
        Ok(Outcome::Ok(CacheReservation { id, object, number: inserted.number as u64, upload: None, blob: None }))
    }

    /// `cache_commit`: the entry is ready; entries past the quota are
    /// evicted, restored longest ago first.
    pub async fn cache_commit(&self, a: CacheCommitArgs) -> Result<Outcome<CacheCommitted>> {
        let job = check!(self.cache_job(&a.job, &a.token).await?);
        if a.size > CACHE_MAX_ENTRY_BYTES {
            return Ok(fail(FailureCode::Invalid, "That entry is larger than a cache entry may be."));
        }
        let ready = self
            .db
            .prepare("UPDATE cache_entries SET status = 'ready', size = ?, last_used_at = ? WHERE id = ? AND repo_id = ? AND status = 'pending' RETURNING id")
            .bind(&[(a.size as f64).into(), rfc3339(now_ms()).into(), a.id.as_str().into(), job.repo_id.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if ready.is_none() {
            return Ok(fail(FailureCode::NotFound, "No upload of that entry is in progress."));
        }
        // What the repository holds, summed: only past the quota are its
        // entries listed to choose what to evict. A tool that saves an
        // entry per compiled file (sccache) commits thousands of small
        // entries a build, and listing them all on each was quadratic.
        #[derive(Deserialize)]
        struct Total {
            bytes: Option<f64>,
        }
        let total = self
            .db
            .prepare("SELECT SUM(size) AS bytes FROM cache_entries WHERE repo_id = ? AND status = 'ready'")
            .bind(&[job.repo_id.as_str().into()])?
            .first::<Total>(None)
            .await?
            .and_then(|t| t.bytes)
            .unwrap_or(0.0);
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
        let mut evicted = Vec::new();
        for id in &evict {
            if let Some(entry) = held.iter().find(|h| &h.id == id) {
                self.db.prepare("DELETE FROM cache_entries WHERE id = ?").bind(&[id.as_str().into()])?.run().await?;
                evicted.push(entry.object.clone());
            }
        }
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
            filter.push_str(" AND substr(key, 1, length(?)) = ?");
            values.push(key.into());
            values.push(key.into());
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
        for row in &rows {
            self.db.prepare("UPDATE cache_entries SET status = 'expired' WHERE id = ?").bind(&[row.id.as_str().into()])?.run().await?;
        }
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
            for (id, _) in chunk {
                self.db.prepare("DELETE FROM cache_entries WHERE id = ?").bind(&[id.as_str().into()])?.run().await?;
            }
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
                &NotePendingArgs { workspace: workspace.clone(), source: "cache".to_owned(), cost_micros: cost, detail: Some(format!("{months:.2} GB-months")) },
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
