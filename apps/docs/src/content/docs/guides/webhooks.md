---
title: Webhooks
description: Have g1t send a repository's or a workspace's events to your own address as they happen, signed and retried.
---

A webhook sends events to an HTTPS address you choose, as they happen: a
push, an issue opened, a pull request merged, checks finished, the merge
queue moving. Use them to build on g1t: post to chat, start a deploy, keep
another system in step.

A webhook belongs to one of two things:

| | Sent the events of | Managed by | Where |
| --- | --- | --- | --- |
| A repository's | That repository | People with the Admin [role](/guides/access-and-roles/) on it | The project's **Settings → Webhooks** |
| A workspace's | Every repository in the workspace, the workspace's own [packages](/guides/packages/), and its [teams](/guides/teams/) | Owners | The workspace's **Settings → Webhooks** |

Seeing a repository's webhooks, and their deliveries, needs Admin too: the
page is not shown to anyone else, since a webhook's address and secret are
the workspace's own.

## Add one

1. Open **Settings → Webhooks** for the repository or the workspace.
2. Give the **payload URL**: an HTTPS address on the public internet.
3. Choose the events, or leave **Everything**, which also includes event
   types added later.
4. Give a **secret**, or leave it empty and g1t makes one. A secret g1t
   makes is shown once.
5. **Add webhook**. g1t sends it a `ping` at once, so you can see straight
   away whether your receiver answers.

## What is sent

Each delivery is a `POST` with a JSON body:

```json
{
  "id": "evt_01m401tecce9h8wt7k3ayvs72n",
  "type": "comment.created",
  "time": "2026-10-03T04:54:37.708Z",
  "workspace": "acme",
  "repository": { "id": "rep_cf985171afeee00a62a1c0acb0", "full_name": "acme/web" },
  "actor": { "id": "usr_b51a1a09fc53e9471cbe1426b7", "username": "ada" },
  "data": { "comment_id": "cmt_01m401te9eekb92kccgwhympr4", "number": 3, "repo_id": "rep_cf985171afeee00a62a1c0acb0" }
}
```

`data` holds what the event is about: ids and numbers to fetch the rest with
the [API](/reference/api/). `actor` is null for something g1t did by
itself. An event whose `data` would be larger than about 96 KB has its
long text, such as a comment's or release's body, shortened, and
`data.truncated` is `true`: fetch the whole text from the API.

With these headers:

| Header | |
| --- | --- |
| `X-G1t-Event` | The event type, such as `pull.merged`, or `ping`. |
| `X-G1t-Delivery` | The delivery's id. A redelivery has a new one. |
| `X-G1t-Hook` | The webhook's id. |
| `X-G1t-Signature-256` | `sha256=` and the HMAC-SHA256 of the body, keyed with the secret. |
| `User-Agent` | `g1t-webhooks/1`, followed by a link to this page |

## Events

