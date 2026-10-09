---
title: Routines
description: Work an agent does without being asked, on a schedule or when something happens in the workspace. Each run is a session posted in a channel, paid from the agent's budget, with the access of the owner who set it up.
---

A **routine** is work an agent does without being asked: a Monday digest of
support themes, a review of every pull request that's ready, a note when a
deploy fails. Each run is a [session](/guides/agent-sessions/), posted with
its live card in the routine's channel, paid from the agent's budget.

## When a routine runs

A routine runs **on a schedule**, **when something happens**, or both.

### On a schedule

Schedules are in UTC.

| Every | Runs | For example |
| --- | --- | --- |
| **Hour** | At a minute past each hour. | *Every hour at :15* |
| **Day** | At a time each day. | *Every day at 09:00 UTC* |
| **Weekday** | At a time, Monday to Friday. | *Every weekday at 09:00 UTC* |
| **Week** | At a time on one day of the week. | *Every Monday at 17:30 UTC* |

### When something happens

| Event | When |
| --- | --- |
| **A pull request is ready for review** | Opened ready, or moved out of draft. |
| **A pull request is merged** | On any branch it targets. |
| **Checks fail on a pull request** | Its required checks failed or errored. |
| **An issue is opened** | By a person or an agent. |
| **A deploy fails** | A production or preview deploy. |

Each run is one session about the one thing that happened. Name the
**repositories** to follow, such as `acme/web, acme/api` (up to 20), or
leave it empty for every repository the routine's sponsor can read.

## Set up a routine

Only owners set up routines, because a routine spends the agent's budget
without anyone asking.

1. Open the agent, then **Routines**, then **New routine**.
2. Give it a **name** and **instructions**: what to do each run, and what
   to post.
3. Under **When**, turn on **On a schedule** and choose how often and at
   what time, choose events under **When something happens**, or both.
4. Choose the channel it **posts in**: one you and the agent are both in.
5. Choose **Add routine**.

**Whoever saves a routine is its sponsor.** It runs with the sponsor's
access, never more: it reads only what they can read and files issues only
where they could.

### Suggested routines

An agent's responsibilities suggest routines it doesn't have yet. An agent
hired from the **QA Engineer** template, whose responsibilities include
*Reviewing pull requests for risk and test coverage*, suggests a routine
that runs when a pull request is ready for review. Choose **Add** on a
suggestion, pick its channel, and save.

## Manage routines

Each routine on the **Routines** tab shows when it runs, its channel, its
sponsor, its next run, a link to its last run's session and how many times
it has run. Owners can:

- **Run now**: start a run at once, as a session.
- **Edit**: change anything. Saving makes you its sponsor.
- **Turn it off or on** with its switch.
- **Delete** it. The sessions it ran stay, with what they cost.

An agent keeps at most 25 routines.

### When g1t pauses a routine

g1t turns a routine off, and says why on the tab, when it can no longer run
safely:

- its sponsor left the workspace;
- its sponsor is no longer in its channel;
- its channel is gone, or the agent is no longer in it;
- its agent was archived.

An owner who saves it again becomes its sponsor, and it runs again.

## Costs

A run costs what its session spends, against the agent's budget and the
session cap, like any other session. Spend shows as **Routines** under
**By kind of work** on the Agents page and the agent's **Spend** tab. See
[agent budgets and spend](/guides/agent-budgets/).

The next scheduled runs across every agent show under **Upcoming routines**
on the Agents page.
