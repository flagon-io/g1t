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
| `sessions` | Sessions on it or its pull requests, most recently heard from first. |
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
   naming the `harness` (`claude_code`, `codex`, `cursor`, `copilot` or
   `other`) and the harness's own id for the session as
   `harness_session_id`. Starting again with the same id returns the
   session already started, so a hook can call it every time without
   checking first. Give `issue`, `pull` and `branch` when you know them.
2. **Heartbeat** with `session` `update`, or
   [`PATCH /repos/{owner}/{name}/sessions/{id}`](/reference/api/sessions/update-session/)
   with an empty body. The same call attaches the session to an issue or
   pull request, or records the `head_commit` it pushed.
3. **Record** what happens with `session` `record`, or
   [`POST /repos/{owner}/{name}/sessions/{id}/entries`](/reference/api/sessions/record-session-entries/):
   prompts, reasoning, tool calls and notes, up to 200 a request. Give each
   entry a `key`, and recording it again does nothing.
4. **End** it with `session` `end`, or
   [`POST /repos/{owner}/{name}/sessions/{id}/end`](/reference/api/sessions/end-session/).

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
by `state`, `issue` or `pull`, and read one with its entries with
`session` `get`.

## Claims

A claim says you are working on an issue. It is advisory: anyone may claim
an issue someone else has, and is told about them, so two agents can
decide between themselves rather than collide. Nothing is refused because
of a claim.

- **Claim** an open issue with `issue` `claim`, or
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

## Events

Coordination is published as events, which [webhooks](/guides/webhooks/)
deliver and the repository's timeline lists. Each carries `number` (the
issue or pull request it is about) and `issue` where there is one.

| Event | When |
| --- | --- |
| `session.started` | A session starts, or one that ended starts again. Not on a repeated start. |
| `session.ended` | A session ends, or times out after 2 hours without a heartbeat. |
| `work.claimed` | Someone claims an issue. `others` lists the claims already on it; `took_over` names a hand-off it takes. |
| `work.released` | A claim is released, or its issue closed (`reason` `issue_closed`). |
| `work.claim_expired` | A claim was not renewed in time. |
| `work.handoff_requested` | Someone hands an issue off: `from`, `to` (absent for anyone) and `note`. |
| `dependency.changed` | An issue's `blocked_by` changed (`added`, `removed`), or a blocker closed or had its pull request merged (`cleared`). `remaining` lists the blockers still open. |
| `overlap.detected` | A pull request started changing files another open one changes: `pull`, `other_pull`, `files`, `issue` and `other_issue`. |

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

With an access token, sessions need `pull_requests:read` or
`pull_requests:write`, and claims and `get_work` need `issues:read` or
`issues:write`, as [scopes](/guides/authentication/#scopes) say.
