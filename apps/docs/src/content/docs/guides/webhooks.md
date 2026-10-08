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
itself.

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
| `git.push` | A branch moved. `data.ref`, `data.after`, `data.default_branch`. |
| `repo.created`, `repo.forked` | A repository was made, or forked for a pull request. |
| `repo.updated` | Its description, website, topics, protection or visibility changed. |
| `repo.visibility_changed` | It was made public or private. |
| `repo.renamed` | It was given a new name. Its old address redirects. |
| `repo.transferred` | It moved to another workspace. |
| `repo.default_branch_changed` | Its default branch changed, or the default branch was renamed. |
| `branch.renamed` | A branch was renamed. |
| `repo.collaborator_added`, `repo.collaborator_role_changed`, `repo.collaborator_removed` | Someone was given a role on it, had their role changed, or lost it. `data.username`, `data.role`, `data.previous_role`. See [access and roles](/guides/access-and-roles/). |
| `team.created`, `team.edited`, `team.deleted` | A [team](/guides/teams/) was created, changed or deleted. Sent to the workspace's webhooks. `data.workspace`, `data.team` (its slug), `data.team_id`, `data.name`, `data.visibility`, `data.parent`; on `team.edited`, `data.changes`. |
| `team.member_added`, `team.member_role_changed`, `team.member_removed` | Someone joined or left a team, or became its maintainer or a member. Sent to the workspace's webhooks. `data.username`, `data.role` (`member` or `maintainer`), `data.previous_role`. |
| `team.repo_added`, `team.repo_role_changed`, `team.repo_removed` | A team was given a role on the repository, had it changed, or lost it. `data.repo`, `data.repo_id`, `data.repo_role`, `data.previous_repo_role`. |
| `repo.archived`, `repo.unarchived` | It was made read-only, or writable again. |
| `repo.deleted`, `repo.restored`, `repo.purged` | It was deleted, restored within its 30 days, or removed for good. |
| `issue.labeled`, `issue.unlabeled`, `pull.labeled`, `pull.unlabeled` | A [label](/guides/labels/) was put on an issue or a pull request, or taken off: one event for each label. `data.number` and `data.label` (`name` and `color`). |
| `issue.milestoned`, `issue.demilestoned`, `pull.milestoned`, `pull.demilestoned` | An issue or a pull request was put in a [milestone](/guides/milestones/), or taken out of one. `data.milestone` (`number` and `title`). Moving it from one to another is both. |
| `pull.base_changed` | The branch a pull request merges into changed. `data.base` names it. See [pull requests into other branches](/guides/base-branches/). |
| `issue.opened`, `issue.updated`, `issue.assigned`, `issue.closed`, `issue.reopened` | An issue changed. `data.number` and `data.author` (`id` and `username`); on close, `data.reason` and `data.resolved_by`; on assignment, `data.assignees` and the newly assigned `data.added`. For an issue g1t's agent filed while at work, `data.author` is g1t and `data.requested_by` is the person it was working for. |
| `comment.created` | A comment or review on an issue or pull request. |
| `pull.opened`, `pull.ready`, `pull.updated`, `pull.merge_requested`, `pull.merged`, `pull.closed` | A pull request changed. `data.number`, `data.issue` and `data.author` (`id` and `username`); on merge, `data.commit`. For a change g1t made, `data.author` is g1t and `data.requested_by` is the person who asked for it; `actor` is still whoever caused the event. On a change by g1t, once g1t has worked it out, `data.confidence`: `level` (`high`, `medium` or `low`), `reasons`, `self_reported`, `uncertain_about`, `run_id` and `assessed_at`. See [how sure the agent is](/guides/working-with-g1t/#how-sure-the-agent-is). |
| `pull.assigned` | People were assigned to a pull request. `data.assignees` is everyone assigned now, `data.added` those newly assigned. |
| `pull.review_requested`, `pull.review_request_removed` | Reviewers were asked for a pull request, or no longer are. `data.reviewers` names the people. `data.teams` lists the [teams](/guides/teams/#review-requests) asked, or no longer asked, each with `team` (`workspace/team`), `notified` (who in it was told) and `assigned` (who review assignment picked). `data.code_owners` is `true` when its [CODEOWNERS file](/guides/codeowners/) asked them. |
| `pull.stalled`, `pull.resumed` | g1t stopped seeing a pull request through until a person steps in, with why in `data.detail`; or it picked back up. |
| `secret_scanning_alert.created`, `.fixed`, `.dismissed`, `.reopened` | A [secret alert](/guides/security/secret-protection/) opened (found in history, or blocked at a push: `data.pusher`), was revoked, dismissed or reopened. `data.alert_id`, `data.title`, `data.path`, `data.line`, `data.severity`, `data.state`, `data.reason`, `data.link`. Never the secret. |
| `secret_scanning.bypass_requested`, `secret_scanning.bypass_reviewed` | Someone asked to bypass push protection, or the request was approved or denied (`data.state`). `data.request_id`, `data.alert_id`, `data.reason`. |
| `code_scanning_alert.created`, `.fixed`, `.dismissed`, `.reopened` | A [code scanning alert](/guides/security/code-scanning/) changed. `data.alert_id`, `data.alert_number`, `data.title`, `data.severity`, `data.path`, `data.line`, `data.state`, `data.link`. |
| `vulnerability_alert.created`, `.fixed`, `.dismissed`, `.reopened` | A [vulnerability alert](/guides/security/supply-chain/) changed. `data.alert_id`, `data.title` (package, version, lockfile and advisory), `data.severity`, `data.state`, `data.link`. |
| `checks.completed` | A pull request's checks finished: every status on its head has reported and none is still pending, or the merge queue took it out. `data.number`, `data.commit`, and `data.status`, `passed` or `failed`. |
| `status.created` | A status was set on a commit through the API. `data.sha`, `data.context`, `data.state`, `data.description`, `data.target_url`. See [Checks](/guides/checks/). |
| `check_run.created`, `check_run.completed` | A check run was reported on a commit, or completed. `data.check_run`: `id`, `name`, `head_sha`, `status`, `conclusion`, `details_url`, `external_id`, `html_url`, `output`, `actions`, `check_suite` and `app`. |
| `check_run.rerequested`, `check_run.requested_action` | Someone asked for a check run to run again, or pressed one of its buttons: `data.requested_action` is the button's `identifier`. Report a new run, or do what the button says. |
| `check_suite.completed`, `check_suite.rerequested` | Every latest check run of a reporter's suite on a commit completed, or someone asked for it to run again. `data.check_suite`: `id`, `head_sha`, `status`, `conclusion`, `app`. |
| `review.completed` | g1t reviewed a pull request. `data.verdict`. |
| `workflow.completed` | A [workflow](/guides/actions/) run finished. `data.workflow`, `data.conclusion`, `data.run_id`, `data.sha`, `data.pull`. |
| `deployment.succeeded`, `deployment.failed` | A g1t.page build of a [project](/guides/deployments/) finished, for production or a pull request's preview. `data.deployment_id`, `data.project`, `data.kind` (`production` or `preview`), `data.number` for a preview, `data.commit`, `data.path`, `data.error` on failure, and `data.recovered` when a success follows a failure. |
| `deployment.created` | A deployment was made, from any source: reported through the [API](/guides/deployments-api/), made by a g1t Actions job with an `environment:`, or a g1t.page build. `data.repo_id` and `data.deployment`, without its `payload`. |
| `deployment_status.created` | A deployment got a status, from any source. `data.repo_id`, `data.deployment` without its `payload`, and `data.deployment_status`. |
| `queue.changed` | The merge queue gained, lost or settled an entry. |
| `session.appended` | An agent's session grew. Busy: choose it only if you need it. |
| `agent.asked` | An agent asked the agent on another pull request a question, or handed it work, while that one was not at work; g1t wakes it to answer. |

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
