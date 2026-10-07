//! Nightly backups of every repository, outside the git store
//! (docs/ARTIFACTS.md, R11; the flow is in `g1t_contracts::backups`).
//!
//! Each repository whose refs moved since its last backup gets a
//! `git bundle`: a full one first, then incremental ones whose
//! prerequisites are the commits the one before ended at, and a full one
//! again after [`Settings::full_every`] incremental ones, so a restore
//! never reads a long chain. Bundles and a manifest that lists the chain
//! are kept in object storage through the `BlobStore` port: the BACKUPS R2
//! bucket hosted, any S3-compatible store (RustFS in the compose file)
//! self-hosted, as BACKUP_STORE says.
//!
//! ```text
//! backups/<repo id>/manifest.json
//! backups/<repo id>/<20261006T025300Z>-full.bundle
//! backups/<repo id>/<20261007T025300Z>-incr.bundle
//! ```
//!
//! Restoring is fetching each bundle of `chain` in order into an empty
//! repository, then setting every ref to what the last entry says
//! (scripts/ops/backup-restore-drill.mjs does it and compares).
//!
//! `repo_backups` keeps, per repository, the last backup (the refs version
//! it was cut at, its tips, when) and the job in hand, if any:
//! `idle` → `queued` (the nightly cron) → `running` (claimed by the
//! runner's sweep) → `idle` again, done or failed. A job that has been
//! running longer than [`LEASE_MS`] is queued again; one that failed
//! [`MAX_ATTEMPTS`] times waits for the next night.

use std::collections::{BTreeMap, BTreeSet};

use g1t_blobstore::{BlobStore, Config, Part, Store};
use g1t_contracts::backups::{
    BackupClaim, BackupComplete, BackupFail, BackupJobArgs, BackupKind, BackupPart, BackupSpec, ClaimBackupsArgs, PART_BYTES,
};
use g1t_contracts::repos::RepoPath;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use serde::{Deserialize, Serialize};
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, Env, Result};

use crate::PULLS_NAMESPACE;
use crate::meters;
use crate::registry::{Registry, store_key};
use crate::store::{GitStore, Scope};

/// Where backups are kept: the BACKUPS bucket, or, when BACKUP_STORE is
/// `s3`, the bucket BACKUP_S3_BUCKET names on the installation's S3 store.
pub const STORAGE: Config = Config {
    kind: "BACKUP_STORE",
    binding: "BACKUPS",
    r2_signer: None,
    s3_bucket: "BACKUP_S3_BUCKET",
    s3_public_endpoint: None,
};

/// The meter a backup's clone is counted under: an operation for g1t's own
/// bill, never for the workspace's (migrations/0013).
pub const FETCH_METER: &str = "internal.git.backup_fetch";

/// How long a claimed job may run before it is given to another sandbox.
pub const LEASE_MS: u64 = 3 * 60 * 60 * 1000;
/// How many times a night a backup is tried.
pub const MAX_ATTEMPTS: u32 = 3;
/// How many backups of deleted repositories one night removes.
const PRUNES_PER_NIGHT: u32 = 50;

/// How backups are paced, from the service's variables.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    /// BACKUPS_PER_NIGHT: how many repositories one night queues.
    pub per_night: u32,
    /// BACKUP_FULL_EVERY: incremental bundles before the next full one.
    pub full_every: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { per_night: 200, full_every: 30 }
    }
}

impl Settings {
    pub fn from_env(env: &Env) -> Settings {
        let number = |name: &str| env.var(name).ok().and_then(|value| value.to_string().parse::<u32>().ok());
        let defaults = Settings::default();
        Settings {
            per_night: number("BACKUPS_PER_NIGHT").unwrap_or(defaults.per_night),
            full_every: number("BACKUP_FULL_EVERY").unwrap_or(defaults.full_every).max(1),
        }
    }
}

/// The storage backups go to, or None when this installation has none
/// (no BACKUPS binding and BACKUP_STORE is not `s3`): backups are then off.
pub fn storage(env: &Env) -> Option<Store> {
    match Store::from_env(env, &STORAGE) {
        Ok(store) => Some(store),
        Err(error) => {
            worker::console_log!("repos: backups are off: {error}");
            None
        }
    }
}

// ---------------------------------------------------------------------
// Which repositories are due
// ---------------------------------------------------------------------

/// A repository and its last backup, as the nightly query reads them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Candidate {
    pub repo_id: String,
    pub namespace: String,
    pub created_at: String,
    pub refs_version: u64,
    /// Until when a credential that can push was out of g1t's hands
    /// (`git_access`); a push with it does not move `refs_version`.
    pub refs_open_until: u64,
    pub deleted: bool,
    pub retired: bool,
    /// None: never backed up, and no row.
    pub status: Option<String>,
    pub backed_version: Option<u64>,
    pub backed_up_ms: u64,
}

/// Whether a repository needs a backup tonight: it is live, it is not a
/// pull request's working copy (whose work lands in its repository, and
/// whose head is kept there once it goes), nothing is already queued or
/// running for it, and its refs moved since the last backup: its
/// `refs_version` went past the one backed up, or a credential that could
/// push was handed out after the last backup started.
pub fn is_due(c: &Candidate) -> bool {
    if c.deleted || c.retired || c.namespace == PULLS_NAMESPACE {
        return false;
    }
    match c.status.as_deref() {
        None => true,
        Some("idle") => match c.backed_version {
            None => true,
            Some(version) => version < c.refs_version || c.refs_open_until > c.backed_up_ms,
        },
        _ => false,
    }
}

