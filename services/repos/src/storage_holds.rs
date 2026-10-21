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
//!   was taken) has passed by [`GRACE_MS`]: by its lease the operation
//!   stops sending, whatever happens. A push still streaming is cut short,
//!   so the store refuses it whole (git_http.rs), and a copy's next chunk is
//!   refused (land.rs). The grace covers clocks that differ between
//!   isolates and an answer the store is still writing.
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
    UpstreamState,
};
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

pub(crate) const RECOVERIES: &str = "SELECT id, kind, root_id, target_id, reservation_id, operation, actor_id, bytes, held_since,
      evidence, staff, reason, released_at
    FROM storage_recoveries ORDER BY released_at DESC, id DESC LIMIT ?1";

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
                        "Its lease ended at {}: by then the write had stopped sending to the store, and its grace has passed.",
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
                    why: format!("Its lease ended at {}: the copy that took it stopped by then, and its grace has passed.", at(lease)),
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
        let (statements, bytes_released) = match &found {
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
        let results = db.batch(statements).await?;
        if results[0].results::<Written>()?.is_empty() {
            return Ok(Outcome::fail(FailureCode::Conflict, "It changed since it was inspected, so nothing was released. Inspect it again."));
        }
        worker::console_log!(
            "{}",
            serde_json::json!({ "storage_hold_released": found.kind(), "id": found.id(), "bytes": bytes_released, "staff": staff, "audit": audit })
        );
        let hold = &inspection.hold;
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
        }))
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
        for id in ids {
            let measured = self.measure(&id).await?;
            if let Some(store) = measured.store_bytes {
                drift.stored_bytes += measured.stored_bytes;
                drift.store_bytes += store;
            }
            drift.repos.push(measured);
        }
        Ok(drift)
    }

    async fn measure(&self, id: &str) -> Result<RepoDrift> {
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
        let measured = async {
            let access = self.store.access(&store_key(&repo), Scope::Read).await?;
            let all = ref_map(refs::all(&access).await?);
            let mut wants: Vec<String> = all.values().cloned().collect();
            wants.sort();
            wants.dedup();
            let mut total = land::pack_size(&access, &wants, &[]).await?;
            let mut skipped = 0;
            for (index, copy_id) in copies.iter().enumerate() {
                if index >= DRIFT_WORKING_COPIES {
                    skipped += 1;
                    continue;
                }
                let Some(copy) = self.registry.by_id(copy_id).await? else { continue };
                let copy_access = self.store.access(&store_key(&copy), Scope::Read).await?;
                let theirs = ref_map(refs::all(&copy_access).await?);
                let mut copy_wants: Vec<String> = theirs.values().filter(|hash| !wants.contains(hash)).cloned().collect();
                copy_wants.sort();
                copy_wants.dedup();
                // What the working copy holds beyond its repository: the
                // repository's commits are what it has in common.
                total += land::pack_size(&copy_access, &copy_wants, &wants).await?;
            }
            Ok::<_, worker::Error>((total, skipped))
        };
        match measured.await {
            Ok((total, skipped)) => {
                drift.store_bytes = Some(total);
                drift.drift_bytes = Some(i64::try_from(total).unwrap_or(i64::MAX) - i64::try_from(stored).unwrap_or(i64::MAX));
                if skipped > 0 {
                    drift.note = Some(format!("{skipped} working copies were not measured."));
                }
            }
            Err(error) => drift.note = Some(format!("Not measured: {error}")),
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
    fn a_release_is_checked_again_in_sql_by_the_same_rules() {
        // The SQL holds the same conditions as `verdict`, so a hold that
        // changed after it was inspected is never released.
        assert!(RELEASE_RESERVATION.contains("bytes = ?3 AND (state = 'ended' OR lease_until_ms + ?8 <= ?9)"));
        assert!(RELEASE_UNLEDGERED.contains("(SELECT started_ms FROM storage_ledger_epoch WHERE id = 1) + ?8 <= ?9"));
        assert!(RELEASE_LOCK.contains("lease_until_ms + ?9 END <= ?10"));
        for dependent in [RELEASE_RESERVATION_SUM, RELEASE_RESERVATION_ROW, RELEASE_UNLEDGERED_SUM, RELEASE_LOCK_ROW] {
            assert!(dependent.contains("EXISTS (SELECT 1 FROM storage_recoveries WHERE id = ?1)"), "{dependent}");
        }
        assert!(!RELEASE_RESERVATION_SUM.contains("stored_bytes"), "a release never changes what is billed");
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
