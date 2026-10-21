# Storage holds

Owner: whoever answers a workspace whose public pushes are refused for room
it does not use, or a fork whose source refuses pushes. The page is sudo →
Platform → **Storage holds** (`/storage`); the design is in
`services/repos/src/storage_holds.rs` and the docs' architecture page
[Git](https://docs.g1t.sh/architecture/git/#public-storage-reservations).

A write reserves public storage before it reaches the git store, and a
native fork locks its source while it copies. One that is interrupted keeps
its hold: a reservation counts against the workspace's 5 GB public cap, and
a copy lock refuses every push to the source (with the "storage is full"
message, as a full workspace gets). Nothing expires them on a timer, on
purpose: releasing one that is still in flight would let two writes take the
same room.

## Provably abandoned

The repos service decides, from what the write recorded:

| Hold                                                           | Abandoned when                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A reservation marked `ended`                                   | At once: the write stopped without knowing whether the store kept it, and sends nothing after                                  |
| A reservation still `held`                                     | 15 minutes after its lease, two hours from when it was taken. By its lease a push is cut short and a copy's chunks are refused |
| Unledgered bytes (reserved before migration 0023, with no row) | 24 hours after the ledger began (`storage_ledger_epoch`): older code had no lease                                              |
| A copy lock with a lease                                       | 15 minutes after its lease                                                                                                     |
| A copy lock without one (older code)                           | 24 hours after the ledger began, and at least its lease and grace after it was taken                                           |

Release is offered only then, and the repos service checks again, in the
same batch that releases.

## Checklist

1. **Find the hold.** On Storage holds, the workspace's repository, oldest
   first. A copy lock names the fork it was copying into.
2. **Inspect it.** Read what the store lists for each repository (refs, the
   default branch's commit) and what g1t counts (stored, reserved, how much
   of it the ledger accounts for). For a push that ended, each ref it asked
   for says **landed** when the store has it: the push may have been stored
   though its answer was an error, or a later push may have set the same
   ref.
3. **Release it**, with a reason that says what you saw ("ended with a 500;
   main is not at the commit it asked for"). The reason and the inspection
   are kept in the audit row, listed under **Released**.
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
`git_access`), and ended pushes that landed, are not counted. Below zero,
g1t counted objects that a later push made unreachable (a force push), or
packs that sent objects the store already had: g1t asks for whole packs. Large or growing
drift is for the owner of billing to decide on; nothing corrects it
automatically.