/// The repositories to queue: those due, the longest since their last
/// backup first (never backed up first of all, oldest repository first),
/// `limit` at most.
pub fn pick_due(candidates: &[Candidate], limit: usize) -> Vec<String> {
    let mut due: Vec<&Candidate> = candidates.iter().filter(|c| is_due(c)).collect();
    due.sort_by(|a, b| {
        a.backed_up_ms
            .cmp(&b.backed_up_ms)
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.repo_id.cmp(&b.repo_id))
    });
    due.into_iter().take(limit).map(|c| c.repo_id.clone()).collect()
}

/// The same choice in SQL, so a night reads only what it queues. `?1`:
/// the working copies' namespace, `?2`: how many.
const DUE_SQL: &str = "
SELECT r.id AS repo_id, r.namespace, r.created_at,
       coalesce(r.refs_version, 0) AS refs_version,
       coalesce(r.refs_open_until, 0) AS refs_open_until,
       (r.deleted_at IS NOT NULL) AS deleted,
       (r.retired_at IS NOT NULL) AS retired,
       b.status, b.refs_version AS backed_version,
       coalesce(b.backed_up_ms, 0) AS backed_up_ms
FROM repos r LEFT JOIN repo_backups b ON b.repo_id = r.id
WHERE r.deleted_at IS NULL AND r.retired_at IS NULL AND r.namespace != ?1
  AND (b.repo_id IS NULL
       OR (b.status = 'idle'
           AND (b.refs_version IS NULL
                OR b.refs_version < coalesce(r.refs_version, 0)
                OR coalesce(r.refs_open_until, 0) > coalesce(b.backed_up_ms, 0))))
ORDER BY coalesce(b.backed_up_ms, 0), r.created_at, r.id
LIMIT ?2";

// ---------------------------------------------------------------------
// The chain and its manifest
// ---------------------------------------------------------------------

/// One backup in a chain: a bundle, or, when nothing new was there to
/// bundle (a branch deleted, a ref pointed at a commit already kept), only
/// the refs it ended with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// When it was cut, `20261006T025300Z`: also its name in the chain.
    pub id: String,
    pub kind: BackupKind,
    /// The bundle's key in storage; None when only the refs moved.
    pub key: Option<String>,
    pub created_at: String,
    /// The repository's `refs_version` when the clone began.
    pub refs_version: u64,
    /// Every ref, by name, once this backup is applied.
    pub refs: BTreeMap<String, String>,
    /// The commits the bundle leaves out: the previous entry's tips.
    pub prerequisites: Vec<String>,
    pub size: u64,
    pub sha256: Option<String>,
}

/// What restoring a repository reads first: its chain, oldest first, and
/// the chain before it, kept until the next full backup replaces it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub repo_id: String,
    /// The repository's name in the git store, and its path, when last cut.
    pub store_key: String,
    pub path: Option<RepoPath>,
    pub updated_at: String,
    pub chain: Vec<Entry>,
    #[serde(default)]
    pub previous: Vec<Entry>,
}

pub const MANIFEST_VERSION: u32 = 1;

impl Manifest {
    pub fn new(repo_id: &str, store_key: &str) -> Manifest {
        Manifest {
            version: MANIFEST_VERSION,
            repo_id: repo_id.to_owned(),
            store_key: store_key.to_owned(),
            path: None,
            updated_at: String::new(),
            chain: Vec::new(),
            previous: Vec::new(),
        }
    }

    pub fn last(&self) -> Option<&Entry> {
        self.chain.last()
    }

    /// Adds `entry` to the chain. A full one starts a new chain, and the
    /// current one becomes `previous`. Returns the bundles no longer kept.
    pub fn add(&mut self, entry: Entry) -> Vec<String> {
        if entry.kind == BackupKind::Full {
            let dropped = std::mem::take(&mut self.previous);
            self.previous = std::mem::replace(&mut self.chain, vec![entry]);
            return dropped.into_iter().filter_map(|entry| entry.key).collect();
        }
        self.chain.push(entry);
        Vec::new()
    }

    /// Every bundle it lists.
    pub fn keys(&self) -> Vec<String> {
        self.chain.iter().chain(&self.previous).filter_map(|entry| entry.key.clone()).collect()
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec_pretty(self).unwrap_or_default()
    }

    pub fn from_bytes(bytes: &[u8]) -> Option<Manifest> {
        serde_json::from_slice::<Manifest>(bytes).ok().filter(|manifest| manifest.version == MANIFEST_VERSION)
    }
}

/// What the next backup of a repository cuts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub kind: BackupKind,
    pub prerequisites: Vec<String>,
    pub previous_refs: BTreeMap<String, String>,
}

