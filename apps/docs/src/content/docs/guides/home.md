---
title: Home
description: Your workspace's front page. Where you're needed now, what happened since you were last here, what is running, and the one item to start with. How every number is worked out.
---

**Home** is the first page of your workspace, at `/<workspace>/-/home`.
It answers three questions, in this order:

1. **Where you're needed**: everything waiting on you, however long ago
   it started, with the action beside each item.
2. **What happened while you were away**: what people did and what
   agents did, side by side; what landed; deploys, decisions and spend,
   since you were last here.
3. **What is running now**: agent sessions, agents' changes, workflow
   runs and builds still going.

**Start here** picks the one item to do first, and **Ask g1t** at the top
sends a message to g1t from the page.

Every number on the page comes from what g1t has recorded. Nothing is
estimated. When a part of g1t does not answer, the section it feeds says
so, and the rest of the page still shows.

## Where you're needed

This list has no time window: something that started waiting a week ago
is here until you deal with it. Each row says what it is, what is at
stake, how long it has waited, and has its action beside it.

| Source | Rows |
| --- | --- |
| Code | A failed production build; an agent's pull request that stopped and needs a decision, including one whose checks fail; a pull request ready for you to merge; a review asked of you by name; an invitation to a repository; an agent run that stopped reporting; a job waiting for a self-hosted runner |
| Agents | The workspace's agents at 100% of its monthly agent budget, and an agent out of its own monthly budget, both shown only to those who may raise them; a session stopped at its spend cap that you may approve more for; an agent waiting |
| Marketplace | A member's open request to add an extension or integration, shown only to owners |
| Notifications | An unread notification in this workspace that is a warning (someone or something is waiting) or a failure |
| Chat | A conversation that mentions you, or a direct message you haven't read. Muted conversations are left out |

A notification about something already on the list, such as a pull
request whose row is there, is left out.

Rows are ordered most pressing first, by tier, then by how long each has
waited, longest first:

1. A failed production build, or the workspace's agents at their budget.
2. Agent work that has stopped and can't go on without you: a session at
   its spend cap, an agent out of budget, a pull request g1t stopped on.
3. Finished work that only waits for you: a pull request to merge, a
   review, an invitation, an agent waiting, a request to add something.
4. Something that may be stuck: a quiet agent run, a job without a runner.
5. Unread warnings and failures in your notifications.
6. Mentions and direct messages.

The list shows the first eight rows; **Show more** opens the rest. The
sentence under the page's heading starts with how many things need you.

## Start here

**Start here** is the first row of Where you're needed: the most pressing
tier, and within it the row that has waited longest. g1t picks it with
that rule, not with a model, so the same rows always give the same pick.
The card shows who is on it, the next action, how long it has waited, what
is at stake, and why it was picked.

## Since you were last here

Home remembers when you were last on it, for each workspace, with your
account, so it is the same on your laptop and your phone. The second half
of the page covers what happened since then, and its heading says the span
in words, such as **Since Tuesday evening · 2 days** or **Since 40
minutes ago**.

| Switch | What it covers |
| --- | --- |
| **Since last visit** | From the end of your last visit to now. The default. |
| **Last 24 hours** | The 24 hours up to now. |
| **Last 7 days** | The 7 days up to now. |

The switch is part of the address (`?window=24h`, `?window=7d`), so you
can bookmark a span.

How a visit is counted:

- A visit counts once the page has been in view for five seconds. A quick
  refresh does not count, so it never wipes what you haven't looked at.
- What it records is when the page loaded, so anything that happens while
  you are reading shows next time.
- Visits less than 30 minutes apart are one visit. Going to a pull request
  and coming back, or refreshing, keeps the same span until you have been
  away for half an hour.
- With no visit on record, Home shows the last 24 hours and says so. After
  more than 14 days away, it shows the last 14 days.

The sentence under the heading sums it up, for example:

> 8 things need you. Since Tuesday evening, 3 people pushed 41 commits and
> merged 5 changes, agents finished 7 tasks, and 12 changes landed.

