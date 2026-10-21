//! Public storage admission is independent of a paid subscription. Reserve
//! bytes before contacting the git store; a crash retains the reservation
//! rather than admitting the same capacity twice. A successful write
//! replaces its reservation with the bytes it measured.
//!
//! Each reservation is a row of `storage_reservations` (migration 0023)
//! next to the sum admission reads, `repos.storage_reserved_bytes`: the
//! row says which operation holds it, for whom, since when, and its lease,
//! after which a push or streamed copy is cut short, and by which any other
//! write's one request to the store has been answered (storage_holds.rs
//! says which writes are which).
//! Both move in one batch, so the sum is always the rows plus what older
//! code reserved without one ("unledgered"). An operation that stops
//! without knowing whether the store took its write (the store answered
//! with an error, or stopped answering) marks its row `ended` instead of
//! settling it: nothing of it can still arrive, so staff may release it
//! (storage_holds.rs), but whether it landed is for them to inspect.
//!
//! Settling is by row: an operation whose row staff already released still
//! records the bytes it measured, and never takes another write's
//! reservation with it.
use std::cell::RefCell;

use g1t_contracts::new_id;
use g1t_contracts::repos::Repo;
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::registry::Registry;

/// How long an operation holding a reservation may send to the store. A
/// push still streaming at its lease is cut short, so the store refuses it
/// whole, and one read whole after it is declined (git_http.rs); a branch
/// copied chunk by chunk is refused its next chunk (land.rs). Writes of one
/// pack in memory, and a native fork's one call to the store, are not cut:
/// the lease assumes they have been answered by then. An hour: a 950 MB
/// repository, the largest g1t holds (pack_limits.rs), uploads well within
/// it on any ordinary connection. The copy lock's lease, the grants a
/// streamed copy may still take (`HOLD`) and a push's deadline all come
/// from this one figure.
pub const LEASE_MS: u64 = 60 * 60 * 1000;

/// The lease in words, for people: `an hour`, `2 hours`, `45 minutes`.
pub fn lease_words() -> String {
    match LEASE_MS / 60_000 {
        60 => "an hour".to_owned(),
        minutes if minutes % 60 == 0 => format!("{} hours", minutes / 60),
        minutes => format!("{minutes} minutes"),
    }
}
/// How long after a lease a reservation still counts as possibly in
/// flight: clocks differ between isolates, and the store may still be
/// answering what it was sent just before.
pub const GRACE_MS: u64 = 15 * 60 * 1000;
/// How long after the ledger began (`storage_ledger_epoch`) bytes reserved
/// without a row, and copy locks without a lease, may still belong to a
/// write in flight: older code had no lease of its own.
pub const LEGACY_MS: u64 = 24 * 3600 * 1000;

/// What holds a reservation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Operation {
    /// Git over HTTPS (lib.rs `git_http`).
    Push,
    /// A file committed from the web (commit_file.rs).
    Commit,
    /// A pull request merged (merge_methods.rs).
    Merge,
    /// The merge queue building its branch (merge_methods.rs).
    Queue,
    /// A pull request's branch brought up to date (catch_up.rs).
    Update,
    /// A branch landed from another repository (lib.rs `land`).
    Land,
    /// A fork synced with its parent (network.rs).
    Sync,
    /// A repository imported (lib.rs `create`).
    Import,
    /// A fork made (network.rs).
    Fork,
}

impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Operation::Push => "push",
            Operation::Commit => "commit",
            Operation::Merge => "merge",
            Operation::Queue => "queue",
            Operation::Update => "update",
            Operation::Land => "land",
            Operation::Sync => "sync",
            Operation::Import => "import",
            Operation::Fork => "fork",
        }
    }
}

/// One reservation an operation holds.
#[derive(Clone, Debug)]
pub(crate) struct Reservation {
    pub id: String,
    /// The repository charged.
    pub root: String,
    /// The repository written.
    pub target: String,
    pub operation: Operation,
    pub actor: Option<String>,
    /// Reserved so far.
    pub bytes: u64,
    pub created_at: String,
    pub lease_until_ms: u64,
}

