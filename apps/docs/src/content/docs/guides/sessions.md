---
title: Sessions, claims and dependencies
description: How agents and people on one repository see who is working on what, with sessions of their own harnesses, advisory claims on issues, what an issue is blocked by, and the one call that loads an issue's whole context.
---

When several agents and people work on one repository at once, each needs
to know what the others are doing. g1t keeps that around the issue, which
is the unit of work: its description says what is wanted and what done
means, its pull requests are the proposals, and around it g1t records:

- **Sessions**: one run of your own harness (a Claude Code session, a
  Codex run) on the repository, attached to the issue and pull request it
  works on.
- **Claims**: an advisory, expiring "I'm working on #12". Never a lock.
- **Dependencies**: the issues that have to land before this one.

Until there is an issue, the session is the unit: work that starts from a
question or a quick request is recorded as a session titled with what it
is for, and shows to the team on its branch or pull request. It opens or
claims an issue only when it becomes a change others should know about;
see [Work with no issue yet](#work-with-no-issue-yet).

Nothing here waits on a harness. A harness that crashes, loses its
network or sends the same thing twice does no harm: sessions and claims
that go quiet are read as idle, ended or expired the next time anyone
looks, and starting a session or recording an entry again is a no-op.
What git and g1t record (commits, pull requests, checks, merges) is the
truth; sessions are the account of how it got there.

## On the site

Everything here shows on g1t.sh as it happens, without reloading.

- **The Work page**, `g1t.sh/<workspace>/<repo>/work`, a tab beside
  **Pull requests**, **Merge queue** and **Sessions**:
  - **Live now**: the active claims and the active and idle sessions,
    grouped by the issue they are on, the most recently active first. An
    issue with more than one claim is marked. Sessions on no issue yet
    follow, grouped by their pull request, else by their branch (when it
    is not the default branch), the most recently heard from first; those
    on neither are last, under **No branch yet**. Each session shows its
    title, who it acts for, its harness, its state, when it was last heard
    from and its branch. A session with no title is named by what its
    first prompt was for, else **Session on** its branch, else **Untitled
    session**. A title that is only a tag, such as
    `<pasted_content id="5c50">`, counts as no title.
  - **Merge queue**: what is waiting to land and what is being tested,
    as on the [Merge queue](/guides/merge-queue/#the-merge-queue-page) page.
  - **What happened**: the latest 30 coordination events, from claims to
    what the merge queue found when it combined changes.
  - **Just landed**: the latest merges, each with a link to the session
    behind it.

  With nothing going on, it says how to start: install the
  [Claude Code plugin](/guides/claude-code-plugin/), or run
  `g1t work claim <number>` from any harness.
- **An issue's Work panel**, at the top of its sidebar: its claims (who,
  from which harness, since when and when each lapses; ones released,
  expired or handed off lately are shown dimmed), the sessions on it with
  their state and when each was last heard from, what it is blocked by
  and where each of those stands, and the issues it blocks. Its author
  and anyone with the Triage role change what it is blocked by with
  **Edit**. Under its pull requests, the issue shows the latest
  combination that failed in the merge queue, and its
  [decision records](/guides/why-blame/#decision-records), each marked
  **Claimed**, **Tested** or **Approved**.
- **A session's page**, `g1t.sh/<workspace>/<repo>/work/sessions/<id>`,
  opened from any of these: who ran it, in which harness and on which
  model, how long it has run, the issues and pull requests it and its
  subagents worked on (each says how it was tied), its subagents as a tree
  you open one at a time (each with its kind, the task it was given, what
  it touched and what it reported), the skills used, what was touched
  (files, commits, branches, pull requests), and everything it recorded,
  as it records it: its prompt folded, its messages formatted as they were
  written, and the tool calls between them a line each (a command as code,
  a file by its path, a g1t tool by what it did, such as *issue · claim*),
  more than three in a row folded into one line that opens to them; a
  long command and what a tool gave back open under its line. A
  subagent's own page links back to the session that started it.
- **An issue's and a pull request's sessions**: every session tied to it
  in any way, with its subagents under it.
- **Start a session** on an issue, for members of a workspace with an
  Anthropic AI provider: see
  [Start a session on your Anthropic account](#start-a-session-on-your-anthropic-account).

## Picking up an issue

Before working on an issue, load its whole context in one call: `issue`
with `"action": "work"` over MCP, or
[`GET /repos/{owner}/{name}/issues/{number}/work`](/reference/api/claims-and-work/get-work/):

```sh
curl https://api.g1t.sh/repos/acme/web/issues/12/work \
  -H "Authorization: Bearer $G1T_TOKEN"
```

| Field | What it holds |
| --- | --- |
| `issue` | The issue, with its body. |
| `definition_of_done` | The items under its **Definition of done** heading. |
| `required_checks` | The checks every pull request into the default branch must pass. |
| `claims` | Who says they are working on it now. |
| `sessions` | Sessions on it or its pull requests, or tied to it any other way, subagents included, active ones first. Each says how many `subagents` it started. |
| `pulls` | Its pull requests. Those still open or draft carry their `required_checks` as they stand on the head, `mergeable`, the other pull requests they `overlap`, and their place in the merge `queue`. |
| `blocked_by` | Each issue it waits on, with that issue's claims and pull requests. |
| `blocks` | The issues waiting on it. |
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
   checking first. Give `issue`, `pull` and `branch` when you know them,
   and a `title`: what the session is for, in a few words (up to 200
   characters).
2. **Heartbeat** with `session` `update`, or
   [`PATCH /repos/{owner}/{name}/sessions/{id}`](/reference/api/sessions/update-session/)
   with an empty body. The same call attaches the session to an issue or
   pull request, records the `head_commit` it pushed, or changes its
   `title`.
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
  -d '{"harness": "claude_code", "harness_session_id": "5b0c1f9e-3d2a-4e8b-9f61-0c7d2a9e4b13", "issue": 12}'
```

A session's `state` is worked out from when it was last heard from. Every
update and every batch of entries counts as a heartbeat:

| State | Means |
| --- | --- |
| `active` | Heard from in the last 15 minutes. |
| `idle` | Not heard from for 15 minutes. It may still come back. |
| `ended` | Ended with `end_session`, or not heard from for 2 hours (`end_reason` `timed_out`). A heartbeat brings a timed-out session back; an ended one stays ended. |

Entries of a session attached to a pull request show in that pull
request's [session](/guides/why-blame/#sessions), beside what was recorded
on it with `record_session`, so reviewers and why-blame see them. Entries
recorded before the session named its pull request move onto it when it
does. A session never records tool output unless you send it as a
`tool_result` entry; a session is as visible as the repository, so keep
secrets out of it.

List a repository's sessions with `session` `list`, or
[`GET /repos/{owner}/{name}/sessions`](/reference/api/sessions/list-sessions/)
by `state`, `issue` or `pull` (any session tied to it), or `path` (those
that touched a file, or any under a folder ending in `/`); subagents are
listed too with `subagents=true`. A session in the list with no `title`
carries `first_prompt`: the first 300 characters of the first prompt it
recorded. Read one with its entries, subagents, links, skills and what it
touched with `session` `get`.

## Work with no issue yet

Not every session starts from an issue, and most should not end with one:
a question, a look around or a quick fix needs no issue. The session is
the record of that work, and the team sees it in **Live now** while it
goes:

1. **It says what it is for.** Give it a `title` when you start it, or
   later with `session` `update`. The
   [Claude Code plugin](/guides/claude-code-plugin/#work-with-no-issue-yet)
   titles each session from its first prompt that says what it is for,
   from the words you typed: pasted text and image placeholders are left
   out, and a slash command or a prompt that is only a paste leaves the
   title to the next prompt. It never replaces a title the session
   already has.
2. **It shows where it works.** Attach its `branch` and, once there is
   one, its `pull`: **Live now** groups sessions on no issue by pull
   request, then by branch.
3. **It opens or claims an issue when it becomes a change** others should
   know about: a branch to push, a pull request. Look for one first
   (`issue` `list`, `issue` `list_claims`); if one covers the work,
   claim it. Otherwise open one and claim it in one step with `issue`
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
- It starts on its parent's issue, pull request and branch unless it says
  otherwise, so it is listed on them, and its heartbeats keep its parent
  active.
- End it with its `result`: its final message, kept up to 8,000
  characters. That is its parent's evidence; what its tools returned is
  never recorded. Once ended it stays ended, even when a late hook starts
  it again: that only fills in what it says.
- Ending a session ends the subagents it left going (`end_reason`
  `parent ended`).

Subagents see each other. Sibling subagents on one issue are listed in
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
| `issue` | An issue it named or claimed, by number. |

From these and the rest of what it records, g1t ties the session to the
issues and pull requests it worked on, each in as many ways as it was
(`via` in the session's `links`):

| `via` | When |
| --- | --- |
| `attached` | It said it is on it, starting or updating. |
| `claim` | It claimed the issue. |
| `opened` | It opened the pull request. |
| `branch` | It pushed the pull request's branch, also when the pull request is opened later. |
| `commit` | It made the pull request's head commit. |
| `trailer` | A commit pushed to the pull request's branch names it in a `G1t-Session: ses_…` trailer. |
| `ref` | Its prompt, its task, its result or a subagent's names it as `#12`. |

A session's links cover its subagents too, and the issue and pull request
pages list every session tied to them with its subagents. Put the trailer
on the commits a session makes (`git commit --trailer "G1t-Session:
$G1T_SESSION"`) and they lead back to it.

When a file a session touched was touched by another active session as
well (outside its own parents and subagents), g1t sends `overlap.detected`
to both, naming each other and the files: once per pair, and again when
they touch another file in common, naming the new files.

## Start a session on your Anthropic account

g1t runs no model. Work on an issue happens in your own harness, with your
own Claude, its skills and settings; g1t ties it back to the issue. To
hand an issue to a session from g1t itself (the issue page's **Start a
session**, `g1t work dispatch`, the `session` tool's `dispatch`, or
[`POST /repos/{owner}/{name}/agent-sessions`](/reference/api/sessions/start-agent-session/)):

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/agent-sessions \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"issue": 12, "mode": "implement", "instruction": "Keep the old greeting behind a flag."}'
```

Give `issue`, or `title` and `body` to open a new issue first, a `mode`
(`plan`, `implement` or `review`) and an optional `instruction`.

- **With an Anthropic AI provider** in the workspace (an owner adds one
  under [**AI**](/guides/ai/)), g1t starts a
  [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)
  session on that account, with its key, on the model Ask is set to use
  (or `claude-opus-5-5`). It runs in a sandbox on Anthropic's side. Its
  first step installs the [g1t CLI](/guides/cli/) from g1t, sets git up to
  send the token and to commit as you (your username and noreply address),
  clones the repository and ties the clone to the session,
  so it works the way the work-on-issue skill describes: `g1t work
  context`, `g1t work claim`, `g1t pr create`, `g1t pr checks --watch`.
  It works on a branch and a pull request, except in a repository with no
  commits yet, where there is nothing to open one against: it pushes the
  first version straight to the default branch.
  g1t's MCP server is attached too, for anything the CLI has no command
  for. It can search and read the web (web search and web fetch), for a
  fact the work needs from outside g1t. Both reach g1t with a token made for you
  and that repository only, which lasts the session and is revoked when it
  ends. The token is kept in a vault on the Anthropic account: the MCP
  server's credential, and `G1T_TOKEN`, which the sandbox holds only as a
  placeholder that is swapped for the token on its way to g1t. It is never
  in the prompt, and the model never sees it. The session has g1t's skills
  (work-on-issue, coordinate and fix-integration, uploaded to the account
  the first time, and as a new version whenever g1t changes them; the
  agent uses the version g1t uploaded) next to the account's own custom
  skills, at their latest version, up to 20 in all. It may hand parts of the work to copies of itself; each is recorded
  as a subagent.
- **Without one**, or with `handoff: true`, nothing starts: you get
  `command`, a Claude Code command line to run in your working copy with
  the [plugin](/guides/claude-code-plugin/), and `prompt`, what to paste.
  The session that starts attaches to the issue.

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
result. Whoever started it can stop it from its page. It runs on your
workspace's key and Anthropic bills the account for it; g1t bills nothing.

## Assign g1t, or ask it in the thread

You can also hand work to g1t from the issue or pull request itself, the
way you would ask a teammate:

- **Assign the issue to `g1t`**: **Assign to g1t** in the issue's
  sidebar, `g1t` among the assignees in
  [`update_issue`](/reference/api/issues/update-issue/), or
  `g1t issue edit 12 --add-assignee g1t`.
- **Mention `@g1t` in a comment** on an issue or a pull request:
  "@g1t the button still overlaps on a phone, fix that". On a pull
  request, the session carries on with that pull request on its branch.
  On an issue, it takes the issue on.

g1t reacts 👀 to what asked it, the comment or (for an assignment) the
issue, then starts a session on the workspace's Anthropic account, as
the person who asked, with what they wrote as its instruction. Each
session shows in the issue's or pull request's conversation as a card,
where it started, the way a comment or a review does: who it works for,
where it stands, its branch, and its report when it ends, linked to its
page. Not happy with what a session did? Say so with `@g1t` in the same
thread. The next session is told to fix the work on the same branch and
pull request, not start over, and `g1t work context` shows it every
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

A claim says you are working on an issue. It is advisory: anyone may claim
an issue someone else has, and is told about them, so two agents can
decide between themselves rather than collide. Nothing is refused because
of a claim.

- **Claim** an open issue with `issue` `claim` (with `session_id`, so
  that two of your sessions, such as sibling subagents, hold claims of
  their own and each is told of the other's), or
  [`POST /repos/{owner}/{name}/issues/{number}/claim`](/reference/api/claims-and-work/claim-issue/).
  The answer has your `claim`, the `others` already on the issue, and
  `blocked_by`: each issue this one waits on, with its claims and pull
  requests.
- **Open an issue and claim it** in one step, for work that has no issue
  yet: `issue` `claim` with `title` (and `body`) and no `number`, or
  [`POST /repos/{owner}/{name}/claims`](/reference/api/claims-and-work/claim-new-issue/).
  The issue is opened (an `issue.opened` event), then claimed, and the
  session named by `session_id` is attached to it. The answer also has
  `issue`, the issue opened. The session is checked first: a claim that
  would be refused for it opens nothing.
- **Renew** it by claiming again, or give the `session_id` of your session
  when you claim, and that session's heartbeats renew it.
- **Release** it with `issue` `release`, or
  [`POST /repos/{owner}/{name}/issues/{number}/release`](/reference/api/claims-and-work/release-claim/),
  with an optional `reason`.
- **Hand it off** with `issue` `handoff`, or
  [`POST /repos/{owner}/{name}/issues/{number}/handoff`](/reference/api/claims-and-work/hand-off-issue/),
  with a `note` on where the work stands, for `to` (a username) or anyone.
  When whoever it was for claims the issue, their `work.claimed` event
  names the hand-off in `took_over`.

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/issues/12/claim \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "ses_01m4b2c3d4e5f6g7h8j9k0m1n2", "note": "Taking the argument parsing first."}'

curl -X POST https://api.g1t.sh/repos/acme/web/claims \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "ses_01m4b2c3d4e5f6g7h8j9k0m1n2", "title": "Preview builds time out on large repositories"}'
```

| | |
| --- | --- |
| How long a claim lasts | `ttl_minutes`: 30 unless you say, at most 240. |
| Opening its issue | `title` (and `body`) instead of `number`. Giving both is refused with `422`. |
| When it ends | Released, handed off, its issue closed, or not renewed in time (`expired`). |
| States | `active`, `released`, `expired`, `handed_off`. |

See who is on what with `issue` `list_claims`, or
[`GET /repos/{owner}/{name}/claims`](/reference/api/claims-and-work/list-claims/):
active claims unless `state` says otherwise, and `issue` for one issue's.

## Dependencies

An issue's `blocked_by` lists the issues of the same repository that have
to land before it. Set it with `issue` `update`, or
[`PATCH /repos/{owner}/{name}/issues/{number}`](/reference/api/issues/update-issue/),
which replaces the whole list:

```sh
curl -X PATCH https://api.g1t.sh/repos/acme/web/issues/12 \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"blocked_by": [9, 10]}'
```

A list is refused with `422` when a number is not an issue of the
repository, names the issue itself, or would make a cycle (the answer
shows the cycle, such as `#12 → #9 → #12`). Up to 50 issues. Changing it
notes the change in the issue's conversation and needs what editing the
issue does: being its author, or the Triage role.

g1t says when a dependency moves, as a `dependency.changed` event on the
blocked issue: when its list changes, and when one of its blockers closes
or has a pull request merged into the default branch. `remaining` lists
the blockers still open; when it is empty, the issue is unblocked.

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
issue or pull request it is about) and `issue` where there is one.

| Event | When |
| --- | --- |
| `session.started` | A session (or a subagent) starts, or one that ended starts again. Not on a repeated start. |
| `session.ended` | A session ends, or times out after 2 hours without a heartbeat. |
| `session.progressed` | A session recorded more: at most every 5 seconds for each, with `session_id` (and `root_id` for a subagent), never what it recorded. Pages showing the session follow it with this. |
| `work.claimed` | Someone claims an issue. `others` lists the claims already on it; `took_over` names a hand-off it takes. |
| `work.released` | A claim is released, or its issue closed (`reason` `issue_closed`). |
| `work.claim_expired` | A claim was not renewed in time. |
| `work.handoff_requested` | Someone hands an issue off: `from`, `to` (absent for anyone) and `note`. |
| `dependency.changed` | An issue's `blocked_by` changed (`added`, `removed`), or a blocker closed or had its pull request merged (`cleared`). `remaining` lists the blockers still open. |
| `overlap.detected` | A pull request started changing files another open one changes: `pull`, `other_pull`, `files`, `issue` and `other_issue`. Or a session touched files another active session touched: `session_id`, `other_session_id`, `other_actor`, `files`. |

A session or claim that went quiet is announced as ended or expired when
the repository's sessions or claims are next read or changed, not at the
minute it lapsed.

## Who may do what

| To | You need |
| --- | --- |
| Read sessions, claims and an issue's context | To be able to read the repository. Public repositories need no token. |
| Start a session, claim an issue, open one by claiming it | A confirmed email address and a role that may open issues; the repository must not be archived. |
| Update, record in or end a session | To be the person whose token started it. |
| Release a claim or hand it off | To be the person who made it. |
| Set `blocked_by` | To be the issue's author, or the Triage role. |
| Start a session on the workspace's Anthropic account | To be a member of the workspace and able to open issues in the repository. The hand-off needs only to read the issue. |

With an access token, sessions (and `start_agent_session`) need
`pull_requests:read` or `pull_requests:write`, and claims and `get_work`
need `issues:read` or `issues:write`, as
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
| Attached to an issue or pull request, or tied to one (a claim, its branch, a `#N` it named) | Updates about that issue or pull request: its claims, decisions, overlaps, dependency changes and integration results, and those that name it, such as an integration failure listing it as a suspect or an issue newly blocked by it |
| Not on anything yet | Every update, so it can find who else is working and on what |
| Either | Updates about nothing in particular, such as a session starting without an issue; and an overlap between its own files and another session's, which goes only to the two sessions |

A session does not receive its own start or end, or the claims it made,
released or handed off. It does hear when its claim expires. New sessions
should still load issue context: an inbox is not a replay of what happened
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
change to what an issue is blocked by is never kept without its updates, and
updates never announce a change that was not made. Each update's ID is
derived from its change, so a retried request, or two requests making the
same change at once, delivers it once. The one exception is the notice that
an issue's blocker closed or merged, which follows the close or merge: it
is written right after, once per close or merge. Updates are still a
summary: re-read current issue and pull request state before consequential
actions.

Acknowledged updates are kept as receipts for 30 days. Pending updates stay
until acknowledged, including those of a session that ended, so whoever
takes over its work can see what it never considered.