| Event | When |
| --- | --- |
| `git.push` | A branch moved. `data.ref`, `data.after`, `data.default_branch`, and `data.commits` (how many commits the push brought to the branch, at most 50; absent for a tag, a deleted branch or a merge). A push of more than 3 tags, or more than 1,000 branches, sends fewer; see [pushes of many branches or tags](/guides/git/#pushes-of-many-branches-or-tags). |
| `repo.created` | A repository was made. A [fork](/concepts/forks/) has `data.parent_id`, the repository it was forked from. |
| `repo.forked` | Someone forked this repository, or a pull request's working copy was made of it. `data.repo_id` is the new repository, `data.source_repo_id` this one, and `data.pull_id` the pull request, for a working copy only. |
| `repo.detached` | A fork left its parent: an admin detached it, or its parent was made public or private. `data.repo_id` and `data.parent_id`. Its workflows stay off unless someone had turned them on. |
| `repo.updated` | Its website, topics, protection or visibility changed. |
| `repo.visibility_changed` | It was made public or private. |
| `repo.renamed` | It was given a new name. Its old address redirects. |
| `repo.transferred` | It moved to another workspace. |
| `repo.default_branch_changed` | Its default branch changed, or the default branch was renamed. |
| `git.deleted` | A push deleted a branch or tag. `data.ref` is the full ref, and `data.before` the commit it pointed to. A push that deletes more than 3 tags sends none for them. |
| `branch.renamed` | A branch was renamed. |
| `repo.collaborator_added`, `repo.collaborator_role_changed`, `repo.collaborator_removed` | Someone was given a role on it, had their role changed, or lost it. `data.username`, `data.role`, `data.previous_role`. See [access and roles](/guides/access-and-roles/). |
| `team.created`, `team.edited`, `team.deleted` | A [team](/guides/teams/) was created, changed or deleted. Sent to the workspace's webhooks. `data.workspace`, `data.team` (its slug), `data.team_id`, `data.name`, `data.visibility`, `data.parent`; on `team.edited`, `data.changes`. |
| `team.member_added`, `team.member_role_changed`, `team.member_removed` | Someone joined or left a team, or became its maintainer or a member. Sent to the workspace's webhooks. `data.username`, `data.role` (`member` or `maintainer`), `data.previous_role`. |
| `team.repo_added`, `team.repo_role_changed`, `team.repo_removed` | A team was given a role on the repository, had it changed, or lost it. `data.repo`, `data.repo_id`, `data.repo_role`, `data.previous_repo_role`. |
| `workspace.member_joined` | A person became a member of the [workspace](/guides/workspaces/#when-someone-joins). Sent to the workspace's webhooks. `data.workspace_id`, `data.workspace` (its slug), `data.user_id`, `data.username`, `data.role` (`owner` or `member`) and `data.how`: `invitation` (they accepted an invitation), `joined` (they used an invite code that names the workspace) or `created` (they made the workspace and are its first owner). |
| `repo.archived`, `repo.unarchived` | It was made read-only, or writable again. |
| `repo.deleted`, `repo.restored`, `repo.purged` | It was deleted, restored within its 30 days, or removed for good. |
| `issue.labeled`, `issue.unlabeled`, `pull.labeled`, `pull.unlabeled` | A [label](/guides/labels/) was put on an issue or a pull request, or taken off: one event for each label. `data.number` and `data.label` (`name` and `color`). |
| `issue.milestoned`, `issue.demilestoned`, `pull.milestoned`, `pull.demilestoned` | An issue or a pull request was put in a [milestone](/guides/milestones/), or taken out of one. `data.milestone` (`number` and `title`). Moving it from one to another is both. |
| `pull.base_changed` | The branch a pull request merges into changed. `data.base` names it. See [pull requests into other branches](/guides/base-branches/). |
| `issue.opened`, `issue.updated`, `issue.assigned`, `issue.closed`, `issue.reopened` | An issue changed. `data.number` and `data.author` (`id` and `username`); on close, `data.reason` and `data.resolved_by` (the pull request that closed it) or `data.commit` (the commit on the default branch that did), and `data.session` when it was closed in a session; on assignment, `data.assignees` and the newly assigned `data.added`. |
| `comment.created` | A comment or review on an issue or pull request. |
| `comment.edited` | A comment's text was [edited](/guides/pull-requests/#editing-and-deleting-comments). `data.comment_id`, `data.number`, `data.pull_id` on a pull request, and `data.changes.body.from`, what it said before. |
| `comment.deleted` | A comment was [deleted](/guides/pull-requests/#editing-and-deleting-comments). `data.comment_id`, `data.number`, `data.pull_id` on a pull request, and `data.comment` as it was: `id`, `body`, `author` (`id` and `username`), `created_at`, `path` and `line`. |
| `commit_comment.created`, `commit_comment.edited`, `commit_comment.deleted` | A [comment on a commit](/guides/pull-requests/#commit-comments) was made, edited or deleted. `data.comment_id`, `data.commit` and `data.comment` (`id`, `commit`, `path`, `line`, `author`, `body`, `created_at`, `updated_at`); on edit, `data.changes.body.from`, what it said before. |
| `pull.opened`, `pull.ready`, `pull.updated`, `pull.merge_requested`, `pull.merged`, `pull.closed` | A pull request changed. `data.number`, `data.issue` and `data.author` (`id` and `username`); on merge, `data.commit`. `actor` is whoever caused the event. |
| `pull.auto_merge_enabled`, `pull.auto_merge_disabled` | [Auto-merge](/guides/pull-requests/#auto-merge) was turned on for a pull request, or off: by a person, or by g1t when it merged, closed or someone else pushed. `data.number`; on enable, `data.detail` is the merge method; on disable, `data.detail` says why g1t turned it off, `data.auto_merge_by` names who had turned it on, and `data.queued` is `true` when g1t turned it off because the pull request joined the merge queue, which lands it. |
| `pull.head_branch_deleted`, `pull.head_branch_restored` | A merged or closed pull request's [branch](/guides/pull-requests/#deleting-the-branch) was deleted, on merge or by hand, or made again. `data.number` and `data.detail`, the branch. |
| `pull.reopened`, `pull.converted_to_draft` | A closed pull request was [reopened](/guides/pull-requests/#reopen-a-pull-request), or one ready for review was [turned back into a draft](/guides/pull-requests/#convert-to-a-draft). The same data as `pull.closed`; on reopen, `data.commit` is its head. |
| `pull.assigned` | People were assigned to a pull request. `data.assignees` is everyone assigned now, `data.added` those newly assigned. |
| `pull.review_requested`, `pull.review_request_removed` | Reviewers were asked for a pull request, or no longer are. `data.reviewers` names the people. `data.teams` lists the [teams](/guides/teams/#review-requests) asked, or no longer asked, each with `team` (`workspace/team`), `notified` (who in it was told) and `assigned` (who review assignment picked). `data.code_owners` is `true` when its [CODEOWNERS file](/guides/codeowners/) asked them. |
| `secret_scanning_alert.created`, `.fixed`, `.dismissed`, `.reopened` | A [secret alert](/guides/security/secret-protection/) opened (found in history, or blocked at a push: `data.pusher`), was revoked, dismissed or reopened. `data.alert_id`, `data.title`, `data.path`, `data.line`, `data.severity`, `data.state`, `data.reason`, `data.link`. Never the secret. The first 200 of a scan's alerts get one each; the scan's `.summary` carries the counts. |
| `secret_scanning_alert.summary`, `code_scanning_alert.summary`, `vulnerability_alert.summary` | What one scan did to a repository's alerts of one type, published once per scan: `data.scan` (`push`, `history`, `dependencies`, `analysis`, or `change` for a dismissal or reopening), `data.opened` (up to 200 ids) and `data.opened_count`, `data.fixed` and `data.fixed_count`, `data.dismissed_count`, `data.new_by_severity` and `data.open` (counts by severity), `data.worst`, `data.latest` (the worst new alert's title), `data.link`, and for a refused push `data.pusher` and `data.blocked`. What [notifications](/guides/notifications/#security) are built from. |
| `secret_scanning.bypass_requested`, `secret_scanning.bypass_reviewed` | Someone asked to bypass push protection, or the request was approved or denied (`data.state`). `data.request_id`, `data.alert_id`, `data.reason`. |
| `code_scanning_alert.created`, `.fixed`, `.dismissed`, `.reopened` | A [code scanning alert](/guides/security/code-scanning/) changed. `data.alert_id`, `data.alert_number`, `data.title`, `data.severity`, `data.path`, `data.line`, `data.state`, `data.link`. |
| `vulnerability_alert.created`, `.fixed`, `.dismissed`, `.reopened` | A [vulnerability alert](/guides/security/supply-chain/) changed. `data.alert_id`, `data.title` (package, version, lockfile and advisory), `data.severity`, `data.state`, `data.link`. |
| `security_advisory.published`, `security_advisory.withdrawn` | The repository [published or withdrew a security advisory](/guides/security/advisories/). `data.id`, `data.g1tsa_id`, `data.title`, `data.severity`, `data.state`, `data.link`. |
| `security_advisory.reported` | Someone [reported a vulnerability privately](/guides/security/advisories/#private-vulnerability-reporting) to the repository's maintainers. `data.id`, `data.title`, `data.severity`, `data.link`. Never the reporter or the description: it says to look. |
| `checks.completed` | A pull request's checks finished: every status on its head has reported and none is still pending, or the merge queue took it out. `data.number`, `data.commit`, and `data.status`, `passed` or `failed`. |
| `status.created` | A status was set on a commit: through the API, by a workflow run, by a deploy, or by another part of g1t. `data.sha`, `data.context`, `data.state`, `data.description`, `data.target_url`. See [Checks](/guides/checks/). |
| `check_run.created`, `check_run.completed` | A check run was reported on a commit, or completed. `data.check_run`: `id`, `name`, `head_sha`, `status`, `conclusion`, `details_url`, `external_id`, `html_url`, `output`, `actions`, `check_suite` and `app`. |
| `check_run.rerequested`, `check_run.requested_action` | Someone asked for a check run to run again, or pressed one of its buttons: `data.requested_action` is the button's `identifier`. Report a new run, or do what the button says. |
| `check_suite.completed`, `check_suite.rerequested` | Every latest check run of a reporter's suite on a commit completed, or someone asked for it to run again. `data.check_suite`: `id`, `head_sha`, `status`, `conclusion`, `app`. |
| `workflow.completed` | A [workflow](/guides/actions/) run finished. `data.workflow`, `data.conclusion`, `data.run_id`, `data.sha`, `data.pull`. |
| `deployment.succeeded`, `deployment.failed` | A g1t.page build of a [project](/guides/deployments/) finished, for production or a pull request's preview. `data.deployment_id`, `data.project`, `data.kind` (`production` or `preview`), `data.number` for a preview, `data.commit`, `data.path`, `data.error` on failure, and `data.recovered` when a success follows a failure. |
| `deployment.created` | A deployment was made, from any source: reported through the [API](/guides/deployments-api/), made by a g1t Actions job with an `environment:`, or a g1t.page build. `data.repo_id` and `data.deployment`, without its `payload`. |
| `deployment_status.created` | A deployment got a status, from any source. `data.repo_id`, `data.deployment` without its `payload`, and `data.deployment_status`. |
| `release.created`, `.published`, `.released`, `.prereleased`, `.edited`, `.unpublished`, `.deleted` | A [release](/guides/releases/) changed; one change can send several, as the [release activity types](/guides/actions/#releases) say. `data.release_id`, `data.tag_name`, and `data.release` (`tag_name`, `target`, `name`, `body`, `draft`, `prerelease`, `author`, `created_at`, `published_at`), as it was for `release.deleted`. On `release.edited`, `data.changes` holds the old `name` and `body`. |
| `queue.changed` | The merge queue gained, lost or settled an entry. |
| `integration.failed` | A pull request failed in the [merge queue](/guides/merge-queue/#when-an-entry-fails) combined with the ones ahead of it. `pull` (also `number`) is the one that answers for it, `issue` its issue, `combination` the pull requests tested together, `check` the check that failed (`name`, `conclusion`, `url`), `suspects` the pull requests ahead it fails with, `bisected` whether smaller combinations were built to find them, `other_pulls` the rest of the combination, and `landed`, when nothing was ahead of it though it passes its checks on its own, the pull requests merged into the default branch since it branched, newest first and at most ten (empty otherwise). |
| `integration.passed` | A pull request's combined state passed in the merge queue: `pull` and `combination`. |
| `decision.recorded` | A [decision record](/guides/why-blame/#decision-records) was kept on an issue or pull request: `decision`, with `number` and `issue`. |
| `session.appended` | A pull request's [session](/guides/why-blame/#sessions) grew: a coding agent recorded entries with `record_session`, a session on it recorded some, or g1t noted a merge queue failure. Busy: choose it only if you need it. |
| `session.started`, `session.ended` | A [session](/guides/sessions/#sessions) of someone's harness started (not on a repeated start), or ended or timed out. `data.session`, and `data.number` (its pull request, else its issue) and `data.issue`. |
| `work.claimed`, `work.released`, `work.claim_expired`, `work.handoff_requested` | A [claim](/guides/sessions/#claims) on an issue was made, released, expired or handed off. `data.number` and `data.issue` (the issue), `data.claim`; on `work.claimed`, `data.others` (the other active claims) and `data.took_over`; on `work.released`, `data.reason`; on a hand-off, `data.from`, `data.to` and `data.note`. |
| `dependency.changed` | What an issue is [blocked by](/guides/sessions/#dependencies) changed, or a blocker closed or had its pull request merged. `data.number` (the blocked issue), `data.blocked_by`, `data.added`, `data.removed`, `data.cleared`, `data.remaining` (blockers still open) and `data.merged_pull`. |
| `overlap.detected` | A push made a pull request [change files another open one changes](/guides/sessions/#overlaps). Sent once for each of the two: `data.pull`, `data.other_pull`, `data.files`, `data.issue` and `data.other_issue`. |

[Managing a repository](/guides/managing-repositories/) says what each of
the `repo.` and `branch.` changes does.

## Check the signature

Compute the HMAC-SHA256 of the raw body with your secret and compare it to
`X-G1t-Signature-256` in constant time, before you parse the body.

```js
// Node.js
import { createHmac, timingSafeEqual } from "node:crypto";

function fromG1t(rawBody, signature, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return signature?.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

```python
# Python
import hashlib, hmac

def from_g1t(raw_body: bytes, signature: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature or "", expected)
```

## Answering, and retries

Answer with any 2xx within 10 seconds. Do slow work after answering.

A delivery that gets anything else, or no answer, is tried again after 1
minute, 5 minutes, 30 minutes, 2 hours and 5 hours: six attempts over
about seven and a half hours. Then it is marked failed. Pausing or removing
a webhook stops its retries.

An event is delivered to a webhook once. Use `X-G1t-Delivery`, or the
event's `id`, to ignore one you have already handled.

## The delivery log

Each webhook keeps its deliveries for 14 days. Open **Deliveries** to see,
for each one, the request g1t sent, the status and body your receiver
answered with, how long it took, and when it will be tried again.
**Redeliver** sends the same payload again, as a new delivery.

The status dot beside each webhook shows how its latest delivery went:
green delivered, amber waiting to try again, red failed.

## Addresses

Webhooks are sent only over HTTPS, to public addresses. Private and local
addresses (`localhost`, `10.0.0.0/8`, `192.168.0.0/16` and the like) are
refused. To receive webhooks on your own machine while you build, use a
tunnel such as Cloudflare Tunnel.

## Without a public address

An agent on a laptop, or anything else that cannot take requests from the
internet, can follow a repository's events instead:
[`list_events`](/reference/api/repositories/list-events/) with `after` and
`wait` holds each request until an event is written, so one request at a
time hears about events within a second or so. `g1t work events --follow`
does this for you ([The g1t CLI](/guides/cli/#following-events)).

## From the API

The same routes, and the MCP server's `webhook` tool, work for a
repository's webhooks (give `repo`) and a workspace's (give `workspace`
instead).

| `webhook` action | Route |
| --- | --- |
| `list` | `GET /repos/{owner}/{name}/hooks`, `GET /workspaces/{workspace}/hooks` |
| `create` | `POST …/hooks` with `url`, `events`, `secret` |
| `update` | `PATCH …/hooks/{id}` with `url`, `events`, `active` |
| `delete` | `DELETE …/hooks/{id}` |
| `ping` | `POST …/hooks/{id}/pings` |
| `list_deliveries` | `GET …/hooks/{id}/deliveries` |
| `redeliver` | `POST …/hooks/{id}/deliveries/{delivery}/redeliver` |

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/hooks \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/g1t", "events": ["pull.merged", "checks.completed"]}'
```