/// A streamed copy's reservation, grown chunk by chunk (land.rs).
pub(crate) struct StreamQuota {
    pub registry: Registry,
    pub repo: Repo,
    pub cap: i64,
    pub operation: Operation,
    pub actor: Option<String>,
    pub held: RefCell<Option<Reservation>>,
}

impl StreamQuota {
    /// Reserves `bytes` more, under the one reservation of this copy.
    pub async fn grow(&self, bytes: u64) -> Result<bool> {
        let held = self.held.borrow().clone();
        match held {
            None => match self.registry.reserve_public(&self.repo, bytes, self.cap, self.operation, self.actor.as_deref()).await? {
                Some(reservation) => {
                    *self.held.borrow_mut() = Some(reservation);
                    Ok(true)
                }
                None => Ok(false),
            },
            Some(mut reservation) => {
                let grown = self.registry.grow_public(&mut reservation, bytes, self.cap).await?;
                *self.held.borrow_mut() = Some(reservation);
                Ok(grown)
            }
        }
    }

    pub async fn finish(&self, measured: u64) -> Result<()> {
        let held = self.held.borrow_mut().take();
        match held {
            Some(reservation) => self.registry.finish_public(&reservation, measured).await,
            None => Ok(()),
        }
    }

    /// The copy was refused whole: nothing of it was kept.
    pub async fn release(&self) -> Result<()> {
        let held = self.held.borrow_mut().take();
        match held {
            Some(reservation) => self.registry.release_public(&reservation).await,
            None => Ok(()),
        }
    }

    /// The copy stopped without knowing whether the store took it.
    pub async fn end(&self, outcome: &str) {
        let held = self.held.borrow_mut().take();
        if let Some(reservation) = held {
            self.registry.end_public(&reservation, outcome, &[]).await;
        }
    }
}

impl<S: crate::store::GitStore> crate::Repos<S> {
    pub(crate) fn public_quota(&self, repo: &Repo, operation: Operation, actor: Option<&str>) -> Option<std::rc::Rc<StreamQuota>> {
        Some(std::rc::Rc::new(StreamQuota {
            registry: Registry { db: self.registry.db.clone() },
            repo: repo.clone(),
            cap: self.free_public_bytes,
            operation,
            actor: actor.map(str::to_owned),
            held: RefCell::new(None),
        }))
    }

