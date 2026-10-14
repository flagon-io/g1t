---
title: Merge queue
description: Test each pull request together with the ones ahead of it, so main only moves to a state whose required checks passed.
---

Merging one pull request at a time, each caught up with `main`, keeps every
merge clean as text. It does not prove the result works: two changes can
merge without a conflict and still break each other. With the merge queue
on, a pull request is tested together with everything ahead of it before it
lands, and `main` only ever moves to a state whose required checks passed.

g1t builds the queue's states in the repository itself, without a
sandbox. What checks them is the repository's `merge_group`
[workflows](/guides/actions/), which run and are billed like any other
workflow run.

## Turn it on

1. Open the project's **Settings → Rules**. You need the Admin
   [role](/guides/access-and-roles/) on its repository.
2. Open the ruleset that covers the default branch, or create one.
3. Choose **Add a rule**, then **Require the merge queue**. Set how many
   pull requests it tests at once, the smallest batch it starts with and
   how long it waits for one, and how long a batch's checks may take.
4. Save.
5. Add `merge_group` to the `on:` of every workflow behind a
   [required status check](/guides/pull-requests/#required-status-checks),
   so that it runs on the queue's states too
   ([below](#what-each-state-is-held-to)).

From the API, send `merge_queue` to `PATCH /repos/{owner}/{name}/settings`
(or `update_repo_settings`), which adds the rule to the "Default branch
protection" [ruleset](/guides/rules/):

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
for, including its [code owners'](/guides/codeowners/#require-review-from-code-owners)
when it requires them. Only people with the Write [role](/guides/access-and-roles/) or higher can add to the
queue. Merging a pull
request that is already queued changes nothing.

The pull request's conversation records who added it, and its page shows
where it is in the queue. Anyone who can merge can take it out with **Remove from the
queue**. Closing a pull request also takes it out.

## How entries are tested

g1t takes up to four entries (the rule's `max_entries_to_build`) from the
front of the queue and tests them all at once, speculatively. Each entry's
state is the one before it with that entry landed on top, in queue order:

| Entry | Tested as |
| --- | --- |
| 1st | `main` + #41 |
| 2nd | `main` + #41 + #44 |
| 3rd | `main` + #41 + #44 + #46 |
| 4th | `main` + #41 + #44 + #46 + #47 |

Each entry is landed on the state ahead of it by its own
[merge method](/guides/pull-requests/#merge-methods), exactly as merging it
there would:

- **Merge commit**: a merge commit, with the message for the repository's
  merge commits or the one written when it was queued.
- **Squash**: one commit, by the pull request's author, with the squash
  message and its `Co-authored-by:` trailers.
- **Rebase**: each of its commits made again on top, keeping their authors.
- **Fast-forward**: its own head, which must already contain everything
  ahead of it; otherwise it fails, saying to bring it up to date or merge
  it another way.

The method is the one asked for when it was merged into the queue (the
merge box's choice, `merge_method` in the API), else the merge queue
rule's `merge_method` (merge commit unless set). Both must be methods the
repository and the branch's [rules](/guides/rules/) allow, or merging is
refused, saying which are; linear history rules out merge commits.
A commit message written then (`commit_title`, `commit_message`) is kept
with the entry; otherwise the repository's default message is used, worked
out when the entry is first built. Sign-off is added where the repository
requires it. The same limits apply as to merging directly: g1t makes at
most 1,000 changed files, 100 files merged line by line and 250 rebased
commits itself.

If every entry passes, the four can land one after another without being
tested again. The next batch starts when nothing is being tested. A batch
that takes longer than 45 minutes (`check_response_timeout_minutes`) is tested again.

### What each state is held to

g1t pushes each state it built to a branch of its own, `g1t-queue/<entry>-<attempt>`,
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

Each build has its own attempt token. A result from an old attempt cannot
replace a retry or put a removed entry back in the queue. Workflow results
apply only to the combined commit still being checked.
Retries use separate Git branches, so a late build cannot overwrite the
new attempt's branch. Workflow results wait until the whole group has been
registered; a dispatch error does not count as a pass.

## How entries land

Entries land in order. When an entry has passed and everything ahead of it
has landed, `main` moves to exactly the state that was tested: since each
state was built on the one ahead of it, that is a fast-forward to the
commits its method made, which are the commits its checks ran on. The pull
request is recorded as merged by its method, with the commit `main` moved
to as its merge commit. The issue closes and the other pull requests for
it are superseded, as with any merge.

Current reviews and branch rules are checked again before publication,
against the combined commit's checks and the entry's merge method. Once publication starts, removal,
closing or conversion to draft returns a conflict until it finishes. If the
service stops after updating Git, the next queue poll resumes bookkeeping
for that same commit instead of publishing a different branch tip.

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
date, [catch it up](/guides/pull-requests/#keeping-it-up-to-date) first: when it and
`main` did not change the same lines, that takes a few seconds.

## When an entry fails

An entry fails when its `merge_group` workflows or required checks fail
on the combined state, when its change clashes with what is ahead of it, or
when the state cannot be built (a fast-forward that does not contain what
is ahead, or more than g1t makes itself). One that cannot be built leaves
the queue, and the entries behind it are built in the next batch without
it.

### Who answers for it

A state that fails while an entry ahead of it is still being tested is
held until those ahead are settled. If one of them fails too, the held
entry is tested again without it and is not blamed. Once every entry ahead
has passed, the held entry answers for the failure. So when #41 is
broken, it leaves the queue, and #44 and #46, which were tested with #41
in them, are tested again without it rather than taken out with it.

The entry that answers for a failure leaves the queue, and g1t works out
what it failed with:

| What happened | Who it failed with (`suspects`) |
| --- | --- |
| Tested on `main` alone, and its own checks fail on its head too | Nobody: the change is the cause. |
| Tested on `main` alone, though its own checks pass on its head | Nobody: the change answers for it, and the note names what landed on `main` since it branched (`landed`), [below](#when-main-moved-under-it). |
| Its own checks fail on its head too | Nobody: the change is the cause. |
| It conflicts with an entry ahead | That entry, and the conflicting files. |
| A required check did not report, or the state could not be built | Nobody: the note says what to fix. |
| Its own checks pass, one entry ahead | That entry. |
| Its own checks pass, several entries ahead | Found by building smaller combinations, below. |

### When `main` moved under it

An entry with nothing ahead of it is tested on `main` as it is now. When
its own checks pass on its head but a check fails once it is merged into
`main`, something that landed on `main` after the pull request branched is
what it now breaks with: #1 changed a function's signature, say, and this
pull request, written before #1 landed, still calls the old one.

The entry still answers for the failure, since it is the one that has to
adapt, and nothing extra is built. g1t looks at the 50 pull requests most
recently merged into `main` before the entry was tested, keeps those whose
commits the entry's history (its latest 1,000 commits) does not hold, and
reports up to ten of them, newest first, as `landed`. A pull request that
was brought up to date with `main` since it branched holds what it merged,
so only what landed after that is named. The note on the pull request then
reads, for example:

> g1t traced its merge queue failure to the default branch as it is now:
> `CI / merge_group` failed with this change merged into it, though this
> passes its checks on its own. Since this branched, #1 landed and is the
> likely cause. Bring it up to date with the default branch, fix what
> breaks, and push. Push a fix: once its checks pass on the new commit, it
> rejoins the merge queue by itself.

When only one pull request landed it is named as the likely cause; when
several did, they are listed as what it may conflict with. When none is
found (`main` moved by a push rather than a pull request, say), the note
says the change is the cause, as before. A conflict, a required check that
did not report and a state that could not be built never look this up.

### Narrowing it down

When an entry passes its own checks but fails combined with several entries
ahead, g1t tests smaller combinations using the same `merge_group` workflows.
A failing subset becomes the new suspect set. A passing subset causes g1t
to test its complement before excluding anything. If both subsets pass,
g1t retains the last failing combination: the failure may involve several
changes together, or may not be deterministic. Diagnosis stops after three
extra builds, retaining the last combination demonstrated to fail.

These combinations are built as the queue's states are, each entry by
its own method and with the same commit messages, on `g1t-queue/<id>`
branches that are deleted afterwards, and never land. They
do not hold up the queue: the entries behind are tested again at once. When
a combination cannot be built or checked, or its checks are still running
past the rule's timeout when the queue next moves, g1t stops and reports
the entries still suspected.

The result identifies a failing combination, not proof of one root cause.
Missing or pending checks on the original change do not count as passing
in isolation. Agents should inspect the recorded checks and reproduce the
failure before choosing a repair.

### Who is told

1. Its pull request records the failed check, saying why: which workflow
   failed on the state, which required check did not report, or, for a
   conflict, the pull request ahead it collided with and the files.
2. Its conversation records that it was taken out of the queue, then what
   g1t found: the pull requests it fails with, whether that was narrowed
   down, and the check that failed; or, with nothing ahead, the pull
   requests that landed on `main` since it branched.
3. Its issue's conversation says the same in one line, and so does the
   pull request's [session](/guides/why-blame/#sessions), so the agent
   working on it reads it there.
4. A [decision record](/guides/why-blame/#decision-records) of kind
   `integration_failure`, confidence `tested`, keeps it, with the
   combination, the check, the suspects, `bisected` and `landed` as
   evidence. [`get_work`](/guides/sessions/)'s `last_integration_failure`
   is the latest of these.
5. The `integration.failed` [event](/guides/webhooks/#events) carries the
   same to webhooks and to anyone following the repository's events:
   `pull` (the entry that failed, also `number`), `issue`, `combination`
   (the pull requests tested together, in order), `check` (`name`,
   `conclusion`, `url`), `bisected`, `suspects`, `other_pulls`, `landed`
   (with nothing ahead, the pull requests merged into `main` since it
   branched, newest first; otherwise empty) and `commit`.
6. The entries that were tested on top of it are tested again without it.

A combined state that passes is recorded too: an `integration_passed`
decision and the `integration.passed` event, with `pull` and `combination`.

On the site, the pull request shows the failure above its checks until it
passes in the queue or merges: the pull requests tested together, with the
one that answers for it marked, the check that failed (linked to its run),
what it fails with, and the fix once one is recorded. Its issue shows the
same under its pull requests, and the repository's
[Work page](/guides/sessions/#on-the-site) lists it among what happened.

### Getting back in the queue

The merge stays asked for. Push a fix to the pull request, starting from
`main` as it is now: once every check on the new commit has finished, none
failed and every required check passed, g1t merges it again as whoever
queued it, which puts it back in the queue. Everything a merge needs is
checked again then, so if an approval was dismissed by the push, the
conversation says so and you merge it again once it is approved. Until a
new commit's checks pass, merging it again is refused: "It failed in the
merge queue; push a fix to try again."

A pull request whose checks are not reported by workflows (none run on its
pushes) is not put back by itself: merge it again once it is fixed.

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
| Checks | How its state's checks stand, linked to the `merge_group` workflow run on the tested commit (each run by name when there are several). |
| Who | The person or coding agent who made the pull request, and who queued it. |
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
      "agent": "ada",
      "state": "testing",
      "ahead": [41],
      "base_commit": "8f3c2e1…",
      "combined_commit": null,
      "results": [],
      "enqueued_by": "ada"
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

An agent working on a pull request learns of a failure without polling the
queue: from the `integration.failed` event, from the note in the pull
request's session (`pull_request` `read_session`), or from its decisions
(`pull_request` `list_decisions`, or
`GET /repos/{owner}/{name}/pulls/{number}/decisions`).