/// The next backup, from the manifest (what a restore reads) and the
/// entry the repository's row says was last (`last_entry`). Full when
/// there is no chain, the two disagree, the last entry had no refs, or the
/// chain already holds `full_every` incremental backups. Otherwise
/// incremental, leaving out every commit the last entry's refs reach.
pub fn plan(manifest: Option<&Manifest>, last_entry: Option<&str>, full_every: u32) -> Plan {
    let full = Plan { kind: BackupKind::Full, prerequisites: Vec::new(), previous_refs: BTreeMap::new() };
    let Some(manifest) = manifest else { return full };
    let Some(last) = manifest.last() else { return full };
    let previous_refs = last.refs.clone();
    if last_entry != Some(last.id.as_str()) || last.refs.is_empty() {
        return full;
    }
    let incrementals = manifest.chain.len().saturating_sub(1);
    if incrementals >= full_every as usize {
        return Plan { previous_refs, ..full };
    }
    let prerequisites: BTreeSet<&String> = last.refs.values().collect();
    Plan {
        kind: BackupKind::Incremental,
        prerequisites: prerequisites.into_iter().cloned().collect(),
        previous_refs,
    }
}

/// `20261006T025300Z`, from milliseconds since the epoch.
pub fn stamp(now_ms: u64) -> String {
    let text = rfc3339(now_ms);
    let whole = text.split('.').next().unwrap_or(&text).trim_end_matches('Z');
    format!("{}Z", whole.replace(['-', ':'], ""))
}

pub fn manifest_key(repo_id: &str) -> String {
    format!("backups/{repo_id}/manifest.json")
}

pub fn bundle_key(repo_id: &str, id: &str, kind: BackupKind) -> String {
    format!("backups/{repo_id}/{id}-{}.bundle", kind.suffix())
}

fn is_hash(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Whether what a sandbox says a bundle holds can be: ref names git would
/// make (`HEAD` or under `refs/`) pointing at full commit hashes.
pub fn valid_refs(refs: &BTreeMap<String, String>) -> bool {
    refs.iter().all(|(name, hash)| {
        let named = name == "HEAD"
            || (name.starts_with("refs/")
                && name.len() <= 1024
                && !name.contains("..")
                && !name.ends_with('/')
                && !name.bytes().any(|b| b <= b' ' || b"~^:?*[\\".contains(&b)));
        named && is_hash(hash)
    })
}

/// Whether the parts a sandbox says it sent are the ones a bundle of
/// `size` bytes makes, numbered from 1 with none missing.
pub fn parts_fit(parts: &[BackupPart], size: u64, part_bytes: u64) -> bool {
    let wanted = size.div_ceil(part_bytes.max(1));
    parts.len() as u64 == wanted && parts.iter().enumerate().all(|(index, part)| part.number as usize == index + 1)
}

// ---------------------------------------------------------------------
// The record in D1, and the job in hand
// ---------------------------------------------------------------------

/// A repository's row in `repo_backups`, as a job reads it.
#[derive(Clone, Debug, Default, Deserialize)]
struct JobRow {
    repo_id: String,
    token_hash: Option<String>,
    attempts: Option<f64>,
    target_version: Option<f64>,
    store_key: Option<String>,
    upload_key: Option<String>,
    upload_id: Option<String>,
    upload_kind: Option<String>,
    upload_entry: Option<String>,
    prerequisites: Option<String>,
    last_entry: Option<String>,
}

fn refused<T>(message: &str) -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, message)
}

fn n(value: u64) -> JsValue {
    JsValue::from_f64(value as f64)
}

fn text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

/// What a nightly run did.
#[derive(Debug, Default)]
pub struct Night {
    pub queued: u32,
    pub pruned: u32,
}

/// Queues tonight's backups: the repositories due, `settings.per_night`
/// at most. Also removes the backups of repositories that were purged.
pub async fn nightly(db: &D1Database, blobs: &Store, settings: Settings, now: u64) -> Result<Night> {
    let candidates = db
        .prepare(DUE_SQL)
        .bind(&[PULLS_NAMESPACE.into(), n(settings.per_night as u64)])?
        .all()
        .await?
        .results::<CandidateRow>()?
        .into_iter()
        .map(Candidate::from)
        .collect::<Vec<_>>();
    let due = pick_due(&candidates, settings.per_night as usize);
    let mut statements = Vec::new();
    for repo_id in &due {
        statements.push(
            db.prepare(
                "INSERT INTO repo_backups (repo_id, status, queued_ms, attempts) VALUES (?1, 'queued', ?2, 0)
                 ON CONFLICT (repo_id) DO UPDATE SET status = 'queued', queued_ms = ?2, attempts = 0, last_error = NULL
                 WHERE repo_backups.status = 'idle'",
            )
            .bind(&[repo_id.as_str().into(), n(now)])?,
        );
    }
    if !statements.is_empty() {
        db.batch(statements).await?;
    }
    let pruned = prune(db, blobs).await?;
    Ok(Night { queued: due.len() as u32, pruned })
}

/// The row the due query reads; D1 gives numbers as floats.
#[derive(Deserialize)]
struct CandidateRow {
    repo_id: String,
    namespace: String,
    created_at: Option<serde_json::Value>,
    refs_version: Option<f64>,
    refs_open_until: Option<f64>,
    deleted: Option<f64>,
    retired: Option<f64>,
    status: Option<String>,
    backed_version: Option<f64>,
    backed_up_ms: Option<f64>,
}

