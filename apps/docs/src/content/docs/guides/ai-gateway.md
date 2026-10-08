---
title: AI Gateway
description: Send your own code's model requests through g1t in Anthropic's or OpenAI's format, with a workspace access token, to Claude, open models or your own providers, with a log of every request.
---

The AI Gateway takes model requests from your own code and sends them to
the model. It speaks two formats, and any model works in either:

| Format | Base URL | For |
| --- | --- | --- |
| Anthropic's Messages API | `https://models.g1t.sh/anthropic` | Anthropic's SDKs, Claude Code, and anything else that speaks that format |
| OpenAI's Chat Completions API | `https://models.g1t.sh/openai/v1` | OpenAI's SDKs, and any tool that lets you set an OpenAI-compatible base URL |

In both, the API key is a workspace access token (`g1t_…`) with the
`models:write` scope.

The model a request names decides where it goes:

- **g1t's models**: Claude on Anthropic, and open models on Workers AI.
  Each request is charged to the workspace at the model's price and paid
  from the plan's included usage and
  [AI credit](/guides/usage-and-billing/#ai-credit). While the gateway is in
  beta there is no markup.
- **Your own providers**: an Anthropic key, an OpenAI key, or any endpoint
  that speaks either API, connected under
  [Integrations](/guides/models/#connect-a-provider). You choose which models
  go to each. Those requests are counted and never charged on g1t.

Every request is logged with its format, who served it, its model, tokens,
cost and status. Prompts and answers are never kept.

## Before you start

You need one of these:

- **The workspace on the g1t plan**, with AI credit or this month's
  included usage left. See [AI credit](/guides/usage-and-billing/#ai-credit).
- **One of the workspace's own model providers**, connected under
  [Integrations](#your-own-providers). Requests for the models it takes need
  no plan and cost nothing on g1t.

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

The token goes in `x-api-key` or in `Authorization: Bearer`, in either
format. The gateway answers these routes:

| Route | What it does |
| --- | --- |
| `POST /anthropic/v1/messages` | A message, streamed (`"stream": true`) or whole. Logged and charged. |
| `POST /anthropic/v1/messages/count_tokens` | Counts a request's input tokens. Not logged, and costs nothing. For a model that does not speak Anthropic's API, an estimate. |
| `POST /openai/v1/chat/completions` | A chat completion, streamed or whole. Logged and charged. |
| `POST /openai/v1/embeddings` | Embeddings, from an embeddings model. Logged and charged by their input tokens. |
| `GET /openai/v1/models` | The models this workspace can use, with g1t's prices. |

### Anthropic's format

With curl:

```sh
curl https://models.g1t.sh/anthropic/v1/messages \
  -H "x-api-key: $G1T_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-haiku-5-5",
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
  model: "claude-haiku-5-5",
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
    model="claude-haiku-5-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a commit message for: fix the login redirect"}],
)
```

Request and answer bodies are Anthropic's, and so are streamed events. To
an open model, such as `workers-ai/@cf/openai/gpt-oss-120b`, the request is
translated: messages, system prompt, images, tools and tool results,
`tool_choice`, stop sequences, `output_config.effort` (as
`reasoning_effort`, `xhigh` and `max` as `high`) and `output_config.format`
(as a JSON schema). The answer comes back as an Anthropic message, tool
calls included. Server tools have no counterpart there and are refused on
g1t's models.

### OpenAI's format

With curl:

```sh
curl https://models.g1t.sh/openai/v1/chat/completions \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "model": "anthropic/claude-haiku-5-5",
    "messages": [{ "role": "user", "content": "Write a commit message for: fix the login redirect" }]
  }'
```

With OpenAI's TypeScript SDK:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://models.g1t.sh/openai/v1",
  apiKey: process.env.G1T_TOKEN,
});

const completion = await client.chat.completions.create({
  model: "workers-ai/@cf/openai/gpt-oss-120b",
  messages: [{ role: "user", content: "Label this issue: the login page is blank on Safari" }],
});
```

With OpenAI's Python SDK:

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://models.g1t.sh/openai/v1",
    api_key=os.environ["G1T_TOKEN"],
)

completion = client.chat.completions.create(
    model="anthropic/claude-sonnet-5-5",
    messages=[{"role": "user", "content": "Summarize this diff in one sentence."}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in completion:
    print(chunk.choices[0].delta.content or "" if chunk.choices else "", end="")
```

Embeddings:

```sh
curl https://models.g1t.sh/openai/v1/embeddings \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "content-type: application/json" \
  -d '{ "model": "workers-ai/@cf/baai/bge-m3", "input": ["fix the login redirect"] }'
```

What OpenAI's format supports, to any model:

| In the request | |
| --- | --- |
| `messages` | `system`, `developer`, `user`, `assistant` and `tool` messages. User content can be text, `image_url` (a URL or a `data:` URL) and, to Claude, `file` with `file_data` (a PDF as a `data:` URL). |
| `tools`, `tool_choice`, `parallel_tool_calls` | Function tools. To Claude, `required` is `any` and a named function is that tool. |
| `stream`, `stream_options.include_usage` | Server-sent chunks, ending with `data: [DONE]`. With `include_usage`, a last chunk carries the usage. |
| `max_tokens`, `max_completion_tokens` | To Claude, 8,192 when neither is given. |
| `temperature`, `top_p`, `stop`, `user` | As given. Some models refuse sampling settings. |
| `reasoning_effort` | To Claude, `output_config.effort`; `minimal` and `none` are `low`. |
| `response_format` | `json_schema` is a JSON schema the answer follows. `json_object` asks Claude for one JSON object. |
| `thinking` | To Claude, passed as it is, for a caller that sets Anthropic's thinking. |

To Claude, the answer's `usage` counts cached tokens in `prompt_tokens`,
with `prompt_tokens_details.cached_tokens`; Claude's thinking comes back as
`reasoning_content`. Claude's thinking blocks must go back with the tool
calls they led to, so the gateway carries them in the first tool call's
`id`: send the `id` back unchanged in the assistant message and the `tool`
message, as OpenAI's SDKs do. `n` above 1 is refused for Claude.

### Claude Code and other tools

Claude Code speaks Anthropic's format. Set two environment variables
before you start it:

```sh
export ANTHROPIC_BASE_URL=https://models.g1t.sh/anthropic
export ANTHROPIC_AUTH_TOKEN=g1t_…
claude
```

Claude Code's own small requests go to Claude Haiku 4.5, which the gateway
offers. To choose the main model, also set `ANTHROPIC_MODEL`, such as
`claude-opus-5-5`, or `ANTHROPIC_SMALL_FAST_MODEL`, such as
`claude-haiku-5-5`.

Any other tool that lets you set an OpenAI-compatible base URL and key
works the same way: give it `https://models.g1t.sh/openai/v1` and the
token, and a model id from [the models list](#models).

## Models

### Model ids

A request names a model:

| Id | Goes to |
| --- | --- |
| `anthropic/claude-sonnet-5-5` | Claude on g1t's account, in either format |
| `claude-sonnet-5-5` | The same, as Anthropic's API names it |
| `workers-ai/@cf/openai/gpt-oss-120b` | An open model on g1t's account, in either format |
| `@cf/openai/gpt-oss-120b` | The same |
| Any id one of your own providers takes, such as `gpt-5.5` or `ollama/llama3.3` | That provider, with its key. See [your own providers](#your-own-providers). |

Your own providers come first: when one of them takes a model, the request
goes there, even one that names a model g1t offers. An Anthropic key takes
`claude-*` unless you choose otherwise, so with one connected, Claude goes to
your key.

`GET /openai/v1/models` lists what the workspace can use: its own
providers' models first, then g1t's, cheapest Claude first. Each has
`billed_to` (`workspace` or `g1t`), `connection` (your provider's name) and,
on g1t's models, `pricing` in dollars per million tokens:

```json
{
  "object": "list",
  "data": [
    {
      "id": "anthropic/claude-haiku-5-5",
      "object": "model",
      "created": 0,
      "owned_by": "anthropic",
      "name": "Claude Haiku 5.5",
      "kind": "chat",
      "billed_to": "g1t",
      "connection": null,
      "pricing": {
        "currency": "usd",
        "input": 0.1,
        "output": 0.5,
        "cache_read": 0.01,
        "cache_write": 0.125,
        "cache_write_1h": 0.2,
        "long_prompt": { "above_tokens": 100000, "input": 0.5, "output": 2.5, "cache_read": 0.05, "cache_write": 0.625, "cache_write_1h": 1 }
      }
    }
  ]
}
```

### Claude, on Anthropic

Prices are per million tokens, Anthropic's list price. Cache writes are
five-minute ones; one-hour cache writes (`"ttl": "1h"`) cost twice the
input price.

| Model | `model` | Input | Output | Cache reads | Cache writes | One-hour cache writes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Haiku 5.5 | `claude-haiku-5-5` | $0.10 | $0.50 | $0.01 | $0.125 | $0.20 |
| Claude Haiku 5.5, prompts over 100,000 tokens | `claude-haiku-5-5` | $0.50 | $2.50 | $0.05 | $0.625 | $1.00 |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | $2.00 | $10.00 | $0.10 | $2.50 | $4.00 |
| Claude Opus 5.5 | `claude-opus-5-5` | $4.00 | $20.00 | $0.20 | $5.00 | $8.00 |
| Claude Haiku 4.5 | `claude-haiku-4-5`, `claude-haiku-4-5-20251001` | $1.00 | $5.00 | $0.10 | $1.25 | $2.00 |

Claude Haiku 5.5 is the cheapest Claude and the one to start with. It is
priced by the prompt's length: a request whose prompt (its input, cache
read and cache write tokens) is longer than 100,000 tokens is charged
entirely at the higher prices. It takes effort, like Opus: set
`output_config.effort` in Anthropic's format, or `reasoning_effort` in
OpenAI's.

### Open models, on Workers AI

Prices are per million tokens, Cloudflare's list price. Workers AI has no
prompt-cache price: cached tokens, where a model reports them, cost what
input does.

| Model | `model` | Input | Output |
| --- | --- | --- | --- |
| GLM-5.3 Flash | `workers-ai/@cf/zai-org/glm-5.3-flash` | $0.15 | $0.50 |
| gpt-oss-20b | `workers-ai/@cf/openai/gpt-oss-20b` | $0.20 | $0.30 |
| Llama 4 Scout | `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct` | $0.27 | $0.85 |
| gpt-oss-120b | `workers-ai/@cf/openai/gpt-oss-120b` | $0.35 | $0.75 |
| Mistral Small 3.1 | `workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct` | $0.351 | $0.555 |
| DeepSeek V4 Flash | `workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731` | $0.44 | $1.32 |
| Nemotron 3 120B | `workers-ai/@cf/nvidia/nemotron-3-120b-a12b` | $0.50 | $1.50 |
| Kimi K2.6 | `workers-ai/@cf/moonshotai/kimi-k2.6` | $0.95 | $4.00 |
| DeepSeek V4 Pro | `workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813` | $1.32 | $3.96 |
| GLM-5.3 | `workers-ai/@cf/zai-org/glm-5.3` | $1.40 | $4.40 |

Embeddings, through `POST /openai/v1/embeddings` only:

| Model | `model` | Input |
| --- | --- | --- |
| BGE M3 | `workers-ai/@cf/baai/bge-m3` | $0.012 |
| BGE Base (English) | `workers-ai/@cf/baai/bge-base-en-v1.5` | $0.067 |

Open models cost much less per call than Claude, and suit one-shot work:
titles, summaries, labels, triage, embeddings. In a long loop that sends
the same context every turn, Claude's cache reads close most of that gap.

### What is refused on g1t's models

A request for a model nobody offers is refused with `404` before it
reaches a provider, and the error names the models offered. On g1t's
models a request is charged only by its tokens, so what a provider bills
some other way is refused with `400` for now:

| Not offered on g1t's models yet | In the request |
| --- | --- |
| Fast mode | `speed` other than `standard` |
| Inference in one region | `inference_geo` other than `global` |
| Server-side fallbacks | `fallbacks` |
| Server tools, such as web search, web fetch and code execution | In Anthropic's format, a tool whose `type` is not your own (`custom` or none) or a client tool (`bash_…`, `text_editor_…`, `computer_…`, `memory_…`). In OpenAI's, a tool that is not a `function`, or `web_search_options`. |
| Containers and skills | `container` |

All of them work on your own provider, which bills them. In Claude Code on
g1t's models, its web search fails for this reason; the rest of Claude Code
works.

## Your own providers

Connect a model provider under **Integrations**, and choose which models
your own code's gateway requests send to it. Requests there use its key,
are counted in the log, and are never charged on g1t. Any provider works:

| Provider | Takes, unless you choose |
| --- | --- |
| An Anthropic key, or an Anthropic-compatible endpoint | `claude-*` |
| An OpenAI key, or any other provider | Nothing until you choose |
| An OpenAI-compatible endpoint: a self-hosted vLLM or Ollama, LiteLLM, another provider | Nothing until you choose |

1. Open the workspace's **Integrations** and choose a provider under
   **Model providers**. For your own server, choose **OpenAI-compatible
   endpoint** or **Anthropic-compatible endpoint** and give its base URL.
2. Paste its key. It is sealed when saved and never shown again: the page,
   the API and MCP show only its last four characters.
3. Under **AI Gateway models**, list the models to send there, separated by
   spaces:

   | Write | Takes |
   | --- | --- |
   | `gpt-5.5` | That model only |
   | `gpt-*` | Every model whose id starts with `gpt-` |
   | `ollama/*` | Every model named `ollama/…`, sent without the prefix: `ollama/llama3.3` arrives as `llama3.3` |
   | `*` | Every model |
   | Nothing | No gateway requests |

4. Select **Connect**. To change the list or replace the key later, open
   **Change its AI Gateway models or key** under the provider.

The first provider, in the order they were connected, that takes a model
gets its requests. Either format reaches either kind of provider: a Claude
key answers OpenAI-format requests, and an OpenAI-compatible endpoint
answers Claude Code. Agent runs choose their models under
[routing](/guides/models/), apart from this list.

From code, connect one with
[`POST /workspaces/{workspace}/integrations`](/reference/api/integrations/connect-integration/)
and change it with
[`PATCH /workspaces/{workspace}/integrations/{id}`](/reference/api/integrations/update-integration/),
with `config.gateway_models`, or the `workspace` MCP tool's
`connect_integration` and `update_integration` actions. Both need
`workspace:admin` and act for an owner. The key is write-only: neither
returns it.

```sh
curl -X PATCH https://api.g1t.sh/workspaces/acme/integrations/con_01kpx5c2d8e4f6g0h2j4k6m8n0 \
  -H "Authorization: Bearer $G1T_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{ "config": { "base_url": "https://gpu.acme.dev/v1", "gateway_models": ["ollama/*"] }, "secret": "…" }'
```

`config` replaces the provider's settings whole, so send the ones it has
with the change.

## What it costs

| Where it goes | You pay |
| --- | --- |
| g1t's models | Its tokens at the model's price above, with no markup while the gateway is in beta |
| Your own providers | Nothing on g1t. The provider bills you for the model. |

On g1t's models:

- Each request that used tokens is one line on the statement, under
  **AI Gateway**, such as *AI Gateway: Claude Sonnet 5.5, 14,352 tokens,
  token release-notes*. A Claude Haiku 5.5 request over 100,000 prompt
  tokens says *long-prompt price*.
- The plan's included usage pays first, then AI credit. Trial credit and
  g1t's open-source pool never pay for gateway requests.
- It is not an agent run, so the [agent rate](/guides/usage-and-billing/#the-agent-rate)
  does not apply.
- It counts toward the workspace's [spend limit](/guides/usage-and-billing/#your-spend-limit)
  like any other usage, and shows on **Usage** under the AI Gateway product.
- A workspace with a 100% discount gets it free through the discount; an
  enterprise is invoiced for it after use.

## Limits and errors

A request on g1t's models is refused before it reaches the model when:

- The workspace is over its spend limit.
- It is on the plan, and has no AI credit and none of this month's included
  usage left. If auto-reload is on, g1t tries it first.
- It is not on the g1t plan.

Errors are in the format of the route, so SDKs raise their usual errors.
Anthropic's:

```json
{ "type": "error", "error": { "type": "billing_error", "message": "The acme workspace is out of AI credit …" } }
```

OpenAI's:

```json
{ "error": { "message": "The acme workspace is out of AI credit …", "type": "insufficient_quota", "param": null, "code": "insufficient_quota" } }
```

| Status | Anthropic's `error.type` | OpenAI's `error.type` (`code`) | Why |
| --- | --- | --- | --- |
| `400` | `invalid_request_error` | `invalid_request_error` | The body is not JSON, the model is of the wrong kind, the request asks for something [not offered on g1t's models yet](#what-is-refused-on-g1ts-models), or it cannot be said to the model (such as `n` above 1 to Claude). |
| `401` | `authentication_error` | `authentication_error` (`invalid_api_key`) | The token is unknown, expired or deleted, or your provider refused its key. |
| `402` | `billing_error` | `insufficient_quota` (`insufficient_quota`) | Out of AI credit, over the spend limit, or not on the plan. The message says what an owner can do. |
| `403` | `permission_error` | `permission_error` | Not a workspace's token, or it lacks `models:write`. |
| `404` | `not_found_error` | `invalid_request_error` (`model_not_found`) | No provider offers the model, or a route the gateway does not answer. |

An error from the model provider, such as `429` or `529`, comes back with
its status and message, in the route's format. A provider's key never
appears in an error or the log, even when the provider quotes it. Refused
and failed requests are logged with their status and why, and cost
nothing. Every answer carries `x-g1t-request-id`, the request's id in the
log.

A deleted token, a provider added or changed under Integrations, or AI
credit just bought takes effect within about ten seconds.

## See every request

The **AI Gateway** page lists the workspace's requests, newest first. Open
it from the link under **Usage**, or at `g1t.sh/<workspace>/-/gateway`.
Every member can see it.

| Column | |
| --- | --- |
| Time | When it was sent. Hover for the exact time, how long it took and whether it streamed. |
| Model | The model it named on g1t's models, or the one that answered on your own provider; below it, the format it was sent in. |
| Served by | g1t's account and the provider (*g1t · Anthropic*, *g1t · Workers AI*), or your provider by name. *None* when it was refused first. |
| Input, Output | Its tokens by kind. Hover Input for all of them. |
| Cache | Cache reads, then cache writes. Hover for how many writes were to the one-hour cache. |
| Cost | What it was charged, before included usage and AI credit paid for it, or **Not charged** on your own provider. |
| Status | The status it was answered with. Hover a refusal or failure for why. |
| Token | The name of the token that sent it. |

Requests are kept 30 days.

From code, list them with
[`GET /workspaces/{workspace}/gateway/requests`](/reference/api/billing/list-gateway-requests/),
or the `billing` MCP tool's
[`gateway_requests`](/reference/mcp/#billing) action. Each request has
`format`, `provider`, `connection`, `model` and its tokens, with
`cache_write_hour` for one-hour cache writes. Both need `models:read`,
which the Read only and Agent presets include.
