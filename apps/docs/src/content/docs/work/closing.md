---
title: Closing work items
description: How pull requests and commits land a work item in each repository it names, when it closes, what Part of and Refs do, turning it off with auto_close_items, closing by hand or with a commit already on the default branch, and reopening.
---

A work item closes when its work has landed. Work lands in a repository
when a pull request for it merges into that repository's default branch,
or a commit naming it reaches it. A work item that names several target
repositories closes once every one of them has landed, so work across a
service, its client and its docs closes when the last of them ships.

## Closing keywords

A pull request lands its repository on the work item it was made for
(`g1t pr create --item 12`), and on every work item its title or
description names after a closing keyword:

`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`,
`resolves`, `resolved`

in any case, with or without a colon, the reference right after it:

```text
Fixes #12. Resolves: #14, closes acme/api#15
```

`Fixes#12` (no space) and `Fixes issue #12` (a word between) name
nothing. Each work item counts once, and up to 50 are read. References in
code, `` `#12` `` or a code block, are never read.

`#12`, `owner/name#12` and `workspace#12` name work items of the
repository's own workspace only. A work item of another workspace is never
closed by your repositories: `Closes other-workspace#3` does nothing.

## Landing, target by target

When a pull request merges into its repository's default branch, for each
work item it closes, g1t:

1. links the repository as `touched`, unless it is already linked;
2. marks the repository **landed** on the work item;
3. records a **resolution**: the repository, and the pull request (or
   commit) that landed it.

Then the work item closes as `completed`:

- **with no target**, at its first resolution;
- **with targets**, once every target has landed.

Until then it stays open, on the [Board](/work/board/)'s **Landing**,
and its page says which targets are still missing: its conversation reads
**landed acme/web; still to land in acme/api, acme/docs**. Each landing is
a `work_item.landed` event, with the `resolution` and the targets still
`missing`; the last one is `work_item.closed` instead. A resolution on a
work item already closed is recorded without reopening it.

Merging into any other branch lands nothing. Neither does a pull request
merged with `keep_item_open` (`g1t pr merge --keep-item-open`): what it
names is linked as if it said **Part of**, and the other pull requests for
its work item stay open.

When a pull request merges, the other open pull requests for its own work
item in the same repository close as superseded.

## Part of and Refs

A pull request that does only part of a repository's share says so
instead:

```text
Part of #12
Refs acme/api#12
```

`Part of`, `Refs` and `Ref` link the pull request to the work item, and
its repository as touched, without landing anything. Use one for each
pull request of a series, and a closing keyword on the last.

## Commits

Commit messages land work items the same way. When a push to the default
branch brings in a commit whose message names a work item after a closing
keyword, the commit's repository lands on it. That holds for commits
pushed directly, merged in a clone, or landed by a pull request, up to
250 commits a push. The resolution records the `commit` and who pushed it,
as `pushed_by`; the work item's timeline says who pushed it and **landed
this in** that commit, and the commit's page lists the work items it
landed on.

A push that makes a new branch reads none of its commits, since they were
pushed before, except a repository's first push, which makes its default
branch: `Closes #1` in the first version of a new repository lands on #1.
Commits pushed to other branches land nothing until they reach the default
branch.

## Turning it off

A repository's `auto_close_items` setting, on unless you turn it off, says
whether merges and pushes land work items. With it off, a merged pull
request lands nothing (its **Part of** links are still made), and pushes to
the default branch are not read at all. See
[managing a repository](/guides/managing-repositories/).

## Close one by hand

Anyone who may [manage the work item](/work/work-items/#who-can-do-what)
(its owner, or the Triage role) can close it themselves:

- on its page, **Close work item** (as completed) or **Close as not
  planned**; on a phone, **Close** in the bar at its foot closes it as
  completed;
- `g1t work close 12`, or `g1t work close 12 --reason not_planned`, with
  `--comment` to say why;
- the `work_item` tool's `close`, or
  [`POST /workspaces/{workspace}/work/{number}/close`](/reference/api/work-items/close-work-item/),
  with `reason`.

Closing ends the claims on it (`work.released`, `reason` `item_closed`),
and tells the work items [blocked by it](/work/claims-and-dependencies/#dependencies).

## Close one with a commit

A commit already on the default branch can land a work item later: one
pushed before the work item was filed, or while `auto_close_items` was
off.

```sh
g1t work close 12 --commit 3f9a2c1e…
```

In the repository, give the commit's full hash. Over MCP and the API,
`close` takes `repo` and `commit`. The commit's message must name the work
item after a closing keyword. Its repository then lands in that commit,
the way a push of it would have, by whoever did it, and the work item
closes if no target is left. A commit that is not on the default branch,
or whose message does not name the work item, is refused, and so is a work
item that is already closed.

## Reopen one

**Reopen work item** on its page, `g1t work reopen 12`, or the
`work_item` tool's `reopen`. Reopening clears its resolutions and where
it landed: every repository has to land again. It is a
`work_item.reopened` event.

## Who closed it, and how

A work item's timeline links whatever closed it: **closed this by merging
acme/web#14**, **closed this in acme/web@3f9a2c1**, or **closed this as
not planned**. When it was done in a [session](/work/sessions/), the line
ends **via session**, linking that session. That session is the one the
closing commit names in a `G1t-Session: ses_…` trailer, or, for a work
item closed with a token (from an agent, the CLI or the MCP server), the
closer's own session on the work item that is still going.
`work_item.closed` carries it as `session`. A work item closed on the site
says only who closed it.

Put the trailer on a session's commits so they lead back to it:

```sh
git commit --trailer "G1t-Session: $G1T_SESSION"
```