impl From<CandidateRow> for Candidate {
    fn from(row: CandidateRow) -> Candidate {
        Candidate {
            repo_id: row.repo_id,
            namespace: row.namespace,
            created_at: match row.created_at {
                Some(serde_json::Value::String(text)) => text,
                Some(other) => other.to_string(),
                None => String::new(),
            },
            refs_version: row.refs_version.unwrap_or(0.0) as u64,
            refs_open_until: row.refs_open_until.unwrap_or(0.0) as u64,
            deleted: row.deleted.unwrap_or(0.0) != 0.0,
            retired: row.retired.unwrap_or(0.0) != 0.0,
            status: row.status,
            backed_version: row.backed_version.map(|v| v as u64),
            backed_up_ms: row.backed_up_ms.unwrap_or(0.0) as u64,
        }
    }
}

/// Removes the backups of repositories that no longer exist (purged, so
/// their data is gone for good): every bundle the manifest lists, the
/// manifest, and the row.
async fn prune(db: &D1Database, blobs: &Store) -> Result<u32> {
    #[derive(Deserialize)]
    struct Gone {
        repo_id: String,
    }
    let gone = db
        .prepare(
            "SELECT b.repo_id FROM repo_backups b LEFT JOIN repos r ON r.id = b.repo_id
             WHERE r.id IS NULL LIMIT ?1",
        )
        .bind(&[n(PRUNES_PER_NIGHT as u64)])?
        .all()
        .await?
        .results::<Gone>()?;
    for row in &gone {
        let key = manifest_key(&row.repo_id);
        if let Some(manifest) = blobs.read(&key).await?.as_deref().and_then(Manifest::from_bytes) {
            for bundle in manifest.keys() {
                blobs.delete(&bundle).await?;
            }
        }
        blobs.delete(&key).await?;
        db.prepare("DELETE FROM repo_backups WHERE repo_id = ?1")
            .bind(&[row.repo_id.as_str().into()])?
            .run()
            .await?;
    }
    Ok(gone.len() as u32)
}

/// For the runner's sweep: up to `limit` queued backups, each marked
/// running with a token of its own, so long as no more than `max_running`
/// are then running. Jobs past their lease go back in the queue first.
pub async fn claim(db: &D1Database, blobs: Option<&Store>, a: &ClaimBackupsArgs, now: u64) -> Result<Vec<BackupClaim>> {
    // Past their lease: the sandbox died without saying so.
    let stale = db
        .prepare("SELECT * FROM repo_backups WHERE status = 'running' AND claimed_ms < ?1")
        .bind(&[n(now.saturating_sub(LEASE_MS))])?
        .all()
        .await?
        .results::<JobRow>()?;
    for row in &stale {
        give_up_upload(blobs, row).await;
        settle_failure(db, row, "The backup ran past its time and was started again.").await?;
    }
    if blobs.is_none() {
        return Ok(Vec::new());
    }

    #[derive(Deserialize)]
    struct Count {
        running: f64,
    }
    let running = db
        .prepare("SELECT count(*) AS running FROM repo_backups WHERE status = 'running'")
        .first::<Count>(None)
        .await?
        .map_or(0, |row| row.running as u32);
    let room = a.max_running.saturating_sub(running).min(a.limit);
    if room == 0 {
        return Ok(Vec::new());
    }

    #[derive(Deserialize)]
    struct Queued {
        repo_id: String,
        namespace: Option<String>,
        name: Option<String>,
        deleted: Option<f64>,
    }
    let queued = db
        .prepare(
            "SELECT b.repo_id, r.namespace, r.name, (r.id IS NULL OR r.deleted_at IS NOT NULL) AS deleted
             FROM repo_backups b LEFT JOIN repos r ON r.id = b.repo_id
             WHERE b.status = 'queued' ORDER BY b.queued_ms, b.repo_id LIMIT ?1",
        )
        .bind(&[n(room as u64)])?
        .all()
        .await?
        .results::<Queued>()?;
    let mut claims = Vec::new();
    for row in queued {
        let (Some(namespace), Some(name)) = (row.namespace, row.name) else { continue };
        if row.deleted.unwrap_or(0.0) != 0.0 {
            // Deleted since it was queued: nothing to back up until it is
            // restored, if it is.
            db.prepare("UPDATE repo_backups SET status = 'idle' WHERE repo_id = ?1 AND status = 'queued'")
                .bind(&[row.repo_id.as_str().into()])?
                .run()
                .await?;
            continue;
        }
        let job_id = new_id("bkp", now);
        let token = g1t_secrets::random_hex(32);
        let claimed = db
            .prepare(
                "UPDATE repo_backups SET status = 'running', job_id = ?2, token_hash = ?3, claimed_ms = ?4,
                   attempts = attempts + 1, target_version = NULL, store_key = NULL, upload_key = NULL,
                   upload_id = NULL, upload_kind = NULL, upload_entry = NULL, prerequisites = NULL
                 WHERE repo_id = ?1 AND status = 'queued' RETURNING repo_id",
            )
            .bind(&[
                row.repo_id.as_str().into(),
                job_id.as_str().into(),
                g1t_secrets::sha256_hex(&token).into(),
                n(now),
            ])?
            .first::<serde_json::Value>(None)
            .await?;
        if claimed.is_some() {
            claims.push(BackupClaim { job_id, token, repo_id: row.repo_id, path: RepoPath { namespace, name } });
        }
    }
    Ok(claims)
}

