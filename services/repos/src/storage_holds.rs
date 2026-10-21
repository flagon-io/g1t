//! Public storage holds that outlived their write, for staff (sudo's
//! Storage holds page): listing them, inspecting each with the git store's
//! state, releasing what is provably abandoned with an audit row, and
//! measuring what the store holds against what g1t counted.
//!
//! A hold is one of:
//!
//! - a **reservation**: a row of `storage_reservations` (public_storage.rs),
//!   capacity a write took before it reached the store;
//! - **unledgered** bytes: what `repos.storage_reserved_bytes` holds beyond
//!   its rows, reserved by code that predates the ledger (migration 0023);
//! - a **copy lock**: a native fork's lock on its source, which refuses
//!   the source's writes while the fork's size is taken (network.rs).
//!
//! ## Provably abandoned
//!
//! A hold is provably abandoned when the write behind it cannot still send
//! anything to the store, by what the write itself recorded, never by its
//! age alone:
//!
//! - A reservation that is `ended`: the operation recorded that it stopped
//!   (the store answered its write with an error, or stopped answering)
//!   and settles nothing after that.
//! - A reservation still `held` once its lease ([`LEASE_MS`] from when it
//!   was taken) has passed by [`GRACE_MS`]. What the lease cuts depends on
//!   the write:
//!   - **Cut at the lease.** A push over git: one still streaming is cut
//!     short, so the store refuses it whole, and one read whole after its
//!     lease is declined before the store is asked (git_http.rs). A branch
//!     copied chunk by chunk (land.rs `fast_forward`: a fast-forward
//!     landing, a fork synced, an EU fork of its default branch): a chunk
//!     past the lease is refused, so the copy is cut short.
//!   - **Not cut.** Writes that send one pack already in memory right after
//!     reserving (a commit from the site, other merge methods, the merge
//!     queue, a pull request update, an import or EU fork of every branch,
//!     copy.rs), and a native fork, one call to the store that g1t cannot
//!     cut short. For these the lease assumes the store has answered that
//!     one request or call by then; a native fork whose call failed in a
//!     way that may still be copying keeps its lock (network.rs).
//!
//!   The grace covers clocks that differ between isolates and an answer
//!   the store is still writing.
//! - Unledgered bytes once [`LEGACY_MS`] has passed since the ledger began:
//!   every write since then keeps a row, and older code had no lease.
//! - A copy lock past its lease by [`GRACE_MS`]; one taken by older code,
//!   without a lease, once [`LEGACY_MS`] has passed since the ledger began
//!   and its lease would have passed too.
//!
//! Releasing never touches `stored_bytes`: whether an ended write's bytes
//! landed is in the inspection (the refs it asked for, against the store's)
//! and the drift report, never guessed into what is billed. A write that
//! does settle after its hold was released still records what it measured,
//! and takes nothing else's reservation (public_storage.rs). Each release
//! re-inspects, is checked again in SQL in the same batch that releases,
//! and writes a row of `storage_recoveries` with the evidence.
use std::collections::HashMap;

use g1t_contracts::repos::{
    AdminReleaseStorageHoldArgs, AdminStorageDriftArgs, AdminStorageHoldArgs, AdminStorageHoldsArgs, AdminStorageRecoveriesArgs,
    AskedRef, Repo, RepoDrift, StorageDrift, StorageHold, StorageHoldInspection, StorageHoldRepo, StorageHolds, StorageRecovery,
    StorageRecoveryAudit, UpstreamState,
};
use g1t_contracts::billing::AdminLogArgs;
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::Result;

use crate::public_storage::{GRACE_MS, LEASE_MS, LEGACY_MS};
use crate::registry::{Registry, store_key};
use crate::store::{GitStore, Scope};
use crate::{Repos, land, refs};

/// Holds listed at most.
const LIST_LIMIT: u32 = 500;
/// Repositories measured in one drift report, at most and by default.
const DRIFT_MAX: u32 = 20;
const DRIFT_DEFAULT: u32 = 5;
/// Repositories counted larger than this are passed over by default.
const DRIFT_MAX_BYTES: u64 = 200_000_000;
/// Working copies measured with one repository.
const DRIFT_WORKING_COPIES: usize = 10;
/// The most one drift report streams from the store, all repositories
/// together: past it, the rest are passed over.
pub const DRIFT_BUDGET_BYTES: u64 = 1_000_000_000;
/// What drift's listings and packs are counted as: an operation on g1t's
/// own bill and never a workspace's (meters.rs `COST_ONLY_OPERATIONS`), so
/// measuring a repository neither bills it nor uses its free operations.
pub const DRIFT_METER: &str = "internal.git.drift_fetch";

// --- The ledger, read ---

pub(crate) const RESERVATIONS: &str = "SELECT id, root_id, target_id, operation, actor_id, bytes, state, created_at, created_ms,
      lease_until_ms, ended_ms, outcome, refs
    FROM storage_reservations ORDER BY created_ms LIMIT ?1";

pub(crate) const RESERVATION: &str = "SELECT id, root_id, target_id, operation, actor_id, bytes, state, created_at, created_ms,
      lease_until_ms, ended_ms, outcome, refs
    FROM storage_reservations WHERE id = ?1";

/// What each repository reserves beyond its rows. ?1 limit, ?2 one
/// repository or null for all.
pub(crate) const UNLEDGERED: &str = "SELECT r.id AS root_id,
      r.storage_reserved_bytes - COALESCE((SELECT SUM(s.bytes) FROM storage_reservations s WHERE s.root_id = r.id), 0) AS bytes
    FROM repos r
    WHERE r.storage_reserved_bytes > 0 AND (?2 IS NULL OR r.id = ?2)
      AND r.storage_reserved_bytes > COALESCE((SELECT SUM(s.bytes) FROM storage_reservations s WHERE s.root_id = r.id), 0)
    ORDER BY r.id LIMIT ?1";

pub(crate) const LOCKS: &str = "SELECT repo_id, destination_id, created_at, created_ms, lease_until_ms
    FROM storage_copy_locks WHERE ?2 IS NULL OR repo_id = ?2 ORDER BY created_at LIMIT ?1";

pub(crate) const EPOCH: &str = "SELECT started_at, started_ms FROM storage_ledger_epoch WHERE id = 1";

/// What g1t counts for a repository.
pub(crate) const SUMS: &str = "SELECT stored_bytes, storage_reserved_bytes,
      COALESCE((SELECT SUM(bytes) FROM storage_reservations WHERE root_id = ?1), 0) AS ledger_bytes
    FROM repos WHERE id = ?1";

// --- Releases: each an audit row first, the rest only if it was written ---

/// ?1 audit id, ?2 reservation, ?3 bytes as inspected, ?4 evidence, ?5
/// staff, ?6 reason, ?7 released_at, ?8 grace, ?9 now.
pub(crate) const RELEASE_RESERVATION: &str = "INSERT INTO storage_recoveries
      (id, kind, root_id, target_id, reservation_id, operation, actor_id, bytes, held_since, evidence, staff, reason, released_at)
    SELECT ?1, 'reservation', root_id, target_id, id, operation, actor_id, bytes, created_at, ?4, ?5, ?6, ?7
    FROM storage_reservations
    WHERE id = ?2 AND bytes = ?3 AND (state = 'ended' OR lease_until_ms + ?8 <= ?9)
    RETURNING id";

