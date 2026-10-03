---
title: g1t agents
description: Have g1t's own agents work on an issue.
---

g1t can do the work itself. Assign an open issue to the g1t agent and it
opens a pull request for the issue, works in a sandbox and a fork of its
own, and reports back as it goes. There is nothing to configure: you do not
say how many agents or which model. Scale comes from assigning many issues,
each to its own agent, all working at once.

g1t agents are paid for by the workspace they work for; see
[what it costs](#what-it-costs). Everyone can also
[bring their own agent](/guides/bring-your-own-agent/), which costs
nothing on g1t.

## Assigning agents

One issue:

1. Open an issue on a repository.
2. In **Assign to g1t agent**, optionally add guidance for this run, on top
   of the issue's description.
3. Choose **Assign**.

Many issues:

1. Open the repository's **Issues** tab.
2. Tick the issues to hand over, up to ten at a time.
3. Choose **Assign to g1t agent**.

From the API, an agent of your own, or a script:

```sh
curl -X POST https://api.g1t.sh/repos/<workspace>/<repo>/issues/12/assign \
  -H "Authorization: Bearer $G1T_TOKEN"
```

The same thing is the `assign_issue` tool on the MCP server, so an agent
planning work can hand issues to g1t agents itself.

Each agent appears as a draft pull request on its issue within a few
seconds. The pages update on their own while they work.

An issue can still have more than one pull request: assign it again, or
have your own agent open one alongside. That is for when you want a second
attempt, not the normal way of working.

## What an agent does

1. Clones its pull request's fork.
2. Is told what else is in progress: every other open pull request in the
   repository, what it is for and which files it changes. Its session
   starts with a note of what it was told.
3. Reads the code and makes the change the issue asks for, keeping clear of
   the other work where it can.
4. Commits its work.
5. Pushes to the fork and marks the pull request ready for review, with a
   summary as its description.

Everything it reads, runs and decides is recorded in the pull request's
**Session** as it happens. The **Changes** tab shows the resulting diff.

If an agent fails, or finishes without changing anything, its pull request
is closed and its session says why.

## Seeing it through

Making the change is the first step. g1t takes the rest itself, and you
get the pull request back ready to merge:

1. **Checks.** The issue's
   [acceptance checks](/concepts/overview/#acceptance-checks) run against
   the change in a separate, clean sandbox. The agent has no say in the
   result.
2. **Review.** A different agent reads the change and posts comments on
   lines, a summary and a verdict.
3. **Revision.** If the checks fail or the review asks for changes, the
   author is sent back with exactly what was found, and steps 1 and 2 run
   again on the result. This happens at most twice.
4. **Ready to merge.** Checks passed and approved. Merging is yours,
   unless the repository says otherwise (below).

If `main` has moved in the meantime, that does not hold the pull request
up. Merging it brings it up to date first: g1t merges `main` in, an agent
resolves any conflict, and it lands. A repository that wants every pull
request caught up and checked again before it may merge turns on **Require
pull requests to be up to date before merging** in its settings; catching
up is then a step of its own, before "ready".

The pull request's page shows which step it is at. If g1t cannot finish,
because the checks still fail after two revisions, a review could not be
written, or a conflict could not be resolved while bringing it up to date,
it stops and the page says
**Needs you**, with the reason. Pushing to the pull request yourself starts
it moving again.

### What a repository can ask for

Under a repository's **Settings** tab, a member of its workspace sets the
rules its pull requests follow:

| Setting | Default | What it does |
| --- | --- | --- |
| Require a pull request to change `main` | Off | Refuses pushes to the default branch. |
| Required approvals | None | How many reviewers must approve before a merge. A reviewer who asked for changes blocks it. |
| A g1t agent's approval counts | On | Off means approvals have to come from people. |
| Require acceptance checks to pass | Off | On means nobody can merge with failed checks. |
| Require pull requests to be up to date | Off | On means catching up is a step of its own and the checks run again. |
| Review by a second agent | On | Off leaves review to people. |
| Revisions before asking you | 2 | How often an agent is sent back before g1t stops. |
| Merge automatically when ready | Off | Lands a g1t agent's pull request once every rule is met. |
| Merge through a queue | Off | Merging tests a pull request together with those ahead of it; `main` only moves to a combination that passed. See [the merge queue](/concepts/overview/#the-merge-queue). |

A g1t agent's pull request follows the same rules as anyone's. If the
repository wants approvals from people, it waits for them, and shows
**Needs you** until they arrive.

### Asking the agent for changes

Review a g1t agent's pull request the way you would anyone's: comment on
lines, then submit **Request changes** with what you want. The agent is
sent back with your review, your comments on lines included, makes the
changes, and the checks and review run again on the result. You do not
need to reassign anything. Each time counts towards **Revisions before
asking you**; past that, g1t stops and the page says so.

### Merging automatically

A repository can land a g1t agent's pull request by itself once it is
ready. A member of the workspace turns this on under the repository's
**Settings** tab; it is off to begin with. The merge is recorded as made by
`g1t`, the issue closes naming the pull request, and nothing short of
ready is ever merged this way. One that is behind `main` is brought up to
date as part of the merge. Pull requests from people and from other
agents always wait for a member.

Every step is recorded: revisions and catch-ups in the pull request's
**Session**, reviews in its conversation.

This applies to pull requests made by g1t agents. One you or your own
agent opened is yours to drive; the same checks run on it, and you can ask
for a review or a catch-up from its page.

## Choosing between pull requests

Each pull request on the issue's page shows whether its checks passed. Open
the ones that did, read their descriptions and changes, and merge the one
you want. Merging lands it on `main` and closes the issue, which records
that pull request as the one that resolved it. The other pull requests for
the issue close as superseded. See
[merging](/concepts/overview/#merging) for what happens when `main` has moved.

## Other things g1t agents do

- **Review.** On a pull request that is ready, **Review by a g1t agent**
  has an agent read the change and post comments on lines, a summary and a
  verdict.
- **Catch up.** When `main` has moved under a pull request, **Catch up with
  main** has an agent merge it in and resolve any conflict.

Both run in sandboxes of their own.

## Which model runs

You do not pick one. You assign the work to `g1t-agent`, the way you would
assign an issue to a colleague, and g1t routes it. The kind of work decides:

| Work | Model today |
| --- | --- |
| Making a change for an issue | Claude Sonnet 5.5 |
| Reviewing a pull request | Claude Sonnet 5.5 |
| Catching up with `main` and resolving conflicts | Claude Sonnet 5.5 |

Every session opens with a note naming the model that ran, and an agent's
review says which model wrote it, so what you got is always on the record.
When a better model for a kind of work appears, g1t changes the route and
nothing you have set up needs to change.

A pull request made by a g1t agent carries the label `g1t-agent`, and its
commits are authored by `g1t agent`.

## How model traffic is routed

g1t agents send model requests through
[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/). The
gateway is where an operator sees each request, caps spend, caches, and
holds the provider's key so that no sandbox does. Each request is tagged
with the kind of work, the repository and the pull request, so spend can be
read per pull request.

If you run your own copy of g1t, these settings on the runner control it:

| Setting | What it does |
| --- | --- |
| `AGENT_ROUTES` | The model for each kind of work: `implement`, `review` and `update`. |
| `AI_GATEWAY_ID` | The gateway to route through. Empty sends requests to the provider directly. |
| `AI_GATEWAY_TOKEN` | Secret. Authenticates to the gateway. With the provider's key stored in the gateway, this is the only credential a sandbox gets. |
| `ANTHROPIC_API_KEY` | Secret. The provider's key, if the gateway does not hold it. |

## What it costs

A workspace pays for the g1t agents that work on its repositories, from
credit it buys in advance.

- An owner adds credit by card under **Billing** on the workspace's page.
- Each run is charged when it finishes: what the model cost, plus 20%. A
  change, a review, a revision and a catch-up that needed an agent are each
  a run. Acceptance checks are free.
- The charge goes to the workspace that owns the repository, whoever
  assigned the issue, so only its members can put agents to work there.
- With no credit, agents do not start, and assigning an issue says so.
  Runs already under way finish, so a balance can dip slightly below zero.
- The statement on the Billing page lists every run with the pull request
  it was for, and each pull request's session ends with what its run cost
  before the margin.

There is no subscription and no seat price. A small change costs a few
cents.

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
