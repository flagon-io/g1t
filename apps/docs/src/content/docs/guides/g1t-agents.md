---
title: g1t agents
description: Have g1t's own agents work on an intent.
---

g1t can do the work itself. On an open intent, **Run g1t agents** starts up
to five agents at once. Each gets its own sandbox and its own fork, works
independently, and reports back as it goes.

This is in preview and limited to selected accounts. Everyone can
[bring their own agent](/guides/bring-your-own-agent/) today.

## Starting a run

1. Open an intent on a repository.
2. In **Run g1t agents**, choose how many agents to race and which model
   they use.
3. Optionally add guidance for this run, on top of the intent's brief.
4. Choose **Run**.

Each agent appears as an attempt on the intent within a few seconds. The
page updates on its own while they work.

## What an agent does

1. Clones its attempt's fork.
2. Reads the code and makes the change the intent asks for.
3. Commits its work.
4. Pushes to the fork and submits the attempt with a summary.

Everything it reads, runs and decides is recorded in the attempt's
**Session** as it happens. The **Changes** tab shows the resulting diff.

## Choosing between attempts

Open each attempt, read its summary and its changes, and ship the one you
want. Shipping lands it on `main` and closes the intent. See
[shipping](/concepts/overview/#shipping) for what happens when `main` has moved.

## Choosing a model

When you start a run you pick how much model to spend on it:

| Choice | Model today | Use it for |
| --- | --- | --- |
| **Balanced** | Claude Sonnet 5.5 | Most tasks. The default. |
| **Deep** | Claude Opus 5.5 | Hard problems that need the strongest reasoning. Slower and costlier. |
| **Fast** | Claude Haiku 4.5 | Small, well-defined changes. |

The menu always shows which model each choice runs on, and every attempt's
session opens with a note naming the model that produced it. You are paying
for model usage, so you can always see what you are getting.

The choices keep their names when the model behind one is upgraded, so
intents and automations that say "Balanced" keep working. An agent's
attempt carries the label `g1t-agent`.

## How model traffic is routed

g1t agents can send every model request through
[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/). The
gateway is where an operator sees each request, caps spend, caches, and
sets a fallback to another provider if one is down, without changing
anything in g1t.

If you run your own copy of g1t, two settings on the runner control this:

| Setting | What it does |
| --- | --- |
| `AGENT_MODELS` | The choices offered, in order, each mapped to a provider's model. |
| `AI_GATEWAY_ID` | The gateway to route through. Empty sends requests to the provider directly. |

## Limits in the preview

- Sandboxes have git and common shell tools, but not every language's
  toolchain. An agent may not be able to build or test your project, and
  will say so in its summary.
- An agent is given one fork and the intent. Its credential, though, is
  your account's for the length of the run; credentials limited to the
  attempt are planned.
- A run has two hours. After that its credential expires and it can no
  longer push or report.

## What a sandbox can reach

A sandbox holds one fork and a credential that expires two hours after the
run starts.
That credential, and the model key the agent runs on, are removed from
anything recorded in the session.