/// The running job `a` names, if its token is the one it was given.
async fn job(db: &D1Database, a: &BackupJobArgs) -> Result<Option<JobRow>> {
    let row = db
        .prepare("SELECT * FROM repo_backups WHERE job_id = ?1 AND status = 'running'")
        .bind(&[a.job_id.as_str().into()])?
        .first::<JobRow>(None)
        .await?;
    Ok(row.filter(|row| {
        row.token_hash
            .as_deref()
            .is_some_and(|hash| g1t_secrets::same(hash, &g1t_secrets::sha256_hex(&a.token)))
    }))
}

const NO_JOB: &str = "No such backup job, or it is not running.";

/// The job, for its sandbox: what to cut, and a read-only credential for
/// the repository that lasts minutes. Asked again, the same bundle with a
/// new credential.
pub async fn spec<S: GitStore>(
    registry: &Registry,
    blobs: &Store,
    store: &S,
    a: &BackupJobArgs,
    full_every: u32,
    now: u64,
) -> Result<Outcome<BackupSpec>> {
    let db = &registry.db;
    let Some(row) = job(db, a).await? else { return Ok(refused(NO_JOB)) };
    #[derive(Deserialize)]
    struct Live {
        refs_version: Option<f64>,
    }
    let Some(repo) = registry.by_id(&row.repo_id).await? else {
        settle_failure(db, &row, "The repository was deleted.").await?;
        return Ok(refused("The repository was deleted."));
    };
    let key = store_key(&repo);
    let access = store.handout(&key, Scope::Read).await?;
    // Asked before: the same bundle, so parts already sent still fit.
    if let (Some(kind), Some(_)) = (row.upload_kind.as_deref(), row.upload_id.as_deref()) {
        let manifest = blobs.read(&manifest_key(&row.repo_id)).await?.as_deref().and_then(Manifest::from_bytes);
        let prerequisites: Vec<String> = row.prerequisites.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or_default();
        let previous_refs = manifest.as_ref().and_then(|m| m.last()).map(|e| e.refs.clone()).unwrap_or_default();
        return Ok(Outcome::Ok(BackupSpec {
            kind: if kind == "full" { BackupKind::Full } else { BackupKind::Incremental },
            remote: access.remote,
            git_token: access.token,
            prerequisites,
            previous_refs,
            part_bytes: PART_BYTES,
        }));
    }
    let version = db
        .prepare("SELECT refs_version FROM repos WHERE id = ?1")
        .bind(&[row.repo_id.as_str().into()])?
        .first::<Live>(None)
        .await?
        .and_then(|live| live.refs_version)
        .unwrap_or(0.0) as u64;
    let manifest = blobs.read(&manifest_key(&row.repo_id)).await?.as_deref().and_then(Manifest::from_bytes);
    let next = plan(manifest.as_ref(), row.last_entry.as_deref(), full_every);
    let entry = stamp(now);
    let upload_key = bundle_key(&row.repo_id, &entry, next.kind);
    let upload_id = blobs.create_multipart(&upload_key).await?;
    db.prepare(
        "UPDATE repo_backups SET target_version = ?2, store_key = ?3, upload_key = ?4, upload_id = ?5,
           upload_kind = ?6, upload_entry = ?7, prerequisites = ?8, backed_from_ms = ?9
         WHERE job_id = ?1",
    )
    .bind(&[
        a.job_id.as_str().into(),
        n(version),
        key.as_str().into(),
        upload_key.as_str().into(),
        upload_id.as_str().into(),
        next.kind.suffix().into(),
        entry.as_str().into(),
        serde_json::to_string(&next.prerequisites)?.into(),
        n(now),
    ])?
    .run()
    .await?;
    Ok(Outcome::Ok(BackupSpec {
        kind: next.kind,
        remote: access.remote,
        git_token: access.token,
        prerequisites: next.prerequisites,
        previous_refs: next.previous_refs,
        part_bytes: PART_BYTES,
    }))
}

/// One part of the job's bundle, kept.
pub async fn part(db: &D1Database, blobs: &Store, a: &BackupJobArgs, number: u16, bytes: Vec<u8>) -> Result<Outcome<BackupPart>> {
    let Some(row) = job(db, a).await? else { return Ok(refused(NO_JOB)) };
    let (Some(key), Some(upload)) = (row.upload_key.as_deref(), row.upload_id.as_deref()) else {
        return Ok(Outcome::fail(FailureCode::Conflict, "Ask for the job's spec first."));
    };
    if number == 0 || bytes.len() as u64 > PART_BYTES {
        return Ok(Outcome::fail(FailureCode::Invalid, "Parts are numbered from 1, and hold 32 MiB at most."));
    }
    let Part { number, etag } = blobs.upload_part(key, upload, number, bytes).await?;
    Ok(Outcome::Ok(BackupPart { number, etag }))
}

