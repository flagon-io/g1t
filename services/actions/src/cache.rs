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
//!   starts with one of its restore keys.
//! - An entry is at most `CACHE_MAX_ENTRY_BYTES`. A repository's entries
//!   hold at most `CACHE_REPO_QUOTA_BYTES` together: saving past it evicts
//!   the entries restored longest ago.
//! - An entry not restored for `CACHE_UNUSED_DAYS`, or saved more than
//!   `CACHE_MAX_AGE_DAYS` ago, is deleted by the hourly sweep, which also
//!   writes down what each workspace holds, its artifacts included (they
//!   are in the same bucket), and reports this month's storage to billing
//!   (`note_pending`, source `cache`) at R2's price.
//!
//! The API calls these with the job's token, or its runtime token for the
//! toolkit's protocols (runtime.rs), which is checked here. An entry the
//! toolkit saves has the toolkit's version, and is found only by the same
//! version; g1t's own `actions/cache` saves and finds entries without one.

use g1t_contracts::FailureCode;
use g1t_contracts::Outcome;
use g1t_contracts::actions::{
    CACHE_MAX_AGE_DAYS, CACHE_MAX_ENTRY_BYTES, CACHE_MICROS_PER_GB_MONTH, CACHE_REPO_QUOTA_BYTES, CACHE_UNUSED_DAYS,
    CacheAbortArgs, CacheCommitArgs, CacheCommitted, CacheHit, CacheLookupArgs, CacheReservation, CacheReserveArgs, CacheUploadArgs,
};
use g1t_contracts::billing::NotePendingArgs;
use g1t_contracts::new_id;
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::Result;

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

/// A month's GB-months from the bytes held each day so far: each day's
/// bytes over 30 days.
pub(crate) fn gb_months(days: &[u64]) -> f64 {
    days.iter().map(|bytes| *bytes as f64).sum::<f64>() / GB / 30.0
}

/// What `gb_months` of cache cost g1t, in millionths of a dollar.
pub(crate) fn storage_cost(gb_months: f64) -> i64 {
    (gb_months * CACHE_MICROS_PER_GB_MONTH as f64).ceil() as i64
}

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
            for prefix in a.restore.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
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
        if let Some(bucket) = &self.cache {
            for chunk in gone.chunks(100) {
                if let Err(error) = bucket.delete_multiple(chunk.iter().map(|g| g.object.as_str()).collect()).await {
                    worker::console_error!("actions: cache objects not deleted: {error}");
                    return Ok(());
                }
                for entry in chunk {
                    self.db.prepare("DELETE FROM cache_entries WHERE id = ?").bind(&[entry.id.as_str().into()])?.run().await?;
                }
            }
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
