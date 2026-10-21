# Storage holds

Owner: whoever answers a workspace whose public pushes are refused for room
it does not use, or a fork whose source refuses pushes. The page is sudo →
Platform → **Storage holds** (`/storage`); the design is in
`services/repos/src/storage_holds.rs` and the docs' architecture page
[Git](https://docs.g1t.sh/architecture/git/#public-storage-reservations).

A write reserves public storage before it reaches the git store, and a
native fork locks its source while it copies. One that is interrupted keeps
its hold: a reservation counts against the workspace's 5 GB public cap, and
a copy lock refuses every write to the source, private or public (each
told "This repository is being copied into a fork. Try again in a few
minutes; if it lasts more than an hour, g1t staff release it.", never that
storage is full; a push is told the same in git's `remote:` lines; once the
copy has taken longer than it should or did not finish cleanly, that it can
take a few hours, below). A pull
request g1t merges by itself stalls with that message, and a person's
automatic merge turns off with it: neither is tried again by itself once the lock
is released. Nothing expires a hold on a timer, on
purpose: releasing one that is still in flight would let two writes take the
same room.

## A source that takes no writes

A fork whose call to the store timed out or met a server error may still be
copying, so it keeps its source's lock, and the source refuses every write
until staff release it: at the soonest 75 minutes after the copy began (the
lease, an hour, and 15 minutes' grace). The repos service reads a lock as
stalled when its fork's reservation ended, when its fork holds no live
reservation a minute after it locked, or once its lease has passed. Its
writers are then told the copy has taken longer than it should, or did not
finish cleanly, and that it can take a few hours, so do not leave it.

- **Where it shows.** sudo's Overview has **Writes blocked** under Needs
  attention: the repositories a copy lock has held longer than a copy
  ordinarily takes (15 minutes), red once one did not finish cleanly. The
  Storage holds page lists them under **Writes blocked**, with how long each
  has been blocked, how the fork's call ended, and when its lock becomes
  releasable. The repos service also logs `copy_lock_kept` (an error, with
  the source, the fork and the store's error) when it keeps a lock this
  way.
- **What to do.** Inspect the lock: the fork's refs in the store say whether
  the copy landed. Once it is releasable, release the **lock first**, with
  what you saw; the source takes writes again at once. Then release the
  fork's ended reservation the same way. In that order because the ended
  reservation is releasable at once while the lock waits for its lease and
  grace, and the reservation is what tells sudo how the fork's call ended:
  released first, the Writes blocked row loses it (the lock still reads as
  stalled, as one whose fork holds no live reservation). Whether the fork
  kept the copy, its `stored_bytes` stays as it was: note it in the reason,
  and use Drift.
- **A fork that outlived its lock.** If the store's call returns after staff
  released the lock, the fork is counted at its source's measured size, a
  lower bound that never overcharges: it is the source's `stored_bytes`
  read right after the lock, which only grows, and a fork counts in full by
  policy, even of its default branch only. The fork is counted before the
  lock is let go, so an unlock that fails (logged as `copy_unlock_failed`,
  the lock left for staff, reading as stalled) never leaves it uncounted.
  The repos service logs
  `fork_outlived_copy_lock` (a warning, with the fork and the bytes
  counted): the source may have taken writes the fork holds and the count
  misses. Drift measures how far it is out.

## Provably abandoned

The repos service decides, from what the write recorded:

| Hold                                                           | Abandoned when                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A reservation marked `ended`                                   | At once: the write stopped without knowing whether the store kept it, and sends nothing after                                                                                                                                              |
| A reservation still `held`                                     | 15 minutes after its lease, an hour from when it was taken. A push or a branch copied chunk by chunk is cut short at its lease; a write of one pack, and a native fork's one call to the store, are not, and are taken as answered by then |
| Unledgered bytes (reserved before migration 0023, with no row) | 24 hours after the ledger began (`storage_ledger_epoch`): older code had no lease                                                                                                                                                          |
| A copy lock with a lease                                       | 15 minutes after its lease. A fork whose call timed out or met a server error keeps its lock until then: the store may still be copying                                                                                                    |
| A copy lock without one (older code)                           | 24 hours after the ledger began, and at least its lease and grace after it was taken                                                                                                                                                       |

Release is offered only then, and the repos service checks again, in the
same batch that releases.

## Checklist

1. **Find the hold.** On Storage holds, the workspace's repository, oldest
   first. A copy lock names the fork it was copying into.
2. **Inspect it.** Read what the store lists for each repository (refs, the
   default branch's commit) and what g1t counts (stored, reserved, how much
   of it the ledger accounts for). For a push that ended, each ref it asked
   for says **landed** when the store has it: the push may have been stored
   though its answer was an error (a 500, or a 200 with a fatal error,
   whose outcome quotes it), or a later push may have set the same ref.
3. **Release it**, with a reason that says what you saw ("ended with a 500;
   main is not at the commit it asked for"). The reason and the inspection
   are kept in the audit row, listed under **Released**. The release is
   also in sudo's audit log (**Storage hold released**, under the
   repository's workspace, or `storage` if its row is gone), naming the
   row. The repos service keeps that line in the release's own batch
   (`storage_recovery_audits`) and sends it to billing right after, keyed by
   the row, then every hour until billing confirms it, so it is written
   once even if an answer is lost or the page stops waiting. If billing has
   not confirmed it yet, the page and the row under **Released** say so,
   with billing's last answer: the release still stands, so do not release
   it again. A line that stays unconfirmed past a few hours means billing
   keeps refusing it: the repos logs have `storage_release_unaudited` with
   the error.
4. **If it is not provably abandoned yet**, the page says when it will be.
   Wait: a write that may still be sending is never released by hand. A
   workspace that needs room sooner can delete what it does not need.
5. **If a push ended but landed**, its bytes are not in `stored_bytes`,
   which is a lower bound by design and what private storage is billed
   from. A release never changes it, and neither does anything here: note
   it in the reason, and use Drift to see how far a repository is out.

## Drift

**Measure** streams a small random sample of repositories (1 to 20, those
over 200 MB passed over) from the store: the pack it sends for every ref,
plus what each pull request's working copy holds beyond it, beside
`stored_bytes`. It reads only. Above zero, g1t counts less than the store
holds: pushes made with a credential straight to the store (sandboxes'
`git_access`), ended pushes that landed, and g1t's own refs (a pull
request's test merge, `refs/pull/N/merge`) are not counted. Below zero,
g1t counted objects that a later push made unreachable (a force push), or
packs that sent objects the store already had: g1t asks for whole packs.
Before #307, g1t also counted writes the store refused (a merge or update
whose branch had moved, an `ng`, a failed unpack); since, a refused write
gives its reservation back and counts nothing. Large or growing
drift is for the owner of billing to decide on; nothing corrects it
automatically.