/// The bundle is cut and sent: the upload is completed, the chain gains
/// an entry (unless nothing changed), bundles of the chain before last
/// are removed, and the repository is backed up as of the refs version it
/// had when the clone began.
pub async fn complete(registry: &Registry, blobs: &Store, a: &BackupComplete, now: u64) -> Result<Outcome<bool>> {
    let db = &registry.db;
    let args = BackupJobArgs { job_id: a.job_id.clone(), token: a.token.clone() };
    let Some(row) = job(db, &args).await? else { return Ok(refused(NO_JOB)) };
    let (Some(upload_key), Some(upload_id), Some(entry_id), Some(store_key)) =
        (row.upload_key.clone(), row.upload_id.clone(), row.upload_entry.clone(), row.store_key.clone())
    else {
        return Ok(Outcome::fail(FailureCode::Conflict, "Ask for the job's spec first."));
    };
    if !valid_refs(&a.refs) {
        return Ok(Outcome::fail(FailureCode::Invalid, "A ref name or commit is not one git makes."));
    }
    if !parts_fit(&a.parts, a.size, PART_BYTES) {
        return Ok(Outcome::fail(FailureCode::Invalid, "The parts do not add up to the bundle's size."));
    }
    meter_fetch(&store_key, a.fetched_bytes);
    let kind = if row.upload_kind.as_deref() == Some("full") { BackupKind::Full } else { BackupKind::Incremental };
    let mut manifest = blobs
        .read(&manifest_key(&row.repo_id))
        .await?
        .as_deref()
        .and_then(Manifest::from_bytes)
        .unwrap_or_else(|| Manifest::new(&row.repo_id, &store_key));
    let unchanged = a.size == 0 && kind == BackupKind::Incremental && manifest.last().is_some_and(|last| last.refs == a.refs);
    let version = row.target_version.unwrap_or(0.0) as u64;
    let mut last_entry = row.last_entry.clone();
    if a.size == 0 {
        blobs.abort_multipart(&upload_key, &upload_id).await?;
    } else {
        let parts: Vec<Part> = a.parts.iter().map(|p| Part { number: p.number, etag: p.etag.clone() }).collect();
        blobs.complete_multipart(&upload_key, &upload_id, &parts).await?;
    }
    if !unchanged {
        let prerequisites: Vec<String> = row.prerequisites.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or_default();
        let dropped = manifest.add(Entry {
            id: entry_id.clone(),
            kind,
            key: (a.size > 0).then(|| upload_key.clone()),
            created_at: rfc3339(now),
            refs_version: version,
            refs: a.refs.clone(),
            prerequisites,
            size: a.size,
            sha256: a.sha256.clone(),
        });
        manifest.store_key = store_key.clone();
        manifest.updated_at = rfc3339(now);
        manifest.path = registry
            .by_id(&row.repo_id)
            .await?
            .map(|repo| RepoPath { namespace: repo.namespace, name: repo.name });
        blobs.put(&manifest_key(&row.repo_id), manifest.to_bytes()).await?;
        for key in dropped {
            if let Err(error) = blobs.delete(&key).await {
                worker::console_error!("repos: backup {key} not removed: {error}");
            }
        }
        last_entry = Some(entry_id);
    }
    db.prepare(
        "UPDATE repo_backups SET status = 'idle', job_id = NULL, token_hash = NULL, claimed_ms = NULL,
           attempts = 0, last_error = NULL, refs_version = ?2, backed_up_ms = backed_from_ms,
           tips = ?3, last_entry = ?4, upload_key = NULL, upload_id = NULL, upload_kind = NULL,
           upload_entry = NULL, prerequisites = NULL, target_version = NULL
         WHERE job_id = ?1",
    )
    .bind(&[a.job_id.as_str().into(), n(version), serde_json::to_string(&a.refs)?.into(), text(last_entry.as_deref())])?
    .run()
    .await?;
    Ok(Outcome::Ok(true))
}

/// The sandbox could not do the job: tried again later tonight, up to
/// [`MAX_ATTEMPTS`] times, and tomorrow night after that.
pub async fn fail(db: &D1Database, blobs: &Store, a: &BackupFail) -> Result<Outcome<bool>> {
    let args = BackupJobArgs { job_id: a.job_id.clone(), token: a.token.clone() };
    let Some(row) = job(db, &args).await? else { return Ok(refused(NO_JOB)) };
    if let Some(key) = row.store_key.as_deref() {
        meter_fetch(key, a.fetched_bytes);
    }
    give_up_upload(Some(blobs), &row).await;
    let said: String = a.error.chars().take(500).collect();
    settle_failure(db, &row, &said).await?;
    Ok(Outcome::Ok(true))
}

/// A clone counts once, with what it read, whenever it got as far as
/// reading anything.
fn meter_fetch(store_key: &str, fetched_bytes: u64) {
    if fetched_bytes > 0 {
        meters::record("internal.git.info_refs", store_key, 0, 0);
        meters::record(FETCH_METER, store_key, 0, fetched_bytes);
    }
}

async fn give_up_upload(blobs: Option<&Store>, row: &JobRow) {
    if let (Some(blobs), Some(key), Some(upload)) = (blobs, row.upload_key.as_deref(), row.upload_id.as_deref())
        && let Err(error) = blobs.abort_multipart(key, upload).await
    {
        worker::console_error!("repos: backup upload {key} not given up: {error}");
    }
}

