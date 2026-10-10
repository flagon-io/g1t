---
title: Today
description: Your workspace's front page. How the agents' work went today, what is waiting on you with the action beside it, what the day cost, and the one item to start with. How every number is worked out.
---

**Today** is the first page of your workspace, at `/<workspace>/-/today`.
It sums up the day instead of opening a conversation: one sentence about
the day, how the agents' work went, what is waiting on you, what the day
cost, and the one thing g1t suggests you start with. Chat is one click
away, and **Ask g1t** at the top sends a message to g1t from here.

Every number on the page comes from what g1t has recorded. Nothing is
estimated. When a part of g1t does not answer, the section it feeds says
so, and the rest of the page still shows.

## What "today" means

Today is your calendar day in your own time zone, which your browser
tells g1t. Until it has, g1t uses UTC.

**Spent today** is the one exception: the statement keeps days from
midnight to midnight UTC, so the spend shown is for the current UTC day.
See [Spent today](#spent-today).

## The sentence at the top

Under the heading, one sentence counts the day's tasks and what waits on
you, for example:

> Oct 9 · Agents finished 35 tasks. 4 needed a fix after review, and 6 are
> still open. 8 things are waiting on you.

- **Finished** counts tasks accepted first time, fixed after review, and
  sessions that finished.
- **Needed a fix after review**, **didn't finish** and **still open** are
  the counts defined under [Tasks](#tasks).
- **Things waiting on you** is the number of rows in
  [Needs attention](#needs-attention).

The **Review** button beside it shows the same number and opens your
notifications.

## Tasks

A **task** is one piece of agent work. Two kinds count:

| Kind | What it is | Where it comes from |
| --- | --- | --- |
| Pull request | A pull request an agent made in one of the workspace's projects | Code |
| Session | An agent session at the root of its tree: one a person started in a conversation, or one a routine started | Agents |

A session that another session started, such as a subagent or a colleague
brought in, is part of the task that started it and is not counted again.
A conversation whose session filed an issue that an agent then worked on
counts twice: once for the session, once for the pull request.

A task is one of **today's** when it settled today, or when it is still
open and something happened on it today. Each one has one outcome:

| Outcome | Pull request | Session |
| --- | --- | --- |
| Accepted first time | Merged today, and the agent was never sent back to revise it | Never: sessions are not reviewed |
| Fixed after review | Merged today after the agent was sent back to revise it at least once | Never |
| Session finished | — | Finished today |
| Still open | Draft or open, and updated today | Queued, working, waiting or waiting for spend approval, and updated today |
| Didn't finish | Closed today without merging | Failed or stopped today |

"Sent back to revise" means g1t started a revise run on the pull request:
it does this when checks fail or a review asks for changes. Fixes a person
pushes themselves are not counted as revisions.

## Accepted first time

The large percentage is:

> pull requests accepted first time ÷ agents' pull requests that merged or
> closed today

A pull request closed without merging counts against it. Open pull
requests and sessions are not part of it. With no agent pull request
settled today, the percentage shows as a dash.

Under it, the change from the **last 7 days** is the same share over the
seven calendar days before today, in whole percentage points. It is left
out when nothing settled in those days, or when g1t could not read back far
enough to count them all.

## The strip

Beside the percentage are four counts (tasks today, accepted first time,
fixed after review, still open) and a strip with one mark for each of
today's tasks, coloured by its outcome. Settled tasks come first, in the
order they settled, then open ones. Point at a mark to see what it is, and
select it to open it. A session in a conversation you are not in shows as
"A session in a conversation you're not in".

## Needs attention

Each row is one thing waiting on you, with what is at stake and the
action beside it. Rows come from:

| Source | Rows |
| --- | --- |
| Code | A failed production build; an agent's pull request that stopped and needs a decision; a pull request ready for you to merge; a review asked of you by name; an invitation to a repository; an agent run that stopped reporting; a job waiting for a self-hosted runner |
| Agents | A session stopped at its spend cap that you may approve more for; an agent out of its monthly budget, shown only to those who may raise it; an agent waiting |
| Notifications | An unread notification in this workspace that is a warning (someone or something is waiting) or a failure |
| Chat | A conversation that mentions you, or a direct message you haven't read. Muted conversations are left out |

A notification about something already on the list, such as a pull request
whose row is there, is left out.

Rows are ordered most pressing first, by tier, then by how long each has
waited, longest first:

1. A failed production build, or the workspace at its usage limit.
2. Agent work that has stopped and can't go on without you: a session at
   its spend cap, an agent out of budget, a pull request g1t stopped on.
3. Finished work that only waits for you: a pull request to merge, a
   review, an invitation, an agent waiting.
4. Something that may be stuck: a quiet agent run, a job without a runner.
5. Unread warnings and failures in your notifications.
6. Mentions and direct messages.

The card shows the first six rows. **Where today's work came from** under
it counts today's tasks by source: Chat (sessions started in a
conversation), Code (pull requests), Schedules (sessions a routine
started) and Another agent.

## Start here

**Start here** is the first row of Needs attention: the most pressing
tier, and within it the row that has waited longest. g1t picks it with that
rule, not with a model, so the same rows always give the same pick. The
card shows who is on it, the next action, how long it has waited, what is
at stake, and why it was picked.

## Spent today

**Spent today** is the current UTC day of your workspace's
[statement](/guides/usage-and-billing/), with each line at its price:
what was charged plus what your plan's included usage, a trial, a pool or a
discount paid of it. The lines are the statement's kinds of charge, such as
**Agent runs**, **Sandbox time**, **Self-hosted runner time** and
**Deployments**, most first. Payments, credits, refunds, tax and card fees
are money in, not spend, and are left out. Usage that g1t measures through
the month, such as hosting requests and storage, shows on the day it is
added to the statement. Under the total is the month so far, at price.

## Without Code access

A member whose membership does not include Code sees Today without
anything from Code:

- Tasks are sessions only. The large number is **Finished today**, and the
  counts are sessions finished, didn't finish and still open. Accepted
  first time is not shown, since it is measured on pull requests.
- Needs attention has no rows from Code, and no notifications about a
  repository.
- Spent today is the same for every member.

## When something doesn't answer

Each section reads its own part of g1t and shows as soon as it has it.
When one does not answer:

- The day's work counts what could be read and says which part is missing.
  If neither answered, it says so instead of showing counts.
- Needs attention names the parts that didn't answer, so an empty list
  never reads as nothing waiting.
- Spent today says billing didn't answer.

When a list g1t reads is longer than it reads at once (200 sessions, 200
revise runs, 100 pull requests per project and state, 50 projects), the
page says that some of today's tasks may be missing.