/// ?1 audit id, ?2 root, ?3 bytes.
pub(crate) const RELEASE_RESERVATION_SUM: &str = "UPDATE repos SET storage_reserved_bytes = MAX(0, storage_reserved_bytes - ?3)
    WHERE id = ?2 AND EXISTS (SELECT 1 FROM storage_recoveries WHERE id = ?1)";

/// ?1 audit id, ?2 reservation.
pub(crate) const RELEASE_RESERVATION_ROW: &str = "DELETE FROM storage_reservations
    WHERE id = ?2 AND EXISTS (SELECT 1 FROM storage_recoveries WHERE id = ?1)";

/// ?1 audit id, ?2 repository, ?3 bytes as inspected, ?4 evidence, ?5
/// staff, ?6 reason, ?7 released_at, ?8 legacy window, ?9 now.
pub(crate) const RELEASE_UNLEDGERED: &str = "INSERT INTO storage_recoveries
      (id, kind, root_id, bytes, evidence, staff, reason, released_at)
    SELECT ?1, 'unledgered', id, ?3, ?4, ?5, ?6, ?7 FROM repos
    WHERE id = ?2 AND ?3 > 0
      AND storage_reserved_bytes - COALESCE((SELECT SUM(bytes) FROM storage_reservations WHERE root_id = ?2), 0) >= ?3
      AND (SELECT started_ms FROM storage_ledger_epoch WHERE id = 1) + ?8 <= ?9
    RETURNING id";

/// ?1 audit id, ?2 repository, ?3 bytes.
pub(crate) const RELEASE_UNLEDGERED_SUM: &str = "UPDATE repos SET storage_reserved_bytes = storage_reserved_bytes - ?3
    WHERE id = ?2 AND EXISTS (SELECT 1 FROM storage_recoveries WHERE id = ?1)";

/// ?1 audit id, ?2 source, ?3 destination, ?4 evidence, ?5 staff, ?6
/// reason, ?7 released_at, ?8 deadline of a lock without a lease, ?9 grace,
/// ?10 now, ?11 legacy window.
pub(crate) const RELEASE_LOCK: &str = "INSERT INTO storage_recoveries
      (id, kind, root_id, target_id, held_since, evidence, staff, reason, released_at)
    SELECT ?1, 'copy_lock', repo_id, destination_id, created_at, ?4, ?5, ?6, ?7 FROM storage_copy_locks
    WHERE repo_id = ?2 AND destination_id = ?3
      AND CASE WHEN lease_until_ms IS NULL THEN ?8 ELSE lease_until_ms + ?9 END <= ?10
      AND (lease_until_ms IS NOT NULL OR (SELECT started_ms FROM storage_ledger_epoch WHERE id = 1) + ?11 <= ?10)
    RETURNING id";

/// ?1 audit id, ?2 source, ?3 destination.
pub(crate) const RELEASE_LOCK_ROW: &str = "DELETE FROM storage_copy_locks
    WHERE repo_id = ?2 AND destination_id = ?3 AND EXISTS (SELECT 1 FROM storage_recoveries WHERE id = ?1)";

/// The release's line for sudo's audit log, kept to send (the outbox,
/// migration 0024): written in the release's batch, only if its recovery
/// row was. ?1 audit id, ?2 workspace or null, ?3 account or null, ?4
/// action, ?5 detail, ?6 staff, ?7 created_at.
pub(crate) const RELEASE_AUDIT: &str = "INSERT INTO storage_recovery_audits (recovery_id, workspace, account, action, detail, by, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM storage_recoveries WHERE id = ?1)";

/// Lines billing has not confirmed: those never tried first, then those
/// tried longest ago, so lines billing keeps refusing cannot keep newer
/// ones from being sent. ?1 limit, ?2 one recovery or null for all.
pub(crate) const AUDITS_UNSENT: &str = "SELECT recovery_id, workspace, account, action, detail, by FROM storage_recovery_audits
    WHERE sent_at IS NULL AND (?2 IS NULL OR recovery_id = ?2) ORDER BY tried_at IS NOT NULL, tried_at, created_at LIMIT ?1";

/// Where one line stands. ?1 recovery.
pub(crate) const AUDIT_STATE: &str = "SELECT sent_at, attempts, error FROM storage_recovery_audits WHERE recovery_id = ?1";

/// Billing confirmed it. ?1 recovery, ?2 now.
pub(crate) const AUDIT_SENT: &str = "UPDATE storage_recovery_audits SET sent_at = ?2, tried_at = ?2, attempts = attempts + 1, error = NULL
    WHERE recovery_id = ?1 AND sent_at IS NULL";

/// Billing did not confirm it, so it is sent again later. ?1 recovery, ?2
/// what it answered, ?3 now.
pub(crate) const AUDIT_UNSENT: &str = "UPDATE storage_recovery_audits SET tried_at = ?3, attempts = attempts + 1, error = ?2
    WHERE recovery_id = ?1 AND sent_at IS NULL";

pub(crate) const RECOVERIES: &str = "SELECT r.id, r.kind, r.root_id, r.target_id, r.reservation_id, r.operation, r.actor_id, r.bytes,
      r.held_since, r.evidence, r.staff, r.reason, r.released_at,
      a.recovery_id AS audit_id, a.sent_at AS audit_sent_at, a.attempts AS audit_attempts, a.error AS audit_error
    FROM storage_recoveries r LEFT JOIN storage_recovery_audits a ON a.recovery_id = r.id
    ORDER BY r.released_at DESC, r.id DESC LIMIT ?1";

// --- The release's line in sudo's audit log ---

/// The audit log's kind of change for a release (sudo's ledgers.ts
/// `AUDIT_ACTIONS`).
pub const RELEASE_ACTION: &str = "storage_released";

/// Where billing files a release whose repository's row is gone, so no
/// workspace can be named (billing's `ADMIN_LOG_ACCOUNTS`).
pub const RELEASE_ACCOUNT: &str = "storage";

/// Unsent lines one sweep sends at most.
const AUDITS_PER_SWEEP: u32 = 50;

/// A release's line in sudo's audit log, as #310 had sudo write it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditLine {
    /// The charged repository's workspace; `None` when its row is gone, and
    /// then filed under [`RELEASE_ACCOUNT`].
    pub workspace: Option<String>,
    pub detail: String,
}

fn kind_label(kind: &str) -> &str {
    match kind {
        "reservation" => "Reservation",
        "unledgered" => "Unledgered",
        "copy_lock" => "Copy lock",
        other => other,
    }
}

/// Bytes in the decimal units the storage limits use, as sudo shows them:
/// `1.5 GB`, `320 MB`, `12.3 kB`, `7 bytes`.
/// Rounded half up in integers, as sudo's `formatBytes` rounds
/// (`toFixed`, `Math.round`), so the audit line says what the page does.
pub fn format_bytes(bytes: u64) -> String {
    let size = u128::from(bytes);
    for (scale, unit) in [(1_000_000_000u128, "GB"), (1_000_000, "MB"), (1_000, "kB")] {
        if size >= scale {
            let shown = if size >= 100 * scale {
                format!("{}", (size + scale / 2) / scale)
            } else {
                let tenths = (size * 10 + scale / 2) / scale;
                if tenths % 10 == 0 { format!("{}", tenths / 10) } else { format!("{}.{}", tenths / 10, tenths % 10) }
            };
            return format!("{shown} {unit}");
        }
    }
    format!("{bytes} {}", if bytes == 1 { "byte" } else { "bytes" })
}

