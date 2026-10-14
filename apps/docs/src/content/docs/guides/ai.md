---
title: AI providers
description: Choose the models g1t works with in your workspace. Use a frontier lab or a model platform, or a model you host yourself, on your own keys. Ask, @g1t in Chat and sessions on issues answer with them.
---

**AI**, at `g1t.sh/<workspace>/-/ai`, is where a workspace chooses the
models g1t works with. It is one of the workspace's own settings, like
Billing or Runners, and not an integration: the
[Integrations](/guides/integrations/) directory is for connecting other
products, such as Sentry or Linear.

Everything here runs on your workspace's own keys. g1t hosts no model for
it and bills nothing for it: what a model costs is on your provider's
bill, under your agreement with them.

What uses it:

- **[Ask g1t](/guides/ask/)**, in the top bar, and **@g1t in Chat**
  answer with the provider and model chosen under **Ask g1t**.
- **Sessions on issues** start on the workspace's Anthropic provider. See
  [Start a session on your Anthropic account](/guides/sessions/#start-a-session-on-your-anthropic-account).

Only workspace owners add, test, change and remove providers, and choose
what Ask uses. Members see which providers there are and what Ask answers
with.

## Choose where models come from

**Add a provider** lists them in three groups. A workspace can have any
number of providers, from any mix of groups.

| Group | Providers | What it needs |
| --- | --- | --- |
| Frontier labs | Anthropic, OpenAI, Google Gemini, xAI, Mistral, DeepSeek | An API key |
| Model platforms | Azure OpenAI, OpenRouter, Groq, Together AI, Fireworks AI, Cerebras | An API key. Azure OpenAI also needs your resource's endpoint and the deployment's name. |
| Self-hosted or your own gateway | Anthropic-compatible endpoint, OpenAI-compatible endpoint | A base URL over `https://`, and a key if it asks for one |

**Self-hosted or your own gateway** is for a model you run yourself
(vLLM, Ollama behind a tunnel) or a gateway in front of other providers
(LiteLLM, your own proxy, Amazon Bedrock or Google Vertex AI behind one).
For an Anthropic-compatible endpoint, give the base URL without `/v1`,
such as `https://llm.acme.dev`. For an OpenAI-compatible endpoint, give
it up to and including the version, such as `https://llm.acme.dev/v1`. The
key is sent as `x-api-key` (Anthropic's header) or
`Authorization: Bearer` (OpenAI's and most others'), whichever you choose.

You can name the model your team uses on each provider. It is optional,
except for Azure OpenAI, where it is the deployment.

### Anthropic Console workspace

Sessions on issues run on the Anthropic provider's account, and the
Anthropic Console shows each one in the Console workspace its key belongs
to. A session does not say which workspace that is, so if the key is not
in the account's Default workspace, tell g1t: paste any Console address
from that workspace (such as
`https://platform.claude.com/workspaces/wrkspc_01AbC…/sessions`), or its
`wrkspc_` id, into the provider's **Console workspace**. Links to its
sessions then open there. Left empty, they open in the Default workspace.

## Look after a provider

- **Test.** g1t checks a key when it is saved, and again whenever you
  choose **Test**, by asking the provider for its models. A key that
  works shows how many models it offers. One that fails says why, on the
  provider, until it next works. An endpoint that does not list its
  models is reached, but its key cannot be checked this way.
- **Change.** **Change its model, address or key** sets a new model or
  address, or replaces the key (for Anthropic, its model, Console
  workspace or key). The old key is gone once the new one is
  saved.
- **Remove.** The **×** on a provider removes it and deletes its key. If
  Ask was using it, Ask is turned off until an owner chooses another.

Keys are sealed when they are saved and never shown again, to anyone. The
page shows only their last four characters, so you can tell keys apart.
A key is used to call the provider and is never sent to your browser.

## Choose what Ask answers with

Under **Ask g1t**, at the top of the page, an owner chooses one of the
workspace's providers and its model, then **Use for Ask**:

- **Auto**, the default, picks a model of that provider for each
  question: a fast one for a short lookup, a standard one for questions
  about why, how, what shipped, or a long conversation. See
  [Auto](/guides/ask/#auto).
- **A model by name** uses that one for every answer. Choose from the
  models the provider offered when it was last tested, or, for one that
  lists none, write the name.

**Turn Ask off** stops Ask and @g1t answering until a provider is chosen
again.

## From the API

Owners manage a workspace's AI through the API and MCP with a person's
token (a workspace token cannot). Members can list the providers and read
what Ask answers with.

| MCP tool and action | Route |
| --- | --- |
| `ai` `list_providers` | `GET /workspaces/{workspace}/ai/providers` |
| `ai` `add_provider` | `POST /workspaces/{workspace}/ai/providers` |
| `ai` `update_provider` | `PATCH /workspaces/{workspace}/ai/providers/{id}` |
| `ai` `test_provider` | `POST /workspaces/{workspace}/ai/providers/{id}/test` |
| `ai` `remove_provider` | `DELETE /workspaces/{workspace}/ai/providers/{id}` |
| `ai` `get_ask` | `GET /workspaces/{workspace}/ai/ask` |
| `ai` `set_ask` | `PUT /workspaces/{workspace}/ai/ask` |

```sh
curl -X POST https://api.g1t.sh/workspaces/acme/ai/providers   -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json"   -d '{"provider": "openai_endpoint", "name": "Our vLLM", "config": {"base_url": "https://llm.acme.dev/v1", "model": "qwen3-coder"}, "secret": "<key>"}'
```

`provider` is one of `anthropic`, `openai`, `gemini`, `xai`, `mistral`,
`deepseek` (frontier labs), `azure_openai`, `openrouter`, `groq`,
`together`, `fireworks`, `cerebras` (model platforms), `anthropic_endpoint`
or `openai_endpoint` (self-hosted or your own gateway). `config` takes
`base_url`, `auth_header` (`x-api-key` or `authorization`) and `model`.
The key is checked as it is saved: the response's `models` lists what it
offers, and `last_error` says why a check failed. `secret` is write-only;
`secret_hint` shows its last four characters.

To choose what Ask answers with, `PUT /workspaces/{workspace}/ai/ask` with
`provider_id` (a provider's `id`) and `model` (`auto` for
[Auto](/guides/ask/#auto), or a model it offers). Without `provider_id`,
Ask is turned off.
