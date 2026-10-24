//! Public storage admission is independent of a paid subscription. Reserve
//! bytes before contacting the git store; a crash retains the reservation
//! rather than admitting the same capacity twice. A write the store took
//! replaces its reservation with the bytes it measured; one the store
//! refused (an `ng` for its ref, a failed unpack) gives it back and counts
//! nothing, since `stored_bytes` is what private storage is billed from.
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
//!
//! A refused grant says why ([`Refusal`]), read in the batch that asked:
//! a native fork's copy lock on the root refuses every write to it, private
//! or public and whatever room there is, and says so; only a write the cap
//! refused is told that public storage is full.
use std::cell::RefCell;

use g1t_contracts::new_id;
use g1t_contracts::repos::Repo;
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::land::{Answer, Report, Verdict};
use crate::registry::Registry;

/// How long an operation holding a reservation may send to the store. A
/// push still streaming at its lease is cut short, so the store refuses it
/// whole, and one read whole after it is declined (git_http.rs); a branch
/// copied chunk by chunk is refused its next chunk (land.rs). Writes of one
/// pack in memory, and a native fork's one call to the store, are not cut:
/// the lease assumes they have been answered by then. An hour: a push is at most
/// 100 MB (pack_limits.rs), which uploads well within it on any ordinary
/// connection. The copy lock's lease, the grants a
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

/// Why a write was refused its reservation: decided here, in the batch
/// that asked ([`COPY_LOCKED`] beside [`HOLD`]), so every write says the
/// same thing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// The repository is being copied into a native fork, whose lock
    /// refuses its writes until the fork's size is taken (network.rs),
    /// whether it is private or public, and whatever room there is.
    Locked,
    /// Locked, by a copy that has taken longer than it should or did not
    /// finish cleanly: the fork holds no live reservation, its call to
    /// the store failed in a way that may still be copying, or the lock's
    /// lease has passed. The lock stays until staff release it
    /// (storage_holds.rs), at the soonest its lease and grace after it was
    /// taken.
    Stalled,
    /// The workspace's public repositories cannot fit it.
    Full,
    /// A streamed copy's lease passed before it finished (land.rs).
    Overdue,
}

impl Refusal {
    /// What the write's author is told.
    pub fn message(self) -> String {
        match self {
            Refusal::Locked => LOCKED_MESSAGE.to_owned(),
            Refusal::Stalled => STALLED_MESSAGE.to_owned(),
            Refusal::Full => FULL_MESSAGE.to_owned(),
            Refusal::Overdue => format!("The copy took longer than {}, so g1t stopped it. Try again.", lease_words()),
        }
    }

    /// The failure a write from the site answers with. The lock is
    /// `Unavailable`, not a conflict: an automatic merge lets go of a
    /// conflict for its next look to try again, and the lock's end
    /// publishes nothing that would look again, so a merge g1t makes
    /// stalls with the message instead (work's lifecycle.rs
    /// `merge_by_policy`).
    pub fn outcome<T>(self) -> g1t_contracts::Outcome<T> {
        let code = match self {
            Refusal::Locked | Refusal::Stalled => g1t_contracts::FailureCode::Unavailable,
            Refusal::Overdue => g1t_contracts::FailureCode::Conflict,
            Refusal::Full => g1t_contracts::FailureCode::Forbidden,
        };
        g1t_contracts::Outcome::fail(code, self.message())
    }
}

/// A write to a repository being copied into a fork. A native fork is one
/// call to the store, which ordinarily answers within a few minutes; one
/// whose call timed out keeps its lock until its lease (an hour) and grace
/// have passed, and staff release it (storage_holds.rs).
pub const LOCKED_MESSAGE: &str =
    "This repository is being copied into a fork. Try again in a few minutes; if it lasts more than an hour, g1t staff release it.";
