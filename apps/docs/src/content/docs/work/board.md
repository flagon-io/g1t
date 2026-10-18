---
title: The Board
description: The workspace's backlog as it moves, in five stages from Backlog to Done. Each work item's stage follows from what is true of it, its claims, sessions, pull requests and landings, so there is nothing to drag.
---

**Board**, in Work's sidebar, at `g1t.sh/<workspace>/-/work/board`, is
the backlog as it moves. Its columns are stages, and a work item's stage
comes from what is true of it: who is on it, its pull requests, where it
has landed. There is nothing to drag. Do the work, and the card moves.

## The stages

| Stage | Holds the work items |
| --- | --- |
| **Backlog** | Open, and nobody is on it. |
| **In progress** | Claimed or assigned, with a live session on it, or with a draft pull request. |
| **In review** | With a pull request open for review. |
| **Landing** | Landed in some of its target repositories, still missing in others. |
| **Done** | Closed in the last 14 days. |

A work item is in the first stage that holds for it, in the order
**Done**, **Landing**, **In review**, **In progress**, **Backlog**. So a
work item with one pull request in review and another still a draft is
**In review**, and one that has landed in one of its two targets is
**Landing** whatever else is going on. A work item closed more than 14
days ago leaves the Board; the Work list's **Closed** still has it.

## How a work item moves

A typical work item goes left to right as the work happens:

1. **Backlog.** Someone files it. Nobody has claimed it, it has no
   assignee, no session is on it and it has no pull request.
2. **In progress.** Someone [claims it](/work/claims-and-dependencies/#claims)
   (`g1t work claim 12`), it is assigned, a [session](/work/sessions/)
   starts on it, or a draft pull request is opened for it
   (`g1t pr create --item 12` opens a draft). A pull request a live session
   is on counts too.
3. **In review.** Its pull request is marked ready for review.
4. **Landing.** For a work item with several targets: its pull request
   merged in one repository and the others are still to land. A work item
   with no target, or one, skips this stage: it closes as soon as it lands.
5. **Done.** It closed: every target landed, or someone closed it. See
   [closing work items](/work/closing/).

It moves back as well: a claim released or expired with nobody else on it
and no pull request sends it back to **Backlog**, and reopening a work item
clears where it landed, so it goes back to whatever stage its pull
requests and claims put it in.

## Reading the Board

Each column lists its work items most recently changed first, and **Done**
most recently closed first. Each card shows the work item's title, number
and repositories, and who is on it: up to three people (its assignees,
whoever claimed it, whoever runs a session on it), up to two of its live
sessions, then "+2" for the rest. Choose a card to open the work item.

The Board follows the work as it happens, without reloading, and checks
again every 30 seconds while a session is live, since a session going idle
sends no event.

- **One repository's**: filter it with `?repo=<name>`. **Board** on the
  Work list filtered to a repository keeps the filter.
- **On a phone** the Board shows one stage at a time, with a button for
  each and how many it holds; the address keeps it as `?stage=landing`.
- **In the phone app**, **Board** at the top of Work shows the stages one
  under another, with a chip for each to show one alone.

**New work item** is on the Board too.
