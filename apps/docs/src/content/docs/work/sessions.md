---
title: Sessions
description: The work being done, as it happens. Sessions lists every run of people's coding agents, and of g1t's, across the workspace, live; a session's page shows what it worked on, what it touched and everything it recorded.
---

A session is one run of a coding agent on a repository: a Claude Code
session, a Codex run, a session g1t started on your Anthropic account.
Work items are what a workspace means to do; sessions are that work being
done. Each is recorded as it goes, tied to the work items and pull
requests it works on, and shown to the team while it runs.

Not every session starts from a work item. A question, a look around or a
quick fix needs none: the session is the record of that work, named by g1t
from what it does (see [session titles](/work/session-titles/)), and it
claims or files a work item only when it becomes a change others should
know about.

Nothing here waits on a harness. A harness that crashes, loses its network
or sends the same thing twice does no harm: a session that goes quiet is
read as idle, then ended, the next time anyone looks, and recording the
same thing again is a no-op. What git and g1t record (commits, pull
requests, checks, merges) is the truth; sessions are the account of how it
got there.

To record your own harness's sessions, see
[recording sessions](/guides/sessions/), or install the
[Claude Code plugin](/guides/claude-code-plugin/), which does it for you.

## The Sessions pages

**All sessions** is at the bottom of Chat's sidebar, under your own recent
sessions in [**Sessions**](/guides/chat/#sessions), each with whether it's
working, waiting on you or idle. Its address is `g1t.sh/<workspace>/-/chat/sessions`.
It shows the sessions in every one of the workspace's repositories you can
read. Links to its old address, `g1t.sh/<workspace>/-/work/sessions`, still
work and go on to the same place.

**Live now** is what is cooking right now:

- **Live now**: the active and idle sessions, the most recently heard
  from first, and how many are going and idle. Each card shows the
  session's title, who it acts for, its harness, its repository and
  branch, the work item and pull request it is on, when it was last heard
  from, how many subagents it has, and whether it is live or idle.
- **Merge queue**: each repository's merge queue that has something
  waiting, as on its [Merge queue](/guides/merge-queue/#the-merge-queue-page)
  page.
- **Just landed**: the pull requests merged lately, each with its work
  item, who merged it, and **Why**, a link to the session behind it.
- **What happened**: the latest coordination events across the
  repositories: claims, sessions starting and ending, overlaps, and what
  the merge queue found when it combined changes.
- **Recent**: the sessions that ended lately.

**Every session**, in the sidebar, is every session in one list, live or ended,
the most recently heard from first. **Yours** is the sessions you ran.

With nothing going on, Sessions says how to start: choose your client in
the [connection instructions](/guides/bring-your-own-agent/), or run
`g1t work claim <number>` from any harness.

### Filters

Narrow it by repository, person, harness, kind and work item. The address
keeps the filters, so a filtered view can be shared:

| Filter        | In the address                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Repository    | `?repo=web`                                                                                       |
| Person        | `?person=<username>`                                                                              |
| Harness       | `?harness=codex`: `claude_code`, `claude_managed_agents`, `codex`, `cursor`, `copilot` or `other` |
| Kind          | `?kind=hosted`                                                                                    |
| Work item     | `?item=12`, shown as **On #12**                                                                   |
| Every session | `?state=recent`                                                                                   |

A repository's sessions are Sessions filtered to it,
`g1t.sh/<workspace>/-/chat/sessions?repo=<name>`: a repository has no
Sessions page of its own. On a phone the filters are in one **Filters**
sheet.

### Kinds of session

Every kind of session is listed in this one place, and each has its own
row in the sidebar:

| Kind       | Sidebar                       | Is                                                                                                                                                                                                                                           |
| ---------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness`  | **People's harnesses**        | A run of someone's own harness (Claude Code, Codex, Cursor, Copilot or another), with its [subagents](/guides/sessions/#subagents) under it.                                                                                                 |
| `hosted`   | **Started on g1t**            | A session started on g1t, from a work item or the web, on the workspace's Anthropic provider: harness `claude_managed_agents`. See [start a session on your Anthropic account](/guides/sessions/#start-a-session-on-your-anthropic-account). |
| `agent`    | **g1t's agent**               | g1t's own agent at work on a pull request. Only the workspace's members see these.                                                                                                                                                           |
| `recorded` | **Recorded on pull requests** | A session recorded on a pull request with no session of its own. It opens on the pull request's **Session** tab, `g1t.sh/<owner>/<repo>/pull/<number>/session`.                                                                              |

### As it happens

Sessions, Cooking now, the [Board](/work/board/) and a work item's page
follow the work without reloading. Signed in, the page listens for changes
in the workspace's repositories and reads itself again a second after the
last one, never while you type or a dialog is open, and catches up when you
come back to the tab. Since a session going idle sends nothing, Sessions
also checks every 15 seconds while anything is going. Signed out, a page
reads itself again when you come back to it and once a minute.

## States

A session's `state` is worked out from when it was last heard from. Every
heartbeat, update and recorded entry counts:

| State    | Means                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `active` | Heard from in the last 15 minutes.                                                                                                                                 |
| `idle`   | Not heard from for 15 minutes. It may still come back.                                                                                                             |
| `ended`  | Ended by its harness, or not heard from for 30 minutes (`end_reason` `timed_out`). A heartbeat brings a timed-out session back; one its harness ended stays ended. |

A session its harness left behind, killed or never told to end, can be
ended by hand: **End session** in its menu under Live now (on the repository's
overview and on Sessions), or on its page. Whoever runs a session can end
it, and so can anyone with write access to the repository; nobody else
sees the action. It ends with `end_reason` `ended by hand by @name`, its
subagents still going end with it, and its claims stay until they are
released or expire. Like a session that timed out, it comes back the
moment its harness is heard from again, so a harness that was in fact
still running picks up where it was. A session g1t runs on the workspace's
Anthropic account is stopped from its page instead, with **Stop**.

## A session's page

A session's page is `g1t.sh/<workspace>/-/chat/sessions/<id>` (its
`ses_…` id), opened from Sessions or from anywhere the session is listed.
It shows:

- for a session g1t runs on the workspace's Anthropic account, while it
  runs, and to whoever started it or a workspace member with write access
  to its repository: a card at the top for each call waiting for approval,
  with **Allow** and **Deny**, and **Send to this session** under its
  answer, to message it. See
  [answer a running session](/guides/sessions/#answer-a-running-session);
- who ran it, in which harness and on which model, its state, when it
  started and how long it ran, when it was last heard from or why it
  ended, its repository, branch and head commit;
- the work items and pull requests it and its subagents worked on, each
  saying how it was tied (see [what a session records](#what-a-session-records));
- **What it reported**, when it ended with a result;
- its **subagents** as a tree you open one at a time, each with its kind,
  the task it was given, what it touched and what it reported. A
  subagent's own page links back to the session that started it;
- the **skills** it used, **what it touched** (files, commits, branches,
  pull requests), and its commits and pull requests;
- the [coordination updates](/work/claims-and-dependencies/#coordination-updates)
  it has not acknowledged yet;
- **What it recorded**, as it records it: its prompt folded, its messages
  formatted as they were written, and the tool calls between them a line
  each (a command as code, a file by its path, a g1t tool by what it did,
  such as _work item · claim_), more than three in a row folded into one
  line that opens to them. A long command and what a tool gave back open
  under its line.

Whoever runs it, and anyone with write access to the repository, can
**Rename** it there, which pins the title; see
[session titles](/work/session-titles/#pin-a-title).

## Sessions elsewhere on the site

Sessions show where the work is, as it happens:

- **A work item's Work panel**, at the top of its sidebar: its claims, the
  sessions on it (up to five, then a link to Sessions filtered to it), what
  it is blocked by and what it blocks. See
  [claims and dependencies](/work/claims-and-dependencies/).
- **A work item's and a pull request's sessions**: every session tied to
  it in any way, in any of the workspace's repositories, with its
  subagents under it. A pull request's **Session** tab,
  `g1t.sh/<owner>/<repo>/pull/<number>/session`, is what was recorded on
  it.
- **Cooking now**, above the [Work list](/work/#cooking-now): the live
  sessions, a strip of cards.
- **A repository's overview**: **Live now**, the people and coding agents
  working on that repository, grouped by work item, then by pull request
  or branch. See [the overview](/guides/repositories/#the-overview).

## What a session records

A session records its prompts, its messages, the tool calls it makes,
notes, the skills it uses, and its result when it ends. It never records
what a tool gave back unless its harness sends it. It also says what it
touched, each kept once:

| `kind`   | `value`                                                          |
| -------- | ---------------------------------------------------------------- |
| `file`   | A file it wrote, from the repository's root.                     |
| `commit` | A commit it made.                                                |
| `branch` | A branch it made or pushed.                                      |
| `pull`   | A pull request it opened, by number.                             |
| `item`   | A work item it named or claimed, by its number in the workspace. |

From these and the rest of what it records, g1t ties the session to the
work items and pull requests it worked on, each in as many ways as it was
(`via` in the session's `links`):

| `via`      | When                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| `attached` | It said it is on it, starting or updating.                                               |
| `claim`    | It claimed the work item.                                                                |
| `opened`   | It opened the pull request.                                                              |
| `branch`   | It pushed the pull request's branch, also when the pull request is opened later.         |
| `commit`   | It made the pull request's head commit.                                                  |
| `trailer`  | A commit pushed to the pull request's branch names it in a `G1t-Session: ses_…` trailer. |
| `ref`      | Its prompt, its task, its result or a subagent's names it as `#12`.                      |

A session's links cover its subagents too, and the work item and pull
request pages list every session tied to them with its subagents. Put the
trailer on the commits a session makes and they lead back to it:

```sh
git commit --trailer "G1t-Session: $G1T_SESSION"
```

A work item a session closes, or a repository it lands on one, says so on
its timeline, **via session** and a link to it (see
[who closed it, and how](/work/closing/#who-closed-it-and-how)). When two
active sessions touch the same file, each is told; see
[overlaps](/work/claims-and-dependencies/#overlaps).

Entries of a session attached to a pull request show in that pull
request's [session](/guides/why-blame/#sessions) too, so reviewers and
why-blame see them.

## Who sees what

A session records someone's own work as it happens, so g1t shows it by who
is looking, on the site, the API, MCP and the CLI alike.

| Who                                     | Sees                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Whoever ran it                          | All of it: its prompts, tool calls, what it touched and reported, its pending updates.                                                                                                                                                                                                                                                                                   |
| A member of the repository's workspace  | What it did: its title, tool calls, messages, notes, skills, what it touched, its subagents' tasks, prompts and reports, what it cost ([estimated at list price](/guides/sessions/#what-a-session-cost)), its pending updates. Not the prompts someone else typed, nor a tool's output (`tool_result`): those entries show as kept back. A title shows without swearing. |
| Anyone else who may read the repository | That it runs: who runs it, in which harness, since when, its state and the work items and pull requests it is tied to. Nothing it recorded, touched, was asked or reported, nor its title, branch, model or cost. On a pull request's session, only g1t's own notes.                                                                                                     |

g1t's own agent's sessions are listed only for members.

Before anything is kept, g1t takes out what looks like a credential
(`[redacted]`): every token format [secret protection](/guides/security/secret-protection/)
knows, any key or token by its issuer's prefix, `NAME_TOKEN=value`,
`password: value` and the like, `--token`/`--password` flags, `Bearer` and
`Authorization` headers, a URL's user and password and its signed query
parameters, JWTs, private keys, and long random-looking strings. What was
recorded before this is hidden the same way as it is read. The
[Claude Code plugin](/guides/claude-code-plugin/) does the same before
anything leaves your machine. It is a safety net, not a vault: keep
secrets out of prompts and command lines.

## From the API, MCP and the CLI

The same list is in the API, MCP and the CLI:
[`GET /workspaces/{workspace}/sessions`](/reference/api/sessions/list-workspace-sessions/)
by `state` (`live`, `recent` or `ended`), `kind` (`harness`, `hosted`,
`agent` or `recorded`), `harness`, `person`, `repo`, `item`, `subagents`
and `limit`, which returns the `sessions`, each repository's `queue`, what
`landed` and the `repos` it covers;
[`GET /workspaces/{workspace}/sessions/{id}`](/reference/api/sessions/get-workspace-session/)
for one session, with its `repo`. Over MCP, the `session` tool's `list`
takes `workspace` instead of `repo`, and `get` takes `workspace` and `id`.
From the CLI:

```sh
g1t session list --workspace                 # this repository's workspace
g1t session list --workspace acme --in web   # one repository of it
g1t session list --workspace --harness codex --state active
g1t session view ses_01m4b2c3d4e5f6g7h8j9k0m1n2
```

`--workspace` takes a slug, or none for the current repository's
workspace; `--harness`, `--person`, `--in NAME` (a repository of it),
`--state` (active or idle: what is going now; ended), `--item` and
`--subagents` narrow it.

One repository's sessions are
[`GET /repos/{owner}/{name}/sessions`](/reference/api/sessions/list-sessions/),
or `session` `list` with `repo`, by `state`, `item` or `pull` (any session
tied to it), or `path` (those that touched a file, or any under a folder
ending in `/`); subagents are listed too with `subagents=true`. A session
in the list with no `title` carries `first_prompt`: the first 300
characters of the first prompt it recorded. Reading sessions needs
`pull_requests:read` with an access token.
