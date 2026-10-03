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
| A repository's | That repository | Members of its workspace | The repository's **Settings → Webhooks** |
| A workspace's | Every repository in the workspace | Owners | The workspace's **Settings → Webhooks** |

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
  "repository": { "id": "rep_cf985171afeee00a62a1c0acb0", "fullName": "acme/web" },
  "actor": { "id": "usr_b51a1a09fc53e9471cbe1426b7", "username": "ada" },
  "data": { "commentId": "cmt_01m401te9eekb92kccgwhympr4", "number": 3, "repoId": "rep_cf985171afeee00a62a1c0acb0" }
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
| `User-Agent` | `g1t-webhooks/1` |

## Events

| Event | When |
| --- | --- |
| `git.push` | A branch moved. `data.ref`, `data.after`, `data.defaultBranch`. |
| `repo.created`, `repo.forked` | A repository was made, or forked for a pull request. |
| `issue.opened`, `issue.updated`, `issue.assigned`, `issue.closed`, `issue.reopened` | An issue changed. `data.number`; on close, `data.reason` and `data.resolvedBy`. |
| `comment.created` | A comment or review on an issue or pull request. |
| `pull.opened`, `pull.ready`, `pull.updated`, `pull.merge_requested`, `pull.merged`, `pull.closed` | A pull request changed. `data.number`, `data.issue`; on merge, `data.commit`. |
| `checks.completed` | An issue's acceptance checks finished on a pull request. `data.status` is `passed`, `failed` or `errored`. |
| `review.completed` | A g1t agent reviewed a pull request. `data.verdict`. |
| `workflow.completed` | A GitHub Actions run finished. `data.workflow`, `data.conclusion`, `data.runId`, `data.sha`, `data.pull`. |
| `queue.changed` | The merge queue gained, lost or settled an entry. |
| `session.appended` | An agent's session grew. Busy: choose it only if you need it. |
| `agent.asked` | An agent asked the agent on another pull request a question, or handed it work, while that one was not at work; g1t wakes it to answer. |

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

The same tools work for a repository's webhooks (give `repo`) and a
workspace's (give `workspace` instead).

| Tool | Route |
| --- | --- |
| `list_webhooks` | `GET /repos/{owner}/{name}/hooks`, `GET /workspaces/{workspace}/hooks` |
| `create_webhook` | `POST …/hooks` with `url`, `events`, `secret` |
| `update_webhook` | `PATCH …/hooks/{id}` with `url`, `events`, `active` |
| `delete_webhook` | `DELETE …/hooks/{id}` |
| `ping_webhook` | `POST …/hooks/{id}/pings` |
| `list_webhook_deliveries` | `GET …/hooks/{id}/deliveries` |
| `redeliver_webhook` | `POST …/hooks/{id}/deliveries/{delivery}/redeliver` |

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/hooks \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/g1t", "events": ["pull.merged", "checks.completed"]}'
```
