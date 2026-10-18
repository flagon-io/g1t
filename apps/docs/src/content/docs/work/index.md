---
title: Work
description: Where a workspace keeps what it means to do and sees it being done. Work items are the backlog, of any kind of work; Sessions are the work being done on them, by people and their coding agents. On the site, the phone and the native app.
---

**Work** is where a workspace keeps what it means to do, and sees it being
done. It has two halves:

- **Work items** are the backlog: a feature, a bug, a chore, any kind of
  work. Each belongs to the workspace, not to one repository, and names
  the repositories it should land in. See [work items](/work/work-items/).
- **Sessions** are the work being done: each run of someone's coding
  agent, or of g1t's, recorded as it goes, with the work items and pull
  requests it is on. See [sessions](/work/sessions/).

Around them, g1t keeps who is on what. A [claim](/work/claims-and-dependencies/#claims)
says someone is working on a work item; what it is
[blocked by](/work/claims-and-dependencies/#dependencies) says what has to
land first. A pull request opened for a work item lands it in its
repository when it merges, and the work item closes once every repository
it names has landed: see [closing work items](/work/closing/).

People and coding agents use the same Work. An agent loads a work item's
whole context in one call, claims it, opens a pull request for it and is
recorded as a session while it works: see
[working with agents](/work/agents/).

## Where Work is

**Work** is in the left rail, third, after **Home** and **Explore**:

| Rail | Is |
| --- | --- |
| **Home** | What needs you, across the workspace. See [Home](/guides/home/). |
| **Explore** | Public repositories and people beyond your workspaces. See [Search and Explore](/guides/search/). |
| **Work** | Work items and sessions, at `g1t.sh/<workspace>/-/work`. |

Then **Chat**, **Code** (for members with Code access), **Artifacts**,
**Routines** and the apps you pinned. Work is there for every member of
the workspace, Code access or not, so someone who never opens a repository
can still file, follow and close work.

A repository has no Work of its own. Its work items are Work filtered to
it, `g1t.sh/<workspace>/-/work?repo=<name>`, and its sessions are
Sessions filtered to it, `g1t.sh/<workspace>/-/work/sessions?repo=<name>`.
A project has no Work tab of its own: from one, the command palette
(`Ctrl K`) has **Work** and **Sessions** filtered to it.

## Work's sidebar

Work's sidebar has its work items first, then its sessions. Each row is a
view kept in the address, so you can share it.

| Row | Opens |
| --- | --- |
| **Open** | The [Work list](#the-work-list): the open work items. |
| **Assigned to you** | The open work items assigned to you, `?assignee=<you>`. |
| **Closed** | The closed ones, `?state=closed`. |
| **Board** | The [Board](/work/board/): the backlog as it moves, from Backlog to Done. |
| **New work item** | A new work item; see [file a work item](/work/work-items/#file-a-work-item). |
| **Labels** | The workspace's [labels](/work/labels/). |
| **Milestones** | The workspace's [milestones](/work/milestones/). |

Under **Sessions**:

| Row | Opens |
| --- | --- |
| **Live now** | [Sessions](/work/sessions/): what is going now, the merge queue, what just landed and what happened. |
| **Every session** | Every session, most recently heard from first, live or ended. |
| **Yours** | The sessions you ran, `?person=<you>`. |
| **People's harnesses**, **Started on g1t**, **g1t's agent**, **Recorded on pull requests** | Each [kind of session](/work/sessions/#kinds-of-session) alone. |

## The Work list

**Open**, at `g1t.sh/<workspace>/-/work`, lists the workspace's work
items. **Open** and **Closed** above it switch between the two. Each row
shows the work item's title, labels and number, who opened or closed it
and when, the repositories it links (the first two, then "+2"), its
milestone, its assignees, and how many pull requests and comments it has.

Filter it by repository, by the role that repository plays (origin,
target or touched; see [repositories and their roles](/work/work-items/#repositories-and-their-roles)),
by label, milestone and assignee. On a phone they are in one **Filters**
sheet. The address keeps them:

| Filter | In the address |
| --- | --- |
| State | `?state=closed` (open unless you say) |
| Repository | `?repo=web`, or `?repo=acme/web` |
| Its role | `?repo=web&role=target`: `origin`, `target` or `touched` |
| Label | `?label=bug` |
| Milestone | `?milestone=3` |
| Assignee | `?assignee=ana`, or `?assignee=@me` |

`?q=` takes the same filters as words, quotes around a name with spaces:
`?q=is:closed label:"good first issue" repo:web role:target`.

The list follows what changes as it happens, without reloading: a work
item opened, closed, labeled or commented on shows at once.

### Cooking now

Above the list, **Cooking now** shows the sessions live in the workspace
right now, the active ones first: up to six, or three on a phone. Each
card has the session's title, its harness, who it runs for, its work item
and repository, and when it was last heard from. Filtered to a
repository, it shows that repository's. **Sessions** at its end opens
[Sessions](/work/sessions/), which has them all. With nothing running, it
says so.

## On a phone

On the site on a phone, the bar along the bottom is **Home**, **Work**,
**Chat**, **Notifications** and **More**. **Work** is there for every
member. Tap **Work** while you are in Work and it opens Work's menu: the
same sidebar, work items then sessions. **More** starts with **Explore**,
then **Code** for members with Code access, then your other apps.

The Work list puts its filters in one **Filters** sheet, and the
[Board](/work/board/) shows one column at a time.

## In the phone app

The [phone app](/guides/mobile/)'s **Work** tab is the same Work, with a
switch at its top: **Items | Board | Sessions**.

- **Items** is the Work list, with **Open**, **Closed** and **All** under
  the switch. **+ New** files a work item. Tap **Work** in the bar again
  for the filters.
- **Board** is the [Board](/work/board/), its columns one under another,
  with a chip for each to show one alone.
- **Sessions** is [Sessions](/work/sessions/): **Everything**, **Live**
  and **Recent**. Tap **Work** in the bar again for its filters.

See [the phone app's Work](/guides/mobile/#work).

## In this section

- [Work items](/work/work-items/): what one has, filing one, its number,
  who sees it and its repositories.
- [The Board](/work/board/): the stages a work item moves through.
- [Closing work items](/work/closing/): how merges and commits land work
  and close it.
- [Labels](/work/labels/) and [milestones](/work/milestones/).
- [Sessions](/work/sessions/) and [session titles](/work/session-titles/).
- [Claims and dependencies](/work/claims-and-dependencies/): who is on
  what, what waits on what, and how sessions stay out of each other's way.
- [Working with agents](/work/agents/): the CLI, MCP and the API.
- [Issues became work items](/work/from-issues/): what changed for the
  issues you had.
