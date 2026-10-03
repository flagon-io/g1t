---
title: Model providers
description: Connect Anthropic, OpenAI, Gemini or any compatible endpoint, choose which model does which work, and pay for it where you choose.
---

Each workspace decides where its agents' model spend goes:

- **g1t's hosted models.** g1t chooses the model for each kind of work, pays
  the provider, and charges your workspace's credit what it cost plus a
  margin. Open to selected workspaces until payments go live, then to all.
- **Your own providers.** Connect as many as you use, then choose, for each
  kind of work, which provider and model it runs on. Each provider bills
  you directly. Open to every workspace now.

g1t's own routing is fixed; yours is not.

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
but Anthropic speaks OpenAI's, so g1t's model proxy translates each
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
models. An Anthropic provider also offers **g1t's choice of Claude model**,
which runs g1t's pick for that kind of work on your key. For example: make
changes on Claude through your Anthropic key, review on GPT through your
OpenAI key, and catch up on a small model through OpenRouter.

**Save routing**, and the next runs use it. Without any routing, work goes
to g1t's models where they are open to the workspace, and otherwise to the
first provider you connected.

A pull request's session says which model ran, and through which provider.

## What it costs

On your own providers, they bill you for the models, and g1t charges your
credit a flat **$0.10 per run** for the sandbox and orchestration. A
change, a review, a revision, a catch-up and a plan are each a run. The
statement marks these runs "on your own model provider" and names the
model and provider; the Usage page shows what they cost at the provider,
as the harness estimated it, beside what g1t charged. See
[Usage and billing](/guides/usage-and-billing/).

Workspaces still need credit to start agents, for the fee.

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

The token stops working when the run ends (three hours at most), or at once
if you disconnect the provider. Keys are sealed when you save them, and used
only by the proxy. g1t's own runs work the same way, with g1t's key.

## From the API

| Tool | Route |
| --- | --- |
| `connect_integration` | `POST /workspaces/{workspace}/integrations` with `provider` one of `anthropic`, `openai`, `gemini`, `xai`, `mistral`, `deepseek`, `azure_openai`, `openrouter`, `groq`, `together`, `fireworks`, `cerebras`, `anthropic_endpoint`, `openai_endpoint` |
| `get_model_routes` | `GET /workspaces/{workspace}/model-routes` |
| `set_model_routes` | `PUT /workspaces/{workspace}/model-routes` |

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
