---
title: Claims and dependencies
description: How people and coding agents work on the same work items without colliding. Advisory claims and hand-offs, what a work item is blocked by, overlapping changes, the coordination updates each session receives, and the events behind them.
---

When several agents and people work in one workspace at once, each needs
to know what the others are doing. g1t keeps that around the
[work item](/work/work-items/), the unit of work, and around the
[sessions](/work/sessions/) working on it:

- **Claims**: an advisory, expiring "I'm working on #12". Never a lock.
- **Hand-offs**: "I'm stopping; here is where it stands".
- **Dependencies**: the work items that have to land before this one.
- **Overlaps**: two pull requests, or two sessions, changing the same files.

Each change is announced as an event, and as a
[coordination update](#coordination-updates) to the sessions it concerns,
so an agent hears about it between steps instead of finding out at merge
time.

## Claims

A claim says you are working on a work item. It is advisory: anyone may
claim a work item someone else has, and is told about them, so two agents
can decide between themselves rather than collide. Nothing is refused
because of a claim. A claim is the workspace's, whichever repository the
session that holds it is checked out in, so sessions in different
repositories see each other's claims on the same work item.

- **Claim** an open work item with `work_item` `claim`, `g1t work claim 12`
  (with `--note` to say what you are taking), or
  [`POST /workspaces/{workspace}/work/{number}/claim`](/reference/api/work-items/claim-work-item/).
  Give your `session_id`, so that two of your sessions, such as sibling
  subagents, hold claims of their own and each is told of the other's. The
  answer has your `claim`, the `others` already on the work item, and
  `blocked_by`: each work item this one waits on, with its claims and pull
  requests. A closed work item cannot be claimed (`409`).
- **File a work item and claim it** in one step, for work that has no work
  item yet: `work_item` `claim` with `title` (and `body`) and no `number`,
  `g1t work claim --title "…"`, or
  [`POST /workspaces/{workspace}/claims`](/reference/api/work-items/claim-new-work-item/).
  The work item is filed (a `work_item.opened` event), with the session's
  repository as its origin when you give `repo`, then claimed, and the
  session named by `session_id` is attached to it. The answer also has
  `item`, the work item filed. The session is checked first: a claim that
  would be refused for it files nothing.
- **Renew** it by claiming again, or give the `session_id` of your session
  when you claim, and that session's heartbeats renew it.
- **Release** it with `work_item` `release`, `g1t work release 12`, or
  [`POST /workspaces/{workspace}/work/{number}/release`](/reference/api/work-items/release-claim/),
  with an optional `reason`.
- **Hand it off** with `work_item` `handoff`, `g1t work handoff 12 --note
"…"`, or
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

|                        |                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| How long a claim lasts | `ttl_minutes`: 30 unless you say, at most 240 (`--ttl 2h` on the CLI).                                   |
| Filing its work item   | `title` (and `body`) instead of `number`. Giving both is refused with `422`.                             |
| When it ends           | Released, handed off, its work item closed (`reason` `item_closed`), or not renewed in time (`expired`). |
| States                 | `active`, `released`, `expired`, `handed_off`.                                                           |

See who is on what with `work_item` `list_claims`, `g1t work status`, or
[`GET /repos/{owner}/{name}/claims`](/reference/api/work-items/list-claims/):
active claims unless `state` says otherwise, and `item` for one work
item's. On the site, a work item's **Work** panel lists its claims: who,
from which harness, since when and when each lapses, with those released,
expired or handed off lately dimmed. A work item with nobody on it says
how to claim it.

## Dependencies

A work item's `blocked_by` lists the work items of the same workspace that
have to land before it. On its page, **Edit** beside **Blocked by** in the
Work panel changes it. From the CLI:

```sh
g1t work block 12 --by 9 --by 10
g1t work unblock 12 --by 10
```

Over MCP and the API, `work_item` `update` or
[`PATCH /workspaces/{workspace}/work/{number}`](/reference/api/work-items/update-work-item/)
replaces the whole list:

```sh
curl -X PATCH https://api.g1t.sh/workspaces/acme/work/12 \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"blocked_by": [9, 10]}'
```

A list is refused with `422` when a number is not a work item of the
workspace, names the work item itself, or would make a cycle (the answer
shows the cycle, such as `#12 → #9 → #12`). Up to 50 work items. Changing
it notes the change in the work item's conversation (**marked this as
blocked by #9**) and needs what editing the work item does: being its
owner, or the Triage role.

The Work panel shows what a work item is blocked by and where each of
those stands, and the work items it blocks. g1t says when a dependency
moves, as a `dependency.changed` event on the blocked work item: when its
list changes, and when one of its blockers closes or has a pull request
merged into the default branch. `remaining` lists the blockers still open;
when it is empty, the work item is unblocked.

## Overlaps

Opening a pull request, and each push to it, works out which files it
changes. When it starts changing files another open or draft pull request
changes, g1t sends `overlap.detected` once for each of the two, naming the
other and the files. A pair is announced once, and again only after it
stopped overlapping. A pull request's `overlaps`, in `pull_request` `get`
and in the work item's [work context](/work/agents/#pick-up-a-work-item),
show current overlaps whenever you look.

Sessions overlap too, before there is a pull request: when a session says
it touched a file that another active session touched (outside its own
parents and subagents), each gets `overlap.detected` with `session_id`,
`other_session_id`, `other_actor` and `files`, once per pair, and again
with the new `files` when another file in common joins.

An overlap with a pull request for a different work item will become a
conflict for whichever merges second: narrow the change, agree an order,
or say so in the pull request.

## Coordination updates

Each session has an inbox of coordination updates: the claims, releases,
hand-offs and expiries, overlaps, dependency changes, decisions,
merge-queue results and sessions starting and ending that concern it. They
work the same with Claude Code, Codex or any other harness:

```sh
g1t session updates --json
g1t session acknowledge upd_ID --note "My scope is separate; no plan change"
```

They use `G1T_SESSION` (or the working copy's remembered session).
`session updates`, `session acknowledge` and `session heartbeat` first say
which files the working copy has changed (from `git status`), as
`session touch --file` would, so overlapping edits are noticed whichever
harness makes them; `G1T_TOUCH=0` turns that off. In a shared checkout,
`updates SESSION_ID` and `acknowledge --session SESSION_ID` name the
session. Over MCP, `session` `get` returns up to 100 pending `updates`,
oldest first, separately from the session's entries; the API's
`get_session` does the same (give `after=4294967295` to leave the entries
out).

An active session receives the updates that concern it:

| The session is                                                                                 | It receives                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attached to a work item or pull request, or tied to one (a claim, its branch, a `#N` it named) | Updates about that work item or pull request: its claims, decisions, overlaps, dependency changes and merge-queue results, and those that name it, such as an integration failure listing it as a suspect or a work item newly blocked by it |
| Not on anything yet                                                                            | Every update, so it can find who else is working and on what                                                                                                                                                                                 |
| Either                                                                                         | Updates about nothing in particular, such as a session starting without a work item; and an overlap between its own files and another session's, which goes only to the two sessions                                                         |

A session does not receive its own start or end, or the claims it made,
released or handed off. It does hear when its claim expires. A new session
should still load the work item's context: an inbox is not a replay of
what happened before the session started.

Reading does not clear an update. After considering it, and recording any
change of plan, the session acknowledges the exact IDs it considered:
`g1t session acknowledge`, the MCP `session` tool's `record` with
`acknowledge`, or

```sh
g1t api record_session_entries -f id=SESSION_ID -f 'acknowledge[]=UPDATE_ID'
```

Repeat the field for more IDs, at most 100 a request, then read again for
the next page. Acknowledging is idempotent and scoped to that session. It
means considered, not resolved. The answer's `acknowledged` says how many
of the IDs name updates of that session, so a mistyped ID or one from
another session shows up as a shortfall (the CLI warns). A session's page
shows what it has not acknowledged.

The [Claude Code plugin](/guides/claude-code-plugin/)'s hooks fetch
updates in the background, at most once every ten seconds, and at once
after an acknowledgement. Every prompt shows what is pending; before a
tool, pending updates are shown when they change and again every two
minutes, until acknowledged. Other harnesses, including sessions g1t runs,
read them between work steps, as the coordinate skill says. Neither a
disconnected harness nor an idle session is interrupted.

An update is written in the same transaction as the change it announces:
a claim, release, hand-off, expiry, session start or end, overlap,
decision or change to what a work item is blocked by is never kept without
its updates, and updates never announce a change that was not made. Each
update's ID is derived from its change, so a retried request, or two
requests making the same change at once, delivers it once. The one
exception is the notice that a work item's blocker closed or merged, which
follows the close or merge: it is written right after, once per close or
merge. Updates are still a summary: read the work item and pull request
again before acting on one.

Acknowledged updates are kept as receipts for 30 days. Pending updates
stay until acknowledged, including those of a session that ended, so
whoever takes over its work can see what it never considered.

## Events

Coordination is published as events, which [webhooks](/guides/webhooks/)
deliver and Sessions' **What happened** lists. Each carries `number` (the
work item or pull request it is about) and `item` (the work item's number
in the workspace) where there is one.

| Event                    | When                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.started`        | A session (or a subagent) starts, or one that ended starts again. Not on a repeated start.                                                                                                                                                   |
| `session.ended`          | A session ends, or times out after 30 minutes without a heartbeat.                                                                                                                                                                           |
| `session.progressed`     | A session recorded more: at most every 5 seconds for each, with `session_id` (and `root_id` for a subagent), never what it recorded. Pages showing the session follow it with this.                                                          |
| `work.claimed`           | Someone claims a work item. `others` lists the claims already on it; `took_over` names a hand-off it takes.                                                                                                                                  |
| `work.released`          | A claim is released, or its work item closed (`reason` `item_closed`).                                                                                                                                                                       |
| `work.claim_expired`     | A claim was not renewed in time.                                                                                                                                                                                                             |
| `work.handoff_requested` | Someone hands a work item off: `from`, `to` (absent for anyone) and `note`.                                                                                                                                                                  |
| `dependency.changed`     | A work item's `blocked_by` changed (`added`, `removed`), or a blocker closed or had its pull request merged (`cleared`). `remaining` lists the blockers still open.                                                                          |
| `overlap.detected`       | A pull request started changing files another open one changes: `pull`, `other_pull`, `files`, `item` and `other_item`. Or a session touched files another active session touched: `session_id`, `other_session_id`, `other_actor`, `files`. |

A session or claim that went quiet is announced as ended or expired when
the repository's sessions or claims are next read or changed, not at the
minute it lapsed.

## Who may do what

| To                                                          | You need                                                                                                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read sessions and claims                                    | To be able to read the repository. Public repositories need no token. What a session shows depends on who you are: see [who sees what](/work/sessions/#who-sees-what). |
| Read a workspace's **Sessions**                             | It lists the sessions of the workspace's repositories you can read; g1t's own agent's sessions only for members.                                                       |
| Read a work item's context                                  | To be able to see the work item: see [who sees a work item](/work/work-items/#who-sees-a-work-item).                                                                   |
| Start a session, claim a work item, file one by claiming it | A confirmed email address and a role that may file work items; the repository must not be archived.                                                                    |
| Update, record in or end a session                          | To be the person whose token started it. Ending one by hand: also anyone with write access.                                                                            |
| Release a claim or hand it off                              | To be the person who made it.                                                                                                                                          |
| Set `blocked_by`                                            | To be the work item's owner, or the Triage role.                                                                                                                       |

With an access token, sessions need `pull_requests:read` or
`pull_requests:write`, and claims and the work context need `work:read` or
`work:write`, as [scopes](/guides/authentication/#scopes) say.