/// The line for a release of `hold`, recorded as `recovery_id`: filed
/// under the charged repository's workspace, naming the hold, the
/// repository, the one written when that is another (a fork, or a copy
/// lock's destination, which may be in another workspace), the size, the
/// reason and the `storage_recoveries` row, which keeps the inspection as
/// evidence.
pub fn audit_line(hold: &StorageHold, bytes: u64, reason: &str, recovery_id: &str) -> AuditLine {
    let named = |repo: &StorageHoldRepo| match &repo.path {
        Some(path) => format!("{path} ({})", repo.id),
        None => format!("repository {} (gone)", repo.id),
    };
    let workspace = hold.repo.path.as_deref().and_then(|path| path.split('/').next()).filter(|slug| !slug.is_empty()).map(str::to_owned);
    let written = match &hold.target {
        Some(target) if target.id != hold.repo.id => format!(" → {}", named(target)),
        _ => String::new(),
    };
    let size = if hold.kind == "copy_lock" { String::new() } else { format!(", {}", format_bytes(bytes)) };
    let detail = format!("{} {} on {}{written}{size}: {reason} · storage_recoveries {recovery_id}", kind_label(&hold.kind), hold.id, named(&hold.repo));
    AuditLine { workspace, detail }
}

// --- Whether a hold is provably abandoned ---

