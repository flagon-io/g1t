---
title: Sessions, claims and dependencies
description: How agents and people see who is working on what, in a repository and across the workspace on Sessions, with sessions of their own harnesses, advisory claims on work items, what a work item is blocked by, and the one call that loads a work item's whole context.
---

When several agents and people work on one repository at once, each needs
to know what the others are doing. g1t keeps that around the
[work item](/guides/work-items/), which is the unit of work: its
description says what is wanted and what done means, its pull requests are
the proposals, and around it g1t records:

- **Sessions**: one run of your own harness (a Claude Code session, a
  Codex run) on the repository, attached to the work item and pull request
  it works on. A session is recorded in the repository it is checked out
  in; its work item is the workspace's.
- **Claims**: an advisory, expiring "I'm working on #12". Never a lock.
- **Dependencies**: the work items that have to land before this one.

Until there is a work item, the session is the unit: work that starts from
a question or a quick request is recorded as a session, named by g1t from
what it does ([Session titles](#session-titles)), and shows to the team on its branch or pull request. It opens or
claims a work item only when it becomes a change others should know about;
see [Work with no work item yet](#work-with-no-work-item-yet).

Nothing here waits on a harness. A harness that crashes, loses its
network or sends the same thing twice does no harm: sessions and claims
that go quiet are read as idle, ended or expired the next time anyone
looks, and starting a session or recording an entry again is a no-op.
What git and g1t record (commits, pull requests, checks, merges) is the
truth; sessions are the account of how it got there.

## The Sessions page

**Sessions** is in the left rail, directly after **Work**, at
`g1t.sh/<workspace>/-/sessions`. It shows what is cooking across the
workspace: the sessions in every one of its repositories you can read,
as they happen, without reloading.

- **Live now**: the active and idle sessions, the most recently heard
  from first. Each card shows the session's title, who it acts for, its
  harness, its repository and branch, the work item and pull request it
  is on, when it was last heard from, how many subagents it has, and
  whether it is live or idle. A session with no title is named by what
  its first prompt was for, else **Session on** its branch, else
  **Untitled session**. A title that is only a tag, such as
  `<pasted_content id="5c50">`, counts as no title.
- **Merge queue**: each repository's merge queue that has something
  waiting, as on its [Merge queue](/guides/merge-queue/#the-merge-queue-page)
  page.
- **Just landed**: the pull requests merged lately, across the
  repositories, each with a link to the session behind it.
- **What happened**: the latest coordination events across the
  repositories: claims, sessions starting and ending, overlaps, and what
  the merge queue found when it combined changes.
- **Recent**: the sessions that ended lately.

With nothing going on, choose your client in the
[connection instructions](/guides/bring-your-own-agent/), or run
`g1t work claim <number>` from any harness.

Narrow it by repository (`?repo=web`), person (`?person=<username>`),
harness (`?harness=codex`), kind (`?kind=hosted`) and state. The address
keeps the filters, so a filtered view can be shared. A repository's
sessions are Sessions filtered to it,
`g1t.sh/<workspace>/-/sessions?repo=<name>`: a repository has no
Sessions page of its own.

Every kind of session is listed in this one place:

| Kind | Is |
| --- | --- |
| `harness` | A run of someone's own harness (Claude Code, Codex, Cursor, Copilot or another), with its [subagents](#subagents) under it. |
| `hosted` | A session started on g1t, from a work item or the web, on the workspace's Anthropic provider: harness `claude_managed_agents`. See [Start a session on your Anthropic account](#start-a-session-on-your-anthropic-account). |
| `agent` | g1t's own agent at work on a pull request. Only the workspace's members see these. |
| `recorded` | A session recorded on a pull request with no session of its own. It opens on the pull request's **Session** tab, `g1t.sh/<owner>/<repo>/pull/<number>/session`. |

**A session's page** is `g1t.sh/<workspace>/-/sessions/<id>` (the
`ses_…` id), opened from Sessions or from anywhere the session is listed:
who ran it, in which harness and on which model, how long it has run, its
repository, the work items and pull requests it and its subagents worked
on (each says how it was tied), its subagents as a tree you open one at a
time (each with its kind, the task it was given, what it touched and what
it reported), the skills used, what was touched (files, commits, branches,
pull requests), and everything it recorded, as it records it: its prompt
folded, its messages formatted as they were written, and the tool calls
between them a line each (a command as code, a file by its path, a g1t
tool by what it did, such as *work item · claim*), more than three in a
row folded into one line that opens to them; a long command and what a
tool gave back open under its line. A subagent's own page links back to
the session that started it.

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
```

`--workspace` takes a slug, or none for the current repository's
workspace; `--harness`, `--person`, `--in NAME` (a repository of it),
`--state` (active or idle: what is going now; ended), `--item` and `--subagents` narrow it.

## On the site

Besides **Sessions**, sessions and claims show where the work is, as it
happens, without reloading.

- **A work item's Work panel**, at the top of its sidebar: its claims
  (who, from which harness, since when and when each lapses; ones
  released, expired or handed off lately are shown dimmed), the sessions on
  it with their state and when each was last heard from, what
  it is blocked by and where each of those stands, and the work items it
  blocks. Its author and anyone with the Triage role change what it is
  blocked by with **Edit**. Under its pull requests, the work item shows
  the latest combination that failed in the merge queue, and its
  [decision records](/guides/why-blame/#decision-records), each marked
  **Claimed**, **Tested** or **Approved**.
- **A work item's and a pull request's sessions**: every session tied to
  it in any way, in any of the workspace's repositories, with its
  subagents under it. A pull request's **Session** tab,
  `g1t.sh/<owner>/<repo>/pull/<number>/session`, is what was recorded on
  it.
- **A project's overview**: **Live now**, the people and coding agents
  working on that repository, grouped by work item, then by pull request
  or branch. See [the overview](/guides/projects/#the-overview).
- **Start a session** on a work item, for members of a workspace with an
  Anthropic AI provider: see
  [Start a session on your Anthropic account](#start-a-session-on-your-anthropic-account).

## Session titles

A session's title names the whole of its work, and settles instead of
following each turn. Each title says where it came from (`title_source`)
and when it settled (`title_settled_at`):

| Source | What it is |
| --- | --- |
| `prompt` | Provisional: what its first prompt asked for (its first line or sentence, without pasted text, image placeholders, code or markdown). Shown muted. |
| `item`, `pull`, `summary` | Settled by g1t from the session's record. |
| `agent` | Its harness or agent named it (`title` on start or update, `g1t session attach --title`). |
| `person` | Someone renamed it on its page: pinned. Neither g1t nor the agent replaces it. **Let g1t name it** unpins it. |

g1t settles a provisional title once there is enough to go on: the session
claims or is attached to a work item, opens or pushes a pull request,
records three prompts, or has run for 30 minutes. It names it again only
when what the session works on changes (another work item or pull
request, or many more prompts), at most every 20 minutes and only when the
new title says something else, and a last time when the session ends,
from everything it did. An agent's own title is kept, unless the session
went on to other work items or pull requests after it was named, when it
is named again as it ends.

With an [AI provider](/guides/ai/) chosen for Ask, the provider names the
session in a few words, on its fast model, from a short digest of the
record: its work items and pull requests, its prompts (as recorded, with
credentials taken out), its subagents' tasks, where it changed files, its
commits and what it reported. A session is asked about at most five times,
and one whose work is a single work item or pull request takes that title
without asking. Without a provider, or when it fails, the title is the
work item's, else the pull request's, else what the session's most telling
prompt asks for, without greetings and preambles ("This project used
to…", "I think", "So"). A subagent goes by its task and is not titled.

## Picking up a work item

Before working on a work item, load its whole context in one call:
`work_item` with `"action": "work"` over MCP, `g1t work view 12`, or
[`GET /workspaces/{workspace}/work/{number}/work`](/reference/api/work-items/get-work/):

```sh
curl https://api.g1t.sh/workspaces/acme/work/12/work \
  -H "Authorization: Bearer $G1T_TOKEN"
```

| Field | What it holds |
| --- | --- |
| `item` | The work item, with its body and its repositories: each with its role and whether it has landed. |
| `missing` | Its targets that have not landed yet. |
| `suggested` | Repositories of the workspace it may also need, each with `why`. |
| `definition_of_done` | The items under its **Definition of done** heading. |
| `required_checks` | The checks every pull request into the default branch must pass. |
| `claims` | Who says they are working on it now. |
| `sessions` | Sessions on it or its pull requests, or tied to it any other way, subagents included, active ones first. Each says how many `subagents` it started. |
| `pulls` | Its pull requests, in every repository it links. Those still open or draft carry their `required_checks` as they stand on the head, `mergeable`, the other pull requests they `overlap`, and their place in the merge `queue`. |
| `blocked_by` | Each work item it waits on, with that work item's claims and pull requests. |
| `blocks` | The work items waiting on it. |
| `decisions` | [Decision records](/guides/why-blame/#decision-records) on it and its pull requests, newest first. |
| `last_integration_failure` | The latest `integration_failure` decision among them, if any: the combination that failed in the merge queue, the check, the `suspects` and, when it failed on `main` alone, the pull requests that `landed` on `main` since it branched. |
| `recent` | Its latest 20 coordination events, newest first. |

Then claim it, and start (or attach) your session.

## Sessions

A session is one run of your harness on a repository. Start one when the
harness starts, keep it alive while it works, and end it when it stops.

1. **Start** it with `session` `start`, or
   [`POST /repos/{owner}/{name}/sessions`](/reference/api/sessions/start-session/),
   naming the `harness` (`claude_code`, `claude_managed_agents`, `codex`,
   `cursor`, `copilot` or `other`) and the harness's own id for the session as
   `harness_session_id`. Starting again with the same id returns the
   session already started, so a hook can call it every time without
   checking first. Give `item` (the work item's number in the
   repository's workspace), `pull` and `branch` when you know them, and a
   `title` only if you can name the whole job in a few words (up to 200
   characters): otherwise g1t names it (see [Session titles](#session-titles)).
2. **Heartbeat** with `session` `update`, or
   [`PATCH /repos/{owner}/{name}/sessions/{id}`](/reference/api/sessions/update-session/)
   with an empty body. The same call attaches the session to a work item
   or pull request, records the `head_commit` it pushed, or names it
   (`title`; a title a person pinned stays).
3. **Record** what happens with `session` `record`, or
   [`POST /repos/{owner}/{name}/sessions/{id}/entries`](/reference/api/sessions/record-session-entries/):
   prompts, reasoning, tool calls, notes and the skills it used (`skill`,
   the skill's name only), up to 200 a request, and in `touched` what it
   touched (see [What a session worked on](#what-a-session-worked-on)).
   Give each entry a `key`, and recording it again does nothing.
4. **End** it with `session` `end`, or
   [`POST /repos/{owner}/{name}/sessions/{id}/end`](/reference/api/sessions/end-session/),
   with its `result` when it has one: what it reported when it finished.

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/sessions \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"harness": "claude_code", "harness_session_id": "5b0c1f9e-3d2a-4e8b-9f61-0c7d2a9e4b13", "item": 12}'
```

A session's `state` is worked out from when it was last heard from. Every
update and every batch of entries counts as a heartbeat:

| State | Means |
| --- | --- |
| `active` | Heard from in the last 15 minutes. |
| `idle` | Not heard from for 15 minutes. It may still come back. |
| `ended` | Ended with `end_session`, or not heard from for 30 minutes (`end_reason` `timed_out`). A heartbeat brings a timed-out session back; an ended one stays ended. |

A session its harness left behind, killed or never told to end, can be
ended by hand: **End session** in its menu under Live now (on the
project's overview and on **Sessions**), or on its page. Whoever runs a
session can end it, and so can anyone with write access to the
repository; nobody else sees the action. It ends with `end_reason`
`ended by hand by @name`, its subagents still going end with it, and its
claims stay until they are released or expire. Ending by hand is a
soft close: like a session that timed out, it comes back the moment
its harness is heard from again (an update, a recorded entry or a
start), so a harness that was in fact still running picks up where it
was. Through the API,
`end_session` on someone else's session does the same, without their
`reason` or `result`. A session g1t runs on the workspace's Anthropic
account is stopped from its page instead.

Entries of a session attached to a pull request show in that pull
request's [session](/guides/why-blame/#sessions), beside what was recorded
on it with `record_session`, so reviewers and why-blame see them. Entries
recorded before the session named its pull request move onto it when it
does. A session never records tool output unless you send it as a
`tool_result` entry. What looks like a credential is taken out of
everything a session records, and only the workspace's members see inside
a session: see [Who sees what](#who-sees-what).

List a repository's sessions with `session` `list`, or
[`GET /repos/{owner}/{name}/sessions`](/reference/api/sessions/list-sessions/)
by `state`, `item` or `pull` (any session tied to it), or `path` (those
that touched a file, or any under a folder ending in `/`); subagents are
listed too with `subagents=true`. A session in the list with no `title`
carries `first_prompt`: the first 300 characters of the first prompt it
recorded. Read one with its entries, subagents, links, skills and what it
touched with `session` `get`. For the sessions of every repository of a
workspace, see [The Sessions page](#the-sessions-page).

## Work with no work item yet

Not every session starts from a work item, and most should not end with
one: a question, a look around or a quick fix needs no work item. The
session is the record of that work, and the team sees it in **Live now**,
on **Sessions** and on the project's overview, while it goes:

1. **It says what it is for.** Give it a `title` when you start it, or
   later with `session` `update`. The
   [Claude Code plugin](/guides/claude-code-plugin/#work-with-no-work-item-yet)
   titles each session from its first prompt that says what it is for,
   from the words you typed: pasted text and image placeholders are left
   out, and a slash command or a prompt that is only a paste leaves the
   title to the next prompt. It never replaces a title the session
   already has.
2. **It shows where it works.** Attach its `branch` and, once there is
   one, its `pull`: the project's **Live now** groups sessions on no work
   item by pull request, then by branch.
3. **It opens or claims a work item when it becomes a change** others
   should know about: a branch to push, a pull request. Look for one first
   (`work_item` `list`, `work_item` `list_claims`); if one covers the work,
   claim it. Otherwise open one and claim it in one step with `work_item`
   `claim` and a `title` instead of a `number` (see [Claims](#claims)),
   which attaches the session to it.

## Subagents

A harness that hands part of its work to a subagent (Claude Code's
subagents, a Managed Agents session's threads) records each as a session
of its own under the one that started it:

- Start it with `parent_id` (the session that started it), `agent_type`
  (its kind, such as `Explore`), the `task` it was given in a few words and
  the `prompt` (kept up to 4,000 characters). As its `harness_session_id`,
  give the parent's, `/agent/` and the subagent's id: starting it again
  returns it, in whatever order the harness's hooks arrive.
- It starts on its parent's work item, pull request and branch unless it says
  otherwise, so it is listed on them, and its heartbeats keep its parent
  active.
- End it with its `result`: its final message, kept up to 8,000
  characters. That is its parent's evidence; what its tools returned is
  never recorded. Once ended it stays ended, even when a late hook starts
  it again: that only fills in what it says.
- Ending a session ends the subagents it left going (`end_reason`
  `parent ended`).

Subagents see each other. Sibling subagents on one work item are listed in
`get_work` and `session` `list` beside the session that started them,
each holds a claim of its own (claims are told apart by session, so a
sibling's claim is listed in `others`), and when two of them touch the
same file, each is told with `overlap.detected`. The
[Claude Code plugin](/guides/claude-code-plugin/#subagents) does all of
this for Claude Code's subagents.

## What a session worked on

A session says what it touched in `touched`, each kept once:

| `kind` | `value` |
| --- | --- |
| `file` | A file it wrote, from the repository's root. |
| `commit` | A commit it made. |
| `branch` | A branch it made or pushed. |
| `pull` | A pull request it opened, by number. |
| `item` | A work item it named or claimed, by its number in the workspace. |

From these and the rest of what it records, g1t ties the session to the
work items and pull requests it worked on, each in as many ways as it was
(`via` in the session's `links`):

| `via` | When |
| --- | --- |
| `attached` | It said it is on it, starting or updating. |
| `claim` | It claimed the work item. |
| `opened` | It opened the pull request. |
| `branch` | It pushed the pull request's branch, also when the pull request is opened later. |
| `commit` | It made the pull request's head commit. |
| `trailer` | A commit pushed to the pull request's branch names it in a `G1t-Session: ses_…` trailer. |
| `ref` | Its prompt, its task, its result or a subagent's names it as `#12`. |

A session's links cover its subagents too, and the work item and pull
request pages list every session tied to them with its subagents. Put the
trailer on the commits a session makes (`git commit --trailer "G1t-Session:
$G1T_SESSION"`) and they lead back to it. A work item a session closes, or
a repository it lands on one, says so on its timeline, **via session** and
a link to it: closed with the session's token while it works on the work
item, or by a commit naming it in that trailer (see
[Closing work items](/guides/pull-requests/#closing-work-items)).

When a file a session touched was touched by another active session as
well (outside its own parents and subagents), g1t sends `overlap.detected`
to both, naming each other and the files: once per pair, and again when
they touch another file in common, naming the new files.

## Start a session on your Anthropic account

g1t runs no model. Work on a work item happens in your own harness, with
your own Claude, its skills and settings; g1t ties it back to the work
item. To hand a work item to a session from g1t itself (the work item
page's **Start a session**, `g1t work dispatch`, the `session` tool's
`dispatch`, or
[`POST /repos/{owner}/{name}/agent-sessions`](/reference/api/sessions/start-agent-session/),
in the repository the session works in):

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/agent-sessions \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"item": 12, "mode": "implement", "instruction": "Keep the old greeting behind a flag."}'
```

Give `item`, or `title` and `body` to open a new work item first (with
the repository as its origin), a `mode`
(`plan`, `implement` or `review`) and an optional `instruction`.

- **With an Anthropic AI provider** in the workspace (an owner adds one
  under [**AI**](/guides/ai/)), g1t starts a
  [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)
  session on that account, with its key, on the model Ask is set to use
  (or `claude-opus-5-5`). It runs in a sandbox on Anthropic's side. Its
  first step installs the [g1t CLI](/guides/cli/) from g1t, sets git up to
  send the token and to commit as you (your username and noreply address),
  clones the repository and ties the clone to the session,
  so it works the way the work-on-item skill describes: `g1t work
  view`, `g1t work claim`, `g1t pr create --item`, `g1t pr checks --watch`.
  It works on a branch and a pull request, except in a repository with no
  commits yet, where there is nothing to open one against: it pushes the
  first version straight to the default branch. To show a screenshot of its
  preview in the pull request or a comment, it uploads the image with
  [`g1t attach`](/guides/cli/#images-in-descriptions-and-comments) (or
  `--attach` on `g1t pr create`, `g1t pr ready` and `g1t pr comment`) and
  pastes the Markdown it prints, rather than committing the image.
  g1t's MCP server is attached too, for anything the CLI has no command
  for. Its sandbox reaches the internet as a CI runner does, and it can
  search and read the web (web search and web fetch), for a fact the work
  needs from outside g1t or to open its own deploy. Before a headless
  browser (Playwright, Puppeteer) opens an https page, it copies the
  certificates the sandbox trusts into Chromium's own store, so pages load
  with certificate checks on. Both reach g1t with one token: g1t
  acting on your behalf, in that repository only, which lasts the session
  and is revoked when it ends. What the session does on g1t shows as
  **g1t, on behalf of @you**: its comments and reviews, what it closes or
  labels, and the work items and pull requests it opens (g1t's, requested
  by you); the audit log says "g1t on behalf of you". What it may do is
  your role in that repository, never more than Write, with what working on
  a work item needs (`repo:read`, `code:write`, `work:write`,
  `pull_requests:write`, and reading checks, workflows, deployments and
  observability): never settings, members, secrets, webhooks or merging.
  The session itself, its claims and its commits stay yours, and its
  pushes are yours too: to the repository and to its pull requests'
  working copies, under the repository's rules. An approval it gives is
  g1t's, so it counts toward required approvals only where agents'
  approvals do. The token is kept in a vault on the Anthropic account: the MCP
  server's credential, and `G1T_TOKEN`, which the sandbox holds only as a
  placeholder that is swapped for the token on its way to g1t. It is never
  in the prompt, and the model never sees it. The session has g1t's skills
  (work-on-item, coordinate and fix-integration, uploaded to the account
  the first time, and as a new version whenever g1t changes them; the
  agent uses the version g1t uploaded) next to the account's own custom
  skills, at their latest version, up to 20 in all. It may hand parts of the work to copies of itself; each is recorded
  as a subagent.
- **Without one**, or with `handoff: true`, nothing starts: you get
  `command`, a Claude Code command line to run in your working copy with
  the [plugin](/guides/claude-code-plugin/), and `prompt`, what to paste.
  The session that starts attaches to the work item.

The answer has the `session` on g1t, its `session_url`, and
`provider_session_url`, where the Anthropic Console shows it. The Console
keeps sessions in the workspace the key belongs to, and a session does not
say which that is: if the key is not in the account's Default workspace,
set the provider's **Console workspace** under [**AI**](/guides/ai/#anthropic-console-workspace)
so the link opens there.
The session is recorded as harness `claude_managed_agents`: its messages,
the tools it called and with what (never what they returned), the skills
it read, what it touched, and each thread as a subagent with its task and
report. g1t follows it every minute, and at once while its page is open. A
call that waits for someone's approval is declined, since nobody is
watching. When it finishes, its session ends with its last message as its
result. Whoever started it can stop it from its page, and open it on the
Claude Console from there (**Open in Claude Console**); nobody else is
given that link, since the Console shows everything the session was asked
and every tool's output. It runs on your
workspace's key and Anthropic bills the account for it; g1t bills nothing.

## Assign g1t, or ask it in the thread

You can also hand work to g1t from the work item or pull request itself,
the way you would ask a teammate:

- **Assign the work item to `g1t`**: **Assign to g1t** in the work
  item's sidebar, `g1t` among the assignees in
  [`update_work_item`](/reference/api/work-items/update-work-item/), or
  `g1t work edit 12 --add-assignee g1t`.
- **Mention `@g1t` in a comment** on a work item or a pull request:
  "@g1t the button still overlaps on a phone, fix that". On a pull
  request, the session carries on with that pull request on its branch.
  On a work item, it takes the work item on.

g1t reacts 👀 to what asked it, the comment or (for an assignment) the
work item, then starts a session on the workspace's Anthropic account, as
the person who asked, with what they wrote as its instruction. Each
session shows in the work item's or pull request's conversation as a card,
where it started, the way a comment or a review does: who it works for,
where it stands, its branch, and its report when it ends, linked to its
page. Not happy with what a session did? Say so with `@g1t` in the same
thread. The next session is told to fix the work on the same branch and
pull request, not start over, and `g1t work view` shows it every
session and pull request so far. If the session you started on that
thread is still going, your comment goes to it instead of starting
another.

Only the workspace's members can ask g1t; anyone else's `@g1t` is an
ordinary mention. A mention in quoted text or code (`` `@g1t` ``) asks
nothing. g1t answers one thread at most six times an hour. When it cannot
start a session, for instance because the workspace has no Anthropic AI
provider, it says why in the thread. On an update pull request g1t opened,
`@g1t rebase` and the other
[comment commands](/guides/dependency-updates/#comment-commands) still do what
they say.

## Claims

A claim says you are working on a work item. It is advisory: anyone may
claim a work item someone else has, and is told about them, so two agents
can decide between themselves rather than collide. Nothing is refused
because of a claim. A claim is the workspace's, whichever repository the
session that holds it is checked out in, so sessions in different
repositories see each other's claims on the same work item.

- **Claim** an open work item with `work_item` `claim` (with
  `session_id`, so that two of your sessions, such as sibling subagents,
  hold claims of their own and each is told of the other's),
  `g1t work claim 12`, or
  [`POST /workspaces/{workspace}/work/{number}/claim`](/reference/api/work-items/claim-work-item/).
  The answer has your `claim`, the `others` already on the work item, and
  `blocked_by`: each work item this one waits on, with its claims and pull
  requests.
- **Open a work item and claim it** in one step, for work that has no
  work item yet: `work_item` `claim` with `title` (and `body`) and no
  `number`, `g1t work claim --title "…"`, or
  [`POST /workspaces/{workspace}/claims`](/reference/api/work-items/claim-new-work-item/).
  The work item is opened (a `work_item.opened` event), with the
  session's repository as its origin when you give `repo`, then claimed,
  and the session named by `session_id` is attached to it. The answer
  also has `item`, the work item opened. The session is checked first: a
  claim that would be refused for it opens nothing.
- **Renew** it by claiming again, or give the `session_id` of your session
  when you claim, and that session's heartbeats renew it.
- **Release** it with `work_item` `release`, `g1t work release 12`, or
  [`POST /workspaces/{workspace}/work/{number}/release`](/reference/api/work-items/release-claim/),
  with an optional `reason`.
- **Hand it off** with `work_item` `handoff`, `g1t work handoff 12`, or
  [`POST /workspaces/{workspace}/work/{number}/handoff`](/reference/api/work-items/hand-off-work-item/),
  with a `note` on where the work stands, for `to` (a username) or anyone.
  When whoever it was for claims the work item, their `work.claimed` event
  names the hand-off in `took_over`.

```sh
curl -X POST https://api.g1t.sh/workspaces/acme/work/12/claim \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "ses_01m4b2c3d4e5f6g7h8j9k0m1n2", "note": "Taking the argument parsing first."}'

curl -X POST https://api.g1t.sh/workspaces/acme/claims \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "ses_01m4b2c3d4e5f6g7h8j9k0m1n2", "repo": "acme/web", "title": "Preview builds time out on large repositories"}'
```

| | |
| --- | --- |
| How long a claim lasts | `ttl_minutes`: 30 unless you say, at most 240. |
| Opening its work item | `title` (and `body`) instead of `number`. Giving both is refused with `422`. |
| When it ends | Released, handed off, its work item closed, or not renewed in time (`expired`). |
| States | `active`, `released`, `expired`, `handed_off`. |

See who is on what with `work_item` `list_claims`, `g1t work status`, or
[`GET /repos/{owner}/{name}/claims`](/reference/api/work-items/list-claims/):
active claims unless `state` says otherwise, and `item` for one work
item's.

## Dependencies

A work item's `blocked_by` lists the work items of the same workspace that
have to land before it. Set it with `work_item` `update`, or
[`PATCH /workspaces/{workspace}/work/{number}`](/reference/api/work-items/update-work-item/),
which replaces the whole list:

```sh
curl -X PATCH https://api.g1t.sh/workspaces/acme/work/12 \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"blocked_by": [9, 10]}'
```

A list is refused with `422` when a number is not a work item of the
workspace, names the work item itself, or would make a cycle (the answer
shows the cycle, such as `#12 → #9 → #12`). Up to 50 work items. Changing
it notes the change in the work item's conversation and needs what
editing the work item does: being its author, or the Triage role.

g1t says when a dependency moves, as a `dependency.changed` event on the
blocked work item: when its list changes, and when one of its blockers
closes or has a pull request merged into the default branch. `remaining`
lists the blockers still open; when it is empty, the work item is
unblocked.

## Overlaps

Opening a pull request, and each push to it, works out which files it
changes. When it starts changing files another open or draft pull request
changes, g1t sends `overlap.detected` once for each of the two, naming the
other and the files. A pair is announced once, and again only after it stopped
overlapping. `get_work` and `pull_request` `get` show current overlaps
whenever you look.

Sessions overlap too, before there is a pull request: when a session says
it touched a file that another active session touched (see
[What a session worked on](#what-a-session-worked-on)), each gets
`overlap.detected` with `session_id`, `other_session_id`, `other_actor`
and `files`, once per pair, and again with the new `files` when another
file in common joins.

## Events

Coordination is published as events, which [webhooks](/guides/webhooks/)
deliver and the repository's timeline lists. Each carries `number` (the
work item or pull request it is about) and `item` (the work item's number
in the workspace) where there is one.

| Event | When |
| --- | --- |
| `session.started` | A session (or a subagent) starts, or one that ended starts again. Not on a repeated start. |
| `session.ended` | A session ends, or times out after 30 minutes without a heartbeat. |
| `session.progressed` | A session recorded more: at most every 5 seconds for each, with `session_id` (and `root_id` for a subagent), never what it recorded. Pages showing the session follow it with this. |
| `work.claimed` | Someone claims a work item. `others` lists the claims already on it; `took_over` names a hand-off it takes. |
| `work.released` | A claim is released, or its work item closed (`reason` `item_closed`). |
| `work.claim_expired` | A claim was not renewed in time. |
| `work.handoff_requested` | Someone hands a work item off: `from`, `to` (absent for anyone) and `note`. |
| `dependency.changed` | A work item's `blocked_by` changed (`added`, `removed`), or a blocker closed or had its pull request merged (`cleared`). `remaining` lists the blockers still open. |
| `overlap.detected` | A pull request started changing files another open one changes: `pull`, `other_pull`, `files`, `item` and `other_item`. Or a session touched files another active session touched: `session_id`, `other_session_id`, `other_actor`, `files`. |

A session or claim that went quiet is announced as ended or expired when
the repository's sessions or claims are next read or changed, not at the
minute it lapsed.

## Who sees what

A session records someone's own work as it happens, so g1t shows it by who
is looking, on the site, the API, MCP and the CLI alike.

| Who | Sees |
| --- | --- |
| Whoever ran it | All of it: its prompts, tool calls, what it touched and reported, its pending updates. |
| A member of the repository's workspace | What it did: its title, tool calls, messages, notes, skills, what it touched, its subagents' tasks, prompts and reports, its pending updates. Not the prompts someone else typed, nor a tool's output (`tool_result`): those entries show as kept back. A title shows without swearing. |
| Anyone else who may read the repository | That it runs: who runs it, in which harness, since when, its state and the work items and pull requests it is tied to. Nothing it recorded, touched, was asked or reported, nor its title, branch or model. On a pull request's session, only g1t's own notes. |

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

## Who may do what

| To | You need |
| --- | --- |
| Read sessions and claims | To be able to read the repository. Public repositories need no token. What a session shows depends on who you are: see [Who sees what](#who-sees-what). |
| Read a workspace's **Sessions** | It lists the sessions of the workspace's repositories you can read; g1t's own agent's sessions only for members. |
| Read a work item's context | To be able to see the work item: see [Who sees a work item](/guides/work-items/#who-sees-a-work-item). |
| Start a session, claim a work item, open one by claiming it | A confirmed email address and a role that may open work items; the repository must not be archived. |
| Update, record in or end a session | To be the person whose token started it. |
| Release a claim or hand it off | To be the person who made it. |
| Set `blocked_by` | To be the work item's author, or the Triage role. |
| Start a session on the workspace's Anthropic account | To be a member of the workspace and able to open work items in the repository. The hand-off needs only to see the work item. |

With an access token, sessions (and `start_agent_session`) need
`pull_requests:read` or `pull_requests:write`, and claims and `get_work`
need `work:read` or `work:write`, as
[scopes](/guides/authentication/#scopes) say.

## Pending coordination updates

These commands work with Codex, Claude, or another harness using the same
session API. There is no provider-specific acknowledgement protocol:

```sh
g1t session updates --json
g1t session acknowledge upd_ID --note "My scope is separate; no plan change"
```

They use `G1T_SESSION` (or the working copy's remembered session).
`session updates`, `session acknowledge` and `session heartbeat` first say
which files the working copy has changed (from `git status`), as
`session touch --file` would, so overlapping edits are noticed whichever
harness makes them; `G1T_TOUCH=0` turns that off. To avoid
shared-checkout ambiguity, `updates SESSION_ID` and `acknowledge --session
SESSION_ID` select a session explicitly. The acknowledgement command records
a decision note before clearing updates, with an idempotency key for retries.
The raw API below also works with older CLI installations.

`g1t api get_session -f id=SESSION_ID` returns up to 100 pending `updates`,
oldest first, separately from transcript entries (give `after=4294967295` to
leave the entries out). Updates are claims, releases, hand-offs and expiries,
overlaps, dependency changes, decisions, integration results, and sessions
starting and ending.

An active session receives the updates that concern it:

| The session is | It receives |
| --- | --- |
| Attached to a work item or pull request, or tied to one (a claim, its branch, a `#N` it named) | Updates about that work item or pull request: its claims, decisions, overlaps, dependency changes and integration results, and those that name it, such as an integration failure listing it as a suspect or a work item newly blocked by it |
| Not on anything yet | Every update, so it can find who else is working and on what |
| Either | Updates about nothing in particular, such as a session starting without a work item; and an overlap between its own files and another session's, which goes only to the two sessions |

A session does not receive its own start or end, or the claims it made,
released or handed off. It does hear when its claim expires. New sessions
should still load the work item's context: an inbox is not a replay of what happened
before the session started.

Reading does not clear an update. After considering it and recording any
change of plan, the session owner acknowledges exact IDs:

```sh
g1t api record_session_entries -f id=SESSION_ID -f 'acknowledge[]=UPDATE_ID'
```

Repeat the field for multiple IDs, at most 100 per request, then read again
for the next page. Acknowledgement is idempotent and scoped to that session.
It means considered, not resolved. The response's `acknowledged` says how
many of the IDs name updates of that session, so a mistyped ID or one from
another session shows up as a shortfall (the CLI warns). The session page
shows pending updates.

Claude Code hooks retrieve updates in the background, at most once per ten
seconds when a successful cached response exists, and at once after an
acknowledgement. Every prompt shows what is pending; before a tool, pending
updates are shown when they change and again every two minutes. Delivery
repeats until acknowledged. Other
harnesses, including managed sessions, should poll between work steps using
the coordination skill. Neither a disconnected harness nor an idle session
is interrupted in real time.

An update is written in the same transaction as the change it announces: a
claim, release, hand-off, expiry, session start or end, overlap, decision or
change to what a work item is blocked by is never kept without its
updates, and updates never announce a change that was not made. Each
update's ID is derived from its change, so a retried request, or two
requests making the same change at once, delivers it once. The one
exception is the notice that a work item's blocker closed or merged, which
follows the close or merge: it is written right after, once per close or
merge. Updates are still a summary: re-read current work item and pull
request state before consequential actions.

Acknowledged updates are kept as receipts for 30 days. Pending updates stay
until acknowledged, including those of a session that ended, so whoever
takes over its work can see what it never considered.
