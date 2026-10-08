---
title: Integrations
description: Connect Sentry, Datadog, Jira, Linear and anything that sends a webhook, so problems become issues and agents read the tickets the work refers to.
---

A workspace connects to the systems its work already lives in. There are
three kinds of connection:

| Kind | Systems | What it does |
| --- | --- | --- |
| [Model providers](/guides/models/) | Anthropic, OpenAI, Google Gemini, xAI, Mistral, DeepSeek, Azure OpenAI, OpenRouter, Groq, Together AI, Fireworks AI, Cerebras, and any Anthropic- or OpenAI-compatible endpoint | Your agents' model requests go to your own accounts, routed by kind of work. |
| [Alerts](#alerts) | Sentry, Datadog, a signed webhook | A problem opens an issue, once however often it fires, and an agent can start on it at once. |
| [Trackers](#trackers) | Jira, Linear | Agents read the tickets that work mentions, people import tickets as issues, and tickets hear back when the work lands. |

Open the workspace's **Settings → Integrations**. Every member
can see the connections; only owners can add, test or remove them.

Secrets are sealed when they are saved and never shown again, to anyone.
The page shows the last four characters of a key, so you can tell keys
apart. Agents never see a connection's secrets.

## Alerts

An alert source opens issues in one repository. Each problem it reports is
one issue:

- **The first alert** opens an issue labelled `bug` (or the label you set)
  and the provider's name, with what the provider said about the problem.
- **The same problem again** updates that issue instead of opening another.
  The issue says so when the count passes 10, 100, 1,000 and so on.
- **The same problem after its issue was closed** reopens it, with a comment
  linking the new occurrence.
- **A recovery** (Datadog) is noted on the issue.

Turn on **Assign each new issue to g1t** and g1t starts on the
issue as soon as it opens: it makes the change, is reviewed, revises, and
lands through your repository's rules, often before anyone has looked. A
reopened issue gets an agent again. Agents need a way to reach a model:
[your own provider](/guides/models/), or g1t's hosted models where they are
open. Without one, the issue says why no agent started.

Text in an alert can include what your users typed, such as an error
message built from a request. Issues opened from alerts say so, and agents
treat that text as a description of the problem, never as instructions.

Each alert connection shows its last five deliveries: what arrived, and
whether g1t opened, updated, reopened, ignored or refused it.

### Sentry

1. On the **Integrations** page, choose **Sentry**. Give your organization's
   slug and the repository issues go to, then **Connect**.
2. In Sentry, open **Settings → Developer Settings → Custom Integrations**
   and create an **internal integration**:
   - **Webhook URL**: the address g1t shows on the connection,
     `https://api.g1t.sh/hooks/<connection>`.
   - Turn on **Alert Rule Action**, and under **Webhooks** tick **issue**.
   - **Permissions**: Issue & Event, read and write.
3. Save it. Paste its **client secret** into the connection on g1t, and its
   **token** as the connection's auth token.

Then:

- New Sentry issues open g1t issues. So does any alert rule whose action
  sends a notification to the integration.
- With the token, g1t adds the latest event's stack trace, in-app frames
  first, so the agent starts at the failing line.
- When the fix merges, g1t resolves the Sentry issue and comments with the
  pull request. If Sentry sees it again, the g1t issue reopens.

Requests without a valid `Sentry-Hook-Signature` are refused.

### Datadog

1. On the **Integrations** page, choose **Datadog**, pick the repository,
   and **Connect**. g1t shows a signing secret once; copy it.
2. In Datadog, open **Integrations → Webhooks** and add a webhook named
   `g1t`:
   - **URL**: the connection's address.
   - **Custom headers**: `{"Authorization": "Bearer <signing secret>"}`
   - **Payload**:

     ```json
     {
       "id": "$ALERT_ID",
       "title": "$EVENT_TITLE",
       "body": "$EVENT_MSG",
       "url": "$LINK",
       "status": "$ALERT_TRANSITION",
       "priority": "$PRIORITY"
     }
     ```

3. Mention `@webhook-g1t` in the message of any monitor that should open
   issues.

A monitor that triggers opens an issue; `Recovered` is noted on it.

### Any other system

The **Webhook** connection takes JSON from anything that can send it:
PagerDuty, Grafana, a deploy script.

```sh
body='{"id":"checkout-500","title":"Checkout returns 500 for empty carts","body":"POST /checkout fails."}'
curl -X POST https://api.g1t.sh/hooks/$CONNECTION \
  -H "Content-Type: application/json" \
  -H "X-G1t-Signature: sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)" \
  -d "$body"
```

Sign it either way:

- `X-G1t-Signature: sha256=<hex HMAC-SHA256 of the body>`, with the signing
  secret as the key, or
- `Authorization: Bearer <signing secret>`.

g1t reads these fields, taking the first name present:

| Field | Names | Notes |
| --- | --- | --- |
| Title | `title`, `event_title`, `summary`, `name` | Required. |
| Id | `id`, `alert_id`, `aggregate`, `incident_key`, `dedup_key` | Alerts with the same id are one issue. The title if missing. |
| Description | `body`, `message`, `event_msg`, `text`, `description` | Markdown. |
| Link | `url`, `link`, `html_url` | |
| State | `status`, `transition`, `alert_transition`, `state` | `recovered`, `resolved`, `ok` or `closed` means it stopped. |
| Priority | `priority`, `severity`, `level` | |
| Count | `count` | How many times it has happened. |

g1t answers `202` once the request is verified and acts on it just after,
so a slow step never makes the sender retry. It answers `401` to a request
that is not signed, and `200` with the reason to one it ignores.

## Trackers

Connect Jira or Linear and tickets become something agents and people can
reach from g1t.

### Agents read tickets the work mentions

When g1t starts on an issue, or plans an outcome, g1t looks for
ticket keys and addresses in the text (`TECH-1234`,
`https://acme.atlassian.net/browse/TECH-1234`,
`https://linear.app/acme/issue/ENG-42/…`, a Sentry issue's address) and
fetches each from the system it lives in. The agent gets their titles,
statuses and descriptions as reference material, and its session notes
what it read.

So a brief of "Accomplish TECH-1234" works: the planner reads the ticket.

Agents, and your own agent through MCP, can also look a reference up with
the `search` tool's `ticket` action:

```sh
curl "https://api.g1t.sh/repos/acme/web/context?reference=TECH-1234" \
  -H "Authorization: Bearer $G1T_TOKEN"
```

### Import a ticket as an issue

On a repository's **New issue** page, give a key or paste an address under
**Bring one in**. g1t opens an issue with the ticket's title and
description, linked to it. Tick **Put an agent on it** to start one at
once. Importing the same ticket again opens the issue already made.

From the API or an agent:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/issues/import \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"reference": "TECH-1234", "assign": true}'
```

An issue tied to something outside g1t shows it under **From outside g1t**,
with a link to the original.

### Tickets hear back

Unless you turn it off, g1t comments on the ticket when a pull request
opens for its issue, and again when the issue closes as done, with a link
to what merged. For Sentry, closing as done resolves the Sentry issue.

### Jira

| Setting | |
| --- | --- |
| Site | Your Jira's address, such as `https://acme.atlassian.net`. |
| Email | The Atlassian account the API token belongs to. |
| API token | From id.atlassian.com, **Security → API tokens**. g1t sees what that account can see. |
| Project keys | Optional. The projects this connection answers for, such as `TECH, OPS`. Empty answers for any key. |

### Linear

| Setting | |
| --- | --- |
| API key | From Linear, **Settings → Security & access → Personal API keys**. |
| Team keys | Optional, such as `ENG`. Empty answers for any key. |

A key that matches several connections is looked up in the ones that name
its project first.

## From the API

Owners can manage integrations through the API and MCP, with a person's
token (a workspace token or an agent cannot):

| MCP tool and action | Route |
| --- | --- |
| `workspace` `list_integrations` | `GET /workspaces/{workspace}/integrations` |
| `workspace` `connect_integration` | `POST /workspaces/{workspace}/integrations` |
| `workspace` `update_integration` | `PATCH /workspaces/{workspace}/integrations/{id}` |
| `workspace` `test_integration` | `POST /workspaces/{workspace}/integrations/{id}/test` |
| `workspace` `disconnect_integration` | `DELETE /workspaces/{workspace}/integrations/{id}` |
| `search` `ticket` | `GET /repos/{owner}/{name}/context?reference=` |
| `issue` `import` | `POST /repos/{owner}/{name}/issues/import` |

```sh
curl -X POST https://api.g1t.sh/workspaces/acme/integrations \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"provider": "jira", "config": {"site": "https://acme.atlassian.net", "email": "dev@acme.com", "keys": ["TECH"]}, "secret": "<api token>"}'
```

`provider` is one of the [model providers](/guides/models/#from-the-api),
or `sentry`, `datadog`, `webhook`, `jira` or `linear`. `config` takes `repo`, `assign`, `label`,
`write_back`, `organization`, `site`, `email`, `keys`, `base_url`,
`auth_header` and `model`; each provider uses the ones above. For `datadog`
and `webhook`, the response's `signing_secret` is the only time the secret
is shown.
