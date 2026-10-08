---
title: Model providers
description: Let Auto choose the model for each job, or choose it yourself; connect Anthropic, OpenAI, Gemini or any compatible endpoint, and pay for models where you choose.
---

Each workspace decides where its agents' model spend goes:

- **g1t's hosted models.** **Auto** chooses the model for each job, g1t pays
  the provider, and your workspace is charged the provider's price, with no
  markup, plus the [agent rate](/guides/usage-and-billing/#the-agent-rate).
  The plan's included usage and [the trial](/guides/usage-and-billing/#the-trial)
  pay for it first. While payments are in test mode, they are open only
  to a few invited workspaces, g1t's own among them; a card check or a
  trial does not open them. Every other workspace connects its own
  provider, and an agent assigned without one is refused with a message
  that says so. Once payments go live, they are open to all.
- **Your own providers.** Connect as many as you use, then choose, for each
  kind of work, which provider and model it runs on. Each provider bills
  you for the model directly. Open to every workspace now.

To call models from your own code with a workspace token, in Anthropic's
or OpenAI's format, paid from the same AI credit or sent to these same
providers, use the [AI Gateway](/guides/ai-gateway/). Each provider's
**AI Gateway models** say which of those requests go to it; see
[your own providers](/guides/ai-gateway/#your-own-providers).

## Auto

On g1t's models you do not have to pick a model. **Auto**, the default,
sends each job to the least costly model that can do it, from three tiers:
**fast** (Claude Haiku 5.5 today), **standard** (Claude Sonnet 5.5) and
**most capable** (Claude Opus 5.5). It decides by the kind of job, the
size of the change it reads, the issue's labels, whether the last attempt
at the same work failed, and what has worked in the repository before:

- Catching up, answering a question, planning, and reviewing a small
  change that touches no sensitive path start on the fast model.
- Making and revising changes, and most reviews, start on the standard
  model.
- Planning runs at high effort (the model thinks longer before it
  answers), answering at medium and catching up at low, on models that
  take an effort level.
- A review of a very large change, work on an issue labelled
  `architecture`, and work that failed twice in a row go to the most
  capable model. One failure moves the next attempt up one tier.
- When the cheaper model finished nearly all of a repository's recent runs
  of the same kind, Auto moves that work down a tier there; when a model
  keeps failing, up.

The models behind the tiers are today's. g1t keeps up with new models
as providers release them: it checks for new ones every day, and when g1t
moves a tier to a new model, your runs use it within a minute, with
nothing for you to change. Nobody picks a model; Auto keeps choosing by the
work. A model a provider retires is never used again: the next model for
that tier runs instead, and the run says so.

Every run says which model it used and why, in one line on its run and in
its pull request's session, such as *Used a fast model (Claude Haiku 5.5):
small change, 3 files and 80 lines.* The full rules are in
[which model runs](/guides/working-with-g1t/#which-model-runs).

## Providers

Labs and platforms need only a key; g1t knows where they are.

| | Provider | What you give |
| --- | --- | --- |
| Labs | **Anthropic** | An API key |
| | **OpenAI** | An API key |
| | **Google Gemini** | An API key from Google AI Studio |
| | **xAI** (Grok) | An API key |
| | **Mistral** | An API key |
| | **DeepSeek** | An API key |
| Platforms | **Azure OpenAI** | Your resource's endpoint, its key, and a deployment name |
| | **OpenRouter** | An API key: hundreds of models from every lab |
| | **Groq** | An API key |
| | **Together AI** | An API key |
| | **Fireworks AI** | An API key |
| | **Cerebras** | An API key |
| Any endpoint | **Anthropic-compatible** | A base URL, and a key if it needs one: your own Cloudflare AI Gateway, LiteLLM, Bedrock or Vertex behind a proxy |
| | **OpenAI-compatible** | A base URL including its version, a model, and a key if it needs one: vLLM, Ollama behind a tunnel, LiteLLM |

An endpoint behind an authenticated Cloudflare AI Gateway also takes the
gateway's token, sent as `cf-aig-authorization`.

g1t's agents run Claude Code, which speaks Anthropic's API. Every provider
but Anthropic and an Anthropic-compatible endpoint speaks OpenAI's, so g1t's model proxy translates each
request, and the streamed answer back, tool calls included, and meets each
provider's quirks: the token limits DeepSeek and Groq set, how Mistral
names a required tool, Azure's `api-key` header, and the thought signatures
Gemini needs back with each tool call. Agents work the same either way.
How well they work depends on the model: it has to be good at using tools
over many steps.

## Connect a provider

1. Open the workspace's **Settings → Integrations**. You need to be an owner.
2. Under **Model providers**, choose one, and give its key (and address, for
   an endpoint).
3. **Connect**. g1t checks the key at once and lists the provider's models.
   **Test** checks it again later.

A workspace can connect any number, including several of the same kind.

## Choose which model does which work

Under **Which model does which work**, each kind of work has a choice:

| Kind of work | |
| --- | --- |
| Everything | Used for any kind of work that does not choose for itself. |
| Making changes | Writing the change for an issue, and revising it. |
| Reviewing | The second agent that reviews each change. |
| Planning | Turning an outcome into issues. |
| Catching up | Bringing a change up to date with `main`. |

Each can go to g1t's models, or to any of your providers on any of its
models.

- **On g1t's models**, choose **Auto** (the default), or a tier for every
  run of that kind: **Fast**, **Standard** or **Most capable**. A run on a
  chosen tier says the workspace chose it.
- **On an Anthropic provider**, leave the model empty for g1t's choice of
  Claude: Auto picks the tier's model for each job, as on g1t's models, on
  your key. Name a model to run that one every time.
- **On any other provider**, name the model.

For example: make changes on Claude through your Anthropic key, review on
GPT through your OpenAI key, catch up on g1t's models on Fast, and plan on
Most capable.

**Save routing**, and the next runs use it. Without any routing, work goes
to g1t's models where they are open to the workspace, and otherwise to the
first provider you connected.

A pull request's session says which model ran, and through which provider.

## What it costs

On g1t's models, each run is charged the model at the provider's price
(what AI Gateway priced its requests at, with no markup), the agent rate
on its tokens, and its sandbox time. Auto keeps the first of those down:
the fast model costs about half what the standard one does, and the most
capable up to twice as much, so most of what it saves comes from sending small
jobs to the fast model and from finishing hard ones instead of retrying
them on the same model.

On your own providers, they bill you for the models. g1t charges each
run's [sandbox time](/guides/usage-and-billing/#sandbox-time), at what it
costs g1t plus 20%, by the second, and the
[agent rate](/guides/usage-and-billing/#the-agent-rate) on the tokens the
run used, from Oct 22, 2026: $0.25 per million, as on g1t's models. Tokens
are counted by g1t's model proxy as answers pass, and by the agent in the
sandbox; the more of the two is charged. On **Usage** it is the line
**Agent rate, your own model key**, with its tokens weighted as the
pricing page says.

Both count toward the workspace's usage limit like any other charge.
**Usage** also shows the agent's tokens by model.

## Your keys never reach a sandbox

An agent works in a sandbox with internet access, on code and text that
anyone could have written. g1t assumes a sandbox can be talked into
printing its environment, so no key is ever in it:

1. When a run starts, g1t gives the sandbox a token for that run only.
2. The sandbox sends its model requests to `https://models.g1t.sh` with that
   token in place of a key.
3. g1t's model proxy looks the token up, adds the key for the provider the
   work is routed to, translates if the provider speaks OpenAI's API, and
   forwards the request. Answers stream straight back.

As each answer passes, the proxy reads how many tokens it used (input,
output, and cache reads and writes) and counts them for the run, under the
person it was for. They show on **Usage** by model, and the
[agent rate](/guides/usage-and-billing/#the-agent-rate) is charged on them.
On g1t's models, the model itself is charged at what AI Gateway priced it
at, never from these counts.

The token stops working within seconds of the run finishing, however it
ends, and within seconds if you disconnect the provider. A run whose end
g1t never hears about loses it three hours after it starts. Keys are sealed when you save them, and used
only by the proxy. g1t's own runs work the same way, with g1t's key.

## From the API

| MCP tool and action | Route |
| --- | --- |
| `workspace` `connect_integration` | `POST /workspaces/{workspace}/integrations` with `provider` one of `anthropic`, `openai`, `gemini`, `xai`, `mistral`, `deepseek`, `azure_openai`, `openrouter`, `groq`, `together`, `fireworks`, `cerebras`, `anthropic_endpoint`, `openai_endpoint` |
| `workspace` `get_model_routes` | `GET /workspaces/{workspace}/model-routes` |
| `workspace` `set_model_routes` | `PUT /workspaces/{workspace}/model-routes` |

```sh
curl -X PUT https://api.g1t.sh/workspaces/acme/model-routes \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"routes": [
        {"task": "default", "connection_id": "con_…anthropic", "model": null},
        {"task": "review", "connection_id": "con_…openai", "model": "gpt-5"}
      ]}'
```

`task` is `default`, `implement`, `review`, `plan` or `update`.
`connection_id` is null for g1t's hosted models. `model` is null for the
provider's default, or for an Anthropic provider, g1t's choice of Claude.
On g1t's hosted models, `model` is `small` (Fast), `large` (Standard) or
`frontier` (Most capable), or null for Auto:

```sh
curl -X PUT https://api.g1t.sh/workspaces/acme/model-routes \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"routes": [
        {"task": "default", "connection_id": null, "model": null},
        {"task": "plan", "connection_id": null, "model": "frontier"}
      ]}'
```
