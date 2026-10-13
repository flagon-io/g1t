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
    grouped by the issue they are on, with sessions on no issue yet
    after them. An issue with more than one claim is marked.
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
  as it records it. A subagent's own page links back to the session that
  started it.
- **An issue's and a pull request's sessions**: every session tied to it
  in any way, with its subagents under it.
- **Start a session** on an issue, for members of a workspace with an
  Anthropic connection: see
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
   checking first. Give `issue`, `pull` and `branch` when you know them.
2. **Heartbeat** with `session` `update`, or
   [`PATCH /repos/{owner}/{name}/sessions/{id}`](/reference/api/sessions/update-session/)
   with an empty body. The same call attaches the session to an issue or
   pull request, or records the `head_commit` it pushed.
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
listed too with `subagents=true`. Read one with its entries, subagents,
links, skills and what it touched with `session` `get`.

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
to both, naming each other and the files: once per pair.

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

- **With an Anthropic connection** in the workspace (an owner adds one
  under **Integrations**, **Your AI providers**), g1t starts a
  [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)
  session on that account, with its key, on the model Ask is set to use
  (or `claude-opus-5-5`). It runs in a sandbox on Anthropic's side and
  reaches g1t through g1t's MCP server and git, with a token made for you
  and that repository only, which lasts the session and is revoked when it
  ends. The token is kept in a vault on the Anthropic account: the MCP
  server's credential, and `G1T_TOKEN`, which the sandbox holds only as a
  placeholder that is swapped for the token on its way to g1t. It is never
  in the prompt, and the model never sees it. The session has g1t's skills
  (work-on-issue, coordinate and fix-integration, uploaded to the account
  the first time) next to the account's own custom skills, up to 20 in
  all. It may hand parts of the work to copies of itself; each is recorded
  as a subagent.
- **Without one**, or with `handoff: true`, nothing starts: you get
  `command`, a Claude Code command line to run in your working copy with
  the [plugin](/guides/claude-code-plugin/), and `prompt`, what to paste.
  The session that starts attaches to the issue.

The answer has the `session` on g1t, its `session_url`, and
`provider_session_url`, where the Anthropic Console shows it (its
`default` workspace; another workspace's sessions are under its own id).
The session is recorded as harness `claude_managed_agents`: its messages,
the tools it called and with what (never what they returned), the skills
it read, what it touched, and each thread as a subagent with its task and
report. g1t follows it every minute, and at once while its page is open. A
call that waits for someone's approval is declined, since nobody is
watching. When it finishes, its session ends with its last message as its
result. Whoever started it can stop it from its page. It runs on your
workspace's key and Anthropic bills the account for it; g1t bills nothing.

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
```

| | |
| --- | --- |
| How long a claim lasts | `ttl_minutes`: 30 unless you say, at most 240. |
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
and `files`, once per pair.

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
| Start a session, claim an issue | A confirmed email address and a role that may open issues; the repository must not be archived. |
| Update, record in or end a session | To be the person whose token started it. |
| Release a claim or hand it off | To be the person who made it. |
| Set `blocked_by` | To be the issue's author, or the Triage role. |
| Start a session on the workspace's Anthropic account | To be a member of the workspace and able to open issues in the repository. The hand-off needs only to read the issue. |

With an access token, sessions (and `start_agent_session`) need
`pull_requests:read` or `pull_requests:write`, and claims and `get_work`
need `issues:read` or `issues:write`, as
[scopes](/guides/authentication/#scopes) say.
