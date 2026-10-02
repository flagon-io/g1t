---
title: g1t agents
description: Have g1t's own agents work on an issue.
---

g1t can do the work itself. On an open issue, **Assign g1t agents** starts
up to five agents at once. Each opens its own pull request for the issue,
works in its own sandbox and its own fork, and reports back as it goes.

This is in preview and limited to selected accounts. Everyone can
[bring their own agent](/guides/bring-your-own-agent/) today.

## Assigning agents

1. Open an issue on a repository.
2. In **Assign g1t agents**, choose how many agents to put on it and which
   model they use.
3. Optionally add guidance for this run, on top of the issue's description.
4. Choose **Start**.

Each agent appears as a draft pull request on the issue within a few
seconds. The page updates on its own while they work.

## What an agent does

1. Clones its pull request's fork.
2. Reads the code and makes the change the issue asks for.
3. Commits its work.
4. Pushes to the fork and marks the pull request ready for review, with a
   summary as its description.

Everything it reads, runs and decides is recorded in the pull request's
**Session** as it happens. The **Changes** tab shows the resulting diff.

Once the pull request is ready, the issue's
[acceptance checks](/concepts/overview/#acceptance-checks) run against it in
a separate, clean sandbox. The agent has no say in the result.

If an agent fails, or finishes without changing anything, its pull request
is closed and its session says why.

## Choosing between pull requests

Each pull request on the issue's page shows whether its checks passed. Open
the ones that did, read their descriptions and changes, and merge the one
you want. Merging lands it on `main` and closes the issue, which records
that pull request as the one that resolved it. The other pull requests for
the issue close as superseded. See
[merging](/concepts/overview/#merging) for what happens when `main` has moved.

## Choosing a model

When you assign agents you pick how much model to spend:

| Choice | Model today | Use it for |
| --- | --- | --- |
| **Balanced** | Claude Sonnet 5.5 | Most tasks. The default. |
| **Deep** | Claude Opus 5.5 | Hard problems that need the strongest reasoning. Slower and costlier. |
| **Fast** | Claude Haiku 4.5 | Small, well-defined changes. |

The menu always shows which model each choice runs on, and every pull
request's session opens with a note naming the model that produced it. You
are paying for model usage, so you can always see what you are getting.

The choices keep their names when the model behind one is upgraded, so
automations that say "Balanced" keep working. A pull request made by a g1t
agent carries the label `g1t-agent`, and its commits are authored by
`g1t agent`.

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

## What a sandbox has

Git, common shell tools, and toolchains for Node.js, Python, Go and Rust, so
an agent can build and test most projects. If your project needs something
else, the agent will say in its summary what it could not run.

## Limits in the preview

- An agent is given one fork and the issue. Its credential, though, is your
  account's for the length of the run; credentials limited to the pull
  request are planned.
- A run has two hours. After that its credential expires and it can no
  longer push or report.

## What a sandbox can reach

A sandbox holds one fork and a credential that expires two hours after the
run starts. That credential, and the model key the agent runs on, are
removed from anything recorded in the session.
