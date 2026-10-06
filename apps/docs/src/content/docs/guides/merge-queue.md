---
title: Merge queue
description: Test each pull request together with the ones ahead of it, so main only moves to a state whose required checks passed.
---

Merging one pull request at a time, each caught up with `main`, keeps every
merge clean as text. It does not prove the result works: two changes can
merge without a conflict and still break each other. With the merge queue
on, a pull request is tested together with everything ahead of it before it
lands, and `main` only ever moves to a state whose required checks passed.

The merge queue runs in g1t's sandboxes, which need
[the g1t plan](/guides/usage-and-billing/#the-g1t-plan) or the trial after
a card check; a public repository can use the open-source pool instead.
Without one, an entry fails at once with a message saying so; turn the
queue off to merge directly.

## Turn it on

1. Open the project's **Settings → Branches and merging**. You need the Maintain
   [role](/guides/access-and-roles/) or higher on its repository.
2. Turn on **Merge through a queue**.
3. Save.
4. Add `merge_group` to the `on:` of every workflow behind a
   [required status check](/guides/pull-requests/#required-status-checks),
   so that it runs on the queue's states too
   ([below](#what-each-state-is-held-to)).

From the API, send `merge_queue` to `PATCH /repos/{owner}/{name}/settings`
(or `update_repo_settings`):

```sh
curl -X PATCH https://api.g1t.sh/repos/acme/web/settings \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"merge_queue": true}'
```

## What merging does with the queue on

Merging a pull request, from its page (**Add to the merge queue**), with
the `pull_request` tool's `merge` action, or with
`POST /repos/{owner}/{name}/pulls/{number}/merge`,
adds it to the queue instead of changing `main`. Everything a merge needs
is still checked first: the pull request must be ready for review, every
[required check](/guides/pull-requests/#required-status-checks) must have
passed on its head, and it must have the approvals the repository asks
for. Only people with the Write [role](/guides/access-and-roles/) or higher can add to the
queue. Merging a pull
request that is already queued changes nothing.

The pull request's conversation records who added it, and its page shows
where it is in the queue. Anyone who can merge can take it out with **Remove from the
queue**. Closing a pull request also takes it out.

## How entries are tested

g1t takes up to four entries from the front of the queue and tests them all
at once, speculatively, each in its own sandbox. Each sandbox builds `main`
with that entry and every entry ahead of it merged in, in queue order:

| Entry | Tested as |
| --- | --- |
| 1st | `main` + #41 |
| 2nd | `main` + #41 + #44 |
| 3rd | `main` + #41 + #44 + #46 |
| 4th | `main` + #41 + #44 + #46 + #47 |

If every entry passes, the four can land one after another without being
tested again. The next batch starts when nothing is being tested. A batch
that takes longer than 45 minutes is tested again.

### What each state is held to

g1t pushes each state it built to a branch of its own, `g1t-queue/<entry>`,
and runs the repository's [workflows](/guides/actions/) that run on
`merge_group` on it. The entry waits for them, and passes only if:

- every `merge_group` workflow it started passed; and
- every [required status check](/guides/pull-requests/#required-status-checks)
  of the default branch passed on that commit.

So a change that breaks something another change ahead of it relies on is
caught here, even when it merges without a conflict and its own checks
passed. The branch is deleted once the entry lands or leaves the queue.

A workflow opts in like this:

```yaml
on:
  pull_request:
  merge_group:
```

Required checks only report on a queued state if their workflows run on
`merge_group`. When the branch requires checks and no workflow runs on
`merge_group`, the entry fails with a message saying so: "the required
check CI cannot report on it: no workflow runs on merge_group events. Add
merge_group to the on: of the workflows the branch requires". A required
check that a workflow did not report on the state fails it the same way.
A repository that requires no checks and has no `merge_group` workflows
only has each state built: an entry passes once it merges cleanly with
what is ahead of it.

## How entries land

Entries land in order. When an entry has passed and everything ahead of it
has landed, `main` moves to exactly the state that was tested. The issue
closes and the other pull requests for it are superseded, as with any
merge.

Before landing, g1t checks that nothing has changed underneath:

- If the pull request was pushed to after it was tested, it and the entries
  tested on top of it are tested again.
- If `main` moved outside the queue, every entry is tested again on the new
  `main`.

A pull request that is already known to conflict with `main` is not added
to the queue: [its merge box](/guides/pull-requests/#conflicts) says which
files conflict and how to resolve them first. One that is only behind `main`
does not need to catch up to join the queue, since the queue tests it on
top of `main`. Where the repository requires pull requests to be up to
date, [catch it up](/guides/pull-requests/#catching-up) first: when it and
`main` changed different files that takes a few seconds and no agent.

## When an entry fails

An entry fails when its `merge_group` workflows or required checks fail
on the combined state, when it does not merge cleanly with what is ahead of it, or
when the state cannot be built.
It leaves the queue, and:

1. Its pull request records the failure, saying why: which workflow failed
   on the state, which required check did not report, or, for a conflict,
   the pull request ahead it collided with and the files.
2. Its conversation records that it was taken out of the queue, and why: a
   conflict links the pull request it collided with and each conflicting
   file, which opens in the pull request's changes.
3. The entries that were tested on top of it are tested again without it.

A pull request g1t opened is then sent back to revise, as for any failed
check, starting from `main` as it is now. The revision counts towards
**Revisions before asking you**. Once it is ready again, a repository with
**Merge automatically when ready** on adds it to the queue again by itself;
otherwise it waits for someone to merge it again. A pull request you or
your own agent opened is yours to fix and merge again.

## The Merge queue page

Every repository has a **Merge queue** page, at
`g1t.sh/<workspace>/<repo>/queue`, in the repository's sidebar. It
refreshes on its own while anything is queued.

**In the queue** lists the entries in order, starting from `main`'s commit.
Each shows:

| | |
| --- | --- |
| State | **Waiting**, **Testing** or **Passed**. |
| Tested as | `main` and the pull requests merged into it, such as `main + #41 + #44`. |
| Checks | How its state's checks stand. |
| Who | The agent or person who made the pull request, and who queued it. |
| Commit | The tested state's commit. |

**Recently** lists the last 20 that left the queue: **Landed**, **Failed**
or **Removed**. A failed entry shows why.

## From the API or an agent

The `pull_request` tool's `merge_queue` action, or
`GET /repos/{owner}/{name}/queue`, returns the queue.
It is public for a public repository.

```sh
curl https://api.g1t.sh/repos/acme/web/queue
```

```json
{
  "enabled": true,
  "active": [
    {
      "number": 44,
      "title": "Add a --shout flag",
      "agent": "g1t",
      "state": "testing",
      "ahead": [41],
      "base_commit": "8f3c2e1…",
      "combined_commit": null,
      "results": [],
      "enqueued_by": "g1t"
    }
  ],
  "recent": []
}
```

| Field | |
| --- | --- |
| `enabled` | Whether the repository merges through the queue. |
| `active` | The entries waiting to land, in order. |
| `recent` | Those that landed or left, newest first. |
| `state` | `waiting`, `testing`, `passed`, `failed`, `landed` or `removed`. |
| `ahead` | The pull requests merged ahead of it in the state being tested. Empty when it was tested on `main` alone. |
| `base_commit` | The commit of `main` the state was built on. |
| `combined_commit` | The tested state. |
| `results` | What building the state recorded, each with `command`, `passed` and `output`. The workflow runs on it are on its commit, `combined_commit`. |
| `error` | Why it failed: a conflict, a workflow that failed on it, a required check that did not report, or what could not be built. |
| `enqueued_by` | Who added it: a username, or `g1t` when it was merged automatically. |