    /// Reserves `bytes` for `repo` and keeps the reservation in `slot`: an
    /// admission for copy.rs, which asks once with the pack's size.
    pub(crate) async fn hold_into(
        &self, slot: &RefCell<Option<Reservation>>, repo: &Repo, bytes: u64, operation: Operation, actor: Option<&str>,
    ) -> Result<bool> {
        match self.registry.reserve_public(repo, bytes, self.free_public_bytes, operation, actor).await? {
            Some(reservation) => {
                *slot.borrow_mut() = Some(reservation);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Pushes `pack` to `branch` under a reservation of its size: `None`
    /// when the workspace's public storage cannot fit it. The inner result
    /// is the store's verdict on the branch (land.rs `push_pack`); the pack
    /// is counted either way, as the store answered. A push the store
    /// answered with an error, or never answered, leaves its reservation
    /// ended for staff.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn push_reserved(
        &self, repo: &Repo, operation: Operation, actor: Option<&str>, access: &g1t_contracts::repos::GitAccess,
        branch: &str, old: Option<&str>, new: &str, pack: Vec<u8>,
    ) -> Result<Option<std::result::Result<(), String>>> {
        let bytes = pack.len() as u64;
        let Some(reservation) = self.registry.reserve_public(repo, bytes, self.free_public_bytes, operation, actor).await? else {
            return Ok(None);
        };
        match crate::land::push_pack(access, branch, old, new, pack).await {
            Ok(pushed) => {
                self.registry.finish_public(&reservation, bytes).await?;
                Ok(Some(pushed))
            }
            Err(error) => {
                let refs = [(format!("refs/heads/{branch}"), new.to_owned())];
                self.registry.end_public(&reservation, &error.to_string(), &refs).await;
                Err(error)
            }
        }
    }
}

/// Admission as one statement, as code before the ledger ran it. The rows'
/// admission ([`HOLD`]) is this same test; the conformance tests hold the
/// two to it, and to what code that predates the ledger still runs.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const RESERVE: &str = "UPDATE repos SET storage_reserved_bytes = storage_reserved_bytes + ?2
    WHERE id = ?1 AND fork_of IS NULL AND ?2 >= 0
      AND NOT EXISTS (SELECT 1 FROM storage_copy_locks WHERE repo_id = ?1)
      AND (is_private = 1 OR (?2 <= ?3 AND COALESCE((SELECT SUM(stored_bytes + storage_reserved_bytes) FROM repos r
          WHERE r.namespace = repos.namespace AND r.is_private = 0 AND r.fork_of IS NULL), 0) <= ?3 - ?2))
    RETURNING storage_reserved_bytes AS stored_bytes";

/// A reservation's row, made or grown (same id) when the workspace can fit
/// `?2` more bytes, while its lease lasts. ?1 root, ?2 bytes, ?3 cap, ?4 id,
/// ?5 target, ?6 operation, ?7 actor, ?8 grant, ?9 created_at, ?10 now,
/// ?11 lease_until_ms. Followed in the same batch by [`HOLD_SUM`].
pub(crate) const HOLD: &str = "INSERT INTO storage_reservations (id, root_id, target_id, operation, actor_id, bytes, grant_id, created_at, created_ms, lease_until_ms)
    SELECT ?4, id, ?5, ?6, ?7, ?2, ?8, ?9, ?10, ?11 FROM repos
    WHERE id = ?1 AND fork_of IS NULL AND ?2 >= 0 AND ?10 <= ?11
      AND NOT EXISTS (SELECT 1 FROM storage_copy_locks WHERE repo_id = ?1)
      AND (is_private = 1 OR (?2 <= ?3 AND COALESCE((SELECT SUM(stored_bytes + storage_reserved_bytes) FROM repos r
          WHERE r.namespace = repos.namespace AND r.is_private = 0 AND r.fork_of IS NULL), 0) <= ?3 - ?2))
    ON CONFLICT (id) DO UPDATE SET bytes = bytes + excluded.bytes, grant_id = excluded.grant_id
      WHERE storage_reservations.state = 'held' AND storage_reservations.root_id = excluded.root_id
    RETURNING id";

/// Adds a grant [`HOLD`] made to the sum. ?1 root, ?2 bytes, ?3 id, ?4 grant.
pub(crate) const HOLD_SUM: &str = "UPDATE repos SET storage_reserved_bytes = storage_reserved_bytes + ?2
    WHERE id = ?1 AND EXISTS (SELECT 1 FROM storage_reservations WHERE id = ?3 AND grant_id = ?4)";

/// Settling a reservation staff already released: the measured bytes are
/// recorded all the same. ?1 root, ?2 id, ?3 measured. Runs first.
pub(crate) const SETTLE_RELEASED: &str = "UPDATE repos SET stored_bytes = stored_bytes + ?3
    WHERE id = ?1 AND ?3 > 0 AND NOT EXISTS (SELECT 1 FROM storage_reservations WHERE id = ?2)";

/// Converts a reservation to the bytes measured. ?1 root, ?2 id, ?3 measured.
pub(crate) const SETTLE: &str = "UPDATE repos SET stored_bytes = stored_bytes + ?3,
      storage_reserved_bytes = MAX(0, storage_reserved_bytes - (SELECT bytes FROM storage_reservations WHERE id = ?2))
    WHERE id = ?1 AND EXISTS (SELECT 1 FROM storage_reservations WHERE id = ?2)";

/// Then its row goes. ?1 id.
pub(crate) const SETTLE_ROW: &str = "DELETE FROM storage_reservations WHERE id = ?1";

/// An operation that stopped without knowing whether the store took its
/// write. ?1 id, ?2 now, ?3 outcome, ?4 refs (JSON).
pub(crate) const END: &str = "UPDATE storage_reservations SET state = 'ended', ended_ms = ?2, outcome = ?3, refs = ?4
    WHERE id = ?1 AND state = 'held'";

pub(crate) const MAKE_PUBLIC: &str = "UPDATE repos SET is_private = 0 WHERE id = ?1 AND is_private = 1
    AND stored_bytes + storage_reserved_bytes <= ?2 - COALESCE((SELECT SUM(r.stored_bytes + r.storage_reserved_bytes) FROM repos r
        WHERE r.namespace = repos.namespace AND r.is_private = 0 AND r.fork_of IS NULL), 0)
    RETURNING id";

pub(crate) const TRANSFER: &str = "UPDATE repos SET namespace = ?2 WHERE id = ?1 AND namespace = ?3
    AND (is_private = 1 OR stored_bytes + storage_reserved_bytes <= ?4 - COALESCE((SELECT SUM(r.stored_bytes + r.storage_reserved_bytes) FROM repos r
        WHERE r.namespace = ?2 AND r.is_private = 0 AND r.fork_of IS NULL), 0))
    RETURNING id";

/// A native fork's copy lock, with its lease. ?1 source, ?2 destination,
/// ?3 created_at, ?4 now, ?5 lease_until_ms.
pub(crate) const LOCK_COPY: &str = "INSERT INTO storage_copy_locks (repo_id, destination_id, created_at, created_ms, lease_until_ms)
    VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING RETURNING repo_id";

/// What a push's answer does with its reservation.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Settlement {
    /// Stored: the reservation becomes the bytes measured.
    Finish,
    /// Refused before the store took any of it.
    Release,
    /// The store may have kept it: ended, for staff.
    End,
}

/// A push the store answered with `status`; `rate_limited` when the store
/// refused it for its rate limit (git_http.rs `Forwarded`), which takes
/// nothing. Any other answer than 200 is ambiguous.
pub(crate) fn push_settlement(status: u16, rate_limited: bool) -> Settlement {
    match (status, rate_limited) {
        (200, _) => Settlement::Finish,
        (_, true) => Settlement::Release,
        _ => Settlement::End,
    }
}

/// Ends a copy lock. ?1 source, ?2 destination.
pub(crate) const UNLOCK_COPY: &str = "DELETE FROM storage_copy_locks WHERE repo_id = ?1 AND destination_id = ?2 RETURNING repo_id";

/// Whether a store call that failed with `error` may still be at work in
/// the store: it timed out, the store answered with a server error, or it
/// gave no answer. Not when the store refused it for its rate limit or as
/// read-only, when g1t never asked (its breaker was open), or when the
/// store answered with a reason (a permanent error carries no `Busy`,
/// store.rs `invoke`).
pub(crate) fn may_still_run(error: &str) -> bool {
    match crate::resilience::busy(error) {
        Some(busy) => !(busy.read_only || busy.rate_limited || error.contains(" not asked: ")),
        None => false,
    }
}

impl Registry {
    pub(crate) async fn copy_size(&self, repo: &Repo) -> Result<(u64, u64)> {
        #[derive(Deserialize)]
        struct Size { stored_bytes: f64, storage_reserved_bytes: f64 }
        let row = self.db.prepare("SELECT stored_bytes, storage_reserved_bytes FROM repos WHERE id = ?")
            .bind(&[repo.id.as_str().into()])?.first::<Size>(None).await?
            .ok_or_else(|| worker::Error::RustError("Copy source disappeared".into()))?;
        Ok((row.stored_bytes.max(0.0) as u64, row.storage_reserved_bytes.max(0.0) as u64))
    }
    pub(crate) async fn lock_copy(&self, source: &Repo, destination: &Repo) -> Result<bool> {
        #[derive(Deserialize)]
        struct Locked { #[serde(rename = "repo_id")] _id: String }
        let now = now_ms();
        Ok(self.db.prepare(LOCK_COPY)
            .bind(&[source.id.as_str().into(), destination.id.as_str().into(), destination.created_at.as_str().into(),
                (now as f64).into(), ((now + LEASE_MS) as f64).into()])?
            .first::<Locked>(None).await?.is_some())
    }

    /// Lets the source take writes again. False when its lock was gone
    /// already: staff released it while the copy ran (storage_holds.rs).
    pub(crate) async fn unlock_copy(&self, source: &Repo, destination: &Repo) -> Result<bool> {
        #[derive(Deserialize)]
        struct Unlocked { #[serde(rename = "repo_id")] _id: String }
        Ok(self.db.prepare(UNLOCK_COPY)
            .bind(&[source.id.as_str().into(), destination.id.as_str().into()])?
            .first::<Unlocked>(None).await?.is_some())
    }
    pub(crate) async fn make_public(&self, repo: &Repo, cap: i64) -> Result<bool> {
        #[derive(Deserialize)]
        struct Changed { #[serde(rename = "id")] _id: String }
        let results = self.db.batch(vec![
            self.db.prepare(MAKE_PUBLIC).bind(&[repo.id.as_str().into(), (cap as f64).into()])?,
            self.db.prepare("UPDATE repos SET is_private = 0 WHERE fork_of = ?1 AND EXISTS (SELECT 1 FROM repos root WHERE root.id = ?1 AND root.is_private = 0)")
                .bind(&[repo.id.as_str().into()])?,
        ]).await?;
        Ok(!results[0].results::<Changed>()?.is_empty())
    }

    /// Reserves against the canonical root, also counting retained deleted
    /// repositories, for `operation` writing `repo`. `None` when the
    /// workspace cannot fit the write.
    pub(crate) async fn reserve_public(
        &self, repo: &Repo, bytes: u64, cap: i64, operation: Operation, actor: Option<&str>,
    ) -> Result<Option<Reservation>> {
        let now = now_ms();
        let mut reservation = Reservation {
            id: new_id("srv", now),
            root: repo.fork_of.clone().unwrap_or_else(|| repo.id.clone()),
            target: repo.id.clone(),
            operation,
            actor: actor.map(str::to_owned),
            bytes: 0,
            created_at: rfc3339(now),
            lease_until_ms: now + LEASE_MS,
        };
        Ok(self.grant(&mut reservation, bytes, cap, now).await?.then_some(reservation))
    }

    /// Reserves `bytes` more under `reservation`, while its lease lasts.
    pub(crate) async fn grow_public(&self, reservation: &mut Reservation, bytes: u64, cap: i64) -> Result<bool> {
        self.grant(reservation, bytes, cap, now_ms()).await
    }

    async fn grant(&self, reservation: &mut Reservation, bytes: u64, cap: i64, now: u64) -> Result<bool> {
        #[derive(Deserialize)]
        struct Held { #[serde(rename = "id")] _id: String }
        let grant = new_id("grt", now);
        let actor: worker::wasm_bindgen::JsValue = match &reservation.actor {
            Some(actor) => actor.as_str().into(),
            None => worker::wasm_bindgen::JsValue::NULL,
        };
        let results = self.db.batch(vec![
            self.db.prepare(HOLD).bind(&[
                reservation.root.as_str().into(), (bytes as f64).into(), (cap as f64).into(), reservation.id.as_str().into(),
                reservation.target.as_str().into(), reservation.operation.as_str().into(), actor, grant.as_str().into(),
                reservation.created_at.as_str().into(), (now as f64).into(), (reservation.lease_until_ms as f64).into(),
            ])?,
            self.db.prepare(HOLD_SUM).bind(&[
                reservation.root.as_str().into(), (bytes as f64).into(), reservation.id.as_str().into(), grant.as_str().into(),
            ])?,
        ]).await?;
        let granted = !results[0].results::<Held>()?.is_empty();
        if granted {
            reservation.bytes = reservation.bytes.saturating_add(bytes);
        }
        Ok(granted)
    }

    /// Lets a reservation go, nothing written: the store was never asked,
    /// or refused the write whole.
    pub(crate) async fn release_public(&self, reservation: &Reservation) -> Result<()> {
        self.settle(reservation, 0).await
    }

    /// Converts admitted capacity to measured storage in one batch.
    pub(crate) async fn finish_public(&self, reservation: &Reservation, measured: u64) -> Result<()> {
        if measured > reservation.bytes {
            return Err(worker::Error::RustError("Push exceeded its storage reservation".into()));
        }
        self.settle(reservation, measured).await
    }

    async fn settle(&self, reservation: &Reservation, measured: u64) -> Result<()> {
        let args = [reservation.root.as_str().into(), reservation.id.as_str().into(), (measured as f64).into()];
        self.db.batch(vec![
            self.db.prepare(SETTLE_RELEASED).bind(&args)?,
            self.db.prepare(SETTLE).bind(&args)?,
            self.db.prepare(SETTLE_ROW).bind(&[reservation.id.as_str().into()])?,
        ]).await?;
        Ok(())
    }

    /// The operation stopped without knowing whether the store took its
    /// write: the reservation stays, marked so staff can release it once
    /// they have looked (storage_holds.rs). `refs` are the refs it asked
    /// the store to move, `(name, new)`. Never fails the caller: the
    /// reservation is held either way.
    pub(crate) async fn end_public(&self, reservation: &Reservation, outcome: &str, refs: &[(String, String)]) {
        let refs = serde_json::to_string(refs).unwrap_or_else(|_| "[]".to_owned());
        let outcome: String = outcome.chars().take(500).collect();
        let ended = async {
            self.db.prepare(END)
                .bind(&[reservation.id.as_str().into(), (now_ms() as f64).into(), outcome.as_str().into(), refs.as_str().into()])?
                .run().await
        };
        if let Err(error) = ended.await {
            worker::console_error!("repos: reservation {} could not be marked ended: {error}", reservation.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The part of a statement after its first WHERE, up to `until`.
    fn admission(sql: &str, until: &str) -> String {
        let from = sql.find("WHERE id = ?1 AND fork_of IS NULL").unwrap();
        let rest = &sql[from..];
        let to = rest.find(until).unwrap();
        rest[..to].split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn rows_are_admitted_exactly_as_the_sum_was() {
        let old = admission(RESERVE, "RETURNING");
        let new = admission(HOLD, "ON CONFLICT").replace(" AND ?10 <= ?11", "");
        assert_eq!(old, new);
    }

    #[test]
    fn a_push_refused_for_the_rate_limit_lets_its_reservation_go_at_once() {
        assert_eq!(push_settlement(200, false), Settlement::Finish);
        assert_eq!(push_settlement(429, true), Settlement::Release);
        // A server error, or no answer (g1t's own 503), may have been kept.
        assert_eq!(push_settlement(500, false), Settlement::End);
        assert_eq!(push_settlement(503, false), Settlement::End);
        // A 429 g1t did not see as the store's rate limit is not assumed to be one.
        assert_eq!(push_settlement(429, false), Settlement::End);
    }

    #[test]
    fn a_fork_that_may_still_be_copying_keeps_its_lock() {
        use crate::resilience::Busy;
        let unavailable = Busy { rate_limited: false, retry_after: 5, read_only: false };
        // A timeout, a 5xx or no answer at all: the store may be copying.
        assert!(may_still_run(&unavailable.error("fork for acme--rocket failed: INTERNAL_ERROR").to_string()));
        assert!(may_still_run(&unavailable.error("fork for acme--rocket failed: the operation timed out").to_string()));
        // Refused for the rate limit, read-only, or never asked: nothing is.
        assert!(!may_still_run(&Busy { rate_limited: true, ..unavailable }.error("fork failed: RATE_LIMITED").to_string()));
        assert!(!may_still_run(&Busy::read_only().error("fork refused: the git store is read-only").to_string()));
        assert!(!may_still_run(&unavailable.error("fork not asked: the git store has been failing").to_string()));
        // An answer with a reason (NOT_FOUND, a bad name) carries no Busy.
        assert!(!may_still_run("NOT_FOUND: no such repository"));
    }

    #[test]
    fn a_write_is_cut_short_well_before_older_code_could_still_be_running() {
        assert_eq!(LEASE_MS, 3_600_000, "an hour");
        assert_eq!(lease_words(), "an hour");
        assert!(GRACE_MS > 0 && LEGACY_MS > LEASE_MS + GRACE_MS);
        // Grants past the lease are refused in the statement itself.
        assert!(HOLD.contains("?10 <= ?11"));
        assert!(HOLD.contains("WHERE storage_reservations.state = 'held'"));
    }
}
