---
title: Work
description: Where a workspace keeps what it means to do and sees it being done. Work items are the backlog, of any kind of work, planned in Now, Next and Later and gathered into projects. On the site, the phone and the native app.
---

**Work** is where a workspace keeps what it means to do, and sees it being
done.

- **Work items** are the backlog: a feature, a bug, a chore, any kind of
  work. Each belongs to the workspace, not to one repository, and names
  the repositories it should land in. See [work items](/work/work-items/).
- **The plan** says what the workspace is on now, what comes next and what
  can wait. See [the plan](/work/plan/).
- **Projects** give a body of work a home: its brief, lead and people, its
  work items, its repositories and how it is going. See
  [projects](/work/projects/).
- **Sessions** are the work being done: each run of someone's coding
  agent, or of g1t's, recorded as it goes. They are in Chat, and every
  work item links to its own. See [sessions](/work/sessions/).

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

| Rail        | Is                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------- |
| **Home**    | What needs you, across the workspace. See [Home](/guides/home/).                                  |
| **Explore** | Public repositories and people beyond your workspaces. See [Search and Explore](/guides/search/). |
| **Work**    | Work items, the plan and projects, at `g1t.sh/<workspace>/-/work`.                                |

Then **Chat**, **Code** (for members with Code access), **Artifacts**,
**Routines** and the apps you pinned. Work is there for every member of
the workspace, Code access or not, so someone who never opens a repository
can still file, follow and close work.

A repository has no Work of its own. Its work items are Work filtered to
it, `g1t.sh/<workspace>/-/work?repo=<name>`, and its sessions are
Sessions filtered to it, `g1t.sh/<workspace>/-/chat/sessions?repo=<name>`.
A project has no Work tab of its own: from one, the command palette
(`/`) has **Work** and **Sessions** filtered to it.

## Work's sidebar

Work's sidebar has **New work item** first, then its views, then its
projects. Each row is a view kept in the address, so you can share it.

| Row                 | Opens                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| **New work item**   | A new work item; see [file a work item](/work/work-items/#file-a-work-item). |
| **Plan**            | [The plan](/work/plan/), at `-/work`: Now, Next and Later.                   |
| **Board**           | The [Board](/work/board/): the work as it moves, from Up next to Done.       |
| **Triage**          | New work items nobody has placed in the plan yet.                            |
| **All open**        | The [Work list](#the-work-list), at `-/work/all`: the open work items.       |
| **Assigned to you** | The open work items assigned to you, `?assignee=<you>`.                      |
| **Closed**          | The closed ones, `?state=closed`.                                            |
| **Labels**          | The workspace's [labels](/work/labels/).                                     |
| **Milestones**      | The workspace's [milestones](/work/milestones/).                             |

Under **Projects**:

| Row              | Opens                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **All projects** | The [projects](/work/projects/) page, at `-/work/projects`.                                |
| Each project     | The projects under way, active first, each with a dot for its health: opens its home page. |
| **New project**  | Makes one; see [make a project](/work/projects/#make-a-project).                           |

[Sessions](/work/sessions/) are in Chat, at `-/chat/sessions`.

## The Work list

**All open**, at `g1t.sh/<workspace>/-/work/all`, lists the workspace's
work items. **Open** and **Closed** above it switch between the two. Each row
shows the work item's title, labels and number, who opened or closed it
and when, the repositories it links (the first two, then "+2"), its
milestone, its assignees, and how many pull requests and comments it has.

Filter it by repository, by the role that repository plays (origin,
target or touched; see [repositories and their roles](/work/work-items/#repositories-and-their-roles)),
by label, milestone, project and assignee. On a phone they are in one **Filters**
sheet. The address keeps them:

| Filter     | In the address                                           |
| ---------- | -------------------------------------------------------- |
| State      | `?state=closed` (open unless you say)                    |
| Repository | `?repo=web`, or `?repo=acme/web`                         |
| Its role   | `?repo=web&role=target`: `origin`, `target` or `touched` |
| Label      | `?label=bug`                                             |
| Milestone  | `?milestone=3`                                           |
| Project    | `?project=work-overhaul`, a project's slug               |
| Assignee   | `?assignee=ana`, or `?assignee=@me`                      |

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
- [The plan](/work/plan/): Now, Next and Later.
- [Projects](/work/projects/): homes for bodies of work.
- [The Board](/work/board/): the stages a work item moves through.
- [Sub-items](/work/sub-items/): breaking a work item down, and how far
  along its sub-items are.
- [Closing work items](/work/closing/): how merges and commits land work
  and close it.
- [Labels](/work/labels/) and [milestones](/work/milestones/).
- [Sessions](/work/sessions/) and [session titles](/work/session-titles/).
- [Claims and dependencies](/work/claims-and-dependencies/): who is on
  what, what waits on what, and how sessions stay out of each other's way.
- [Working with agents](/work/agents/): the CLI, MCP and the API.
- [Issues became work items](/work/from-issues/): what changed for the
  issues you had.