/// A write to a repository whose copy into a fork is known not to have
/// finished cleanly ([`Refusal::Stalled`]): it stays locked until staff
/// release it, at the soonest its lease and grace after it began, and
/// later if nobody has looked yet.
pub const STALLED_MESSAGE: &str = "This repository is being copied into a fork, and the copy has taken longer than it should, or did not finish cleanly, so it takes no writes until it ends or g1t staff have checked it. That can take a few hours. Try again later.";
/// A write the workspace's public storage cannot fit: one constant with
/// work's, which tells it from a refusal of who may push.
pub const FULL_MESSAGE: &str = g1t_contracts::repos::PUBLIC_STORAGE_FULL;

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
    pub async fn grow(&self, bytes: u64) -> Result<std::result::Result<(), Refusal>> {
        let held = self.held.borrow().clone();
        match held {
            None => match self.registry.reserve_public(&self.repo, bytes, self.cap, self.operation, self.actor.as_deref()).await? {
                Ok(reservation) => {
                    *self.held.borrow_mut() = Some(reservation);
                    Ok(Ok(()))
                }
                Err(refusal) => Ok(Err(refusal)),
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
        self.end_asking(outcome, &[]).await;
    }

    /// [`Self::end`], with the refs it asked the store to move.
    async fn end_asking(&self, outcome: &str, refs: &[(String, String)]) {
        let held = self.held.borrow_mut().take();
        if let Some(reservation) = held {
            self.registry.end_public(&reservation, outcome, refs).await;
        }
    }

    /// The store answered the copy, `measured` bytes of pack sent, which
    /// asked it to move `(reference, new)`: settled by its
    /// [`write_settlement`]. One that ends keeps the ref it asked for, so
    /// staff can see whether it landed (storage_holds.rs).
    pub async fn settle(&self, verdict: &Verdict, measured: u64, asked: (&str, &str)) -> Result<()> {
        match write_settlement(verdict) {
            Settlement::Finish => self.finish(measured).await,
            Settlement::Release => self.release().await,
            Settlement::End => {
                self.end_asking(verdict.reason(), &asked_refs(asked)).await;
                Ok(())
            }
        }
    }
}

/// The refs a write of one ref asked the store to move, as an ended
/// reservation keeps them: `(name, new)`.
pub(crate) fn asked_refs((reference, new): (&str, &str)) -> Vec<(String, String)> {
    vec![(reference.to_owned(), new.to_owned())]
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
        &self,
        slot: &RefCell<Option<Reservation>>,
        repo: &Repo,
        bytes: u64,
        operation: Operation,
        actor: Option<&str>,
    ) -> Result<std::result::Result<(), Refusal>> {
        let reservation = self.registry.reserve_public(repo, bytes, self.free_public_bytes, operation, actor).await?;
        Ok(reservation.map(|reservation| *slot.borrow_mut() = Some(reservation)))
    }

    /// Pushes `pack` to `branch` under a reservation of its size: the
    /// [`Refusal`] when it was refused one (the repository is being copied
    /// into a fork, or the workspace's public storage cannot fit it). The inner result
    /// is the store's verdict on the branch (land.rs `push_pack_judged`). The pack
    /// is counted only when the branch moved; one the store refused (the
    /// branch had moved, or the unpack failed) gives its reservation back
    /// with nothing counted. A push the store answered with an error, never
    /// answered, or answered without saying either, leaves its reservation
    /// ended for staff.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn push_reserved(
        &self,
        repo: &Repo,
        operation: Operation,
        actor: Option<&str>,
        access: &g1t_contracts::repos::GitAccess,
        branch: &str,
        old: Option<&str>,
        new: &str,
        pack: Vec<u8>,
    ) -> Result<std::result::Result<std::result::Result<(), String>, Refusal>> {
        let bytes = pack.len() as u64;
        let reservation = match self.registry.reserve_public(repo, bytes, self.free_public_bytes, operation, actor).await? {
            Ok(reservation) => reservation,
            Err(refusal) => return Ok(Err(refusal)),
        };
        let refs = asked_refs((&format!("refs/heads/{branch}"), new));
        match crate::land::push_pack_judged(access, branch, old, new, pack).await {
            Ok(verdict) => {
                match write_settlement(&verdict) {
                    Settlement::Finish => self.registry.finish_public(&reservation, bytes).await?,
                    Settlement::Release => self.registry.release_public(&reservation).await?,
                    Settlement::End => self.registry.end_public(&reservation, verdict.reason(), &refs).await,
                }
                Ok(Ok(verdict.into_result()))
            }
            Err(error) => {
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

/// Whether a native fork's copy lock holds `?1` at `?2` (now): read in
/// [`HOLD`]'s batch, so a refused grant says whether the lock or the cap
/// refused it. `stalled` when the copy did not finish cleanly: the fork's
/// reservation ended (its call failed in a way that may still be copying,
/// network.rs), or the lock's lease has passed (or it has none: older
/// code's).
///
/// A lock whose fork holds no `held` reservation is stalled too, once
/// [`FORK_RESERVE_WINDOW_MS`] has passed since it was taken (the fork
/// reserves just after it locks): staff may release an ended reservation
/// at once, while its lock lasts until its lease and grace.
pub(crate) const COPY_LOCKED: &str = "SELECT EXISTS (SELECT 1 FROM storage_copy_locks WHERE repo_id = ?1) AS locked,
      EXISTS (SELECT 1 FROM storage_copy_locks l WHERE l.repo_id = ?1
        AND (COALESCE(l.lease_until_ms, 0) < ?2
          OR EXISTS (SELECT 1 FROM storage_reservations r
            WHERE r.root_id = l.destination_id AND r.operation = 'fork' AND r.state = 'ended')
          OR (COALESCE(l.created_ms, 0) + 60000 < ?2 AND NOT EXISTS (SELECT 1 FROM storage_reservations r
            WHERE r.root_id = l.destination_id AND r.operation = 'fork' AND r.state = 'held')))) AS stalled";

/// How long after a native fork locks its source its reservation may not
/// be there yet (network.rs takes it right after a few writes of its own).
/// Written into [`COPY_LOCKED`], which the tests hold to it.
#[cfg_attr(not(test), allow(dead_code))]
pub const FORK_RESERVE_WINDOW_MS: u64 = 60_000;

/// What [`COPY_LOCKED`] read.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct CopyLock {
    pub locked: f64,
    pub stalled: f64,
}

impl CopyLock {
    /// Why the lock refuses a write, if it holds the repository.
    pub fn refusal(self) -> Option<Refusal> {
        match (self.locked > 0.0, self.stalled > 0.0) {
            (false, _) => None,
            (true, false) => Some(Refusal::Locked),
            (true, true) => Some(Refusal::Stalled),
        }
    }
}

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
    /// Refused: the store took none of it, so nothing is counted.
    Release,
    /// The store may have kept it: ended, for staff.
    End,
}

/// A push the store answered with `status` and `answer`, its answer read
/// whole (land.rs `read_answer`); `rate_limited` when the store refused it
/// for its rate limit (git_http.rs `Forwarded`), which takes nothing. A
/// 200 whose report says the store refused all of it ([`refused_whole`])
/// takes nothing either. A 200 with a fatal error (side-band channel 3,
/// or `ERR`) says nothing of any ref: the store most likely took nothing,
/// but that is not known, so it ends, as a write of one ref answered so
/// does (`write_settlement`). Any other 200 is counted, a report that
/// moved a ref or none at all (a client that asked for none). Any other
/// answer than 200 is ambiguous.
pub(crate) fn push_settlement(status: u16, rate_limited: bool, answer: Option<&Answer>) -> Settlement {
    match (status, rate_limited, answer) {
        (200, _, Some(Answer::Report(report))) if refused_whole(report) => Settlement::Release,
        (200, _, Some(Answer::Fatal(_))) => Settlement::End,
        (200, ..) => Settlement::Finish,
        (_, true, _) => Settlement::Release,
        _ => Settlement::End,
    }
}

/// What an ended push's reservation says of how it ended, for staff.
pub(crate) fn push_outcome(status: u16, answer: Option<&Answer>) -> String {
    match answer {
        Some(Answer::Fatal(said)) => format!("The store answered the push with {status} and a fatal error: {said}"),
        _ => format!("The store answered the push with {status}."),
    }
}

/// Whether a push's report-status says the store kept none of it: its
/// unpack failed, or it refused (`ng`) every ref it reports on and moved
/// none.
pub(crate) fn refused_whole(report: &Report) -> bool {
    report.unpack_failed || (report.unpacked && !report.refused.is_empty() && report.moved.is_empty())
}

/// What the store's answer to a write of one ref (land.rs `Verdict`)
/// does with its reservation: counted only when the ref moved, given back
/// when the store refused it, and ended, for staff, when the answer says
/// neither.
pub(crate) fn write_settlement(verdict: &Verdict) -> Settlement {
    match verdict {
        Verdict::Moved => Settlement::Finish,
        Verdict::Refused(_) => Settlement::Release,
        Verdict::Unclear(_) => Settlement::End,
    }
}

/// Why [`HOLD`] refused a grant at `now`, for a reservation leased to
/// `lease_until_ms`, given what [`COPY_LOCKED`] read in the same batch.
/// The lock comes first: while it is held, nothing is granted however much
/// room there is.
pub(crate) fn refusal(lock: CopyLock, now: u64, lease_until_ms: u64) -> Refusal {
    if let Some(locked) = lock.refusal() {
        locked
    } else if now > lease_until_ms {
        Refusal::Overdue
    } else {
        Refusal::Full
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
        struct Size {
            stored_bytes: f64,
            storage_reserved_bytes: f64,
        }
        let row = self
            .db
            .prepare("SELECT stored_bytes, storage_reserved_bytes FROM repos WHERE id = ?")
            .bind(&[repo.id.as_str().into()])?
            .first::<Size>(None)
            .await?
            .ok_or_else(|| worker::Error::RustError("Copy source disappeared".into()))?;
        Ok((row.stored_bytes.max(0.0) as u64, row.storage_reserved_bytes.max(0.0) as u64))
    }
    pub(crate) async fn lock_copy(&self, source: &Repo, destination: &Repo) -> Result<bool> {
        #[derive(Deserialize)]
        struct Locked {
            #[serde(rename = "repo_id")]
            _id: String,
        }
        let now = now_ms();
        Ok(self
            .db
            .prepare(LOCK_COPY)
            .bind(&[
                source.id.as_str().into(),
                destination.id.as_str().into(),
                destination.created_at.as_str().into(),
                (now as f64).into(),
                ((now + LEASE_MS) as f64).into(),
            ])?
            .first::<Locked>(None)
            .await?
            .is_some())
    }

    /// Why a native fork's copy lock refuses writes to `repo`'s root, if
    /// one holds it: asked when a push begins, so that git shows why
    /// (lib.rs).
    pub(crate) async fn copy_locked(&self, repo: &Repo) -> Result<Option<Refusal>> {
        let root = repo.fork_of.as_deref().unwrap_or(&repo.id);
        let lock = self.db.prepare(COPY_LOCKED).bind(&[root.into(), (now_ms() as f64).into()])?.first::<CopyLock>(None).await?;
        Ok(lock.unwrap_or_default().refusal())
    }

    /// Lets the source take writes again. False when its lock was gone
    /// already: staff released it while the copy ran (storage_holds.rs).
    pub(crate) async fn unlock_copy(&self, source: &Repo, destination: &Repo) -> Result<bool> {
        #[derive(Deserialize)]
        struct Unlocked {
            #[serde(rename = "repo_id")]
            _id: String,
        }
        Ok(self
            .db
            .prepare(UNLOCK_COPY)
            .bind(&[source.id.as_str().into(), destination.id.as_str().into()])?
            .first::<Unlocked>(None)
            .await?
            .is_some())
    }
    pub(crate) async fn make_public(&self, repo: &Repo, cap: i64) -> Result<bool> {
        #[derive(Deserialize)]
        struct Changed {
            #[serde(rename = "id")]
            _id: String,
        }
        let results = self.db.batch(vec![
            self.db.prepare(MAKE_PUBLIC).bind(&[repo.id.as_str().into(), (cap as f64).into()])?,
            self.db.prepare("UPDATE repos SET is_private = 0 WHERE fork_of = ?1 AND EXISTS (SELECT 1 FROM repos root WHERE root.id = ?1 AND root.is_private = 0)")
                .bind(&[repo.id.as_str().into()])?,
        ]).await?;
        Ok(!results[0].results::<Changed>()?.is_empty())
    }

    /// Reserves against the canonical root, also counting retained deleted
    /// repositories, for `operation` writing `repo`. The [`Refusal`] when
    /// the root is being copied into a fork, or the workspace cannot fit
    /// the write.
    pub(crate) async fn reserve_public(
        &self,
        repo: &Repo,
        bytes: u64,
        cap: i64,
        operation: Operation,
        actor: Option<&str>,
    ) -> Result<std::result::Result<Reservation, Refusal>> {
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
        Ok(self.grant(&mut reservation, bytes, cap, now).await?.map(|()| reservation))
    }

    /// Reserves `bytes` more under `reservation`, while its lease lasts.
    pub(crate) async fn grow_public(
        &self,
        reservation: &mut Reservation,
        bytes: u64,
        cap: i64,
    ) -> Result<std::result::Result<(), Refusal>> {
        self.grant(reservation, bytes, cap, now_ms()).await
    }

    async fn grant(&self, reservation: &mut Reservation, bytes: u64, cap: i64, now: u64) -> Result<std::result::Result<(), Refusal>> {
        #[derive(Deserialize)]
        struct Held {
            #[serde(rename = "id")]
            _id: String,
        }
        let grant = new_id("grt", now);
        let actor: worker::wasm_bindgen::JsValue = match &reservation.actor {
            Some(actor) => actor.as_str().into(),
            None => worker::wasm_bindgen::JsValue::NULL,
        };
        let results = self
            .db
            .batch(vec![
                self.db.prepare(HOLD).bind(&[
                    reservation.root.as_str().into(),
                    (bytes as f64).into(),
                    (cap as f64).into(),
                    reservation.id.as_str().into(),
                    reservation.target.as_str().into(),
                    reservation.operation.as_str().into(),
                    actor,
                    grant.as_str().into(),
                    reservation.created_at.as_str().into(),
                    (now as f64).into(),
                    (reservation.lease_until_ms as f64).into(),
                ])?,
                self.db.prepare(HOLD_SUM).bind(&[
                    reservation.root.as_str().into(),
                    (bytes as f64).into(),
                    reservation.id.as_str().into(),
                    grant.as_str().into(),
                ])?,
                self.db.prepare(COPY_LOCKED).bind(&[reservation.root.as_str().into(), (now as f64).into()])?,
            ])
            .await?;
        if !results[0].results::<Held>()?.is_empty() {
            reservation.bytes = reservation.bytes.saturating_add(bytes);
            return Ok(Ok(()));
        }
        let lock = results[2].results::<CopyLock>()?.into_iter().next().unwrap_or_default();
        Ok(Err(refusal(lock, now, reservation.lease_until_ms)))
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
        self.db
            .batch(vec![
                self.db.prepare(SETTLE_RELEASED).bind(&args)?,
                self.db.prepare(SETTLE).bind(&args)?,
                self.db.prepare(SETTLE_ROW).bind(&[reservation.id.as_str().into()])?,
            ])
            .await?;
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
            self.db
                .prepare(END)
                .bind(&[reservation.id.as_str().into(), (now_ms() as f64).into(), outcome.as_str().into(), refs.as_str().into()])?
                .run()
                .await
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
        assert_eq!(push_settlement(200, false, None), Settlement::Finish);
        assert_eq!(push_settlement(429, true, None), Settlement::Release);
        // A server error, or no answer (g1t's own 503), may have been kept.
        assert_eq!(push_settlement(500, false, None), Settlement::End);
        assert_eq!(push_settlement(503, false, None), Settlement::End);
        // A 429 g1t did not see as the store's rate limit is not assumed to be one.
        assert_eq!(push_settlement(429, false, None), Settlement::End);
    }

    /// A report-status, plain.
    fn report(lines: &[&str]) -> Vec<u8> {
        let mut report: Vec<u8> = lines.iter().flat_map(|line| crate::git_http::pkt_line(format!("{line}\n").as_bytes())).collect();
        report.extend_from_slice(b"0000");
        report
    }

    /// The same report inside side-band channel 1, after a progress line,
    /// split across packets, as the store answers a client that asked for
    /// side-band.
    fn banded(lines: &[&str]) -> Vec<u8> {
        let mut answer = crate::git_http::pkt_line(b"\x02Resolving deltas: 100% (3/3)\n");
        for chunk in report(lines).chunks(9) {
            answer.extend(crate::git_http::pkt_line(&[&[1u8][..], chunk].concat()));
        }
        answer.extend_from_slice(b"0000");
        answer
    }

    /// What a write of one pack to `reference` does with its reservation
    /// when the store answers `answer` (`push_reserved`, and a branch
    /// copied chunk by chunk, land.rs `fast_forward`).
    fn settled(answer: &[u8], reference: &str) -> Settlement {
        write_settlement(&crate::land::verdict(answer, reference, true))
    }

    /// The body of `fn name` in `source`, up to the next item.
    fn body_of(source: &str, name: &str) -> String {
        let code = source.split("#[cfg(test)]\nmod tests").next().unwrap_or_default();
        let lines: Vec<&str> = code.lines().collect();
        let start = lines.iter().position(|line| line.contains(&format!("fn {name}("))).unwrap_or_else(|| panic!("no fn {name}"));
        let end = lines[start + 1..]
            .iter()
            .position(|line| {
                let indent = line.len() - line.trim_start().len();
                let rest = line.trim_start();
                indent <= 4 && ["fn ", "async fn ", "pub", "///", "#["].iter().any(|prefix| rest.starts_with(prefix))
            })
            .map_or(lines.len(), |at| start + 1 + at);
        lines[start..end].join("\n")
    }

    #[test]
    fn a_write_is_counted_only_when_the_store_took_it() {
        assert_eq!(write_settlement(&Verdict::Moved), Settlement::Finish);
        assert_eq!(write_settlement(&Verdict::Refused("ng".into())), Settlement::Release);
        assert_eq!(write_settlement(&Verdict::Unclear(String::new())), Settlement::End);
        // Every write of one pack settles by the store's verdict, never by
        // its having answered: the measured bytes go into stored_bytes
        // only on Finish.
        let reserved = body_of(include_str!("public_storage.rs"), "push_reserved");
        assert!(reserved.contains("push_pack_judged("), "{reserved}");
        assert!(reserved.contains("match write_settlement(&verdict)"));
        assert_eq!(reserved.matches("finish_public(").count(), 1);
        assert!(reserved.contains("Settlement::Finish => self.registry.finish_public("));
        assert!(reserved.contains("Settlement::Release => self.registry.release_public("));
        let copied = body_of(include_str!("land.rs"), "fast_forward");
        assert!(copied.contains("quota.settle(&verdict, moved, (&reference, new))"), "{copied}");
        // Ended, either way keeping the ref asked for, for staff to inspect.
        assert!(reserved.contains("asked_refs((&format!(\"refs/heads/{branch}\"), new))"));
        assert!(body_of(include_str!("public_storage.rs"), "settle").contains("self.end_asking(verdict.reason(), &asked_refs(asked))"));
        assert_eq!(asked_refs(("refs/heads/main", "abc")), [("refs/heads/main".to_owned(), "abc".to_owned())]);
        assert!(!copied.contains("quota.finish("));
    }

    #[test]
    fn a_file_committed_to_a_branch_that_appeared_meanwhile_counts_nothing() {
        let source = body_of(include_str!("commit_file.rs"), "commit_file");
        assert!(source.contains("push_reserved(") && !source.contains("finish_public("));
        let refused = report(&["unpack ok", "ng refs/heads/docs failed to update ref"]);
        assert_eq!(settled(&refused, "refs/heads/docs"), Settlement::Release);
        let made = report(&["unpack ok", "ok refs/heads/docs"]);
        assert_eq!(settled(&made, "refs/heads/docs"), Settlement::Finish);
    }

    #[test]
    fn a_merge_whose_branch_moved_counts_nothing_however_often_it_is_tried() {
        let source = body_of(include_str!("merge_methods.rs"), "land_by");
        assert!(source.contains("push_reserved(") && !source.contains("finish_public("));
        // Each attempt reserves again and is refused again: nothing of any
        // of them is counted.
        for reason in ["non-fast-forward", "stale info", "fetch first"] {
            let refused = report(&["unpack ok", &format!("ng refs/heads/main {reason}")]);
            assert_eq!(settled(&refused, "refs/heads/main"), Settlement::Release, "{reason}");
        }
    }

    #[test]
    fn a_merge_queue_branch_the_store_could_not_unpack_counts_nothing() {
        let source = body_of(include_str!("merge_methods.rs"), "build_queue_step");
        assert!(source.contains("push_reserved(") && !source.contains("finish_public("));
        let unpacked = report(&["unpack index-pack abnormal exit", "ng refs/heads/gq/main/1 unpacker error"]);
        assert_eq!(settled(&unpacked, "refs/heads/gq/main/1"), Settlement::Release);
        let moved = report(&["unpack ok", "ng refs/heads/gq/main/1 non-fast-forward"]);
        assert_eq!(settled(&moved, "refs/heads/gq/main/1"), Settlement::Release);
    }

    #[test]
    fn a_pull_request_update_whose_branch_was_pushed_meanwhile_counts_nothing() {
        let source = body_of(include_str!("catch_up.rs"), "push_update");
        assert!(source.contains("push_reserved(") && !source.contains("finish_public("));
        let refused = report(&["unpack ok", "ng refs/heads/feature non-fast-forward"]);
        assert_eq!(settled(&refused, "refs/heads/feature"), Settlement::Release);
    }

    #[test]
    fn a_landing_sync_or_branch_copied_into_a_fork_that_was_refused_counts_nothing() {
        // land (lib.rs), sync_fork and fork (network.rs) copy a branch
        // chunk by chunk, settled in land.rs `fast_forward`.
        for (file, source, function) in [
            ("lib.rs", include_str!("lib.rs"), "land"),
            ("network.rs", include_str!("network.rs"), "sync_fork"),
            ("network.rs", include_str!("network.rs"), "fork"),
        ] {
            let body = body_of(source, function);
            assert!(body.contains("land::fast_forward("), "{file}: {function}");
            assert!(body.contains("self.public_quota("), "{file}: {function}");
        }
        let refused = report(&["unpack ok", "ng refs/heads/main fetch first"]);
        assert_eq!(settled(&refused, "refs/heads/main"), Settlement::Release);
    }

    #[test]
    fn a_landing_or_sync_refused_its_reservation_says_why() {
        // fast_forward hands back the refusal that cut it short, once its
        // reservation was let go as any cut short is.
        let forward = body_of(include_str!("land.rs"), "fast_forward");
        assert!(forward.contains("refused.set(Some(refusal));"));
        let cut = forward.find("match cut_short(delivered.get())").expect("cut short as before");
        let handed = forward.find("return Ok(Err(refusal));").expect("the refusal handed back");
        assert!(cut < handed);
        // Each caller says it: a fast-forward merge and the merge queue's
        // landing (land), a sync, and a fork of the default branch.
        for (file, source, function, said) in [
            ("lib.rs", include_str!("lib.rs"), "land", "Err(refusal) => return Ok(refusal.outcome()),"),
            ("network.rs", include_str!("network.rs"), "sync_fork", "Err(refusal) => return Ok(refusal.outcome()),"),
            ("network.rs", include_str!("network.rs"), "fork", "Err(refusal) => Err(refusal.message()),"),
        ] {
            let body = body_of(source, function);
            let at = body.find("land::fast_forward(").unwrap_or_else(|| panic!("{file}: {function}"));
            assert!(body[at..].contains(said), "{file}: {function}");
        }
        // What a landing on a repository being copied into a fork is told:
        // the lock, as a merge g1t makes stalls with it.
        let g1t_contracts::Outcome::Fail(locked) = Refusal::Locked.outcome::<g1t_contracts::repos::Landed>() else { panic!("refused") };
        assert_eq!(locked.code, g1t_contracts::FailureCode::Unavailable);
        assert_eq!(locked.message, LOCKED_MESSAGE);
        let g1t_contracts::Outcome::Fail(full) = Refusal::Full.outcome::<g1t_contracts::repos::SyncedFork>() else { panic!("refused") };
        assert_eq!((full.code, full.message.as_str()), (g1t_contracts::FailureCode::Forbidden, FULL_MESSAGE));
    }

    #[test]
    fn a_write_the_store_answered_without_a_verdict_stays_ended_for_staff() {
        // Nothing, an unpack that said nothing of the ref, a report for
        // another ref, a fatal error on side-band channel 3, or no report.
        for answer in [
            Vec::new(),
            report(&["unpack ok"]),
            report(&["unpack ok", "ng refs/heads/main2 non-fast-forward"]),
            [crate::git_http::pkt_line(b"\x03fatal: the remote end hung up"), b"0000".to_vec()].concat(),
            b"<html>bad gateway</html>".to_vec(),
        ] {
            assert_eq!(settled(&answer, "refs/heads/main"), Settlement::End, "{answer:?}");
        }
    }

    #[test]
    fn a_push_the_store_refused_whole_counts_nothing() {
        let settle = |answer: Vec<u8>| push_settlement(200, false, Some(&crate::land::read_answer(&answer)));
        for answer in [
            // Every ref refused: the store moved none of them.
            report(&["unpack ok", "ng refs/heads/main non-fast-forward", "ng refs/tags/v1 already exists"]),
            banded(&["unpack ok", "ng refs/heads/main non-fast-forward"]),
            // The unpack failed: nothing of the pack is kept.
            report(&["unpack error: invalid pack", "ng refs/heads/main unpacker error"]),
            banded(&["unpack index-pack abnormal exit", "ng refs/heads/main unpacker error"]),
        ] {
            assert_eq!(settle(answer), Settlement::Release);
        }
        // A ref that moved stores the pack, beside one that did not (a
        // hidden ref g1t refused, hidden_refs.rs).
        assert_eq!(
            settle(banded(&["unpack ok", "ok refs/heads/main", "ng refs/pull/1/head deny updating a hidden ref"])),
            Settlement::Finish
        );
        assert_eq!(settle(report(&["unpack ok", "ok refs/heads/main"])), Settlement::Finish);
        // A 200 whose report cannot be read is counted, as before.
        assert_eq!(settle(b"0000".to_vec()), Settlement::Finish);
        assert_eq!(settle(Vec::new()), Settlement::Finish);
        // An answer other than 200 is ambiguous whatever it says.
        let refused = crate::land::read_answer(&report(&["unpack ok", "ng refs/heads/main x"]));
        assert_eq!(push_settlement(500, false, Some(&refused)), Settlement::End);
        // The push path reads the report before it settles.
        let answer = body_of(include_str!("lib.rs"), "answer_git");
        let read = answer.find("match response.bytes().await").expect("the report is read");
        let parsed = answer.find("land::read_answer(report)").expect("read once");
        let settles =
            answer.find("public_storage::push_settlement(status, forwarded.rate_limited, reply.as_ref())").expect("settled by it");
        assert!(read < parsed && parsed < settles);
    }

    #[test]
    fn a_push_the_store_answered_with_a_fatal_error_stays_ended_for_staff() {
        let fatal = [crate::git_http::pkt_line(b"\x03fatal: the remote end hung up unexpectedly\n"), b"0000".to_vec()].concat();
        let after_progress = [crate::git_http::pkt_line(b"\x02Receiving objects: 40%\n"), fatal.clone()].concat();
        let err = [crate::git_http::pkt_line(b"ERR pack exceeds the store's limit\n"), b"0000".to_vec()].concat();
        for answer in [&fatal, &after_progress, &err] {
            let read = crate::land::read_answer(answer);
            assert!(matches!(read, Answer::Fatal(_)), "{read:?}");
            // Ended with the refs it asked for, as a write of one ref
            // answered so is (Unclear).
            assert_eq!(push_settlement(200, false, Some(&read)), Settlement::End);
            assert_eq!(settled(answer, "refs/heads/main"), Settlement::End);
            // Every ref is left to record_push, which checks the store.
            assert!(read.records("refs/heads/main"));
        }
        let outcome = push_outcome(200, Some(&crate::land::read_answer(&fatal)));
        assert_eq!(outcome, "The store answered the push with 200 and a fatal error: fatal: the remote end hung up unexpectedly");
        assert_eq!(push_outcome(500, None), "The store answered the push with 500.");
        // The push path ends it through end_public with what it asked for.
        let answer = body_of(include_str!("lib.rs"), "answer_git");
        assert!(answer.contains("let outcome = public_storage::push_outcome(status, reply.as_ref());"));
        assert!(answer.contains("self.registry.end_public(reserved, &outcome, &asked).await;"));
    }

    #[test]
    fn a_push_and_a_write_of_one_ref_read_a_report_the_same() {
        // v1, and v2 with option lines after an ok, plain and banded.
        let answers = [
            report(&["unpack ok", "ok refs/heads/main"]),
            report(&["unpack ok", "ok refs/heads/main", "option refname refs/heads/main", "option old-oid abc", "option new-oid def"]),
            banded(&["unpack ok", "ok refs/heads/main", "option forced-update"]),
            report(&["unpack ok", "ng refs/heads/main non-fast-forward"]),
            report(&["unpack ok", "ng refs/heads/main"]),
            report(&["unpack error: bad pack", "ok refs/heads/main"]),
            report(&["unpack ok"]),
            report(&["unpack ok", "ok refs/heads/main2"]),
            report(&["unpack ok", "okrefs/heads/main"]),
        ];
        for answer in &answers {
            let read = crate::land::read_answer(answer);
            let verdict = crate::land::verdict(answer, "refs/heads/main", true);
            let Answer::Report(report) = &read else { panic!("{read:?}") };
            // A write of one ref is counted when the report says it moved,
            // and a ref refused there is one a push does not record.
            assert_eq!(verdict == Verdict::Moved, report.moved("refs/heads/main"), "{report:?}");
            assert_eq!(matches!(verdict, Verdict::Refused(_)), !read.records("refs/heads/main"), "{report:?}");
            if refused_whole(report) {
                assert!(matches!(verdict, Verdict::Refused(_)), "{report:?}");
            }
        }
        // v2's options are not refs.
        let Answer::Report(v2) = crate::land::read_answer(&answers[1]) else { panic!() };
        assert_eq!(v2.moved, ["refs/heads/main"]);
        assert!(v2.refused.is_empty());
        // One parser: neither reads the lines itself.
        let code = include_str!("public_storage.rs").split("#[cfg(test)]\nmod tests").next().unwrap_or_default();
        assert!(!code.contains("starts_with(\"ok \")") && !code.contains("starts_with(\"ng \")"));
    }

    #[test]
    fn a_push_records_every_ref_but_those_its_report_refused() {
        let (main, tag, pull) = ("refs/heads/main", "refs/tags/v1", "refs/pull/1/head");
        let recorded = |answer: Vec<u8>| {
            let read = crate::land::read_answer(&answer);
            [main, tag, pull].into_iter().filter(|git_ref| read.records(git_ref)).collect::<Vec<_>>()
        };
        // Every ref refused, a tag among them: none.
        assert!(
            recorded(report(&[
                "unpack ok",
                "ng refs/heads/main non-fast-forward",
                "ng refs/tags/v1 already exists",
                "ng refs/pull/1/head x"
            ]))
            .is_empty()
        );
        // The unpack failed: none, whatever the refs say.
        assert!(recorded(report(&["unpack error: invalid pack", "ok refs/heads/main"])).is_empty());
        // One moved beside one refused (a hidden ref): all but the refused.
        assert_eq!(recorded(banded(&["unpack ok", "ok refs/heads/main", "ng refs/pull/1/head deny updating a hidden ref"])), [main, tag]);
        assert_eq!(
            recorded(report(&["unpack ok", "ok refs/heads/main", "option refname refs/heads/main", "ng refs/tags/v1 already exists"])),
            [main, pull]
        );
        // A report that mentions only some refs, or none (just `unpack ok`,
        // or cut short): the rest are left to record_push's store checks.
        assert_eq!(recorded(report(&["unpack ok", "ok refs/heads/main"])), [main, tag, pull]);
        assert_eq!(recorded(report(&["unpack ok"])), [main, tag, pull]);
        assert_eq!(recorded(banded(&["unpack ok", "ng refs/tags/v1 already exists"])), [main, pull]);
        // No report, or a fatal error: left to the store too.
        assert_eq!(recorded(Vec::new()), [main, tag, pull]);
        assert_eq!(recorded([crate::git_http::pkt_line(b"\x03fatal: hung up\n"), b"0000".to_vec()].concat()), [main, tag, pull]);
        // The push path filters what it records by it, pushed and deleted.
        let answer = body_of(include_str!("lib.rs"), "answer_git");
        let filtered = answer.find("if let Some(reply) = &reply {").expect("filtered by the report");
        let done = answer.find("after.push = Some(PushDone {").expect("recorded");
        assert!(filtered < done);
        assert!(answer.contains("pushed.retain(|pushed| reply.records(&pushed.git_ref));"));
        assert!(answer.contains("deleted.retain(|(git_ref, _)| reply.records(git_ref));"));
        assert!(!answer[done..].contains("forwarded.pushed") && !answer[done..].contains("forwarded.deleted"));
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

    /// What a refused grant found in its batch (conformance's
    /// public-storage.test.mjs runs [`HOLD`] and [`COPY_LOCKED`] for each
    /// of these), and what a write is told.
    const REFUSED: [(&str, CopyLock, Refusal); 4] = [
        ("a private repository being copied into a fork", CopyLock { locked: 1.0, stalled: 0.0 }, Refusal::Locked),
        ("a public one being copied, with room", CopyLock { locked: 1.0, stalled: 0.0 }, Refusal::Locked),
        ("one whose copy did not finish cleanly", CopyLock { locked: 1.0, stalled: 1.0 }, Refusal::Stalled),
        ("a public one whose workspace is really full", CopyLock { locked: 0.0, stalled: 0.0 }, Refusal::Full),
    ];

    #[test]
    fn a_web_commit_to_a_repository_being_forked_says_so_and_one_with_no_room_says_it_is_full() {
        let now = 1_000;
        for (case, lock, expected) in REFUSED {
            let refused = refusal(lock, now, now + LEASE_MS);
            assert_eq!(refused, expected, "{case}");
            let g1t_contracts::Outcome::Fail(failure) = refused.outcome::<()>() else { panic!("{case}") };
            match expected {
                Refusal::Locked => {
                    assert_eq!(
                        failure.message,
                        "This repository is being copied into a fork. Try again in a few minutes; if it lasts more than an hour, g1t staff release it.",
                        "{case}"
                    );
                }
                Refusal::Stalled => {
                    // Held until staff have checked it: never "a few minutes".
                    assert!(failure.message.starts_with("This repository is being copied into a fork, and the copy has taken longer than it should, or did not finish cleanly"));
                    assert!(failure.message.contains("a few hours") && !failure.message.contains("few minutes"), "{case}");
                }
                _ => {
                    assert_eq!(failure.message, "Public repository storage is full. Make room before adding more data.", "{case}");
                    assert_eq!(failure.code, g1t_contracts::FailureCode::Forbidden);
                    continue;
                }
            }
            // Not a conflict, which a merge g1t makes would let go of with
            // nothing to try it again.
            assert_eq!(failure.code, g1t_contracts::FailureCode::Unavailable);
            assert!(!failure.message.contains("full"));
        }
        // A streamed copy refused past its lease was neither.
        let unlocked = CopyLock::default();
        assert_eq!(refusal(unlocked, now + LEASE_MS + 1, now + LEASE_MS), Refusal::Overdue);
        assert_eq!(refusal(REFUSED[0].1, now + LEASE_MS + 1, now + LEASE_MS), Refusal::Locked);
        assert!(Refusal::Overdue.message().contains("an hour"));
        let g1t_contracts::Outcome::Fail(overdue) = Refusal::Overdue.outcome::<()>() else { panic!("overdue") };
        assert_eq!(overdue.code, g1t_contracts::FailureCode::Conflict);
        // A lock outlasts the copy's few minutes only to its lease.
        assert!(Refusal::Locked.message().contains(&format!("more than {}", lease_words())));
        // Stalled only says how a lock is held: without one, nothing is.
        assert_eq!(CopyLock { locked: 0.0, stalled: 1.0 }.refusal(), None);
        // The window a fork has to reserve after it locks is the one
        // written into the statement.
        assert!(COPY_LOCKED.contains(&format!("COALESCE(l.created_ms, 0) + {FORK_RESERVE_WINDOW_MS} < ?2")));
        // Every write from the site says what its refusal was: none
        // assumes the cap.
        for (file, source, function) in [
            ("commit_file.rs", include_str!("commit_file.rs"), "commit_file"),
            ("catch_up.rs", include_str!("catch_up.rs"), "push_update"),
            ("merge_methods.rs", include_str!("merge_methods.rs"), "land_by"),
            ("merge_methods.rs", include_str!("merge_methods.rs"), "build_queue_step"),
        ] {
            let body = body_of(source, function);
            assert!(body.contains("Err(refusal) => return Ok(refusal.outcome())"), "{file}: {function}");
            assert!(!body.contains("storage is full"), "{file}: {function}");
        }
        for (file, source) in [("land.rs", include_str!("land.rs")), ("copy.rs", include_str!("copy.rs"))] {
            let code = source.split("#[cfg(test)]\nmod tests").next().unwrap_or_default();
            assert!(code.contains("refusal.message()"), "{file}");
            assert!(!code.contains("storage is full"), "{file}");
        }
        // The batch that grants reads the lock, so the refusal is decided
        // where the grant was.
        let grant = body_of(include_str!("public_storage.rs"), "grant");
        assert!(grant.contains("self.db.prepare(COPY_LOCKED)") && grant.contains("refusal(lock, now, reservation.lease_until_ms)"));
    }

    #[test]
    fn a_push_to_a_repository_being_forked_says_so_and_one_with_no_room_says_it_is_full() {
        let now = 1_000;
        let source = include_str!("lib.rs");
        let answer = body_of(source, "answer_git");
        let limits = body_of(source, "git_limits");
        for (case, lock, expected) in REFUSED {
            assert_eq!(refusal(lock, now, now + LEASE_MS), expected, "{case}");
        }
        // When the push begins, so that git shows it, private or public:
        // after the checks for room, so a workspace that is full says so.
        let lock = limits.find("let Some(refusal) = self.registry.copy_locked(repo)").expect("checked when a push begins");
        // A failed read lets the push begin: its reservation refuses it.
        assert!(limits[lock..].starts_with("let Some(refusal) = self.registry.copy_locked(repo).await.unwrap_or(None)"));
        assert!(body_of(include_str!("public_storage.rs"), "grant").contains("self.db.prepare(COPY_LOCKED)"));
        assert!(limits[lock..].contains("git_ops::copy_locked_response(&repo.namespace, &repo.name, refusal)"));
        assert!(limits.find("public_storage_full_response").unwrap() < lock);
        let condition = limits[..lock].rsplit("if ").next().unwrap_or_default();
        assert!(!condition.contains("is_private"), "{condition}");
        // And when its pack is reserved, should the lock have been taken
        // in between.
        assert!(answer.contains("Err(refusal @ (public_storage::Refusal::Locked | public_storage::Refusal::Stalled))"));
        assert!(answer.contains("return git_ops::copy_locked_response(&repo.namespace, &repo.name, refusal);"));
        let message = crate::git_ops::copy_locked_message("acme", "rocket", Refusal::Locked);
        assert!(message.starts_with("acme/rocket is being copied into a fork"), "{message}");
        assert!(message.contains("try again in a few minutes") && message.contains("https://docs.g1t.sh/guides/git/#size-limits"));
        assert!(message.contains(&format!("If it lasts more than {}, g1t staff release it", lease_words())), "{message}");
        // git prints an error's body only when it is plain text.
        let response = body_of(include_str!("git_ops.rs"), "copy_locked_response");
        assert!(response.contains("plain_refusal(copy_locked_message(namespace, name, refusal), 403)"), "{response}");
        assert_eq!(crate::git_ops::PLAIN_TEXT, "text/plain; charset=utf-8");
        assert!(message.ends_with('\n') && !message.contains("full"));
        let stalled = crate::git_ops::copy_locked_message("acme", "rocket", Refusal::Stalled);
        assert!(
            stalled.starts_with(
                "acme/rocket is being copied into a fork, and the copy has taken longer than it should, or did not finish cleanly"
            ),
            "{stalled}"
        );
        assert!(stalled.contains("until it ends or g1t staff have checked it"));
        assert!(stalled.contains("a few hours") && !stalled.contains("few minutes") && stalled.ends_with('\n'));
    }

    #[test]
    fn a_fork_made_after_staff_released_its_copy_lock_is_counted_at_what_was_measured() {
        // network.rs `fork`, after the store's call returned: the
        // reservation is settled at the source's measured size whether or
        // not the lock was still there, never ended, so the fork's
        // stored_bytes (what a private fork is billed from) is never left
        // at 0. Measured is a lower bound: never more than the fork holds.
        let fork = body_of(include_str!("network.rs"), "fork");
        // Settled first, then unlocked: nothing between the store's answer
        // and the settle can return early and leave the fork unbilled.
        let settled = fork.find("self.registry.finish_public(&reservation, measured).await?;").expect("settled at what was measured");
        let unlock = fork.find("let gone = match self.registry.unlock_copy(&source, &fork).await {").expect("then unlocked");
        assert!(settled < unlock);
        let after = &fork[unlock..];
        // An unlock that fails is said, never returned: the settle runs
        // once whatever the unlock does.
        assert!(!after[..after.find("if gone {").unwrap()].contains("?;"));
        assert!(after.contains("\"copy_unlock_failed\"") && after.contains("false"));
        assert_eq!(fork.matches("finish_public(&reservation, measured)").count(), 1);
        let warned = after.find("if gone {").expect("said for staff");
        assert!(after[warned..].contains("\"fork_outlived_copy_lock\""));
        // The only reservation a native fork still ends is one whose call
        // to the store may still be copying.
        let native = &fork[..fork.find("// Kept in the EU").unwrap()];
        assert_eq!(native.matches("end_public(").count(), 1);
        assert!(native.contains("if public_storage::may_still_run(&message)"));
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
