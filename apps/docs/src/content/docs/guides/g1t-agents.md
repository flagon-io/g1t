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
[usage and billing](/guides/usage-and-billing/). Everyone can also
[bring their own agent](/guides/bring-your-own-agent/), which costs
nothing on g1t.

To hand over a whole outcome rather than one issue at a time, have an agent
plan it first: see [hand off an outcome](/guides/outcomes/).

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

In a comment: write `@g1t-agent take this` on the issue. See
[mentioning g1t-agent](#mentioning-g1t-agent).

By label: a project can hand every issue given a label to the agent. See
[the label rule](#the-label-rule).

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
**Session** as it happens; see [sessions and why-blame](/guides/why-blame/).
The **Changes** tab shows the resulting diff.

If an agent fails, or finishes without changing anything, its pull request
is closed and its session says why.

## Repository instructions

Every g1t agent run reads the repository's own instructions for agents
and is told them, labelled as the repository's, before it starts: making a
change, revising it, reviewing, catching up, answering, and planning.

| File | Read by |
| --- | --- |
| `AGENTS.md` and `CLAUDE.md` at the root | Every run. |
| `AGENTS.md` and `CLAUDE.md` in a subdirectory | Runs whose task touches files under it: the nearest one above each file. Where it disagrees with the root's, it wins for the files under it. |
| `.g1t/review.md` | Reviews: what to check, house rules, paths that need extra care. |

Write them for an agent that knows nothing about the project: how to build
and test, how things are named, what never to touch. For example:

```md
# AGENTS.md
- Run `npm test` and `npm run typecheck` before you finish.
- API handlers return a Result; they never throw.
- Never edit files under `vendor/`.
```

Which directories a task touches comes from the pull request's changed
files, and for new work from the paths the issue names, so naming the
files in an issue helps the right instructions reach the agent.

**Where they are read from.** The default branch, as it is when the run
starts. A pull request from one of the repository's own branches is read at
its head instead, since only people who can push to the repository can
change it. A pull request from a fork, which includes every change a g1t
agent makes, is never followed: the agent keeps the default branch's
instructions, and if the fork changes them, it is shown the changed text as
part of the change, marked as not instructions. That way nobody can steer
an agent, or the review of their own change, by editing these files in a
pull request. Treat what a fork's head says as untrusted, as you would its
code.

**Limits.** Each file is cut at 8,000 characters and all of them together
at 24,000; what is left out is named in the prompt. Files are read once per
commit and reused.

The project's **Agents** page lists the files its runs read, what they say
and when each last changed, with a link to each in the code. Each run's
session starts with a note of which files it read. To change them, change
the files and merge to the default branch.

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

g1t also works out ahead of time whether each pull request still merges
cleanly, every time it or `main` moves
([how](/guides/pull-requests/#conflicts)). When one of an agent's pull
requests is found to conflict, g1t does not wait for a merge to trip over
it: the agent is sent to merge `main` in and resolve the conflicts, told
which files conflict, and the checks run again on the result.

The pull request's page shows which step it is at. If g1t cannot finish,
because the checks still fail after two revisions, a review could not be
written, or a conflict could not be resolved while bringing it up to date,
it stops and the page says
**Needs you**, with the reason. Pushing to the pull request yourself starts
it moving again.

### What a repository can ask for

Under a project's **Settings → Repository**, a member of its workspace sets the
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
| Merge through a queue | Off | Merging tests a pull request together with those ahead of it; `main` only moves to a combination that passed. See [merge queue](/guides/merge-queue/). |

A g1t agent's pull request follows the same rules as anyone's. If the
repository wants approvals from people, it waits for them, and shows
**Needs you** until they arrive.

### Talking to an agent

While a g1t agent works, you can steer it with **Message the agent** on its
pull request; it reads the message at its next step, without starting
over. Once it is done, a review with **Request changes** sends it back to
make them, and the checks and review run again. g1t agents working at the
same time can also ask each other questions and hand each other work. See
[talk to agents](/guides/talking-to-agents/).

### Merging automatically

A repository can land a g1t agent's pull request by itself once it is
ready. A member of the workspace turns this on under the repository's
**Settings → Repository**; it is off to begin with. The merge is recorded as made by
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

## Mentioning g1t-agent

Write `@g1t-agent` in a comment on an issue or a pull request, with what
you want, and it does it. The comment box offers to complete the name as
you type `@`.

| Where | You write | What happens |
| --- | --- | --- |
| An issue | A request: `@g1t-agent take this`, `@g1t-agent fix the empty case` | The issue is assigned to the agent, which opens a pull request, as if you had chosen **Assign**. |
| An issue | A question: `@g1t-agent why does search time out?` | The agent reads the code on the default branch and answers in the thread. It changes nothing. |
| A pull request g1t-agent made | A request: `@g1t-agent also handle the empty list` | The agent is sent back to make the change, with your comment as what to address, and the checks and review run again. If it is still working, it gets your comment as a message at its next step. |
| Any pull request | `@g1t-agent review` | A review by a g1t agent, as with **Review by a g1t agent**. |
| Any pull request | A question | The agent reads the change at its head and answers in the thread. On someone else's pull request, which it cannot push to, a request is answered too: it says what it would change. |

A request is a comment whose words after the mention start with what to
do (`take`, `fix`, `add`, `please rename`, `can you update`); a question
starts with a question word or ends with a question mark. `review` near the
start asks for a review.

g1t-agent always replies in the thread, saying what it started or why it
did not. Every run a mention starts shows on the project's **Agents** page
as started by whoever mentioned it, and a mention that started nothing
shows there as a failed run with the reason.

**What does not count.** Mentions in code (`` `@g1t-agent` `` or a code
block), in quoted lines (`> @g1t-agent …`), in email addresses
(`ops@g1t-agent.dev`) and in longer names (`@g1t-agents`) are ignored.
Matching ignores case. Agents mentioning `@g1t-agent` start nothing, so
agents cannot set each other to work this way.

**Who can.** Members of the project's workspace. Anyone else who mentions
it gets a short reply saying only members can, and nothing starts. When
the workspace cannot run agents (for example, its free allowance is used
up and it has no model provider of its own), g1t-agent replies with why.

Each comment starts one run at most; to ask again, write a new comment.

## The label rule

Under a project's **Settings → Agents**, a member sets a label, such as
`agent`. From then on, when a member gives an open issue that label, either
when opening it or later, g1t-agent takes it: the issue is queued for an
agent, the conversation says so, and the agent starts as soon as the
project has room and nothing the issue depends on is still open, exactly as
for a [plan's](/guides/outcomes/) issues. An issue that already had the
label is not affected; removing and adding it again counts. **Turn off**
removes the rule.

## Which model runs

You do not pick one. You assign the work to `g1t-agent`, the way you would
assign an issue to a colleague, and g1t routes it. The kind of work decides:

| Work | Model today |
| --- | --- |
| Making a change for an issue, and revising it | Claude Sonnet 5.5 |
| Reviewing a pull request | Claude Sonnet 5.5 |
| Catching up with `main` and resolving conflicts | Claude Sonnet 5.5 |
| Planning an outcome | Claude Sonnet 5.5 |

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
| `AGENT_ROUTES` | The model for each kind of work: `implement`, `review`, `update` and `plan`. |
| `AI_GATEWAY_ID` | The gateway to route through. Empty sends requests to the provider directly. |
| `AI_GATEWAY_TOKEN` | Secret. Authenticates to the gateway. With the provider's key stored in the gateway, this is the only credential a sandbox gets. |
| `ANTHROPIC_API_KEY` | Secret. The provider's key, if the gateway does not hold it. |

## What it costs

A workspace pays for the g1t agents that work on its repositories, after
they run: each run is charged what AI Gateway priced its model requests
at, plus 20%, and its sandbox by the second past the free minutes. See
[Usage and billing](/guides/usage-and-billing/) for how prices are set and
the limits on usage not yet paid for.
The workspace's **Usage** page shows what its agents have cost, by day,
kind of work, repository, model and pull request. See
[usage and billing](/guides/usage-and-billing/).

## What a sandbox has

Git, common shell tools, and toolchains for Node.js, Python, Go and Rust, so
an agent can build and test most projects. If your project needs something
else, the agent will say in its summary what it could not run.

## Limits in the preview

- g1t's agents, and the sandboxes that run acceptance checks and the merge
  queue, work in any workspace that has
  [its own model provider](/guides/models/), and, until October 22, in any
  workspace on its free $1 of g1t's own models. See
  [the free allowance](/guides/usage-and-billing/#the-free-allowance).
- A run has two hours. After that its credentials expire and it can no
  longer push or report.

## Credentials

Every sandbox run gets credentials of its own, made when it starts and
revoked the moment it stops. They are not your access tokens, and they are
not listed with them.

Each credential carries a composite identity: the agent, acting on behalf
of the person who started the work. A run you started by assigning an issue
is `g1t-agent on behalf of you`, and that is how it appears in the
[audit log](/guides/audit-log/), on the run's page and in the pull
request's **Agent** panel.

What it may do is the intersection of two things:

- **The run's scope.** The credential is bound to the run, its repository,
  and what that kind of run needs. It expires no later than the run's
  timeout.
- **What you may do now.** It works only in the repository's workspace, and
  only while you are still a member of it. If you leave the workspace, every
  agent working on your behalf there stops being able to do anything. Your
  role does not carry over: an owner's agent is only ever a member.

A sandbox holds two credentials. One is for g1t's runner, which clones,
pushes the result and records the session; downstream it acts as you, so
what it pushes is yours, within the run's scope. The other is for the
agent's own tools over MCP, and acts as the agent; it cannot be used with
git at all.

| Kind of run | Git | API and MCP tools |
| --- | --- | --- |
| Implement | Reads the repository; pushes to its pull request's fork only | Records the session and marks its own pull request ready; tools to read issues, pull requests, the merge queue, workflow runs and memory, open issues, comment, remember, and message other agents |
| Revise, answer | Reads the repository; pushes to the pull request's fork, or to its branch only when the change is a branch of the repository | Records the session of its own pull request; the same tools as implement |
| Catch up | Reads the repository; pushes to the pull request's fork or branch only | Records the session of its own pull request |
| Review | Reads the change and the repository; pushes nothing | Reports its review through its own run |
| Plan | Reads the repository; pushes nothing | Reports its plan through its own run, for a person to apply; it can create issues in its repository only |
| Checks, merge check | Reads the change; pushes nothing | None |
| Merge queue | Reads each queued change; pushes the queue's own branch only | None |
| Deploy | Reads the commit it builds; pushes nothing | None |

Nothing an agent's credential holds can reach another repository, or a
workspace's settings, members, access tokens, billing, integrations,
webhooks, secrets and variables, or workflows' controls. It cannot merge a
pull request or put more agents to work. A call that would is refused, and
the refusal is recorded with the rule that refused it:

| Rule | Refused because |
| --- | --- |
| `never` | No agent's credential may ever do this. |
| `scope:operation` | The run's kind does not include this operation. |
| `scope:repository` | It names a repository other than the run's. |
| `scope:pull` | The runner tried to change a pull request other than its own. |
| `on-behalf-of:membership` | The person the agent works for is no longer a member of the workspace. |
| `git:read`, `git:push`, `git:ref` | The run has no grant to clone that repository, push to it, or move that branch or tag. |
| `git:not-a-run` | An agent's tools credential was used with git. |

Personal and workspace access tokens are unchanged by any of this.

## What a sandbox can reach

A sandbox holds one fork and its run's credentials, which expire when the
run's time is up and are revoked as soon as it stops. Those credentials,
and the model key the agent runs on, are removed from anything recorded in
the session.

## Guardrails

A workspace decides what its agents may do in their sandboxes, and each
project can override it: which hosts a sandbox can reach (g1t, the package
registries the project needs, and domains you list; enforced outside the
sandbox), which commands the harness refuses (force-pushing, rewriting the
default branch, reading outside the project, printing the environment,
sudo, and your own patterns), and how much one run may cost and how long it
may take. A run that is refused something shows it as a step; one that
reaches a cap is stopped and its pull request waits for you. A run on a
fork's head loads none of the fork's `CLAUDE.md`, `.claude` settings,
hooks, MCP servers or commands. See [guardrails](/guides/guardrails/) for
every rule and exactly how each is enforced.
