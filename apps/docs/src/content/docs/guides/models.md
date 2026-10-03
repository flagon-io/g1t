---
title: Your own model provider
description: Send your agents' model requests to your own Anthropic account or endpoint, and pay for the models there.
---

By default, g1t chooses the model for each kind of work, pays the provider,
and charges your workspace's credit what it cost plus a margin. A workspace
can instead send its agents' model requests to its own account:

| Provider | What you give | Fits |
| --- | --- | --- |
| **Anthropic** | An API key | Teams with an Anthropic account or contract |
| **Your own endpoint** | A base URL, and a key if it needs one | Your own Cloudflare AI Gateway, LiteLLM, Bedrock or Vertex behind an Anthropic-compatible proxy, a self-hosted model |

The endpoint has to speak Anthropic's Messages API, because g1t's agents run
Claude Code. To use another vendor's models, put a proxy that translates in
front of them, such as LiteLLM.

## What it costs

With your own provider, the provider bills you for the models and g1t
charges your credit a flat **$0.10 per run** for the sandbox and the
orchestration around it. A change, a review, a revision, a catch-up and a
plan are each a run. Your statement marks these runs "on your own model
provider", and the Usage page shows what they cost at your provider, as
the harness estimated it, beside what g1t charged. See
[Usage and billing](/guides/usage-and-billing/).

Workspaces still need credit to start agents, for the fee.

## Connect it

1. Open the workspace's **Integrations** page. You need to be an owner.
2. Under **Model provider**, choose **Anthropic** or **Your own endpoint**.
3. For Anthropic, paste an API key. For an endpoint, give its base URL
   without `/v1`, its key if it needs one, and whether the key goes in
   `x-api-key` or `Authorization: Bearer`.
4. **Connect**, then **Test**: g1t asks the provider to list its models with
   the key. An endpoint that does not list models is checked on the first
   run instead.

The next agent run uses it. A workspace uses one model provider; disconnect
it to go back to g1t's.

### Choosing the model

Nobody picks a model when assigning work; g1t routes each kind of work to
the model that suits it, and with your own Anthropic key the same models
run on your account. If your endpoint names models its own way, set
**Model** on the connection and every kind of work uses it.

A pull request's session says which model ran, and through which provider.

## Your key never reaches a sandbox

An agent works in a sandbox with internet access, on code and text that
anyone could have written. g1t assumes a sandbox can be talked into
printing its environment, so the key is never in it:

1. When a run starts, g1t gives the sandbox a token for that run only.
2. The sandbox sends its model requests to `https://models.g1t.sh` with that
   token in place of a key.
3. g1t's model proxy looks the token up, adds your key, and forwards the
   request to your provider. Responses stream straight back.

The token stops working when the run ends (three hours at most), or at once
if you disconnect the provider. Your key is sealed when you save it, and
used only by the proxy.
