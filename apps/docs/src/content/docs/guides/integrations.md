---
title: Integrations
description: Connect the tools your team and you already use. Workspace integrations work for everyone in a workspace; personal ones work just for you, in every workspace. What is available today, what is coming, and how to ask for one.
---

g1t connects to the tools your work already lives in: where errors are
reported, where tickets are tracked, where code came from. Every
integration is listed in one directory, by category, whether it works
today or is still being built. The directory is **Integrations**, at
`g1t.sh/<workspace>/-/integrations`.

## Workspace and personal

There are two places to connect things, and they are for different people:

| | Workspace integrations | Your integrations |
| --- | --- | --- |
| Where | **Integrations**, at `g1t.sh/<workspace>/-/integrations`, with each integration's setup page under it | **Your settings → Integrations**, at [`g1t.sh/settings/integrations`](https://g1t.sh/settings/integrations) |
| Who it is for | Everyone in that workspace | Just you, in every workspace you belong to |
| Who connects | Workspace owners. Members see what is connected. | You |
| Examples | Your AI providers, Sentry, Jira, Linear, GitHub imports, webhooks | Signing in with GitHub, coding agents you connect through MCP, and soon your calendar |

Some tools have both sides. GitHub, for instance: a workspace owner
installs g1t's GitHub App to import the team's repositories, and
you link your own GitHub account to sign in with it. Each card says when
the other side exists.

## The directory

Both pages are the same directory:

- **Categories** down the side (along the top on a phone): Code & CI,
  Issues & projects, Chat & meetings, Calendar & email, Docs & knowledge,
  Monitoring & incidents, Cloud & deploy, AI models, Data & analytics, CRM & support,
  Design, Security & identity, and Files & storage. Each shows how many
  integrations it has. A link can open on one, with `?category=code` and
  so on.
- **Search** finds an integration by name, by what it does ("in a meeting",
  "opens issues"), or by a tag, across every category.
- **Connected** comes first: what is set up here, with a line about each
  (the account, how many connections) and **Needs attention** when
  something is wrong, such as a key that stopped working or a GitHub
  installation that was suspended. Choose one to manage it.
- **Available** can be connected now. Choose one to open its setup page.
- **Soon** is being built. Each says what it will do, and **Ask for this**
  tells g1t you want it (below).

The tags on a card say what an integration lets g1t do: **Opens issues**,
**Writes back** (the other system hears when work lands), **Imports
repositories**, **Sets your status**, and so on.

## Available today