/// Back in the queue for another try, or idle until tomorrow night once
/// it has been tried enough.
async fn settle_failure(db: &D1Database, row: &JobRow, error: &str) -> Result<()> {
    let attempts = row.attempts.unwrap_or(0.0) as u32;
    let next = if attempts >= MAX_ATTEMPTS { "idle" } else { "queued" };
    worker::console_error!("repos: backup of {} failed ({attempts} of {MAX_ATTEMPTS}): {error}", row.repo_id);
    db.prepare(
        "UPDATE repo_backups SET status = ?2, last_error = ?3, job_id = NULL, token_hash = NULL,
           claimed_ms = NULL, upload_key = NULL, upload_id = NULL, upload_kind = NULL,
           upload_entry = NULL, prerequisites = NULL, target_version = NULL
         WHERE repo_id = ?1",
    )
    .bind(&[row.repo_id.as_str().into(), next.into(), error.into()])?
    .run()
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "c71546fcd893ef8b0f57388b65e620d759705dda";
    const B: &str = "4807077b296e6edbf410d55e72749d3e1170c291";
    const C: &str = "0000000000000000000000000000000000000abc";

    fn candidate(id: &str) -> Candidate {
        Candidate {
            repo_id: id.into(),
            namespace: "acme".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            refs_version: 3,
            ..Candidate::default()
        }
    }

    fn backed(id: &str, version: u64, at: u64) -> Candidate {
        Candidate { status: Some("idle".into()), backed_version: Some(version), backed_up_ms: at, ..candidate(id) }
    }

    #[test]
    fn a_repository_never_backed_up_is_due() {
        assert!(is_due(&candidate("r1")));
        // Even one whose refs never moved: rows from before refs_version.
        assert!(is_due(&Candidate { refs_version: 0, ..candidate("r1") }));
    }

    #[test]
    fn a_repository_is_due_only_once_its_refs_moved() {
        assert!(!is_due(&backed("r1", 3, 1_000)));
        assert!(is_due(&backed("r1", 2, 1_000)));
        // A credential that could push went out after the last backup began.
        assert!(is_due(&Candidate { refs_open_until: 2_000, ..backed("r1", 3, 1_000) }));
        assert!(!is_due(&Candidate { refs_open_until: 900, ..backed("r1", 3, 1_000) }));
        // Tried and failed: no version yet.
        assert!(is_due(&Candidate { backed_version: None, ..backed("r1", 0, 0) }));
    }

    #[test]
    fn deleted_retired_working_copies_and_jobs_in_hand_are_not_due() {
        assert!(!is_due(&Candidate { deleted: true, ..candidate("r1") }));
        assert!(!is_due(&Candidate { retired: true, ..candidate("r1") }));
        assert!(!is_due(&Candidate { namespace: PULLS_NAMESPACE.into(), ..candidate("r1") }));
        assert!(!is_due(&Candidate { status: Some("queued".into()), ..backed("r1", 1, 0) }));
        assert!(!is_due(&Candidate { status: Some("running".into()), ..backed("r1", 1, 0) }));
    }

    #[test]
    fn the_longest_waiting_go_first_and_no_more_than_the_limit() {
        let candidates = vec![
            backed("recent", 1, 5_000),
            backed("older", 1, 1_000),
            backed("current", 3, 0),
            Candidate { created_at: "2026-02-01T00:00:00.000Z".into(), ..candidate("new-b") },
            Candidate { created_at: "2025-02-01T00:00:00.000Z".into(), ..candidate("new-a") },
        ];
        assert_eq!(pick_due(&candidates, 10), ["new-a", "new-b", "older", "recent"]);
        assert_eq!(pick_due(&candidates, 2), ["new-a", "new-b"]);
        assert!(pick_due(&candidates, 0).is_empty());
    }

    fn refs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(name, hash)| ((*name).to_owned(), (*hash).to_owned())).collect()
    }

    fn entry(id: &str, kind: BackupKind, tips: &[(&str, &str)]) -> Entry {
        Entry {
            id: id.into(),
            kind,
            key: Some(format!("backups/r1/{id}-{}.bundle", kind.suffix())),
            created_at: String::new(),
            refs_version: 1,
            refs: refs(tips),
            prerequisites: Vec::new(),
            size: 10,
            sha256: None,
        }
    }

    fn manifest(incrementals: usize) -> Manifest {
        let mut manifest = Manifest::new("r1", "acme--rocket");
        manifest.add(entry("e0", BackupKind::Full, &[("HEAD", A), ("refs/heads/main", A)]));
        for index in 0..incrementals {
            manifest.add(entry(&format!("e{}", index + 1), BackupKind::Incremental, &[("HEAD", A), ("refs/heads/main", A), ("refs/tags/v1", B)]));
        }
        manifest
    }

    #[test]
    fn the_first_backup_is_full() {
        let next = plan(None, None, 30);
        assert_eq!(next.kind, BackupKind::Full);
        assert!(next.prerequisites.is_empty() && next.previous_refs.is_empty());
        assert_eq!(plan(Some(&Manifest::new("r1", "k")), None, 30).kind, BackupKind::Full);
    }

    #[test]
    fn the_next_is_incremental_from_the_last_tips_each_once() {
        let manifest = manifest(1);
        let next = plan(Some(&manifest), Some("e1"), 30);
        assert_eq!(next.kind, BackupKind::Incremental);
        assert_eq!(next.prerequisites, [B, A]);
        assert_eq!(next.previous_refs, manifest.last().unwrap().refs);
    }

    #[test]
    fn a_full_bundle_is_cut_again_after_enough_incrementals() {
        assert_eq!(plan(Some(&manifest(29)), Some("e29"), 30).kind, BackupKind::Incremental);
        let next = plan(Some(&manifest(30)), Some("e30"), 30);
        assert_eq!(next.kind, BackupKind::Full);
        assert!(next.prerequisites.is_empty());
        // What it last held is still said, so an unchanged clone is seen.
        assert!(!next.previous_refs.is_empty());
        assert_eq!(plan(Some(&manifest(1)), Some("e1"), 1).kind, BackupKind::Full);
    }

    #[test]
    fn a_chain_the_row_does_not_know_or_an_empty_one_starts_again() {
        assert_eq!(plan(Some(&manifest(2)), Some("e1"), 30).kind, BackupKind::Full);
        assert_eq!(plan(Some(&manifest(2)), None, 30).kind, BackupKind::Full);
        let mut empty = Manifest::new("r1", "k");
        empty.add(entry("e0", BackupKind::Full, &[]));
        assert_eq!(plan(Some(&empty), Some("e0"), 30).kind, BackupKind::Full);
    }

    #[test]
    fn a_full_backup_starts_a_chain_and_the_one_before_last_goes() {
        let mut manifest = manifest(2);
        assert!(manifest.previous.is_empty());
        let dropped = manifest.add(entry("f1", BackupKind::Full, &[("refs/heads/main", C)]));
        assert!(dropped.is_empty(), "the chain before is kept until the next full one");
        assert_eq!(manifest.chain.len(), 1);
        assert_eq!(manifest.previous.len(), 3);
        manifest.add(entry("f1a", BackupKind::Incremental, &[("refs/heads/main", C)]));
        let dropped = manifest.add(entry("f2", BackupKind::Full, &[("refs/heads/main", C)]));
        assert_eq!(dropped, ["backups/r1/e0-full.bundle", "backups/r1/e1-incr.bundle", "backups/r1/e2-incr.bundle"]);
        assert_eq!(manifest.previous.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["f1", "f1a"]);
        assert_eq!(manifest.keys().len(), 3);
    }

    #[test]
    fn a_manifest_round_trips_and_an_unknown_version_is_not_read() {
        let mut manifest = manifest(2);
        manifest.path = Some(RepoPath { namespace: "acme".into(), name: "rocket".into() });
        manifest.add(Entry { key: None, size: 0, ..entry("e3", BackupKind::Incremental, &[("refs/heads/main", A)]) });
        let bytes = manifest.to_bytes();
        let text = String::from_utf8(bytes.clone()).unwrap();
        // What the restore drill reads: snake_case, the kind in words.
        assert!(text.contains("\"repo_id\": \"r1\"") && text.contains("\"kind\": \"incremental\"") && text.contains("\"key\": null"));
        assert_eq!(Manifest::from_bytes(&bytes), Some(manifest.clone()));
        let mut later = manifest;
        later.version = 2;
        assert_eq!(Manifest::from_bytes(&later.to_bytes()), None);
        assert_eq!(Manifest::from_bytes(b"not json"), None);
    }

    #[test]
    fn a_backup_clone_is_g1ts_operation_not_the_workspaces() {
        let mapping = meters::Mapping::defaults();
        assert_eq!(mapping.cost(FETCH_METER), 1.0);
        assert_eq!(mapping.billable(FETCH_METER), 0.0);
        assert_eq!(mapping.billable("internal.git.fetch"), 1.0);
    }

    #[test]
    fn keys_and_stamps() {
        assert_eq!(stamp(1_369_353_600_123), "20130524T000000Z");
        assert_eq!(manifest_key("r1"), "backups/r1/manifest.json");
        assert_eq!(bundle_key("r1", "20130524T000000Z", BackupKind::Incremental), "backups/r1/20130524T000000Z-incr.bundle");
        assert_eq!(bundle_key("r1", "20130524T000000Z", BackupKind::Full), "backups/r1/20130524T000000Z-full.bundle");
    }

    #[test]
    fn only_refs_git_makes_are_taken() {
        assert!(valid_refs(&refs(&[("HEAD", A), ("refs/heads/main", A), ("refs/pull/pr_1/head", B)])));
        assert!(valid_refs(&BTreeMap::new()));
        assert!(!valid_refs(&refs(&[("main", A)])));
        assert!(!valid_refs(&refs(&[("refs/heads/../x", A)])));
        assert!(!valid_refs(&refs(&[("refs/heads/a b", A)])));
        assert!(!valid_refs(&refs(&[("refs/heads/main", "abc")])));
        assert!(!valid_refs(&refs(&[("refs/heads/main", &A.to_uppercase())])));
    }

    #[test]
    fn parts_must_cover_the_bundle_in_order() {
        let part = |number| BackupPart { number, etag: "e".into() };
        assert!(parts_fit(&[], 0, 10));
        assert!(parts_fit(&[part(1)], 10, 10));
        assert!(parts_fit(&[part(1), part(2)], 11, 10));
        assert!(!parts_fit(&[part(1)], 11, 10));
        assert!(!parts_fit(&[part(2), part(1)], 11, 10));
        assert!(!parts_fit(&[part(1)], 0, 10));
    }
}