It says what people did first (the commits they pushed and the changes
they merged; if neither, the messages they sent), then the agents' tasks
that settled well, then everything that [landed](#landed). When nothing at
all was counted, it says so plainly:

> Quiet since Tuesday evening: nothing pushed, merged, deployed or said.

When Code and Chat both failed to answer, the sentence ends with "what
people did couldn't be read" rather than reading as quiet.

### People and agents

The first card has two columns, **People** and **Agents**. Each lists what
that side did in the span, one line per kind of thing with its count, and
each line opens the place that lists them: a project's Activity tab for
pushes, its pull requests or issues, Artifacts, Chat. Beside the heading
are the faces of the five most active, and how many more there were.

| Line | What counts | From |
| --- | --- | --- |
| *3 people pushed 41 commits to 4 projects* | Every push to a branch of one of the workspace's repositories (`git.push`; tags are not pushes). The commits are the ones each push brought to its branch, along the branch's first-parent line from where it is now back to where it was, at most 50, and one for a new branch. A push recorded before commits were counted counts as one commit. | Events |
| *opened 2 pull requests, merged 5, closed 1 without merging* | `pull.opened`, `pull.merged`, `pull.closed` | Events |
| *reviewed 3 pull requests* | A person's review is a comment with a verdict; an agent's is `review.completed` | Events |
| *opened 4 issues, closed 6* | `issue.opened`, `issue.closed` | Events |
| *left 9 comments* | `comment.created` without a verdict | Events |
| *2 deploys went out, 1 failed* | `deployment.succeeded` and `deployment.failed`, by who set the build off | Events |
| *published 1 release*, *published 2 package versions* | `release.published`, `package.published` | Events |
| *created 1 doc, edited 7 docs* | Artifacts made (`folio.created`), and artifacts whose content changed (`folio.updated`): each artifact once, and everyone whose changes a version holds edited it. "Docs" when every one is a doc, else "artifacts". Counts only: Home never shows an artifact's title here. | Events |
| *sent 120 messages in 5 conversations* (people), *replied 15 times in chat* (agents) | Text messages and thread replies that were not deleted, in the conversations you can read: every public channel, and the private channels and direct messages you are in. Cards agents post are not messages. Conversations are those with at least one message. | Chat |
| *finished 7 tasks, 1 didn't finish*, *ran 2 sessions* (agents only) | The agents' [tasks](#tasks) that settled in the span, and of those the sessions | Code and Agents |

How a side is decided: everything is recorded with who did it. One of the
workspace's agents acting as itself, or g1t, is an agent; everyone else is
a person. A comment a workspace agent writes is the agent's, not the
person's it was working for. A push copied in by a mirror names nobody, so
it is counted under People without a face.

Under the Agents column's lines, a compact row says how their work was
received: accepted first time, fixed after review, didn't finish, and the
share accepted first time with its change from the 7 days before (see
[Accepted first time](#accepted-first-time)), then one mark per task in
the order they settled.

Each column says when it has nothing to show, and names the part that
didn't answer (Code, Chat or Agents) so an empty column never reads as a
quiet day.

### Tasks

A **task** is one piece of agent work. Two kinds count:

| Kind | What it is | Where it comes from |
| --- | --- | --- |
| Pull request | A pull request an agent made in one of the workspace's projects | Code |
| Session | An agent session at the root of its tree: one a person started in a conversation, or one a routine started | Agents |

A session that another session started, such as a subagent or a colleague
brought in, is part of the task that started it and is not counted again.
A conversation whose session filed an issue that an agent then worked on
counts twice: once for the session, once for the pull request.

A task counts in the span when it settled in it. Each has one outcome:

| Outcome | Pull request | Session |
| --- | --- | --- |
| Accepted first time | Merged, and the agent was never sent back to revise it | Never: sessions are not reviewed |
| Fixed after review | Merged after the agent was sent back to revise it at least once | Never |
| Session finished | — | Finished |
| Didn't finish | Closed without merging | Failed or stopped |

Work that is still going is under [Running now](#running-now), not here.
"Sent back to revise" means g1t started a revise run on the pull request:
it does this when checks fail or a review asks for changes. Fixes a person
pushes themselves are not counted as revisions.

### Accepted first time

The share in the Agents column is:

> pull requests accepted first time ÷ agents' pull requests that merged or
> closed in the span

A pull request closed without merging counts against it. Sessions are not
part of it. With no agent pull request settled in the span, the row says
so instead of a share.

Beside it, the change from **the 7 days before** is the same share over the
seven days before the span began, in whole percentage points. It is left
out when nothing settled in those days, or when g1t could not read back far
enough to count them all.

Under it, the counts (accepted first time, fixed after review, didn't
finish) and a strip with one mark for each task, coloured by its outcome,
in the order they settled. Point at a mark to see what it is, and select
it to open it. A session in a conversation you are not in shows as "A
session in a conversation you're not in".

### Landed

Everything that landed in the span, newest first, a person's or an
agent's:

| Row | What it is |
| --- | --- |
| A pull request merged | With who wrote it, and who merged it when that was someone else |
| Commits pushed to a default branch | One row per project with any: how many commits landed on its default branch without a pull request, in how many pushes, and by whom |
| A production build that went live | A project's production build that built and was served (previews stay under Deploys) |
| A release published | Its tag and name, and who released it |
| A package version published | Its name and version, and who published it |

The card's line counts them by kind and how many were agents'. The first
five show; **Show more** opens the rest. When one of its sources (pull
requests, pushes and releases, deployments) didn't answer, the card says
so under the list.

### Deploys

Every build that finished in the span, production and previews: **Went
live** when it built and was served (it may have been replaced since), or
**Failed**. Skipped builds are left out. A workspace whose projects did not
build in the span has no Deploys card.

### Decisions

Decisions recorded in the workspace's [memory](/guides/agent-memory/) in
the span, and Marketplace requests an owner answered, with who made each.
Memories still waiting to be kept are left out. With none, the card is not
shown.

### Spent

What the workspace spent over the span, from its
[statement](/guides/usage-and-billing/), with each line at its price: what
was charged plus what your plan's included usage, a trial, a pool or a
discount paid of it. The lines are the statement's kinds of charge, such
as **Agent runs**, **Sandbox time**, **Self-hosted runner time** and
**Deployments**, most first. Payments, credits, refunds, tax and card fees
are money in, not spend, and are left out. Under the total are the days
counted and the month so far, at price.

The statement keeps whole days, midnight to midnight UTC, so spend counts
from the start of the UTC day the span began: a span since 3 p.m. UTC
yesterday counts all of yesterday. Usage that g1t measures through the
month, such as hosting requests and storage, shows on the day it is added
to the statement.

**Where the work came from** counts the span's tasks by source: Chat
(sessions started in a conversation), Code (pull requests), Schedules
(sessions a routine started) and Another agent.

## Running now

What is going right now, longest-going first:

| Kind | What it is |
| --- | --- |
| Session | An agent session at the root of its tree that is queued, working, or waiting on the helpers it started. One stopped at its spend cap waits on a person, so it is under Where you're needed instead. |
| Change | An agent's pull request that is in the agent's hands: being worked on, waiting on its checks, or a draft still being made |
| Workflow run | A [workflow](/guides/actions/) run that is queued, waiting, running, or waiting for approval, in the ten projects pushed to most in the span (their newest 20 runs each) |
| Build | A project's newest build, queued or building |

## Without Code access

A member whose membership does not include Code sees Home without anything
from Code:

- People shows what was said and the artifacts edited; nothing from
  repositories. Agents shows sessions only: finished, didn't finish, and
  what they said and edited. Accepted first time is not shown, since it is
  measured on pull requests.
- Where you're needed has no rows from Code, and no notifications about a
  repository.
- Landed, Deploys and memory decisions are not shown, and Running now has
  sessions only.
- Spent is the same for every member.

## When something doesn't answer

Each section reads its own part of g1t and shows as soon as it has it.
When one does not answer:

- Where you're needed and Running now name the parts that didn't answer,
  so an empty list never reads as nothing waiting.
- People and Agents count what could be read, and each column names the
  part that is missing (Code, Chat or Agents). If nothing could be read,
  the card says so instead of showing columns, and the sentence under the
  heading says what people did couldn't be read.
- Landed, Deploys and Spent each say their part didn't answer.
- If your last visit can't be read, the span is the last 24 hours and the
  page says why.

When a list g1t reads is longer than it reads at once (200 sessions, 200
revise runs, 100 pull requests per project and state, 50 projects, builds
of 20 projects, 5,000 events of the span), the page says that some work
may be missing or some counts are low.

## How it scales

Every event in g1t is in one log, and its ids sort by time, so a span is a
range of ids. Home asks the events service for one digest of the span: for
each of the workspace's repositories (the first 50) and each kind of event
it counts, that is one range scan of an index on repository, type and id,
and the workspace's artifact events are the same range under no
repository. A busy week of tens of repositories is a few thousand rows,
read in one round trip; chat's count is one query over the conversations
you can read. When a workspace has hundreds of repositories, the next step
is a daily rollup per workspace that the digest reads instead of the log.
It is not built yet.

## For services: activity_digest and activity

Home's counts come from two methods other services can call too.

**`activity_digest`** on the events service (`repo_ids`, `workspace`,
`from`, `until`; RFC 3339, `[from, until)`; the caller has checked the
viewer may read each repository) returns, per repository that had any
event: `pushes` (`count`, `commits`, `branches`, `by` with each actor's
pushes and commits, and `default_branch` with the same for pushes straight
to it and `last_at`), `pulls` (`opened`, `merged`, `closed`), `issues`
(`opened`, `closed`), `reviews`, `comments`, `deployments` (`succeeded`,
`failed`, `production`), `releases` and `packages` (newest first, at most
50 each); and for the workspace named, `folios` (`created`, `edited` with
each folio's authors, `edited_count`). Every count by actor is a list of
`{ actor, count }`, where `actor` is a member key: `user:<id>` for an
account (g1t is `user:usr_g1t_agent`), `agent:<id>` for one of the
workspace's agents acting as itself, or empty for nobody. `complete` is
false when more than 5,000 events fell in the span, or more than 50
repositories were named.

**`activity`** on the chat service (`workspace`, `viewer`, `from`,
`until`) returns `messages`, `channels` (conversations with at least one)
and `authors` (`key`, `messages`; most first), over text messages and
thread replies not deleted in the conversations the viewer can read.