/// What a hold's verdict rests on.
#[derive(Clone, Copy, Debug)]
pub enum Basis<'a> {
    Reservation { state: &'a str, lease_until_ms: u64, ended_ms: Option<u64> },
    Unledgered,
    Lock { lease_until_ms: Option<u64>, created_ms: Option<u64> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub abandoned: bool,
    pub why: String,
    /// When it will be, if nothing changes.
    pub releasable_at_ms: Option<u64>,
}

fn at(ms: u64) -> String {
    rfc3339(ms)
}

/// Whether the hold is provably abandoned at `now`, and why (see the
/// module's documentation). `epoch_ms`: when the ledger began, `None`
/// when it has not.
pub fn verdict(basis: Basis<'_>, now: u64, epoch_ms: Option<u64>) -> Verdict {
    match basis {
        Basis::Reservation { state: "ended", ended_ms, .. } => Verdict {
            abandoned: true,
            why: match ended_ms {
                Some(ended) => format!("The write stopped at {} without knowing whether the store took it, and sends nothing after.", at(ended)),
                None => "The write stopped without knowing whether the store took it, and sends nothing after.".to_owned(),
            },
            releasable_at_ms: None,
        },
        Basis::Reservation { lease_until_ms, .. } => {
            let free = lease_until_ms.saturating_add(GRACE_MS);
            if now >= free {
                Verdict {
                    abandoned: true,
                    why: format!(
                        "Its lease ended at {}, and its grace has passed: a push or streamed copy is cut short at its lease, and any other write has had its one request to the store answered by then.",
                        at(lease_until_ms)
                    ),
                    releasable_at_ms: None,
                }
            } else {
                Verdict {
                    abandoned: false,
                    why: format!("The write may still be sending: its lease runs to {}, then {} minutes' grace.", at(lease_until_ms), GRACE_MS / 60_000),
                    releasable_at_ms: Some(free),
                }
            }
        }
        Basis::Unledgered => match epoch_ms {
            None => Verdict { abandoned: false, why: "The ledger has not begun, so these bytes cannot be told apart from a write in flight.".to_owned(), releasable_at_ms: None },
            Some(epoch) => {
                let free = epoch.saturating_add(LEGACY_MS);
                if now >= free {
                    Verdict {
                        abandoned: true,
                        why: format!(
                            "Reserved before the ledger began at {}, by code with no lease; every write since keeps a row, and {} hours have passed.",
                            at(epoch),
                            LEGACY_MS / 3_600_000
                        ),
                        releasable_at_ms: None,
                    }
                } else {
                    Verdict {
                        abandoned: false,
                        why: format!("Reserved by older code, which may still be running until {}.", at(free)),
                        releasable_at_ms: Some(free),
                    }
                }
            }
        },
        Basis::Lock { lease_until_ms: Some(lease), .. } => {
            let free = lease.saturating_add(GRACE_MS);
            if now >= free {
                Verdict {
                    abandoned: true,
                    why: format!(
                        "Its lease ended at {}, and its grace has passed: the fork is one call to the store, which g1t cannot cut short, and has been answered by then.",
                        at(lease)
                    ),
                    releasable_at_ms: None,
                }
            } else {
                Verdict {
                    abandoned: false,
                    why: format!("The copy may still be running: its lease runs to {}, then {} minutes' grace.", at(lease), GRACE_MS / 60_000),
                    releasable_at_ms: Some(free),
                }
            }
        }
        Basis::Lock { lease_until_ms: None, created_ms } => match epoch_ms {
            None => Verdict { abandoned: false, why: "The ledger has not begun, so this lock cannot be told apart from a copy in flight.".to_owned(), releasable_at_ms: None },
            Some(epoch) => {
                let free = legacy_lock_deadline(epoch, created_ms);
                if now >= free {
                    Verdict {
                        abandoned: true,
                        why: format!("Taken by code older than the ledger (begun {}), with no lease; {} hours have passed since.", at(epoch), LEGACY_MS / 3_600_000),
                        releasable_at_ms: None,
                    }
                } else {
                    Verdict {
                        abandoned: false,
                        why: format!("Taken by older code, which may still be copying until {}.", at(free)),
                        releasable_at_ms: Some(free),
                    }
                }
            }
        },
    }
}

/// When a lock older code took, without a lease, is free.
pub fn legacy_lock_deadline(epoch_ms: u64, created_ms: Option<u64>) -> u64 {
    let window = epoch_ms.saturating_add(LEGACY_MS);
    created_ms.map_or(window, |created| window.max(created.saturating_add(LEASE_MS + GRACE_MS)))
}

// --- Rows ---

#[derive(Debug, Deserialize)]
struct ReservationRow {
    id: String,
    root_id: String,
    target_id: String,
    operation: String,
    actor_id: Option<String>,
    bytes: f64,
    state: String,
    created_at: String,
    #[serde(rename = "created_ms")]
    _created_ms: f64,
    lease_until_ms: f64,
    ended_ms: Option<f64>,
    outcome: Option<String>,
    refs: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UnledgeredRow {
    root_id: String,
    bytes: f64,
}

#[derive(Debug, Deserialize)]
struct LockRow {
    repo_id: String,
    destination_id: String,
    created_at: String,
    created_ms: Option<f64>,
    lease_until_ms: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct EpochRow {
    started_at: String,
    started_ms: f64,
}

#[derive(Debug, Deserialize)]
struct SumsRow {
    stored_bytes: f64,
    storage_reserved_bytes: f64,
    ledger_bytes: f64,
}

#[derive(Debug, Deserialize)]
struct RecoveryRow {
    id: String,
    kind: String,
    root_id: String,
    target_id: Option<String>,
    reservation_id: Option<String>,
    operation: Option<String>,
    actor_id: Option<String>,
    bytes: f64,
    held_since: Option<String>,
    evidence: String,
    staff: String,
    reason: String,
    released_at: String,
    audit_id: Option<String>,
    audit_sent_at: Option<String>,
    audit_attempts: Option<f64>,
    audit_error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UnsentRow {
    recovery_id: String,
    workspace: Option<String>,
    account: Option<String>,
    action: String,
    detail: String,
    by: String,
}

#[derive(Debug, Deserialize)]
struct Written {
    #[serde(rename = "id")]
    _id: String,
}

fn bytes(value: f64) -> u64 {
    value.max(0.0) as u64
}

/// A hold as it was found, before its repositories are named.
#[derive(Debug)]
enum Found {
    Reservation(ReservationRow),
    Unledgered(UnledgeredRow),
    Lock(LockRow),
}

impl Found {
    fn kind(&self) -> &'static str {
        match self {
            Found::Reservation(_) => "reservation",
            Found::Unledgered(_) => "unledgered",
            Found::Lock(_) => "copy_lock",
        }
    }

    fn id(&self) -> &str {
        match self {
            Found::Reservation(row) => &row.id,
            Found::Unledgered(row) => &row.root_id,
            Found::Lock(row) => &row.repo_id,
        }
    }

    fn since_ms(&self) -> Option<u64> {
        match self {
            Found::Reservation(row) => parse_rfc3339(&row.created_at),
            Found::Unledgered(_) => None,
            Found::Lock(row) => row.created_ms.map(bytes).or_else(|| parse_rfc3339(&row.created_at)),
        }
    }

    fn verdict(&self, now: u64, epoch_ms: Option<u64>) -> Verdict {
        let basis = match self {
            Found::Reservation(row) => {
                Basis::Reservation { state: &row.state, lease_until_ms: bytes(row.lease_until_ms), ended_ms: row.ended_ms.map(bytes) }
            }
            Found::Unledgered(_) => Basis::Unledgered,
            Found::Lock(row) => Basis::Lock {
                lease_until_ms: row.lease_until_ms.map(bytes),
                created_ms: row.created_ms.map(bytes).or_else(|| parse_rfc3339(&row.created_at)),
            },
        };
        verdict(basis, now, epoch_ms)
    }

    /// The repository charged (a lock's source) and the one written.
    fn repos(&self) -> (&str, Option<&str>) {
        match self {
            Found::Reservation(row) => (&row.root_id, Some(&row.target_id)),
            Found::Unledgered(row) => (&row.root_id, None),
            Found::Lock(row) => (&row.repo_id, Some(&row.destination_id)),
        }
    }
}

impl Registry {
    async fn epoch(&self) -> Result<Option<(String, u64)>> {
        Ok(self.db.prepare(EPOCH).first::<EpochRow>(None).await?.map(|row| (row.started_at, bytes(row.started_ms))))
    }

    async fn sums(&self, id: &str) -> Result<Option<SumsRow>> {
        self.db.prepare(SUMS).bind(&[id.into()])?.first::<SumsRow>(None).await
    }

    async fn find_hold(&self, kind: &str, id: &str) -> Result<Option<Found>> {
        Ok(match kind {
            "reservation" => self.db.prepare(RESERVATION).bind(&[id.into()])?.first::<ReservationRow>(None).await?.map(Found::Reservation),
            "unledgered" => self.db.prepare(UNLEDGERED).bind(&[1.0.into(), id.into()])?.first::<UnledgeredRow>(None).await?.map(Found::Unledgered),
            "copy_lock" => self.db.prepare(LOCKS).bind(&[1.0.into(), id.into()])?.first::<LockRow>(None).await?.map(Found::Lock),
            _ => None,
        })
    }

    async fn all_holds(&self, limit: u32) -> Result<Vec<Found>> {
        let limit = f64::from(limit);
        let mut found: Vec<Found> = Vec::new();
        found.extend(self.db.prepare(UNLEDGERED).bind(&[limit.into(), JsValue::NULL])?.all().await?.results::<UnledgeredRow>()?.into_iter().map(Found::Unledgered));
        found.extend(self.db.prepare(LOCKS).bind(&[limit.into(), JsValue::NULL])?.all().await?.results::<LockRow>()?.into_iter().map(Found::Lock));
        found.extend(self.db.prepare(RESERVATIONS).bind(&[limit.into()])?.all().await?.results::<ReservationRow>()?.into_iter().map(Found::Reservation));
        Ok(found)
    }
}

/// A repository as a hold names it, with its row when it still has one.
async fn named(registry: &Registry, id: &str, known: &mut HashMap<String, Option<(Repo, bool)>>) -> Result<(StorageHoldRepo, Option<Repo>)> {
    if !known.contains_key(id) {
        let row = registry.by_id_any(id).await?.map(|(repo, deleted_at)| (repo, deleted_at.is_some()));
        known.insert(id.to_owned(), row);
    }
    Ok(match known.get(id).cloned().flatten() {
        Some((repo, deleted)) => (
            StorageHoldRepo { id: id.to_owned(), path: Some(format!("{}/{}", repo.namespace, repo.name)), private: repo.is_private, deleted },
            Some(repo),
        ),
        None => (StorageHoldRepo { id: id.to_owned(), ..StorageHoldRepo::default() }, None),
    })
}

async fn describe(
    registry: &Registry, found: &Found, now: u64, epoch_ms: Option<u64>, known: &mut HashMap<String, Option<(Repo, bool)>>,
) -> Result<StorageHold> {
    let (charged, written) = found.repos();
    let (repo, _) = named(registry, charged, known).await?;
    let target = match written {
        Some(id) => Some(named(registry, id, known).await?.0),
        None => None,
    };
    let verdict = found.verdict(now, epoch_ms);
    let since_ms = found.since_ms();
    let (operation, actor, state, held, lease_until, outcome) = match found {
        Found::Reservation(row) => (
            Some(row.operation.clone()),
            row.actor_id.clone(),
            Some(row.state.clone()),
            bytes(row.bytes),
            Some(at(bytes(row.lease_until_ms))),
            row.outcome.clone(),
        ),
        Found::Unledgered(row) => (None, None, None, bytes(row.bytes), None, None),
        Found::Lock(row) => (Some("fork".to_owned()), None, None, 0, row.lease_until_ms.map(|ms| at(bytes(ms))), None),
    };
    Ok(StorageHold {
        kind: found.kind().to_owned(),
        id: found.id().to_owned(),
        repo,
        target,
        operation,
        actor,
        state,
        bytes: held,
        since: match found {
            Found::Reservation(row) => Some(row.created_at.clone()),
            Found::Lock(row) => Some(row.created_at.clone()),
            Found::Unledgered(_) => None,
        },
        age_seconds: since_ms.map(|since| now.saturating_sub(since) / 1000),
        lease_until,
        outcome,
        abandoned: verdict.abandoned,
        why: verdict.why,
        releasable_at: verdict.releasable_at_ms.map(at),
    })
}

/// The refs an ended write asked the store to move.
fn asked(found: &Found) -> Vec<(String, String)> {
    match found {
        Found::Reservation(row) => row.refs.as_deref().and_then(|refs| serde_json::from_str(refs).ok()).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Where each ref of `all` points: a peeled tag line is not a ref.
fn ref_map(all: Vec<(String, String)>) -> HashMap<String, String> {
    all.into_iter().filter(|(name, _)| !name.ends_with("^{}")).collect()
}

impl<S: GitStore> Repos<S> {
    /// What the store says about `repo`, and what g1t counts for it.
    async fn upstream(&self, role: &str, named: (StorageHoldRepo, Option<Repo>), asked: &[(String, String)]) -> Result<UpstreamState> {
        let (brief, repo) = named;
        let sums = self.registry.sums(&brief.id).await?;
        let mut state = UpstreamState {
            role: role.to_owned(),
            repo: brief,
            stored_bytes: sums.as_ref().map(|sums| bytes(sums.stored_bytes)),
            reserved_bytes: sums.as_ref().map(|sums| bytes(sums.storage_reserved_bytes)),
            ledger_bytes: sums.as_ref().map(|sums| bytes(sums.ledger_bytes)),
            ..UpstreamState::default()
        };
        let Some(repo) = repo else {
            state.error = Some("g1t has no such repository any more.".to_owned());
            return Ok(state);
        };
        let listed = match self.store.access(&store_key(&repo), Scope::Read).await {
            Ok(access) => refs::all(&access).await,
            Err(error) => Err(error),
        };
        match listed {
            Ok(all) => {
                let all = ref_map(all);
                state.read = true;
                state.refs = u32::try_from(all.len()).unwrap_or(u32::MAX);
                state.head = all.get(&format!("refs/heads/{}", repo.default_branch)).cloned();
                state.asked = asked
                    .iter()
                    .map(|(name, wanted)| AskedRef { name: name.clone(), asked: wanted.clone(), now: all.get(name).cloned() })
                    .collect();
            }
            Err(error) => state.error = Some(format!("The store did not list its refs: {error}")),
        }
        Ok(state)
    }

    async fn inspect(&self, found: &Found, now: u64, epoch_ms: Option<u64>) -> Result<StorageHoldInspection> {
        let mut known = HashMap::new();
        let hold = describe(&self.registry, found, now, epoch_ms, &mut known).await?;
        let asked = asked(found);
        let (charged, written) = found.repos();
        let mut upstream = Vec::new();
        let charged_named = named(&self.registry, charged, &mut known).await?;
        let charged_role = if matches!(found, Found::Lock(_)) { "source" } else { "charged" };
        let same = written == Some(charged);
        // A fork's reservation: where it was copied from, too.
        let mut source = None;
        if same && hold.operation.as_deref() == Some("fork") {
            source = charged_named.1.as_ref().and_then(|repo| repo.forked_from.clone());
        }
        upstream.push(self.upstream(charged_role, charged_named, if same { &asked } else { &[] }).await?);
        if let Some(written) = written.filter(|_| !same) {
            let written_named = named(&self.registry, written, &mut known).await?;
            if matches!(found, Found::Reservation(_)) && hold.operation.as_deref() == Some("fork") {
                source = written_named.1.as_ref().and_then(|repo| repo.forked_from.clone());
            }
            upstream.push(self.upstream("written", written_named, &asked).await?);
        }
        if let Some(source) = source.filter(|source| source != charged) {
            let source_named = named(&self.registry, &source, &mut known).await?;
            upstream.push(self.upstream("source", source_named, &[]).await?);
        }
        let releasable = hold.abandoned;
        let refusal = (!releasable).then(|| hold.why.clone());
        Ok(StorageHoldInspection { hold, upstream, releasable, refusal })
    }

    /// `admin_storage_holds`.
    pub(crate) async fn admin_storage_holds(&self, a: AdminStorageHoldsArgs) -> Result<StorageHolds> {
        let limit = a.limit.unwrap_or(200).clamp(1, LIST_LIMIT);
        let now = now_ms();
        let epoch = self.registry.epoch().await?;
        let epoch_ms = epoch.as_ref().map(|(_, ms)| *ms);
        let mut found = self.registry.all_holds(limit).await?;
        // Oldest first; unledgered bytes are older than everything else.
        found.sort_by_key(|hold| hold.since_ms().unwrap_or(0));
        let more = u32::try_from(found.len().saturating_sub(limit as usize)).unwrap_or(u32::MAX);
        found.truncate(limit as usize);
        let mut known = HashMap::new();
        let mut holds = Vec::with_capacity(found.len());
        for hold in &found {
            holds.push(describe(&self.registry, hold, now, epoch_ms, &mut known).await?);
        }
        Ok(StorageHolds { now: at(now), ledger_since: epoch.map(|(at, _)| at), holds, more })
    }

    /// `admin_inspect_storage_hold`.
    pub(crate) async fn admin_inspect_storage_hold(&self, a: AdminStorageHoldArgs) -> Result<Outcome<StorageHoldInspection>> {
        let now = now_ms();
        let epoch_ms = self.registry.epoch().await?.map(|(_, ms)| ms);
        let Some(found) = self.registry.find_hold(&a.kind, a.id.trim()).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no such hold: it may have been settled or released already."));
        };
        Ok(Outcome::Ok(self.inspect(&found, now, epoch_ms).await?))
    }

    /// `admin_release_storage_hold`: inspected again, released only if
    /// provably abandoned, checked once more in the batch that releases it.
    pub(crate) async fn admin_release_storage_hold(&self, a: AdminReleaseStorageHoldArgs) -> Result<Outcome<StorageRecovery>> {
        let staff = a.staff.trim();
        let reason = a.reason.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is doing it."));
        }
        if reason.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why it is being released."));
        }
        let now = now_ms();
        let epoch_ms = self.registry.epoch().await?.map(|(_, ms)| ms);
        let Some(found) = self.registry.find_hold(&a.kind, a.id.trim()).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no such hold: it may have been settled or released already."));
        };
        let inspection = self.inspect(&found, now, epoch_ms).await?;
        if !inspection.releasable {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("It is not provably abandoned, so it stays. {}", inspection.refusal.clone().unwrap_or_default()),
            ));
        }
        let evidence = serde_json::to_string(&inspection).unwrap_or_else(|_| "{}".to_owned());
        let audit = new_id("srr", now);
        let released_at = at(now);
        let db = &self.registry.db;
        let (mut statements, bytes_released) = match &found {
            Found::Reservation(row) => {
                let held = bytes(row.bytes) as f64;
                (
                    vec![
                        db.prepare(RELEASE_RESERVATION).bind(&[
                            audit.as_str().into(), row.id.as_str().into(), held.into(), evidence.as_str().into(), staff.into(),
                            reason.into(), released_at.as_str().into(), (GRACE_MS as f64).into(), (now as f64).into(),
                        ])?,
                        db.prepare(RELEASE_RESERVATION_SUM).bind(&[audit.as_str().into(), row.root_id.as_str().into(), held.into()])?,
                        db.prepare(RELEASE_RESERVATION_ROW).bind(&[audit.as_str().into(), row.id.as_str().into()])?,
                    ],
                    bytes(row.bytes),
                )
            }
            Found::Unledgered(row) => {
                let held = bytes(row.bytes) as f64;
                (
                    vec![
                        db.prepare(RELEASE_UNLEDGERED).bind(&[
                            audit.as_str().into(), row.root_id.as_str().into(), held.into(), evidence.as_str().into(), staff.into(),
                            reason.into(), released_at.as_str().into(), (LEGACY_MS as f64).into(), (now as f64).into(),
                        ])?,
                        db.prepare(RELEASE_UNLEDGERED_SUM).bind(&[audit.as_str().into(), row.root_id.as_str().into(), held.into()])?,
                    ],
                    bytes(row.bytes),
                )
            }
            Found::Lock(row) => {
                let created = row.created_ms.map(bytes).or_else(|| parse_rfc3339(&row.created_at));
                let deadline = epoch_ms.map_or(u64::MAX, |epoch| legacy_lock_deadline(epoch, created));
                (
                    vec![
                        db.prepare(RELEASE_LOCK).bind(&[
                            audit.as_str().into(), row.repo_id.as_str().into(), row.destination_id.as_str().into(), evidence.as_str().into(),
                            staff.into(), reason.into(), released_at.as_str().into(), (deadline as f64).into(), (GRACE_MS as f64).into(),
                            (now as f64).into(), (LEGACY_MS as f64).into(),
                        ])?,
                        db.prepare(RELEASE_LOCK_ROW).bind(&[audit.as_str().into(), row.repo_id.as_str().into(), row.destination_id.as_str().into()])?,
                    ],
                    0,
                )
            }
        };
        // Its line in sudo's audit log, in the same batch: released means
        // the line is kept to send, and it is sent until billing confirms.
        let hold = &inspection.hold;
        let line = audit_line(hold, bytes_released, reason, &audit);
        let filed = |value: Option<&str>| value.map_or(JsValue::NULL, JsValue::from);
        statements.push(db.prepare(RELEASE_AUDIT).bind(&[
            audit.as_str().into(),
            filed(line.workspace.as_deref()),
            filed(line.workspace.is_none().then_some(RELEASE_ACCOUNT)),
            RELEASE_ACTION.into(),
            line.detail.as_str().into(),
            staff.into(),
            released_at.as_str().into(),
        ])?);
        let results = db.batch(statements).await?;
        if results[0].results::<Written>()?.is_empty() {
            return Ok(Outcome::fail(FailureCode::Conflict, "It changed since it was inspected, so nothing was released. Inspect it again."));
        }
        worker::console_log!(
            "{}",
            serde_json::json!({ "storage_hold_released": found.kind(), "id": found.id(), "bytes": bytes_released, "staff": staff, "audit": audit })
        );
        // Sent now, so the page can say it is in the audit log. If this
        // answer or billing's is lost, or this request stops here, the
        // hourly sweep sends it again, and billing writes it once.
        let sent = self.send_recovery_audits(Some(&audit), 1).await;
        let audit_state = match sent.as_deref() {
            Ok([(_, Ok(()))]) => StorageRecoveryAudit { sent_at: Some(at(now_ms())), attempts: 1, error: None },
            Ok([(_, Err(error))]) => StorageRecoveryAudit { sent_at: None, attempts: 1, error: Some(error.clone()) },
            // Nothing unsent: the sweep sent it between the batch and now.
            // Say where it really stands.
            Ok(_) => match self.recovery_audit(&audit).await {
                Ok(Some(state)) => state,
                Ok(None) => StorageRecoveryAudit { sent_at: None, attempts: 0, error: None },
                Err(error) => StorageRecoveryAudit { sent_at: None, attempts: 0, error: Some(error.to_string()) },
            },
            Err(error) => {
                worker::console_error!("{}", serde_json::json!({ "storage_release_unaudited": audit, "error": error.to_string() }));
                StorageRecoveryAudit { sent_at: None, attempts: 0, error: Some(error.to_string()) }
            }
        };
        Ok(Outcome::Ok(StorageRecovery {
            id: audit,
            kind: hold.kind.clone(),
            repo_id: hold.repo.id.clone(),
            target_id: hold.target.as_ref().map(|target| target.id.clone()),
            reservation_id: matches!(found, Found::Reservation(_)).then(|| hold.id.clone()),
            operation: hold.operation.clone().filter(|_| !matches!(found, Found::Lock(_))),
            actor: hold.actor.clone(),
            bytes: bytes_released,
            held_since: hold.since.clone(),
            evidence: serde_json::to_value(&inspection).unwrap_or_default(),
            staff: staff.to_owned(),
            reason: reason.to_owned(),
            released_at,
            audit: Some(audit_state),
        }))
    }

    /// Sends the release lines billing has not confirmed (at most `limit`,
    /// or only `only`) to its `admin_log`, keyed by the recovery's id so a
    /// line sent twice is written once, and marks each sent only once
    /// billing confirms it. What each answered, by recovery id.
    pub(crate) async fn send_recovery_audits(&self, only: Option<&str>, limit: u32) -> Result<Vec<(String, std::result::Result<(), String>)>> {
        let db = &self.registry.db;
        let unsent = db
            .prepare(AUDITS_UNSENT)
            .bind(&[f64::from(limit).into(), only.map_or(JsValue::NULL, JsValue::from)])?
            .all()
            .await?
            .results::<UnsentRow>()?;
        let mut answers = Vec::with_capacity(unsent.len());
        for row in unsent {
            let answer = self.send_recovery_audit(&row).await;
            let now = at(now_ms());
            match &answer {
                Ok(()) => db.prepare(AUDIT_SENT).bind(&[row.recovery_id.as_str().into(), now.as_str().into()])?.run().await?,
                Err(error) => {
                    worker::console_error!("{}", serde_json::json!({ "storage_release_unaudited": row.recovery_id, "error": error }));
                    db.prepare(AUDIT_UNSENT).bind(&[row.recovery_id.as_str().into(), error.as_str().into(), now.as_str().into()])?.run().await?
                }
            };
            answers.push((row.recovery_id, answer));
        }
        Ok(answers)
    }

    async fn send_recovery_audit(&self, row: &UnsentRow) -> std::result::Result<(), String> {
        let Some(billing) = &self.billing else { return Err("The repos service has no BILLING binding.".to_owned()) };
        let args = AdminLogArgs {
            workspace: row.workspace.clone().unwrap_or_default(),
            account: row.account.clone(),
            action: row.action.clone(),
            detail: row.detail.clone(),
            by: row.by.clone(),
            key: Some(row.recovery_id.clone()),
        };
        match g1t_kit::call::<_, bool>(billing, "admin_log", &args).await {
            Ok(true) => Ok(()),
            Ok(false) => Err("Billing did not confirm it.".to_owned()),
            Err(error) => Err(error.to_string().chars().take(500).collect()),
        }
    }

    /// Where one release's line stands, as its outbox row says.
    async fn recovery_audit(&self, recovery_id: &str) -> Result<Option<StorageRecoveryAudit>> {
        #[derive(Deserialize)]
        struct Row {
            sent_at: Option<String>,
            attempts: f64,
            error: Option<String>,
        }
        let row = self.registry.db.prepare(AUDIT_STATE).bind(&[recovery_id.into()])?.first::<Row>(None).await?;
        Ok(row.map(|row| StorageRecoveryAudit { sent_at: row.sent_at, attempts: row.attempts.max(0.0) as u32, error: row.error }))
    }

    /// The hourly sweep's part: lines a release could not send at once.
    pub(crate) async fn sweep_recovery_audits(&self) -> Result<(usize, usize)> {
        let answers = self.send_recovery_audits(None, AUDITS_PER_SWEEP).await?;
        let sent = answers.iter().filter(|(_, answer)| answer.is_ok()).count();
        Ok((sent, answers.len() - sent))
    }

    /// `admin_storage_recoveries`.
    pub(crate) async fn admin_storage_recoveries(&self, a: AdminStorageRecoveriesArgs) -> Result<Vec<StorageRecovery>> {
        let limit = f64::from(a.limit.unwrap_or(100).clamp(1, LIST_LIMIT));
        let rows = self.registry.db.prepare(RECOVERIES).bind(&[limit.into()])?.all().await?.results::<RecoveryRow>()?;
        Ok(rows
            .into_iter()
            .map(|row| StorageRecovery {
                id: row.id,
                kind: row.kind,
                repo_id: row.root_id,
                target_id: row.target_id,
                reservation_id: row.reservation_id,
                operation: row.operation,
                actor: row.actor_id,
                bytes: bytes(row.bytes),
                held_since: row.held_since,
                evidence: serde_json::from_str(&row.evidence).unwrap_or(serde_json::Value::Null),
                staff: row.staff,
                reason: row.reason,
                released_at: row.released_at,
                audit: row.audit_id.map(|_| StorageRecoveryAudit {
                    sent_at: row.audit_sent_at,
                    attempts: row.audit_attempts.map_or(0, |attempts| attempts.max(0.0) as u32),
                    error: row.audit_error,
                }),
            })
            .collect())
    }

    /// `admin_storage_drift`: reads only; nothing it finds is written.
    pub(crate) async fn admin_storage_drift(&self, a: AdminStorageDriftArgs) -> Result<StorageDrift> {
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let max_bytes = a.max_bytes.unwrap_or(DRIFT_MAX_BYTES);
        let ids: Vec<String> = if a.repo_ids.is_empty() {
            let sample = a.sample.unwrap_or(DRIFT_DEFAULT).clamp(1, DRIFT_MAX);
            self.registry
                .db
                .prepare(DRIFT_SAMPLE)
                .bind(&[(max_bytes as f64).into(), f64::from(sample).into()])?
                .all()
                .await?
                .results::<Id>()?
                .into_iter()
                .map(|row| row.id)
                .collect()
        } else {
            a.repo_ids.iter().take(DRIFT_MAX as usize).cloned().collect()
        };
        let mut drift = StorageDrift { measured_at: at(now_ms()), ..StorageDrift::default() };
        let mut budget = DRIFT_BUDGET_BYTES;
        for id in ids {
            let measured = self.measure(&id, max_bytes, &mut budget).await?;
            if let Some(store) = measured.store_bytes {
                drift.stored_bytes += measured.stored_bytes;
                drift.store_bytes += store;
            }
            drift.repos.push(measured);
        }
        Ok(drift)
    }

    /// Measures one repository, unless g1t counts it over `max_bytes` or
    /// it would take more than is left of `budget`, which it spends.
    async fn measure(&self, id: &str, max_bytes: u64, budget: &mut u64) -> Result<RepoDrift> {
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let mut known = HashMap::new();
        let (brief, repo) = named(&self.registry, id, &mut known).await?;
        let stored = self.registry.sums(id).await?.map_or(0, |sums| bytes(sums.stored_bytes));
        let mut drift = RepoDrift { repo: brief, stored_bytes: stored, ..RepoDrift::default() };
        let Some(repo) = repo else {
            drift.note = Some("g1t has no such repository.".to_owned());
            return Ok(drift);
        };
        if repo.fork_of.is_some() {
            drift.note = Some("A pull request's working copy: measured with its repository.".to_owned());
            return Ok(drift);
        }
        if stored > max_bytes {
            drift.note = Some(format!("Passed over: g1t counts it over the {max_bytes} bytes asked for."));
            return Ok(drift);
        }
        if *budget == 0 || stored > *budget {
            drift.note = Some("Passed over: this report has streamed as much as one may.".to_owned());
            return Ok(drift);
        }
        let copies: Vec<String> = self
            .registry
            .db
            .prepare(WORKING_COPIES)
            .bind(&[id.into()])?
            .all()
            .await?
            .results::<Id>()?
            .into_iter()
            .map(|row| row.id)
            .collect();
        drift.working_copies = u32::try_from(copies.len()).unwrap_or(u32::MAX);
        let left = *budget;
        let measured = async {
            let access = self.store.access(&store_key(&repo), Scope::Read).await?;
            let all = ref_map(refs::all_metered(&access, DRIFT_METER).await?);
            let mut wants: Vec<String> = all.values().cloned().collect();
            wants.sort();
            wants.dedup();
            let mut total = land::pack_size(&access, &wants, &[], DRIFT_METER, left).await?;
            let mut skipped = 0;
            for (index, copy_id) in copies.iter().enumerate() {
                if index >= DRIFT_WORKING_COPIES {
                    skipped += 1;
                    continue;
                }
                let Some(copy) = self.registry.by_id(copy_id).await? else { continue };
                let copy_access = self.store.access(&store_key(&copy), Scope::Read).await?;
                let theirs = ref_map(refs::all_metered(&copy_access, DRIFT_METER).await?);
                let mut copy_wants: Vec<String> = theirs.values().filter(|hash| !wants.contains(hash)).cloned().collect();
                copy_wants.sort();
                copy_wants.dedup();
                // What the working copy holds beyond its repository: the
                // repository's commits are what it has in common.
                total += land::pack_size(&copy_access, &copy_wants, &wants, DRIFT_METER, left.saturating_sub(total)).await?;
            }
            Ok::<_, worker::Error>((total, skipped))
        };
        match measured.await {
            Ok((total, skipped)) => {
                *budget = budget.saturating_sub(total);
                drift.store_bytes = Some(total);
                drift.drift_bytes = Some(i64::try_from(total).unwrap_or(i64::MAX) - i64::try_from(stored).unwrap_or(i64::MAX));
                if skipped > 0 {
                    drift.note = Some(format!("{skipped} working copies were not measured."));
                }
            }
            Err(error) => {
                // Whatever it streamed before it stopped is spent; a stop
                // for the budget leaves none.
                if error.to_string().contains("bytes left to measure") {
                    *budget = 0;
                }
                drift.note = Some(format!("Not measured: {error}"));
            }
        }
        Ok(drift)
    }
}

