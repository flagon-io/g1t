---
title: AI Gateway
description: Send your own code's model requests through g1t with a workspace access token, paid from AI credit at the model's price, with a log of every request.
---

The AI Gateway takes model requests from your own code, in Anthropic's
Messages format, and sends them to the model. You point an Anthropic SDK,
Claude Code or anything else that speaks that format at one base URL and
give it a workspace access token as its API key:

| | |
| --- | --- |
| Base URL | `https://models.g1t.sh/anthropic` |
| API key | A workspace access token (`g1t_…`) with the `models:write` scope |

Each request is charged to the workspace at the model's price and paid from
the plan's included usage and [AI credit](/guides/usage-and-billing/#ai-credit).
While the gateway is in beta there is no markup. If the workspace has
connected its own Anthropic key, requests go there instead and cost
nothing on g1t. Every request is logged with its model, tokens, cost and
status. Prompts and answers are never kept.

## Before you start

You need one of these:

- **The workspace on the g1t plan**, with AI credit or this month's
  included usage left. See [AI credit](/guides/usage-and-billing/#ai-credit).
- **The workspace's own Anthropic key**, connected under
  [Integrations](/guides/models/#connect-a-provider). Then the plan is not
  needed and nothing is charged.

## Make a token

The gateway takes a workspace's own token, so its usage is the workspace's
and keeps working when the person who set it up leaves. Only owners make
them.

1. Open the workspace's **Settings → Access tokens**.
2. Under **New token**, give it a name, such as `release-notes`. The log
   shows each request's token by this name.
3. The scopes start on the CI preset. Untick what the code does not need,
   and under **AI Gateway** tick `models:write`. A token with only
   `models:write` can send model requests and nothing else.
4. Choose an expiry and select **Create token**. Copy the token now: it is
   not shown again.

A personal access token is refused, even with `models:write`: the gateway
has to know which workspace to charge. A token with full access has every
scope, `models:write` included. See [scopes](/guides/authentication/#scopes).

## Send a request

The gateway answers the same routes as Anthropic's API, below the base URL:

| Route | What it does |
| --- | --- |
| `POST /anthropic/v1/messages` | A message, streamed (`"stream": true`) or whole. Logged and charged. |
| `POST /anthropic/v1/messages/count_tokens` | Counts a request's input tokens. Not logged, and costs nothing. |

The token goes in `x-api-key`, or in `Authorization: Bearer`. Request and
answer bodies are Anthropic's, unchanged, and so are streamed events.

With curl:

```sh
curl https://models.g1t.sh/anthropic/v1/messages \
  -H "x-api-key: $G1T_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-5-5",
    "max_tokens": 1024,
    "messages": [{ "role": "user", "content": "Write a commit message for: fix the login redirect" }]
  }'
```

With Anthropic's TypeScript SDK:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://models.g1t.sh/anthropic",
  apiKey: process.env.G1T_TOKEN,
});

const message = await client.messages.create({
  model: "claude-sonnet-5-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Write a commit message for: fix the login redirect" }],
});
```

With Anthropic's Python SDK:

```python
import os

import anthropic

client = anthropic.Anthropic(
    base_url="https://models.g1t.sh/anthropic",
    api_key=os.environ["G1T_TOKEN"],
)

message = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a commit message for: fix the login redirect"}],
)
```

### Claude Code

Set two environment variables before you start it:

```sh
export ANTHROPIC_BASE_URL=https://models.g1t.sh/anthropic
export ANTHROPIC_AUTH_TOKEN=g1t_…
claude
```

Claude Code's own small requests go to Claude Haiku 4.5, which the gateway
offers. To choose the main model, also set `ANTHROPIC_MODEL`, such as
`claude-opus-5-5`.

## Models

On g1t's models the gateway offers these. Prices are per million tokens,
the provider's list price; cache writes are five-minute ones.

| Model | `model` | Input | Output | Cache reads | Cache writes |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5.5 | `claude-opus-5-5` | $4.00 | $20.00 | $0.20 | $5.00 |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | $2.00 | $10.00 | $0.20 | $2.50 |
| Claude Haiku 4.5 | `claude-haiku-4-5`, `claude-haiku-4-5-20251001` | $1.00 | $5.00 | $0.10 | $1.25 |

A request for any other model is refused with `400` before it reaches the
provider, and the error names the models offered. On the workspace's own
key, a request can name any model that key can use.

On g1t's models a request is charged only by its tokens, so what the
provider bills some other way is refused with `400` for now:

| Not offered on g1t's models yet | In the request |
| --- | --- |
| Fast mode | `speed` other than `standard` |
| Inference in one region | `inference_geo` other than `global` |
| Server-side fallbacks | `fallbacks` |
| Server tools, such as web search, web fetch and code execution | A tool whose `type` is not your own (`custom` or none) or a client tool (`bash_…`, `text_editor_…`, `computer_…`, `memory_…`) |
| Containers and skills | `container` |

All of them work on the workspace's own key, which the provider bills. In
Claude Code on g1t's models, its web search fails for this reason; the
rest of Claude Code works.

Anthropic's format is the one served today. OpenAI's format and open
models are coming later.

## What it costs

| Where it goes | You pay |
| --- | --- |
| g1t's models | Its tokens at the model's price above, with no markup while the gateway is in beta |
| The workspace's own Anthropic key | Nothing on g1t. The provider bills you for the model. |

On g1t's models:

- Each request that used tokens is one line on the statement, under
  **AI Gateway**, such as *AI Gateway: Claude Sonnet 5.5, 14,352 tokens,
  token release-notes*.
- The plan's included usage pays first, then AI credit. Trial credit and
  g1t's open-source pool never pay for gateway requests.
- It is not an agent run, so the [agent rate](/guides/usage-and-billing/#the-agent-rate)
  does not apply.
- It counts toward the workspace's [spend limit](/guides/usage-and-billing/#your-spend-limit)
  like any other usage, and shows on **Usage** under the AI Gateway product.
- A workspace with a 100% discount gets it free through the discount; an
  enterprise is invoiced for it after use.

### Your own key

When the workspace has an Anthropic or Anthropic-compatible model provider
under [Integrations](/guides/models/), the gateway sends every request to
the first one connected, with its key. Those requests are logged with their
tokens and marked **Own key**, and g1t charges nothing for them. Remove the
provider and requests go to g1t's models again within a few seconds.

## Limits and errors

A request on g1t's models is refused before it reaches the model when:

- The workspace is over its spend limit.
- It is on the plan, and has no AI credit and none of this month's included
  usage left. If auto-reload is on, g1t tries it first.
- It is not on the g1t plan.

Errors are Anthropic's shape, so SDKs raise their usual errors:

```json
{ "type": "error", "error": { "type": "billing_error", "message": "The acme workspace is out of AI credit …" } }
```

| Status | `error.type` | Why |
| --- | --- | --- |
| `400` | `invalid_request_error` | The body is not JSON, the model is not offered, or the request asks for something [not offered on g1t's models yet](#models). |
| `401` | `authentication_error` | The token is unknown, expired or deleted. |
| `402` | `billing_error` | Out of AI credit, over the spend limit, or not on the plan. The message says what an owner can do. |
| `403` | `permission_error` | Not a workspace's token, or it lacks `models:write`. |
| `404` | `not_found_error` | A route the gateway does not answer. |

An error from the model provider, such as `429` or `529`, comes back as
the provider sent it. Refused and failed requests are logged with their
status and why, and cost nothing.

A deleted token, a provider added under Integrations, or AI credit just
bought takes effect within about ten seconds.

## See every request

The **AI Gateway** page lists the workspace's requests, newest first. Open
it from the link under **Usage**, or at `g1t.sh/<workspace>/-/gateway`.
Every member can see it.

| Column | |
| --- | --- |
| Time | When it was sent. Hover for the exact time, how long it took and whether it streamed. |
| Model | The model it named. On the workspace's own key, the one that answered. |
| Input, Output, Cache read, Cache write | Its tokens by kind. |
| Cost | What it was charged, before included usage and AI credit paid for it, or **Own key**. |
| Status | The status it was answered with. Hover a refusal or failure for why. |
| Token | The name of the token that sent it. |

Requests are kept 30 days.

From code, list them with
[`GET /workspaces/{workspace}/gateway/requests`](/reference/api/billing/list-gateway-requests/),
or the `billing` MCP tool's
[`gateway_requests`](/reference/mcp/#billing) action. Both need
`models:read`, which the Read only and Agent presets include.
