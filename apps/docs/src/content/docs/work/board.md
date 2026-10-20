---
title: The Board
description: The work that is moving, in five stages from Up next to Done. Each work item's stage follows from what is true of it, its claims, sessions, pull requests and landings, so there is nothing to drag. Everything else waits in the plan.
---

**Board**, a tab of Work at `g1t.sh/<workspace>/-/work/board`, is the
work that is moving. Its columns are stages, and a work item's stage
comes from what is true of it: who is on it, its pull requests, where it
has landed. There is nothing to drag. Do the work, and the card moves.

The Board holds only what is moving and what comes next, so it stays
short however much work the workspace has. Work nobody is on yet waits in
[the plan](/work/plan/), in the order it will be taken.

## The stages

| Stage           | Holds the work items                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Up next**     | The top of the plan's Next (at most 10), in the plan's order, with nobody on it yet.                                                                |
| **In progress** | Claimed or assigned, with a live session on it, with a draft pull request, or with a pull request merged that did not close it.                     |
| **In review**   | With a pull request open for review.                                                                                                                |
| **Landing**     | Landed in some of its target repositories and still missing in others, or with a pull request that closes it merged while a target still misses it. |
| **Done**        | Closed as completed in the last 14 days.                                                                                                            |

A work item is in the first stage that holds for it, in the order
**Done**, **Landing**, **In review**, **In progress**, **Up next**. So a
work item with one pull request in review and another still a draft is
**In review**, and one that has landed in one of its two targets is
**Landing** whatever else is going on. A work item closed more than 14
days ago leaves the Board, and so does one closed as not planned (a
duplicate, say), since it did not ship. The Work list's **Closed** still
has both.

## Which pull requests count

A pull request counts for a work item when it is for that work item,
when it closes it (`Fixes #12` in its title or description), or when it
is part of it (`Part of #12`). The Board reads each repository's open
and draft pull requests, and those merged in the last 14 days, in every
repository an open work item is linked to.

- **Merged, and it closes the work item**, but a target repository still
  misses it (it merged into a repository that is not a target): the work
  item is **Landing** until it lands in every target.
- **Merged as part of it**, or merged with no target left to land in (for
  example into a branch that is not the default): the work item stays
  **In progress**, since there is more to do before it closes.
- Its card says how many of its pull requests merged in the last 14 days,
  such as "1 merged".

## How a work item moves

A typical work item goes left to right as the work happens:

1. **Up next.** Someone files it, and it waits in [Triage](/work/plan/#horizons)
   until it is placed in the plan. Once it is among the top of Next, with
   nobody on it, the Board shows it here.
2. **In progress.** Someone [claims it](/work/claims-and-dependencies/#claims)
   (`g1t work claim 12`), it is assigned, a [session](/work/sessions/)
   starts on it, or a draft pull request is opened for it
   (`g1t pr create --item 12` opens a draft). A pull request a live session
   is on counts too.
3. **In review.** Its pull request is marked ready for review.
4. **Landing.** For a work item with targets still to land: its pull
   request merged in one target and the others are still to land, or it
   merged into a repository that is not a target. A work item whose pull
   request lands in its only target, or one with no target, skips this
   stage: it closes as soon as it lands.
5. **Done.** It closed as completed: every target landed, or someone
   closed it. See [closing work items](/work/closing/).

It moves back as well: a claim released or expired with nobody else on it
and no pull request sends it back to the plan (and to **Up next** if it is near the top of Next), and reopening a work item
clears where it landed, so it goes back to whatever stage its pull
requests and claims put it in.

## Reading the Board

**Up next** is in the plan's order. The other columns list their work items
most recently changed first, and **Done** most recently closed first. A
card for a work item in Now says so, and an urgent one says that too. Each card shows the work item's title, number
and repositories, how many of its pull requests merged lately, and who is
on it: up to three people (its assignees, whoever claimed it, whoever runs
a session on it) and up to two of its live sessions, each followed by a
count of the rest, such as "+4" for seven people. A session with no title
of its own is named by what it is on, such as "On pull request #158".
Choose a card to open the work item.

A repository that was deleted and can still be restored shows struck
through on its cards, and the Board reads nothing from it. If a
repository's pull requests could not be read at all, the Board says so
above the columns: its work items may stand a column early until it can.

The Board reads the plan's Now and the top of Next, the newest 200 open
work items, and up to 20 older ones that someone has claimed or a live
session is on; up to 300 open and 300 recently merged pull requests in
each repository; and up to 100 work items for **Done**. Past the newest
200 open work items it shows only those in Now or Next, claimed or with a
live session, and says so above the columns.

Under the columns, a line says how much of the plan is not on the Board,
such as "Everything not on the board is in the plan: 12 in Next, 32 in
Later and 8 in Triage", and links to it.

The Board follows the work as it happens, without reloading, and checks
again every 30 seconds while a session is live, since a session going idle
sends no event.

- **One repository's**: filter it with `?repo=<name>`. **Board** on the
  Work list filtered to a repository keeps the filter.
- **On a phone** the Board shows one stage at a time, with a button for
  each and how many it holds; the address keeps it as `?stage=landing`.
- **In the phone app**, **Board** at the top of Work shows the stages one
  under another, with a chip for each to show one alone. It reads only
  open pull requests for now, so a work item whose pull request merged
  without closing it is where its claims and sessions put it.

**New work item** is on the Board too.