| Category | Workspace | Personal |
| --- | --- | --- |
| Code & CI | [GitHub](/guides/github/) import, [webhooks](/guides/webhooks/) | [Signing in with GitHub](/guides/github/#link-and-unlink-github); [MCP clients](/guides/authentication/#signing-in-with-oauth): your [coding agent](/guides/bring-your-own-agent/), connected to g1t as you; [Claude Code plugin](/guides/claude-code-plugin/) |
| Issues & projects | [Jira and Linear](#trackers) | |
| Monitoring & incidents | [Sentry, Datadog, and any system that sends a webhook](#alerts) | |
| AI models | [Your AI providers](#your-ai-providers): Anthropic, OpenAI, Google Gemini, xAI, Mistral, DeepSeek, Azure OpenAI, OpenRouter, Groq, Together AI, Fireworks AI, Cerebras, and any Anthropic- or OpenAI-compatible endpoint | |

AI providers, alerts and trackers each have a setup page under the
directory: `-/integrations/models`, `-/integrations/alerts` and
`-/integrations/trackers`. GitHub and webhooks
keep their own pages; the directory links to them.

Secrets are sealed when they are saved and never shown again, to anyone.
A setup page shows the last four characters of a key, so you can tell keys
apart.

## Coming soon

Every category has integrations on the way, among them Slack, Microsoft
Teams, Google Docs, PagerDuty, AWS, Miro, Okta and Google Drive for
workspaces. For you: **Google Calendar** and **Outlook
Calendar** will set your [status](/guides/chat/#presence-and-status) to *In a meeting* while
you are in one; **Zoom**
and **Google Meet** will set it to *On a call*. A status you set by hand
always wins over one an integration sets.

The directory lists them all. Nothing on a **Soon** card does anything
yet.

## Ask for an integration

On any **Soon** card, **Ask for this** opens an email to g1t with the
integration and your workspace (or "for my own account") filled in. Add
what you would use it for and send it. Searching for something that is
not listed offers the same, for whatever you searched for. Requests decide
what is built next.

## Your AI providers

**Your AI providers**, at `g1t.sh/<workspace>/-/integrations/models`, is
where a workspace keeps the credentials for the AI providers its team
uses, so g1t can hand work to them. Only workspace owners add, test,
change and remove them; members see which are connected.

- **Add one.** Choose a provider and paste its API key. Anthropic, OpenAI,
  Google Gemini, xAI, Mistral, DeepSeek, OpenRouter, Groq, Together AI,
  Fireworks AI and Cerebras need only the key. Azure OpenAI also needs
  your resource's endpoint and the deployment's name. An Anthropic- or
  OpenAI-compatible endpoint (your own gateway, LiteLLM, vLLM and the
  like) needs its base URL over `https://`, and takes a key if it asks for
  one, sent as `x-api-key` or `Authorization: Bearer`. You can name the
  model your team uses on each.
- **Test.** g1t checks a key as it is saved, and again whenever you choose
  **Test**, by asking the provider for its models. A key that works shows
  how many models it offers; one that fails says why, on the connection,
  until it next works. An endpoint that does not list its models is
  reached, but its key cannot be checked this way.
- **Change.** **Change its model, address or key** sets a new model or
  address, or replaces the key. The old key is gone once the new one is
  saved.
- **Remove.** The **×** on a connection disconnects it and deletes its key.

Keys are sealed when they are saved and never shown again, to anyone; the
page shows only their last four characters.

**Ask**, in the top bar, answers with one of these providers: an owner
chooses which, and its model (**Auto**, the default, picks one for each question), under **Ask g1t** on this page. See
[Ask g1t](/guides/ask/).

With an **Anthropic** connection, members can also start a session on an
issue (**Start a session** on the issue, or `g1t work dispatch`): a Claude
Managed Agents session on that account, with its key, recorded on g1t.
g1t keeps one agent and one environment on the account for it, and
uploads its own skills there the first time. See
[Start a session on your Anthropic account](/guides/sessions/#start-a-session-on-your-anthropic-account).

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

Text in an alert can include what your users typed, such as an error
message built from a request. Issues opened from alerts say so.

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
  first, so whoever picks it up starts at the failing line.
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

Connect Jira or Linear and tickets become something people and your
coding agents can reach from g1t.

### Look up a ticket

Give a ticket key or address (`TECH-1234`,
`https://acme.atlassian.net/browse/TECH-1234`,
`https://linear.app/acme/issue/ENG-42/…`, a Sentry issue's address) and
g1t fetches it from the system it lives in, with its title, status and
description as they are now. Your coding agent looks one up over MCP with
the `search` tool's `ticket` action, or through the API:

```sh
curl "https://api.g1t.sh/repos/acme/web/context?reference=TECH-1234" \
  -H "Authorization: Bearer $G1T_TOKEN"
```

### Import a ticket as an issue

On a repository's **New issue** page, give a key or paste an address under
**Bring one in**. g1t opens an issue with the ticket's title and
description, linked to it. Importing the same ticket again opens the issue already made.

From the API or MCP:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/issues/import \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"reference": "TECH-1234"}'
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
token (a workspace token cannot):

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

`provider` is an AI provider (`anthropic`, `openai`, `gemini`, `xai`,
`mistral`, `deepseek`, `azure_openai`, `openrouter`, `groq`, `together`,
`fireworks`, `cerebras`, `anthropic_endpoint` or `openai_endpoint`), or
`sentry`, `datadog`, `webhook`, `jira` or `linear`. `config` takes `repo`,
`label`, `write_back`, `organization`, `site`, `email` and `keys`, and for
an AI provider `base_url`, `auth_header` and `model`; each provider uses
the ones above. For `datadog`
and `webhook`, the response's `signing_secret` is the only time the secret
is shown.