/// Repositories to measure: live, not working copies, counted at most ?1
/// bytes. ?2 how many.
pub(crate) const DRIFT_SAMPLE: &str = "SELECT id FROM repos
    WHERE fork_of IS NULL AND deleted_at IS NULL AND stored_bytes <= ?1 ORDER BY RANDOM() LIMIT ?2";

/// A repository's live working copies.
pub(crate) const WORKING_COPIES: &str = "SELECT id FROM repos
    WHERE fork_of = ?1 AND deleted_at IS NULL AND retired_at IS NULL ORDER BY created_at";

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3_600_000;

    #[test]
    fn an_ended_write_is_abandoned_at_once() {
        let ended = verdict(Basis::Reservation { state: "ended", lease_until_ms: 10 * HOUR, ended_ms: Some(HOUR) }, HOUR, Some(0));
        assert!(ended.abandoned, "{}", ended.why);
        assert_eq!(ended.releasable_at_ms, None);
    }

    #[test]
    fn a_held_reservation_waits_for_its_lease_and_grace() {
        let lease = LEASE_MS;
        let basis = Basis::Reservation { state: "held", lease_until_ms: lease, ended_ms: None };
        for now in [0, lease, lease + GRACE_MS - 1] {
            let held = verdict(basis, now, Some(0));
            assert!(!held.abandoned, "at {now}: {}", held.why);
            assert_eq!(held.releasable_at_ms, Some(lease + GRACE_MS));
        }
        assert!(verdict(basis, lease + GRACE_MS, Some(0)).abandoned);
    }

    #[test]
    fn unledgered_bytes_wait_for_older_code_to_be_gone() {
        assert!(!verdict(Basis::Unledgered, 100 * HOUR, None).abandoned, "never before the ledger begins");
        let epoch = 5 * HOUR;
        assert!(!verdict(Basis::Unledgered, epoch + LEGACY_MS - 1, Some(epoch)).abandoned);
        assert_eq!(verdict(Basis::Unledgered, epoch, Some(epoch)).releasable_at_ms, Some(epoch + LEGACY_MS));
        assert!(verdict(Basis::Unledgered, epoch + LEGACY_MS, Some(epoch)).abandoned);
    }

    #[test]
    fn a_copy_lock_waits_for_its_lease_or_for_older_code_to_be_gone() {
        let leased = Basis::Lock { lease_until_ms: Some(LEASE_MS), created_ms: Some(0) };
        assert!(!verdict(leased, LEASE_MS + GRACE_MS - 1, Some(0)).abandoned);
        assert!(verdict(leased, LEASE_MS + GRACE_MS, Some(0)).abandoned);
        // Older code's lock, taken well before the ledger: the legacy window.
        let legacy = Basis::Lock { lease_until_ms: None, created_ms: Some(0) };
        let epoch = 30 * 24 * HOUR;
        assert!(!verdict(legacy, epoch + LEGACY_MS - 1, Some(epoch)).abandoned);
        assert!(verdict(legacy, epoch + LEGACY_MS, Some(epoch)).abandoned);
        // One taken just as the ledger began still gets its full lease.
        let late = epoch + LEGACY_MS;
        assert_eq!(legacy_lock_deadline(epoch, Some(late)), late + LEASE_MS + GRACE_MS);
        assert!(!verdict(Basis::Lock { lease_until_ms: None, created_ms: None }, u64::MAX / 2, None).abandoned);
    }

    #[test]
    fn measuring_drift_is_never_a_workspaces_operation() {
        // Every listing and pack drift asks the store for is counted under
        // DRIFT_METER, which is g1t's cost and bills no workspace and uses
        // none of its free operations (meters.rs `record`).
        let mapping = crate::meters::Mapping::defaults();
        assert_eq!(mapping.cost(DRIFT_METER), 1.0);
        assert_eq!(mapping.billable(DRIFT_METER), 0.0);
        let source = include_str!("storage_holds.rs");
        let measuring = &source[source.find("async fn measure(").unwrap()..source.find("/// Repositories to measure").unwrap()];
        assert!(!measuring.contains("refs::all("), "a listing for drift names its meter");
        assert_eq!(measuring.matches("land::pack_size(").count(), measuring.matches("DRIFT_METER, ").count());
        assert!(measuring.matches("land::pack_size(").count() >= 2);
        // And the migration gives the meter the same weights.
        let migration = include_str!("../migrations/0023_storage_reservations.sql");
        assert!(migration.contains("('internal.git.drift_fetch', 1, 0,"));
    }

    fn held(kind: &str, path: Option<&str>) -> StorageHold {
        StorageHold {
            kind: kind.to_owned(),
            id: if kind == "reservation" { "srv_1".into() } else { "rep_1".into() },
            repo: StorageHoldRepo { id: "rep_1".into(), path: path.map(str::to_owned), ..StorageHoldRepo::default() },
            ..StorageHold::default()
        }
    }

    #[test]
    fn bytes_are_written_in_the_units_sudo_shows() {
        assert_eq!(format_bytes(5_000_000_000), "5 GB");
        assert_eq!(format_bytes(1_500_000_000), "1.5 GB");
        assert_eq!(format_bytes(100_000_000), "100 MB");
        assert_eq!(format_bytes(320_000_000), "320 MB");
        assert_eq!(format_bytes(12_345), "12.3 kB");
        // A tie rounds up, as sudo's toFixed does.
        assert_eq!(format_bytes(1_250), "1.3 kB");
        assert_eq!(format_bytes(99_950_000), "100 MB");
        assert_eq!(format_bytes(150_500_000), "151 MB");
        assert_eq!(format_bytes(u64::MAX), "18446744074 GB");
        assert_eq!(format_bytes(1), "1 byte");
        assert_eq!(format_bytes(0), "0 bytes");
    }

    #[test]
    fn a_releases_audit_line_is_filed_under_the_repositorys_workspace_and_names_the_recovery_row() {
        let reason = "The push ended with a 500.";
        let line = audit_line(&held("reservation", Some("acme/site")), 320_000_000, reason, "srr_9");
        assert_eq!(line.workspace.as_deref(), Some("acme"));
        assert_eq!(line.detail, "Reservation srv_1 on acme/site (rep_1), 320 MB: The push ended with a 500. · storage_recoveries srr_9");
        // A copy lock holds no bytes of its own.
        let lock = audit_line(&held("copy_lock", Some("acme/site")), 0, reason, "srr_9");
        assert_eq!(lock.detail, "Copy lock rep_1 on acme/site (rep_1): The push ended with a 500. · storage_recoveries srr_9");
        // The repository written, when it is another, as a fork in another workspace is.
        let mut forked = held("copy_lock", Some("acme/site"));
        forked.target = Some(StorageHoldRepo { id: "rep_2".into(), path: Some("bob/site".into()), ..StorageHoldRepo::default() });
        let line = audit_line(&forked, 0, reason, "srr_9");
        assert_eq!(line.workspace.as_deref(), Some("acme"));
        assert_eq!(line.detail, "Copy lock rep_1 on acme/site (rep_1) → bob/site (rep_2): The push ended with a 500. · storage_recoveries srr_9");
        forked.target = Some(StorageHoldRepo { id: "rep_2".into(), ..StorageHoldRepo::default() });
        assert!(audit_line(&forked, 0, reason, "srr_9").detail.contains("→ repository rep_2 (gone)"));
        // A write to the charged repository itself names it once.
        let mut own = held("reservation", Some("acme/site"));
        own.target = Some(own.repo.clone());
        assert!(!audit_line(&own, 1, reason, "srr_9").detail.contains('→'));
    }

    #[test]
    fn a_release_on_a_repository_whose_row_is_gone_is_filed_under_storage() {
        let line = audit_line(&held("unledgered", None), 7, "Older code.", "srr_9");
        assert_eq!(line.workspace, None);
        assert!(line.detail.starts_with("Unledgered rep_1 on repository rep_1 (gone), 7 bytes: Older code."));
        assert!(g1t_contracts::billing::ADMIN_LOG_ACCOUNTS.contains(&RELEASE_ACCOUNT), "billing files it there");
    }

    #[test]
    fn a_release_keeps_its_audit_line_in_the_same_batch_and_billing_writes_it_once() {
        let source = include_str!("storage_holds.rs");
        let release = &source[source.find("async fn admin_release_storage_hold(").unwrap()..source.find("async fn send_recovery_audits(").unwrap()];
        let pushed = release.find("statements.push(db.prepare(RELEASE_AUDIT)").expect("the outbox row is one of the batch's statements");
        assert!(pushed < release.find("db.batch(statements)").unwrap(), "added before the batch runs");
        // Each line is sent with its recovery id as billing's key, and only
        // marked sent once billing says so.
        let sending = &source[source.find("async fn send_recovery_audit(").unwrap()..source.find("async fn sweep_recovery_audits(").unwrap()];
        assert!(sending.contains("key: Some(row.recovery_id.clone())"));
        assert!(sending.contains("Ok(true) => Ok(())"));
    }

    #[test]
    fn the_refs_an_ended_push_asked_for_come_back_from_its_row() {
        let row = ReservationRow {
            id: "srv_1".into(),
            root_id: "rep_1".into(),
            target_id: "rep_1".into(),
            operation: "push".into(),
            actor_id: None,
            bytes: 10.0,
            state: "ended".into(),
            created_at: rfc3339(0),
            _created_ms: 0.0,
            lease_until_ms: LEASE_MS as f64,
            ended_ms: Some(1.0),
            outcome: Some("The store answered the push with 500.".into()),
            refs: Some(r#"[["refs/heads/main","abc"]]"#.into()),
        };
        assert_eq!(asked(&Found::Reservation(row)), vec![("refs/heads/main".to_owned(), "abc".to_owned())]);
        let peeled = ref_map(vec![("refs/tags/v1".into(), "t".into()), ("refs/tags/v1^{}".into(), "c".into())]);
        assert_eq!(peeled.len(), 1);
    }
}
