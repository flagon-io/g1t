---
title: Merge queue
description: Test each pull request together with the ones ahead of it, so main only moves to a state whose checks passed.
---

Merging one pull request at a time, each caught up with `main`, keeps every
merge clean as text. It does not prove the result works: two changes can
merge without a conflict and still break each other. With the merge queue
on, a pull request is tested together with everything ahead of it before it
lands, and `main` only ever moves to a state whose checks passed.

The merge queue runs in g1t's sandboxes, which work in any workspace with
[its own model provider](/guides/models/) and in those g1t's hosted models
are open to. Elsewhere, an entry fails at once with a message saying so;
turn the queue off to merge directly.

## Turn it on

1. Open the repository's **Settings** tab. You need to be a member of its
   workspace.
2. Turn on **Merge through a queue**.
3. Save.

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
`merge_pull_request`, or with `POST /repos/{owner}/{name}/pulls/{number}/merge`,
adds it to the queue instead of changing `main`. Everything a merge needs
is still checked first: the pull request must be ready for review, its
checks must have passed and it must have the approvals the repository asks
for. Only members of the workspace can add to the queue. Merging a pull
request that is already queued changes nothing.

The pull request's conversation records who added it, and its page shows
where it is in the queue. A member can take it out with **Remove from the
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

Each tested state runs:

- the acceptance checks of every pull request in it; and
- the **contract**: the checks of issues already completed on the
  repository, from the 30 most recently closed. Once an issue lands, its
  checks become part of what `main` promises, and every later change is
  held to them.

So a change that breaks something that landed before it is caught here,
even when it merges without a conflict and its own checks pass.

Once those pass, the repository's [GitHub Actions](/guides/actions/)
workflows that run `on: merge_group` run on the state too, with the same
`merge_group` event GitHub sends, on the branch `g1t-queue/<entry>`. The
entry waits for them, and lands only if they pass. The branch is deleted
once the entry lands or leaves the queue. A workflow opts in like this:

```yaml
on:
  pull_request:
  merge_group:
```

A contract check that fails is run again on `main` alone. If it fails there
too, it was broken already: it is marked as passing with a note, "already
failing on the default branch; not held against this", and does not hold
the change back.

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

## When an entry fails

An entry fails when its checks or its `merge_group` workflows fail in the
combined state, when it does not merge cleanly with what is ahead of it, or
when the state cannot be built.
It leaves the queue, and:

1. Its pull request gets a failed check run. Each command is named with the
   state it ran in, such as `cargo test (merge queue, on the default branch
   with #41 merged in first)`, and the run says why it failed. A conflict
   names the pull request ahead it collided with.
2. Its conversation records that it was taken out of the queue, and why.
3. The entries that were tested on top of it are tested again without it.

A g1t agent's pull request is then sent back to revise, like any failed
check, starting from `main` as it is now. The revision counts towards
**Revisions before asking you**. Once it is ready again, a repository with
**Merge automatically when ready** on adds it to the queue again by itself;
otherwise it waits for a member to merge it again. A pull request you or
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
| Checks | How many of the checks passed. |
| Who | The agent or person who made the pull request, and who queued it. |
| Commit | The tested state's commit. |

**Recently** lists the last 20 that left the queue: **Landed**, **Failed**
or **Removed**. A failed entry shows why, and the output of the checks that
failed.

## From the API or an agent

`get_merge_queue`, or `GET /repos/{owner}/{name}/queue`, returns the queue.
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
      "agent": "g1t-agent",
      "state": "testing",
      "ahead": [41],
      "baseCommit": "8f3c2e1…",
      "combinedCommit": null,
      "results": [],
      "enqueuedBy": "g1t"
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
| `baseCommit` | The commit of `main` the state was built on. |
| `combinedCommit` | The tested state. |
| `results` | The checks run against it, each with `command`, `passed` and `output`. |
| `error` | Why it failed: a conflict, or what could not be run. |
| `enqueuedBy` | Who added it: a username, or `g1t` when it was merged automatically. |
